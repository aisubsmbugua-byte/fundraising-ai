// Approval requests (STATE item 98, ruling 0039 clause 3).
//
// A decision gate -- approving a strategy, approving an outreach draft -- is
// never decided on an agent's call. The agent may REQUEST an approval; this
// module answers with a single-use, short-lived LINK bound to the exact
// content fingerprint, and executes nothing. The approval happens only when
// the signed-in owner opens that link, sees the full content and clicks
// (approve-exec.ts, reached only from the approval page's server action).
//
// What is here:
//   * runRequestApproval -- the agent tool. Scope, write cap, validation, the
//     born-before-effect record, then one INSERT of the request. It calls the
//     assistant's approve_* executors' `prepare` (read-only guards and the live
//     fingerprint) and NEVER their `effect`; a source scan asserts this file
//     calls no `.effect(` and imports no entry point.
//   * evaluateApproval -- the pure decision of whether a link can be used right
//     now, and the plain sentence for each refusal. Used by the page (to show
//     or refuse) and by the action (to re-verify).
//   * loadLiveSubject -- reads the live row behind a request through the
//     caller's own client, for the page to render IN FULL.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { COMMAND_EXECUTORS } from "@/lib/assistant/command-exec";
import type { ApproveDraftArgs, ApproveStrategyArgs } from "@/lib/assistant/command-defs";
import { draftFingerprint, normalizeIntel, normalizeStrategy, strategyFingerprint } from "@/lib/assistant/fingerprint";
import { asEnum, asUuid, rejectUnknownKeys, asOptionalBoundedString } from "@/lib/assistant/validate";
import { draftKindLabel } from "@/lib/drafts";
import type { OrganizationIntel, Strategy } from "@/lib/strategy";
import { insertAgentEvent, windowUsage, retryAfterSeconds, describeWait, stopwatch, compactArgs, type AgentEventInsert } from "./log";
import { APPROVAL_TTL_MS, MAX_AGENT_STATEMENT_CHARS, WRITE_CAP, WRITE_WINDOW_MS } from "./limits";
import { READ_TOKEN_REFUSAL } from "./act";
import { isSetupPending } from "./setup";
import type { ToolOutcome, ToolRunContext } from "./types";

