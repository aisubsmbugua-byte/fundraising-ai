// Proposals: the only thing an act-on-approval ability can do (STATE item 87,
// ruling 0037 clause 2).
//
// A propose handler VALIDATES what the model asked for, RESOLVES the subject
// through the session client (so an id the user cannot see is "not found"),
// BUILDS the human-readable summary from the validated payload, and INSERTS a
// pending row. It changes nothing else. Nothing in this file imports an entry
// point that writes to a prospect or a supporter -- that is executors.ts's
// job, and executors.ts is imported by exactly one file, the approve action
// (asserted by source scan in scripts/test-assistant.ts).
//
// Three things in the stored row are CODE, not model text:
//   - `summary`  built here from the payload and the subject's name;
//   - `payload`  the validated, normalized arguments, plus (for a next-action
//                change) the previous value read from the database, which the
//                approve path compares to refuse a stale proposal;
//   - `fields`   the payload rendered to labelled lines for the client, so
//                the user sees exactly what approval will execute.

import type { AbilityOutcome, ProposalStatus, ProposalView, Result, ToolContext } from "./types";
import { INTERACTION_KINDS, interactionKindLabel, type InteractionKind } from "@/lib/interactions";
import {
  asBoundedString,
  asEnum,
  asIsoDate,
  asOptionalIsoDate,
  asUuid,
  isUuid,
  rejectUnknownKeys,
} from "./validate";

export const ACTION_KEYS = ["log_prospect_interaction", "set_prospect_next_action", "log_supporter_interaction"] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

// Bounds a flooding model cannot exceed (enforced here, not in the prompt).
export const MAX_PROPOSALS_PER_TURN = 3;
export const MAX_INTERACTION_SUMMARY_CHARS = 1000;
export const MAX_NEXT_ACTION_CHARS = 200;
export const MAX_SUBJECT_NAME_CHARS = 120;

const KIND_VALUES = INTERACTION_KINDS.map((k) => k.value) as readonly InteractionKind[];
const EARLIEST_DATE = "2000-01-01";
const LATEST_DUE_DATE = "2100-12-31";

const MS_PER_DAY = 86400000;
export function tomorrowIso(now: Date): string {
  return new Date(now.getTime() + MS_PER_DAY).toISOString().slice(0, 10);
}

// --- Payload shapes ----------------------------------------------------------

export type LogInteractionPayload = {
  prospect_id: string;
  subject_name: string;
  kind: InteractionKind;
  summary: string;
  occurred_at: string;
};

export type SetNextActionPayload = {
  prospect_id: string;
  subject_name: string;
  next_action: string;
  next_action_due: string | null;
  // Captured by code from the database when the proposal is written. The
  // approve path refuses the proposal as stale if the current value differs.
  previous: { next_action: string | null; next_action_due: string | null };
};

export type LogSupporterInteractionPayload = {
  supporter_id: string;
  subject_name: string;
  kind: InteractionKind;
  summary: string;
  occurred_at: string;
};

export type ProposalPayload = LogInteractionPayload | SetNextActionPayload | LogSupporterInteractionPayload;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// A previous next action is read back from the database, not typed by anyone,
// so it is bounded by what the stale check compares rather than by the 200
// characters a NEW next action may carry. Both the writer and the stale
// check pass the value through previousForCompare so they agree.
export const MAX_PREVIOUS_CHARS = 2000;
export function previousForCompare(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v.length > MAX_PREVIOUS_CHARS ? v.slice(0, MAX_PREVIOUS_CHARS) : v;
}

// Stored as read, byte for byte: no trimming and no character policy, because
// the stale check compares it to the database's current value.
function optionalDbString(v: unknown, field: string, max: number): Result<string | null> {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: `${field} must be text or null.` };
  if (v.length > max) return { ok: false, error: `${field} must be at most ${max} characters.` };
  return { ok: true, value: v };
}

