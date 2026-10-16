// Deciding a gate from an approval link (STATE item 98, ruling 0039 clause 3).
//
// THIS is the one place an approval executes. It runs only as the direct result
// of the signed-in owner clicking Approve on the approval page, via that page's
// server action (app/(dashboard)/approve/[id]/actions.ts) -- the only importer
// of this module, asserted by scripts/test-agent.ts. Nothing an agent call can
// reach (tools, the act choke point, the JSON-RPC layer) imports it.
//
// It acts as the signed-in COOKIE user, not as the agent's minted session, and
// it reuses the assistant's own guards (command-exec.ts `prepare` for
// approve_strategy and approve_draft: status, ownership, not already approved,
// latest run, still a draft, unsent, has text) and then the same existing
// entry points. What a click replaces from the in-platform command path is the
// quote and the earlier-turn rule: the user is looking at the content right
// now, and the fingerprint the link was made for must still be the live one.
//
// The order is fixed, and the link is consumed BEFORE the effect:
//
//   1. re-verify: the request is the caller's own, unused, unexpired, its token
//      not revoked, its subject still waiting, its live fingerprint recomputed
//      and equal to the one the link was made for       -- else nothing happens
//   2. the assistant's guards (`prepare`), and the recomputed fingerprint
//      compared again against the link's
//   3. CONSUME the request, atomically: used_at is set where it is still null
//      and the request has not expired. Zero rows updated means someone else
//      (or a second tab) got there first, and nothing is approved
//   4. the `started` record (origin user_click) is written, BEFORE the effect
//   5. the existing entry point (approveStrategy / approveDraft)
//   6. the terminal record, noting "approved by the user on the platform"
//
// A link burned by step 3 whose record (step 4) then cannot be written is not
// approved either: the page says so and the owner asks for a fresh link.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { COMMAND_EXECUTORS, type Executor, type Prepared } from "@/lib/assistant/command-exec";
import type { ApproveDraftArgs, ApproveStrategyArgs } from "@/lib/assistant/command-defs";
import type { CommandEntryPoints } from "@/lib/assistant/types";
import { isRedirectError } from "@/lib/assistant/redirect";
import { isUuid } from "@/lib/assistant/validate";
import { APPROVAL_TABLE, evaluateApproval, loadApprovalRow, loadLiveSubject, loadTokenRevoked, APPROVAL_MESSAGES, type ApprovalRow } from "./approvals";
import { insertAgentEvent, stopwatch, type AgentEventInsert } from "./log";
import { isSetupPending, AGENT_SETUP_PENDING_MESSAGE } from "./setup";

export const APPROVED_ON_PLATFORM_NOTE = "approved by the user on the platform";

export type ApproveResult = { ok: true; summary: string; href: string; warning?: string } | { error: string };

export type ApproveDeps = {
  supabase: SupabaseClient;
  userId: string;
  requestId: string;
  now: Date;
  loadEntryPoints: () => Promise<CommandEntryPoints>;
  executors?: Readonly<Record<string, Executor>>;
  log?: typeof insertAgentEvent;
};