export const APPROVAL_TABLE = "agent_approval_requests";
export const APPROVAL_KINDS = ["strategy", "draft"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export type ApprovalRow = {
  id: string;
  user_id: string;
  token_id: string;
  kind: ApprovalKind;
  subject_id: string;
  prospect_id: string;
  fingerprint: string;
  summary: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
};

export const APPROVAL_COLUMNS = "id, user_id, token_id, kind, subject_id, prospect_id, fingerprint, summary, expires_at, used_at, created_at";

export function approvalUrl(origin: string, id: string): string {
  return `${origin}/approve/${id}`;
}

// --- the preview: live guards and fingerprint, read-only -----------------------

type Preview =
  | { ok: true; prospectId: string; prospectName: string; fingerprint: string; subjectTable: "strategy_runs" | "drafts"; draftKind: string | null; draftSubject: string | null }
  | { ok: false; code: string; reason: string };

const NOT_FOUND_STRATEGY = "That strategy could not be found (or you cannot see it), so no approval link was made.";
const NOT_FOUND_DRAFT = "That draft could not be found (or you cannot see it), so no approval link was made.";
const READ_FAILED = "That could not be read just now, so no approval link was made.";

export async function previewGate(supabase: SupabaseClient, userId: string, kind: ApprovalKind, subjectId: string, now: Date): Promise<Preview> {
  const env = { supabase, userId, now };
  if (kind === "strategy") {
    const { data, error } = await supabase.from("strategy_runs").select("id, prospect_id").eq("id", subjectId).maybeSingle();
    if (error) return { ok: false, code: "read_failed", reason: READ_FAILED };
    if (!data) return { ok: false, code: "not_found", reason: NOT_FOUND_STRATEGY };
    const run = data as { id: string; prospect_id: string };
    // The assistant's guards, prepare only: status, ownership, not already
    // approved, latest run, has a proposal. The effect is never run here.
    const res = await COMMAND_EXECUTORS.approve_strategy({ prospectId: run.prospect_id, runId: run.id, fingerprint: "", authorizing_quote: "" } as ApproveStrategyArgs, env);
    if ("refused" in res) return { ok: false, code: res.refused.code, reason: res.refused.reason };
    const fp = res.prepared.liveFingerprint;
    if (typeof fp !== "string") return { ok: false, code: "no_fingerprint", reason: "The strategy's content could not be pinned, so no approval link was made." };
    const name = await prospectName(supabase, run.prospect_id);
    if (!name.ok) return { ok: false, code: "read_failed", reason: READ_FAILED };
    return { ok: true, prospectId: run.prospect_id, prospectName: name.name, fingerprint: fp, subjectTable: "strategy_runs", draftKind: null, draftSubject: null };
  }
  const { data, error } = await supabase.from("drafts").select("id, prospect_id, kind, subject").eq("id", subjectId).maybeSingle();
  if (error) return { ok: false, code: "read_failed", reason: READ_FAILED };
  if (!data) return { ok: false, code: "not_found", reason: NOT_FOUND_DRAFT };
  const d = data as { id: string; prospect_id: string; kind: string; subject: string | null };
  const res = await COMMAND_EXECUTORS.approve_draft({ prospectId: d.prospect_id, draftId: d.id, fingerprint: "", authorizing_quote: "" } as ApproveDraftArgs, env);
  if ("refused" in res) return { ok: false, code: res.refused.code, reason: res.refused.reason };
  const fp = res.prepared.liveFingerprint;
  if (typeof fp !== "string") return { ok: false, code: "no_fingerprint", reason: "The draft's content could not be pinned, so no approval link was made." };
  const name = await prospectName(supabase, d.prospect_id);
  if (!name.ok) return { ok: false, code: "read_failed", reason: READ_FAILED };
  return { ok: true, prospectId: d.prospect_id, prospectName: name.name, fingerprint: fp, subjectTable: "drafts", draftKind: d.kind, draftSubject: d.subject };
}

async function prospectName(supabase: SupabaseClient, id: string): Promise<{ ok: true; name: string } | { ok: false }> {
  const { data, error } = await supabase.from("prospects").select("id, name").eq("id", id).maybeSingle();
  if (error || !data) return { ok: false };
  return { ok: true, name: String((data as { name: string }).name).replace(/\s+/g, " ").trim().slice(0, 120) };
}

function clipLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Code-built; never the agent's words.
export function buildApprovalSummary(p: Extract<Preview, { ok: true }>, kind: ApprovalKind): string {
  if (kind === "strategy") {
    return `Approve the proposed strategy for "${p.prospectName}". Approving records your decision; nothing is sent to anyone.`;
  }
  const label = draftKindLabel(p.draftKind ?? "draft").toLowerCase();
  const subject = p.draftSubject ? ` "${clipLine(p.draftSubject, 100)}"` : "";
  return `Approve the ${label}${subject} for "${p.prospectName}". Approving marks it approved; it does not send it.`;
}

// --- request_approval (the agent tool) -------------------------------------------

export type ApprovalDeps = {
  log?: typeof insertAgentEvent;
  usage?: typeof windowUsage;
  newCallId?: () => string;
};

export async function runRequestApproval(rawArgs: Record<string, unknown>, ctx: ToolRunContext, deps: ApprovalDeps = {}): Promise<ToolOutcome> {
  const log = deps.log ?? insertAgentEvent;
  const usage = deps.usage ?? windowUsage;
  const callId = (deps.newCallId ?? randomUUID)();
  const elapsed = stopwatch();
  const argsForLog = (): Record<string, unknown> => compactArgs(rawArgs);
  const base = () => ({ call_id: callId, token_id: ctx.principal.tokenId, origin: "agent" as const, access: "write" as const, tool: "request_approval" });

  async function refused(code: string, reason: string): Promise<ToolOutcome> {
    await log(ctx.supabase, {
      ...base(),
      event: "refused",
      arguments: argsForLog(),
      agent_statement: null,
      subject_table: null,
      subject_id: null,
      previous: null,
      result: { code },
      error_note: reason.slice(0, 1000),
      duration_ms: elapsed(),
      restores_call_id: null,
    });
    return { isError: true, text: `Not done: ${reason}`, structured: { status: "refused", nothingWasDone: true, code, reason, callId } };
  }

  // scope
  if (ctx.principal.scope !== "act") return refused("scope", READ_TOKEN_REFUSAL);

  // cap (asking for a link is a write: it creates a record)
  const used = await usage(ctx.supabase, ctx.principal.tokenId, "writes", WRITE_WINDOW_MS, ctx.now);
  if (!used.ok) {
    return { isError: true, text: "The number of recent changes could not be checked just now, so nothing was done. Try again shortly.", structured: { status: "refused", nothingWasDone: true, code: "cap_unreadable", callId } };
  }
  if (used.usage.count >= WRITE_CAP) {
    const wait = describeWait(retryAfterSeconds(used.usage.oldestAt, WRITE_WINDOW_MS, ctx.now));
    return refused("write_cap", `This token has made its limit of ${WRITE_CAP} changes for the hour, so this one was not made. Try again in ${wait}.`);
  }

  // arguments
  const unknown = rejectUnknownKeys(rawArgs ?? {}, ["kind", "subject_id", "agent_statement"]);
  if (unknown) return refused("invalid_arguments", `${unknown} Nothing was done.`);
  const kind = asEnum(rawArgs.kind, "kind", APPROVAL_KINDS);
  if (!kind.ok) return refused("invalid_arguments", `${kind.error} Nothing was done.`);
  const subject = asUuid(rawArgs.subject_id, "subject_id");
  if (!subject.ok) return refused("invalid_arguments", `${subject.error} Nothing was done.`);
  const statementRes = asOptionalBoundedString(rawArgs.agent_statement, "agent_statement", { max: MAX_AGENT_STATEMENT_CHARS });
  if (!statementRes.ok) return refused("invalid_arguments", `${statementRes.error} Nothing was done.`);
  const statement = statementRes.value;

  // the live row, its guards and its fingerprint (read-only)
  const preview = await previewGate(ctx.supabase, ctx.principal.userId, kind.value, subject.value, ctx.now);
  if (!preview.ok) return refused(preview.code, preview.reason);

  const summary = buildApprovalSummary(preview, kind.value);
  const expiresAt = new Date(ctx.now.getTime() + APPROVAL_TTL_MS).toISOString();
  const payload = { kind: kind.value, subject_id: subject.value };

  // the record, BEFORE the insert that is this call's only effect
  const started = await log(ctx.supabase, {
    ...base(),
    event: "started",
    arguments: payload,
    agent_statement: statement,
    subject_table: preview.subjectTable,
    subject_id: subject.value,
    previous: null,
    result: null,
    error_note: null,
    duration_ms: null,
    restores_call_id: null,
  });
  if (!started.ok) {
    return {
      isError: true,
      text: `Not done: ${started.setupPending ? started.message : "That could not be recorded, so no approval link was made."}`,
      structured: { status: "refused", nothingWasDone: true, code: started.setupPending ? "setup_pending" : "record_failed", callId },
    };
  }

  const terminal = async (event: "executed" | "failed", result: Record<string, unknown> | null, note: string | null) => {
    const row: AgentEventInsert = {
      ...base(),
      event,
      arguments: payload,
      agent_statement: statement,
      subject_table: preview.subjectTable,
      subject_id: subject.value,
      previous: null,
      result,
      error_note: note,
      duration_ms: elapsed(),
      restores_call_id: null,
    };
    return (await log(ctx.supabase, row)).ok;
  };

  // The only effect: one row in the request table. It decides nothing.
  const { data, error } = await ctx.supabase
    .from(APPROVAL_TABLE)
    .insert({
      token_id: ctx.principal.tokenId,
      kind: kind.value,
      subject_id: subject.value,
      prospect_id: preview.prospectId,
      fingerprint: preview.fingerprint,
      summary,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) {
    const note = isSetupPending(error) ? "The approval record is not in the database yet." : "The approval link could not be made.";
    await terminal("failed", null, note);
    return { isError: true, text: `Not done: ${note}`, structured: { status: "failed", callId, reason: note } };
  }
  const id = String((data as { id: string }).id);
  const url = approvalUrl(ctx.origin, id);
  await terminal("executed", { requestId: id, fingerprint: preview.fingerprint, expiresAt, summary }, null);

  const text = [
    "An approval link was made. Nothing has been approved.",
    summary,
    `Give this link to the owner: ${url}`,
    `It works once, for about ${Math.round(APPROVAL_TTL_MS / 60000)} minutes (until ${expiresAt}), and only for the person this token belongs to, signed in to the platform. They will see the full content and decide there. If the content changes first, the link will not approve it.`,
  ].join("\n");
  return {
    isError: false,
    text,
    structured: { status: "link_created", approvalUrl: url, fingerprint: preview.fingerprint, expiresAt, whatWillBeApproved: summary, nothingApproved: true, callId },
  };
}

// --- evaluating a link (pure) ------------------------------------------------------

export type LiveSubject =
  | {
      kind: "strategy";
      prospectId: string;
      prospectName: string;
      status: string;
      approved: boolean;
      fingerprint: string | null;
      strategy: Strategy | null;
      intel: OrganizationIntel | null;
    }
  | {
      kind: "draft";
      prospectId: string;
      prospectName: string;
      status: string;
      sent: boolean;
      draftKind: string;
      subject: string | null;
      content: string;
      fingerprint: string;
    };

export type ApprovalVerdict =
  | { state: "ready" }
  | { state: "not_found" | "used" | "expired" | "changed" | "subject_gone" | "token_revoked" | "not_waiting"; message: string };

export const APPROVAL_MESSAGES = {
  not_found: "That approval link could not be found for your account. It may belong to someone else, or it may not exist.",
  used: "That approval link has already been used. A link works once. Ask Muse for a fresh one if you still want to decide this.",
  expired: "That approval link has expired. Ask Muse for a fresh one.",
  changed: "What this link was made for has changed since, so nothing was approved. Ask Muse for a fresh link and look at the current version.",
  subject_gone: "What this link was made for could not be found any more, so nothing was approved.",
  token_revoked: "The access token that made this link has been revoked, so the link no longer works. Nothing was approved.",
  not_waiting: "This is no longer waiting for your decision (it was already decided, replaced by a newer version, or delivered), so there is nothing to approve here.",
} as const;

export function evaluateApproval(input: {
  row: ApprovalRow | null;
  userId: string;
  now: Date;
  live: LiveSubject | null;
  tokenRevoked: boolean;
}): ApprovalVerdict {
  const { row, userId, now, live } = input;
  // Wrong user: row-level security already hides another user's request; this
  // check is the second line.
  if (!row || row.user_id !== userId) return { state: "not_found", message: APPROVAL_MESSAGES.not_found };
  if (row.used_at) return { state: "used", message: APPROVAL_MESSAGES.used };
  if (Date.parse(row.expires_at) <= now.getTime()) return { state: "expired", message: APPROVAL_MESSAGES.expired };
  if (input.tokenRevoked) return { state: "token_revoked", message: APPROVAL_MESSAGES.token_revoked };
  if (!live) return { state: "subject_gone", message: APPROVAL_MESSAGES.subject_gone };
  if (live.kind !== row.kind) return { state: "changed", message: APPROVAL_MESSAGES.changed };
  if (live.kind === "strategy") {
    if (live.status !== "ready_for_review" || live.approved) return { state: "not_waiting", message: APPROVAL_MESSAGES.not_waiting };
  } else if (live.status !== "draft" || live.sent) {
    return { state: "not_waiting", message: APPROVAL_MESSAGES.not_waiting };
  }
  // The fingerprint of the live content, recomputed now, must be the one the
  // link was made for.
  if (live.fingerprint !== row.fingerprint) return { state: "changed", message: APPROVAL_MESSAGES.changed };
  return { state: "ready" };
}

// --- reading the request and what it is about (the caller's own client) ----------------

export async function loadApprovalRow(supabase: SupabaseClient, requestId: string): Promise<{ row: ApprovalRow | null; failed: boolean; setupPending: boolean }> {
  const { data, error } = await supabase.from(APPROVAL_TABLE).select(APPROVAL_COLUMNS).eq("id", requestId).maybeSingle();
  if (error) return { row: null, failed: true, setupPending: isSetupPending(error) };
  return { row: (data as ApprovalRow | null) ?? null, failed: false, setupPending: false };
}

export async function loadTokenRevoked(supabase: SupabaseClient, tokenId: string): Promise<boolean> {
  const { data, error } = await supabase.from("agent_tokens").select("id, revoked_at").eq("id", tokenId).maybeSingle();
  // If the token cannot be read the link is treated as revoked: fail closed.
  if (error || !data) return true;
  return (data as { revoked_at: string | null }).revoked_at !== null;
}

export async function loadLiveSubject(supabase: SupabaseClient, row: ApprovalRow): Promise<{ live: LiveSubject | null; failed: boolean }> {
  const name = await prospectName(supabase, row.prospect_id);
  if (row.kind === "strategy") {
    const { data, error } = await supabase
      .from("strategy_runs")
      .select("id, prospect_id, status, strategy, organization_intel, approved_strategy")
      .eq("id", row.subject_id)
      .maybeSingle();
    if (error) return { live: null, failed: true };
    if (!data || !name.ok) return { live: null, failed: false };
    const run = data as { prospect_id: string; status: string; strategy: unknown; organization_intel: unknown; approved_strategy: unknown };
    if (run.prospect_id !== row.prospect_id) return { live: null, failed: false };
    const hasProposal = run.strategy && typeof run.strategy === "object" && run.organization_intel && typeof run.organization_intel === "object";
    return {
      failed: false,
      live: {
        kind: "strategy",
        prospectId: row.prospect_id,
        prospectName: name.name,
        status: run.status,
        approved: run.approved_strategy !== null && run.approved_strategy !== undefined,
        fingerprint: hasProposal ? strategyFingerprint(run.strategy, run.organization_intel) : null,
        strategy: hasProposal ? normalizeStrategy(run.strategy) : null,
        intel: hasProposal ? normalizeIntel(run.organization_intel) : null,
      },
    };
  }
  const { data, error } = await supabase
    .from("drafts")
    .select("id, prospect_id, kind, status, subject, content, sent_at")
    .eq("id", row.subject_id)
    .maybeSingle();
  if (error) return { live: null, failed: true };
  if (!data || !name.ok) return { live: null, failed: false };
  const d = data as { prospect_id: string; kind: string; status: string; subject: string | null; content: string | null; sent_at: string | null };
  if (d.prospect_id !== row.prospect_id) return { live: null, failed: false };
  const content = typeof d.content === "string" ? d.content : "";
  return {
    failed: false,
    live: {
      kind: "draft",
      prospectId: row.prospect_id,
      prospectName: name.name,
      status: d.status,
      sent: Boolean(d.sent_at),
      draftKind: d.kind,
      subject: typeof d.subject === "string" ? d.subject : null,
      content,
      fingerprint: draftFingerprint({ kind: d.kind, subject: d.subject, content }),
    },
  };
}