// The one validator for a payload. Used when a proposal is WRITTEN (from the
// model's arguments plus code-captured fields) and again by the executor
// BEFORE it writes anything (from the stored jsonb) -- so the stored row is
// never trusted just because it is stored.
export function validatePayload(actionKey: string, payload: unknown, now: Date): Result<ProposalPayload> {
  if (!isRecord(payload)) return { ok: false, error: "The stored payload is not an object." };
  const maxPast = tomorrowIso(now);

  if (actionKey === "log_prospect_interaction" || actionKey === "log_supporter_interaction") {
    const idField = actionKey === "log_prospect_interaction" ? "prospect_id" : "supporter_id";
    const unknown = rejectUnknownKeys(payload, [idField, "subject_name", "kind", "summary", "occurred_at"]);
    if (unknown) return { ok: false, error: unknown };
    const id = asUuid(payload[idField], idField);
    if (!id.ok) return id;
    const name = asBoundedString(payload.subject_name, "subject_name", { min: 1, max: MAX_SUBJECT_NAME_CHARS });
    if (!name.ok) return name;
    const kind = asEnum(payload.kind, "kind", KIND_VALUES);
    if (!kind.ok) return kind;
    const summary = asBoundedString(payload.summary, "summary", { min: 1, max: MAX_INTERACTION_SUMMARY_CHARS });
    if (!summary.ok) return summary;
    const date = asIsoDate(payload.occurred_at, "occurred_at", { min: EARLIEST_DATE, max: maxPast });
    if (!date.ok) return date;
    if (actionKey === "log_prospect_interaction") {
      return { ok: true, value: { prospect_id: id.value, subject_name: name.value, kind: kind.value, summary: summary.value, occurred_at: date.value } };
    }
    return { ok: true, value: { supporter_id: id.value, subject_name: name.value, kind: kind.value, summary: summary.value, occurred_at: date.value } };
  }

  if (actionKey === "set_prospect_next_action") {
    const unknown = rejectUnknownKeys(payload, ["prospect_id", "subject_name", "next_action", "next_action_due", "previous"]);
    if (unknown) return { ok: false, error: unknown };
    const id = asUuid(payload.prospect_id, "prospect_id");
    if (!id.ok) return id;
    const name = asBoundedString(payload.subject_name, "subject_name", { min: 1, max: MAX_SUBJECT_NAME_CHARS });
    if (!name.ok) return name;
    const action = asBoundedString(payload.next_action, "next_action", { min: 1, max: MAX_NEXT_ACTION_CHARS });
    if (!action.ok) return action;
    const due = asOptionalIsoDate(payload.next_action_due, "next_action_due", { min: EARLIEST_DATE, max: LATEST_DUE_DATE });
    if (!due.ok) return due;
    if (!isRecord(payload.previous)) return { ok: false, error: "previous must be present." };
    const prevUnknown = rejectUnknownKeys(payload.previous, ["next_action", "next_action_due"]);
    if (prevUnknown) return { ok: false, error: prevUnknown };
    const prevAction = optionalDbString(payload.previous.next_action, "previous.next_action", MAX_PREVIOUS_CHARS);
    if (!prevAction.ok) return prevAction;
    const prevDue = payload.previous.next_action_due === null ? ({ ok: true, value: null } as const) : asIsoDate(payload.previous.next_action_due, "previous.next_action_due", { min: "1900-01-01", max: "2200-12-31" });
    if (!prevDue.ok) return prevDue;
    return {
      ok: true,
      value: {
        prospect_id: id.value,
        subject_name: name.value,
        next_action: action.value,
        next_action_due: due.value,
        previous: { next_action: prevAction.value, next_action_due: prevDue.value },
      },
    };
  }

  return { ok: false, error: "Unknown action." };
}

// --- Code-built presentation -------------------------------------------------