export async function approveFromRequestCore(deps: ApproveDeps): Promise<ApproveResult> {
  const { supabase, userId, requestId, now } = deps;
  const log = deps.log ?? insertAgentEvent;
  const executors = deps.executors ?? COMMAND_EXECUTORS;
  const elapsed = stopwatch();
  if (!isUuid(requestId)) return { error: APPROVAL_MESSAGES.not_found };

  // 1. re-verify, as the signed-in user
  const loaded = await loadApprovalRow(supabase, requestId);
  if (loaded.setupPending) return { error: AGENT_SETUP_PENDING_MESSAGE };
  if (loaded.failed) return { error: "That approval link could not be read just now, so nothing was approved. Try again." };
  const row = loaded.row;
  if (!row) return { error: APPROVAL_MESSAGES.not_found };
  const [revoked, subject] = await Promise.all([loadTokenRevoked(supabase, row.token_id), loadLiveSubject(supabase, row)]);
  if (subject.failed) return { error: "What this link is for could not be read just now, so nothing was approved. Try again." };
  const verdict = evaluateApproval({ row, userId, now, live: subject.live, tokenRevoked: revoked });
  if (verdict.state !== "ready") return { error: verdict.message };

  // 2. the assistant's guards, and the fingerprint recomputed against the link's
  const toolName = row.kind === "strategy" ? "approve_strategy" : "approve_draft";
  const exec = executors[toolName];
  if (!exec) return { error: "That decision is not available. Nothing was approved." };
  const args =
    row.kind === "strategy"
      ? ({ prospectId: row.prospect_id, runId: row.subject_id, fingerprint: row.fingerprint } as unknown as ApproveStrategyArgs)
      : ({ prospectId: row.prospect_id, draftId: row.subject_id, fingerprint: row.fingerprint } as unknown as ApproveDraftArgs);
  let prepared: Prepared;
  try {
    const res = await exec(args, { supabase, userId, now });
    if ("refused" in res) return { error: `${res.refused.reason}` };
    prepared = res.prepared;
  } catch (err) {
    console.error(`[agent] ${toolName} guard step threw:`, err instanceof Error ? err.message : err);
    return { error: "The records needed to check that could not be read just now, so nothing was approved." };
  }
  if (typeof prepared.liveFingerprint !== "string" || prepared.liveFingerprint !== row.fingerprint) {
    return { error: APPROVAL_MESSAGES.changed };
  }

  // 3. consume the link, atomically, BEFORE the effect
  const consumed = await consumeRequest(supabase, row, now);
  if (!consumed.ok) return { error: consumed.message };

  // 4. the record, BEFORE the effect
  const payload = { request_id: row.id, subject_id: row.subject_id, prospect_id: row.prospect_id, fingerprint: row.fingerprint };
  const base = { call_id: randomUUID(), token_id: row.token_id, origin: "user_click" as const, access: "write" as const, tool: toolName };
  const subjectTable = row.kind === "strategy" ? "strategy_runs" : "drafts";
  const started = await log(supabase, {
    ...base,
    event: "started",
    arguments: payload,
    agent_statement: null,
    subject_table: subjectTable,
    subject_id: row.subject_id,
    previous: prepared.previous,
    result: null,
    error_note: null,
    duration_ms: null,
    restores_call_id: null,
  });
  if (!started.ok) {
    return { error: "That could not be recorded, and a decision is never taken unrecorded, so nothing was approved. This link has been used; ask Muse for a fresh one." };
  }
  const terminal = async (event: "executed" | "failed", result: Record<string, unknown> | null, note: string | null) => {
    const r: AgentEventInsert = {
      ...base,
      event,
      arguments: payload,
      agent_statement: null,
      subject_table: subjectTable,
      subject_id: row.subject_id,
      previous: null,
      result,
      error_note: note,
      duration_ms: elapsed(),
      restores_call_id: null,
    };
    return (await log(supabase, r)).ok;
  };

  // 5. the effect: the existing guarded approve, as the signed-in user
  let effect;
  try {
    const eps = await deps.loadEntryPoints();
    effect = await prepared.effect(eps);
  } catch (err) {
    const note = isRedirectError(err) ? "Your session is no longer signed in, so nothing was approved. Sign in and ask for a fresh link." : err instanceof Error && err.message ? err.message : "The approval failed.";
    console.error(`[agent] ${toolName} threw:`, note);
    effect = { ok: false as const, error: note };
  }

  // 6. the outcome, written once
  if (!effect.ok) {
    await terminal("failed", null, effect.error.slice(0, 1000));
    return { error: `${effect.error} The link has been used; ask Muse for a fresh one if you still want to decide this.` };
  }
  const recorded = await terminal("executed", { ...effect.result, requestId: row.id, note: APPROVED_ON_PLATFORM_NOTE }, null);
  return {
    ok: true,
    summary: effect.summary,
    href: effect.href ?? `/prospects/${row.prospect_id}`,
    warning: [effect.warning, recorded ? undefined : "The record of this decision could not be completed; the decision itself was made."].filter(Boolean).join(" ") || undefined,
  };
}

// Sets used_at exactly once. The update is conditional (unused, unexpired); the
// database trigger enforces the same, so a second click, a second tab and an
// expired link all end here with zero rows or an error.
export async function consumeRequest(supabase: SupabaseClient, row: ApprovalRow, now: Date): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from(APPROVAL_TABLE)
    .update({ used_at: now.toISOString() })
    .eq("id", row.id)
    .is("used_at", null)
    .gt("expires_at", now.toISOString())
    .select("id");
  if (error) {
    if (isSetupPending(error)) return { ok: false, message: AGENT_SETUP_PENDING_MESSAGE };
    if (/already used/i.test(error.message ?? "")) return { ok: false, message: APPROVAL_MESSAGES.used };
    if (/expired/i.test(error.message ?? "")) return { ok: false, message: APPROVAL_MESSAGES.expired };
    return { ok: false, message: "That approval link could not be used just now, so nothing was approved. Try again." };
  }
  if (!data || data.length === 0) return { ok: false, message: APPROVAL_MESSAGES.used };
  return { ok: true };
}