function quote(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

export function buildSummary(actionKey: ActionKey, p: ProposalPayload): string {
  if (actionKey === "log_prospect_interaction" || actionKey === "log_supporter_interaction") {
    const x = p as LogInteractionPayload | LogSupporterInteractionPayload;
    const who = actionKey === "log_prospect_interaction" ? `prospect ${quote(x.subject_name, 80)}` : `supporter ${quote(x.subject_name, 80)}`;
    return `Log a ${interactionKindLabel(x.kind).toLowerCase()} dated ${x.occurred_at} on ${who}: ${quote(x.summary)}`;
  }
  const x = p as SetNextActionPayload;
  return `Set the next action on prospect ${quote(x.subject_name, 80)} to ${quote(x.next_action)}${x.next_action_due ? `, due ${x.next_action_due}` : ", with no due date"}`;
}

// The stored payload as labelled lines -- what the user sees beside the
// Approve button. Everything shown is read from the payload that will be
// executed, so what is displayed cannot differ from what runs.
export function describePayload(actionKey: string, payload: unknown): { label: string; value: string }[] {
  if (!isRecord(payload)) return [{ label: "Payload", value: "(unreadable)" }];
  if (actionKey === "log_prospect_interaction" || actionKey === "log_supporter_interaction") {
    return [
      { label: actionKey === "log_prospect_interaction" ? "Prospect" : "Supporter", value: String(payload.subject_name ?? "") },
      { label: "Type", value: interactionKindLabel(String(payload.kind ?? "")) },
      { label: "Date", value: String(payload.occurred_at ?? "") },
      { label: "What happened", value: String(payload.summary ?? "") },
    ];
  }
  if (actionKey === "set_prospect_next_action") {
    const prev = isRecord(payload.previous) ? payload.previous : {};
    return [
      { label: "Prospect", value: String(payload.subject_name ?? "") },
      { label: "New next action", value: String(payload.next_action ?? "") },
      { label: "New due date", value: payload.next_action_due ? String(payload.next_action_due) : "None" },
      { label: "Currently", value: `${prev.next_action ? String(prev.next_action) : "No next action"}${prev.next_action_due ? ` · due ${String(prev.next_action_due)}` : ""}` },
    ];
  }
  return [{ label: "Payload", value: JSON.stringify(payload).slice(0, 400) }];
}

export function subjectHrefFor(actionKey: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (actionKey === "log_supporter_interaction") return "/supporters";
  return isUuid(payload.prospect_id) ? `/prospects/${payload.prospect_id}` : null;
}

export const PROPOSAL_COLUMNS =
  "id, message_id, thread_id, created_by, action_key, payload, subject_table, subject_id, summary, status, expires_at, claimed_at, decided_at, result, error_note, created_at";

export type ProposalRow = {
  id: string;
  message_id: string;
  thread_id: string;
  created_by: string;
  action_key: string;
  payload: unknown;
  subject_table: string;
  subject_id: string;
  summary: string;
  status: ProposalStatus;
  expires_at: string;
  claimed_at: string | null;
  decided_at: string | null;
  result: unknown;
  error_note: string | null;
  created_at: string;
};

export function rowToView(row: ProposalRow): ProposalView {
  return {
    id: row.id,
    messageId: row.message_id,
    actionKey: row.action_key,
    summary: row.summary,
    fields: describePayload(row.action_key, row.payload),
    status: row.status,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    errorNote: row.error_note,
    subjectHref: subjectHrefFor(row.action_key, row.payload),
  };
}

// --- Propose handlers --------------------------------------------------------

export const PROPOSAL_MODEL_NOTE =
  "Nothing has changed yet. The proposal is shown to the user, who must confirm it in the interface before it takes effect.";

function tooMany(ctx: ToolContext): AbilityOutcome | null {
  if (ctx.proposalsCreated >= MAX_PROPOSALS_PER_TURN) {
    return { ok: false, error: `At most ${MAX_PROPOSALS_PER_TURN} proposals can be made in one reply. Tell the user what else you would suggest instead.` };
  }
  return null;
}

async function insertProposal(
  ctx: ToolContext,
  actionKey: ActionKey,
  subjectTable: "prospects" | "supporters",
  subjectId: string,
  payload: ProposalPayload
): Promise<AbilityOutcome> {
  const summary = buildSummary(actionKey, payload);
  const { data, error } = await ctx.supabase
    .from("assistant_proposals")
    .insert({
      thread_id: ctx.threadId,
      message_id: ctx.messageId,
      action_key: actionKey,
      payload,
      subject_table: subjectTable,
      subject_id: subjectId,
      summary,
    })
    .select(PROPOSAL_COLUMNS)
    .single();
  if (error || !data) {
    console.error("[assistant] proposal insert failed:", error?.message ?? "no row returned");
    return { ok: false, error: "The proposal could not be recorded. Nothing was changed." };
  }
  ctx.proposalsCreated += 1;
  const view = rowToView(data as unknown as ProposalRow);
  return { ok: true, modelResult: { proposalId: view.id, status: "pending", summary, note: PROPOSAL_MODEL_NOTE }, proposal: view };
}

export type ProposeInteractionArgs = { id: string; kind: InteractionKind; summary: string; occurredAt: string };

export function validateProposeInteraction(idField: "prospect_id" | "supporter_id") {
  return (raw: Record<string, unknown>, now: Date = new Date()): Result<ProposeInteractionArgs> => {
    const unknown = rejectUnknownKeys(raw, [idField, "kind", "summary", "occurred_at"]);
    if (unknown) return { ok: false, error: unknown };
    const id = asUuid(raw[idField], idField);
    if (!id.ok) return id;
    const kind = asEnum(raw.kind, "kind", KIND_VALUES);
    if (!kind.ok) return kind;
    const summary = asBoundedString(raw.summary, "summary", { min: 1, max: MAX_INTERACTION_SUMMARY_CHARS });
    if (!summary.ok) return summary;
    const date = asIsoDate(raw.occurred_at, "occurred_at", { min: EARLIEST_DATE, max: tomorrowIso(now) });
    if (!date.ok) return date;
    return { ok: true, value: { id: id.value, kind: kind.value, summary: summary.value, occurredAt: date.value } };
  };
}

export async function proposeLogProspectInteraction(args: ProposeInteractionArgs, ctx: ToolContext): Promise<AbilityOutcome> {
  const refused = tooMany(ctx);
  if (refused) return refused;
  const { data, error } = await ctx.supabase.from("prospects").select("id, name").eq("id", args.id).maybeSingle();
  if (error) return { ok: false, error: "Could not look that prospect up just now." };
  if (!data) return { ok: false, error: "No prospect with that id was found." };
  const payload: LogInteractionPayload = {
    prospect_id: args.id,
    subject_name: String((data as { name: string }).name).slice(0, MAX_SUBJECT_NAME_CHARS),
    kind: args.kind,
    summary: args.summary,
    occurred_at: args.occurredAt,
  };
  return insertProposal(ctx, "log_prospect_interaction", "prospects", args.id, payload);
}

export async function proposeLogSupporterInteraction(args: ProposeInteractionArgs, ctx: ToolContext): Promise<AbilityOutcome> {
  const refused = tooMany(ctx);
  if (refused) return refused;
  const { data, error } = await ctx.supabase.from("supporters").select("id, name").eq("id", args.id).maybeSingle();
  if (error) return { ok: false, error: "Could not look that supporter up just now." };
  if (!data) return { ok: false, error: "No supporter with that id was found." };
  const payload: LogSupporterInteractionPayload = {
    supporter_id: args.id,
    subject_name: String((data as { name: string }).name).slice(0, MAX_SUBJECT_NAME_CHARS),
    kind: args.kind,
    summary: args.summary,
    occurred_at: args.occurredAt,
  };
  return insertProposal(ctx, "log_supporter_interaction", "supporters", args.id, payload);
}

export type ProposeNextActionArgs = { prospectId: string; nextAction: string; nextActionDue: string | null };

export function validateProposeNextAction(raw: Record<string, unknown>): Result<ProposeNextActionArgs> {
  const unknown = rejectUnknownKeys(raw, ["prospect_id", "next_action", "next_action_due"]);
  if (unknown) return { ok: false, error: unknown };
  const id = asUuid(raw.prospect_id, "prospect_id");
  if (!id.ok) return id;
  const action = asBoundedString(raw.next_action, "next_action", { min: 1, max: MAX_NEXT_ACTION_CHARS });
  if (!action.ok) return action;
  const due = asOptionalIsoDate(raw.next_action_due, "next_action_due", { min: EARLIEST_DATE, max: LATEST_DUE_DATE });
  if (!due.ok) return due;
  return { ok: true, value: { prospectId: id.value, nextAction: action.value, nextActionDue: due.value } };
}

export async function proposeSetProspectNextAction(args: ProposeNextActionArgs, ctx: ToolContext): Promise<AbilityOutcome> {
  const refused = tooMany(ctx);
  if (refused) return refused;
  const { data, error } = await ctx.supabase
    .from("prospects")
    .select("id, name, next_action, next_action_due")
    .eq("id", args.prospectId)
    .maybeSingle();
  if (error) return { ok: false, error: "Could not look that prospect up just now." };
  if (!data) return { ok: false, error: "No prospect with that id was found." };
  const row = data as { name: string; next_action: string | null; next_action_due: string | null };
  const payload: SetNextActionPayload = {
    prospect_id: args.prospectId,
    subject_name: String(row.name).slice(0, MAX_SUBJECT_NAME_CHARS),
    next_action: args.nextAction,
    next_action_due: args.nextActionDue,
    previous: { next_action: previousForCompare(row.next_action), next_action_due: row.next_action_due ?? null },
  };
  return insertProposal(ctx, "set_prospect_next_action", "prospects", args.prospectId, payload);
}
