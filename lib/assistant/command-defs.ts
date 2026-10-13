// The metadata and argument validators of the assistant's COMMAND and GATE
// abilities (STATE item 92, ruling 0038).
//
// This file is pure: it names an ability, describes it to the model, says
// what arguments it takes and validates them. It imports no entry point, no
// database and no server action, and it performs nothing. What an ability DOES
// lives in command-exec.ts, which only command.ts -- the single choke point --
// imports; abilities.ts builds its registry entries from these definitions and
// its handler can do exactly one thing: hand the call to runCommand.
//
// Two properties of every definition here are asserted by
// scripts/test-assistant.ts, not left to a reader:
//
//   * every command and gate takes a REQUIRED `authorizing_quote`, and every
//     gate additionally takes its subject id and the `fingerprint` the
//     displayed card carried;
//   * nothing is named or described with sending, stage movement, deletion,
//     gifts or contact-detail semantics. (The wording below is chosen to
//     satisfy that regex honestly; it is not a place to relax the regex.)

import type { InteractionKind } from "@/lib/interactions";
import { INTERACTION_KINDS } from "@/lib/interactions";
import { CHANNELS } from "@/lib/prospects";
import { MAX_STRATEGY_FEEDBACK_CHARS } from "@/lib/strategy";
import type { JsonSchemaObject, Result } from "./types";
import { FINGERPRINT_RE } from "./fingerprint";
import {
  EARLIEST_DATE,
  LATEST_DUE_DATE,
  MAX_INTERACTION_SUMMARY_CHARS,
  MAX_NEXT_ACTION_CHARS,
  tomorrowIso,
} from "./proposals";
import {
  asBoundedString,
  asEnum,
  asIsoDate,
  asOptionalBoundedString,
  asOptionalIsoDate,
  asUuid,
  rejectUnknownKeys,
} from "./validate";

// --- Named bounds -------------------------------------------------------------

export const MAX_QUOTE_CHARS = 500;
export const MAX_PROSPECT_NAME_CHARS = 120;
export const MAX_ORGANIZATION_CHARS = 120;
export const MAX_WEBSITE_CHARS = 200;
export const MAX_LOCATION_CHARS = 120;
export const MAX_PROSPECT_NOTES_CHARS = 1000;
export const MAX_SUBJECT_LINE_CHARS = 200;
export const MAX_DRAFT_TEXT_CHARS = 12000;
export const MAX_ASK_AMOUNT = 1_000_000_000;
export const MAX_FEEDBACK_CHARS = MAX_STRATEGY_FEEDBACK_CHARS;

// How long each LONG ability may take once started: the model call's own
// timeout plus the reads and writes around it. The choke point refuses to
// START one if the turn's remaining time is less than this plus a margin
// (command.ts), so a long ability can never be begun in a turn that cannot
// finish it. Named here, beside the ability, so the figure and the thing it
// bounds are read together; scripts/test-assistant.ts asserts the worst case
// against the route's maxDuration.
export const REVISE_DRAFT_MAX_MS = 110_000; // reviseDraftWithFeedback: 100 s model timeout
export const PUSH_BACK_MAX_MS = 75_000; // reviseStrategyWithFeedback: 60 s model timeout
export const GENERATE_DRAFT_MAX_MS = 120_000; // generateDraft: the Anthropic client's 110 s timeout

export const OUTREACH_DRAFT_KINDS = ["intro_email", "call_prep"] as const;
export type OutreachKind = (typeof OUTREACH_DRAFT_KINDS)[number];

const CHANNEL_VALUES = CHANNELS.map((c) => c.value) as readonly string[];
const INTERACTION_VALUES = INTERACTION_KINDS.map((k) => k.value) as readonly InteractionKind[];

// --- Argument types -----------------------------------------------------------

type WithQuote<T> = T & { authorizing_quote: string };

export type AddProspectArgs = WithQuote<{
  name: string;
  channel: string;
  organization: string | null;
  website: string | null;
  location: string | null;
  notes: string | null;
}>;
export type EditDraftArgs = WithQuote<{ draftId: string; subject: string | null; content: string }>;
export type ReviseDraftArgs = WithQuote<{ draftId: string; feedback: string }>;
export type PushBackArgs = WithQuote<{ runId: string; feedback: string }>;
export type GenerateDraftArgs = WithQuote<{ prospectId: string; kind: OutreachKind }>;
export type ReopenDraftArgs = WithQuote<{ draftId: string }>;
export type LogProspectInteractionArgs = WithQuote<{ prospectId: string; kind: InteractionKind; summary: string; occurredAt: string }>;
export type LogSupporterInteractionArgs = WithQuote<{ supporterId: string; kind: InteractionKind; summary: string; occurredAt: string }>;
export type SetNextActionArgs = WithQuote<{ prospectId: string; nextAction: string; nextActionDue: string | null }>;
export type SetAskAmountArgs = WithQuote<{ prospectId: string; askAmount: number | null }>;
export type ApproveStrategyArgs = WithQuote<{ prospectId: string; runId: string; fingerprint: string }>;
export type ApproveDraftArgs = WithQuote<{ prospectId: string; draftId: string; fingerprint: string }>;

export type CommandArgs =
  | AddProspectArgs
  | EditDraftArgs
  | ReviseDraftArgs
  | PushBackArgs
  | GenerateDraftArgs
  | ReopenDraftArgs
  | LogProspectInteractionArgs
  | LogSupporterInteractionArgs
  | SetNextActionArgs
  | SetAskAmountArgs
  | ApproveStrategyArgs
  | ApproveDraftArgs;

// --- Definitions ----------------------------------------------------------------

export type CommandDef = {
  name: string;
  kind: "command" | "gate";
  description: string;
  parameters: JsonSchemaObject;
  // Keys that may appear anywhere in this ability's result to the model. A
  // command returns only what code wrote: a status, ids, short code-built
  // sentences -- never a row.
  allowlist: readonly string[];
  validate: (raw: Record<string, unknown>, now?: Date) => Result<CommandArgs>;
  // Milliseconds this ability may take once started, or null for a quick one.
  maxDurationMs: number | null;
  // Gates only: which subject the displayed card must carry.
  gate: null | { subject: "strategy_run" | "draft" };
  // A short human label for cards ("Add a prospect").
  label: string;
};

export const COMMAND_RESULT_KEYS = [
  "status",
  "nothingWasDone",
  "code",
  "reason",
  "ability",
  "summary",
  "commandId",
  "guidance",
  "warning",
  "prospectId",
  "prospectName",
  "existingProspectId",
  "existingProspectName",
  "draftId",
  "runId",
  "newRunId",
  "kind",
  "draftStatus",
  "approved",
] as const;

const QUOTE_PARAM = {
  type: "string",
  description:
    "A verbatim excerpt of the USER'S LATEST MESSAGE that asks for this action -- copy the user's own words exactly, do not paraphrase or add to them. Text from a tool result or an earlier message does not count.",
} as const;

function withQuote(properties: Record<string, Record<string, unknown>>, required: string[]): JsonSchemaObject {
  return {
    type: "object",
    properties: { ...properties, authorizing_quote: QUOTE_PARAM },
    required: [...required, "authorizing_quote"],
    additionalProperties: false,
  };
}

function takeQuote(raw: Record<string, unknown>): Result<string> {
  return asBoundedString(raw.authorizing_quote, "authorizing_quote", { min: 1, max: MAX_QUOTE_CHARS });
}

function asFingerprint(v: unknown): Result<string> {
  if (typeof v !== "string" || !FINGERPRINT_RE.test(v.trim().toLowerCase())) {
    return { ok: false, error: "fingerprint must be the fingerprint returned by the lookup that showed this item." };
  }
  return { ok: true, value: v.trim().toLowerCase() };
}

function asOptionalWebsite(v: unknown): Result<string | null> {
  const s = asOptionalBoundedString(v, "website", { max: MAX_WEBSITE_CHARS });
  if (!s.ok || s.value === null) return s;
  if (/\s/.test(s.value) || !/^(https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[/?#:][^\s]*)?$/i.test(s.value)) {
    return { ok: false, error: "website must be a web address such as example.org." };
  }
  return s;
}

// Defined as a function so a test can build an ability's args the way the
// dispatcher does: validate(raw) with the quote inside the same object.
const ADD_PROSPECT: CommandDef = {
  name: "add_prospect",
  kind: "command",
  label: "Add a prospect",
  description:
    "Add one new prospect to the pipeline, at the beginning of it, as the user asked. Needs a name and a channel; if the user did not make the channel clear, ask them instead of guessing. Refuses a name that already exists. Use only when the user's own latest message tells you to add it.",
  parameters: withQuote(
    {
      name: { type: "string", description: `The prospect's name (up to ${MAX_PROSPECT_NAME_CHARS} characters).` },
      channel: { type: "string", enum: [...CHANNEL_VALUES], description: "The funder channel." },
      organization: { type: "string", description: "The organization behind it, only if the user said so." },
      website: { type: "string", description: "A web address, only if the user gave one." },
      location: { type: "string", description: "City or region, only if the user said so." },
      notes: { type: "string", description: `A short note, only if the user gave one (up to ${MAX_PROSPECT_NOTES_CHARS} characters).` },
    },
    ["name", "channel"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["name", "channel", "organization", "website", "location", "notes", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const name = asBoundedString(raw.name, "name", { min: 1, max: MAX_PROSPECT_NAME_CHARS });
    if (!name.ok) return name;
    const channel = asEnum(raw.channel, "channel", CHANNEL_VALUES);
    if (!channel.ok) return channel;
    const organization = asOptionalBoundedString(raw.organization, "organization", { max: MAX_ORGANIZATION_CHARS });
    if (!organization.ok) return organization;
    const website = asOptionalWebsite(raw.website);
    if (!website.ok) return website;
    const location = asOptionalBoundedString(raw.location, "location", { max: MAX_LOCATION_CHARS });
    if (!location.ok) return location;
    const notes = asOptionalBoundedString(raw.notes, "notes", { max: MAX_PROSPECT_NOTES_CHARS });
    if (!notes.ok) return notes;
    return {
      ok: true,
      value: {
        authorizing_quote: quote.value,
        name: name.value,
        channel: channel.value,
        organization: organization.value,
        website: website.value,
        location: location.value,
        notes: notes.value,
      },
    };
  },
};

const EDIT_DRAFT: CommandDef = {
  name: "edit_draft",
  kind: "command",
  label: "Edit a draft",
  description:
    "Replace the text (and, for an introductory note, the subject line) of ONE outreach draft that is still a draft, exactly as the user asked. Give the COMPLETE new text, not a fragment. The previous text is kept so the user can restore it. Proposals and decks are changed with revise_draft_with_feedback instead.",
  parameters: withQuote(
    {
      draft_id: { type: "string", description: "The draft's id, as returned by get_drafts." },
      subject: { type: "string", description: "The new subject line. Omit to leave the subject as it is." },
      content: { type: "string", description: `The complete new text (up to ${MAX_DRAFT_TEXT_CHARS} characters).` },
    },
    ["draft_id", "content"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["draft_id", "subject", "content", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw.draft_id, "draft_id");
    if (!id.ok) return id;
    const subject = asOptionalBoundedString(raw.subject, "subject", { max: MAX_SUBJECT_LINE_CHARS });
    if (!subject.ok) return subject;
    const content = asBoundedString(raw.content, "content", { min: 1, max: MAX_DRAFT_TEXT_CHARS });
    if (!content.ok) return content;
    return { ok: true, value: { authorizing_quote: quote.value, draftId: id.value, subject: subject.value, content: content.value } };
  },
};

const REVISE_DRAFT: CommandDef = {
  name: "revise_draft_with_feedback",
  kind: "command",
  label: "Revise a draft with feedback",
  description:
    "Have the platform's own drafting step rewrite ONE grant proposal or deck outline that is still a draft so that it addresses the user's feedback. Pass the user's feedback in their words. This takes up to a couple of minutes; ask for it on its own. The previous text is kept so the user can restore it.",
  parameters: withQuote(
    {
      draft_id: { type: "string", description: "The draft's id, as returned by get_drafts." },
      feedback: { type: "string", description: `What the user wants changed, in their words (up to ${MAX_FEEDBACK_CHARS} characters).` },
    },
    ["draft_id", "feedback"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: REVISE_DRAFT_MAX_MS,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["draft_id", "feedback", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw.draft_id, "draft_id");
    if (!id.ok) return id;
    const feedback = asBoundedString(raw.feedback, "feedback", { min: 1, max: MAX_FEEDBACK_CHARS });
    if (!feedback.ok) return feedback;
    return { ok: true, value: { authorizing_quote: quote.value, draftId: id.value, feedback: feedback.value } };
  },
};

const PUSH_BACK: CommandDef = {
  name: "push_back_on_strategy",
  kind: "command",
  label: "Push back on a strategy",
  description:
    "Have the platform revise the strategy that is waiting for review so that it addresses the user's feedback. The result is a NEW strategy that is waiting for review; the earlier one is kept. Pass the user's feedback in their words. This takes up to a couple of minutes; ask for it on its own.",
  parameters: withQuote(
    {
      run_id: { type: "string", description: "The strategy's run id, as returned by get_strategy_for_review." },
      feedback: { type: "string", description: `What the user wants changed, in their words (up to ${MAX_FEEDBACK_CHARS} characters).` },
    },
    ["run_id", "feedback"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: PUSH_BACK_MAX_MS,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["run_id", "feedback", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw.run_id, "run_id");
    if (!id.ok) return id;
    const feedback = asBoundedString(raw.feedback, "feedback", { min: 1, max: MAX_FEEDBACK_CHARS });
    if (!feedback.ok) return feedback;
    return { ok: true, value: { authorizing_quote: quote.value, runId: id.value, feedback: feedback.value } };
  },
};

const GENERATE_DRAFT: CommandDef = {
  name: "generate_outreach_draft",
  kind: "command",
  label: "Draft outreach",
  description:
    "Have the platform's drafting step write ONE outreach draft (an introductory note or call-prep notes) for a prospect from the strategy that was decided on (it needs one already decided on). The new draft is for the user to review. This takes up to a couple of minutes; ask for it on its own.",
  parameters: withQuote(
    {
      prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." },
      kind: { type: "string", enum: [...OUTREACH_DRAFT_KINDS], description: "intro_email for an introductory note, call_prep for call-prep notes." },
    },
    ["prospect_id", "kind"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: GENERATE_DRAFT_MAX_MS,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["prospect_id", "kind", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw.prospect_id, "prospect_id");
    if (!id.ok) return id;
    const kind = asEnum(raw.kind, "kind", OUTREACH_DRAFT_KINDS);
    if (!kind.ok) return kind;
    return { ok: true, value: { authorizing_quote: quote.value, prospectId: id.value, kind: kind.value } };
  },
};

const UNAPPROVE_DRAFT: CommandDef = {
  name: "unapprove_draft",
  kind: "command",
  label: "Reopen a draft for editing",
  description:
    "Put ONE approved draft back to being a draft so it can be edited again. It does not change the text. A draft that has been delivered, or has a delivery on record, cannot be reopened.",
  parameters: withQuote({ draft_id: { type: "string", description: "The draft's id, as returned by get_drafts." } }, ["draft_id"]),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["draft_id", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw.draft_id, "draft_id");
    if (!id.ok) return id;
    return { ok: true, value: { authorizing_quote: quote.value, draftId: id.value } };
  },
};

function interactionValidator(idField: "prospect_id" | "supporter_id") {
  return (raw: Record<string, unknown>, now: Date = new Date()): Result<LogProspectInteractionArgs | LogSupporterInteractionArgs> => {
    const unknown = rejectUnknownKeys(raw, [idField, "kind", "summary", "occurred_at", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw[idField], idField);
    if (!id.ok) return id;
    const kind = asEnum(raw.kind, "kind", INTERACTION_VALUES);
    if (!kind.ok) return kind;
    const summary = asBoundedString(raw.summary, "summary", { min: 1, max: MAX_INTERACTION_SUMMARY_CHARS });
    if (!summary.ok) return summary;
    const date = asIsoDate(raw.occurred_at, "occurred_at", { min: EARLIEST_DATE, max: tomorrowIso(now) });
    if (!date.ok) return date;
    if (idField === "prospect_id") {
      return { ok: true, value: { authorizing_quote: quote.value, prospectId: id.value, kind: kind.value, summary: summary.value, occurredAt: date.value } };
    }
    return { ok: true, value: { authorizing_quote: quote.value, supporterId: id.value, kind: kind.value, summary: summary.value, occurredAt: date.value } };
  };
}

const LOG_PROSPECT_INTERACTION: CommandDef = {
  name: "log_prospect_interaction",
  kind: "command",
  label: "Log an interaction",
  description:
    "Record an email, call, meeting or note that the user tells you happened with a prospect. Use only for something the user told you, in their words; do not invent what happened.",
  parameters: withQuote(
    {
      prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." },
      kind: { type: "string", enum: INTERACTION_VALUES.slice() },
      summary: { type: "string", description: `What happened, in the user's words (up to ${MAX_INTERACTION_SUMMARY_CHARS} characters).` },
      occurred_at: { type: "string", description: "The date it happened, YYYY-MM-DD." },
    },
    ["prospect_id", "kind", "summary", "occurred_at"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: null,
  validate: (raw, now) => interactionValidator("prospect_id")(raw, now),
};

const LOG_SUPPORTER_INTERACTION: CommandDef = {
  name: "log_supporter_interaction",
  kind: "command",
  label: "Log a supporter interaction",
  description:
    "Record an email, call, meeting or note that the user tells you happened with an individual supporter. Use only for something the user told you, in their words; do not invent what happened.",
  parameters: withQuote(
    {
      supporter_id: { type: "string", description: "The supporter's id, as returned by list_supporters_needing_stewardship." },
      kind: { type: "string", enum: INTERACTION_VALUES.slice() },
      summary: { type: "string", description: `What happened, in the user's words (up to ${MAX_INTERACTION_SUMMARY_CHARS} characters).` },
      occurred_at: { type: "string", description: "The date it happened, YYYY-MM-DD." },
    },
    ["supporter_id", "kind", "summary", "occurred_at"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: null,
  validate: (raw, now) => interactionValidator("supporter_id")(raw, now),
};

const SET_NEXT_ACTION: CommandDef = {
  name: "set_prospect_next_action",
  kind: "command",
  label: "Set a next action",
  description: "Set the next action, and optionally its due date, on ONE prospect, exactly as the user asked. The previous value is shown afterwards.",
  parameters: withQuote(
    {
      prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." },
      next_action: { type: "string", description: `The next action in plain words (up to ${MAX_NEXT_ACTION_CHARS} characters).` },
      next_action_due: { type: "string", description: "Due date, YYYY-MM-DD. Omit for no due date." },
    },
    ["prospect_id", "next_action"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["prospect_id", "next_action", "next_action_due", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw.prospect_id, "prospect_id");
    if (!id.ok) return id;
    const action = asBoundedString(raw.next_action, "next_action", { min: 1, max: MAX_NEXT_ACTION_CHARS });
    if (!action.ok) return action;
    const due = asOptionalIsoDate(raw.next_action_due, "next_action_due", { min: EARLIEST_DATE, max: LATEST_DUE_DATE });
    if (!due.ok) return due;
    return { ok: true, value: { authorizing_quote: quote.value, prospectId: id.value, nextAction: action.value, nextActionDue: due.value } };
  },
};

const SET_ASK_AMOUNT: CommandDef = {
  name: "set_prospect_ask_amount",
  kind: "command",
  label: "Set an ask amount",
  description:
    "Set the ask amount on ONE prospect to the figure the user gave, or clear it. The amount is a plain number of dollars. The previous value is shown afterwards.",
  parameters: withQuote(
    {
      prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." },
      ask_amount: { type: "number", description: "The amount in dollars. Omit when clearing the ask." },
      clear_ask_amount: { type: "boolean", description: "true to clear the ask amount instead of setting one." },
    },
    ["prospect_id"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: null,
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["prospect_id", "ask_amount", "clear_ask_amount", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const id = asUuid(raw.prospect_id, "prospect_id");
    if (!id.ok) return id;
    const clear = raw.clear_ask_amount;
    if (clear !== undefined && typeof clear !== "boolean") return { ok: false, error: "clear_ask_amount must be true or false." };
    let amount: number | null;
    if (clear === true) {
      if (raw.ask_amount !== undefined && raw.ask_amount !== null) return { ok: false, error: "Give either ask_amount or clear_ask_amount, not both." };
      amount = null;
    } else if (typeof raw.ask_amount === "number" && Number.isFinite(raw.ask_amount)) {
      if (raw.ask_amount < 0 || raw.ask_amount > MAX_ASK_AMOUNT) {
        return { ok: false, error: `ask_amount must be between 0 and ${MAX_ASK_AMOUNT}.` };
      }
      amount = Math.round(raw.ask_amount * 100) / 100;
    } else {
      return { ok: false, error: "ask_amount must be a number (or set clear_ask_amount to true to clear it)." };
    }
    return { ok: true, value: { authorizing_quote: quote.value, prospectId: id.value, askAmount: amount } };
  },
};

const APPROVE_STRATEGY: CommandDef = {
  name: "approve_strategy",
  kind: "gate",
  label: "Approve a strategy",
  description:
    "Approve the strategy exactly as it was shown to the user, when the user says to. It works only on a strategy the user was shown in an EARLIER message of this conversation (call get_strategy_for_review first and pass its runId and fingerprint), and only if the user's latest message says to approve it. Approving a strategy only records the decision; it does not reach out to anyone.",
  parameters: withQuote(
    {
      prospect_id: { type: "string", description: "The prospect's id." },
      run_id: { type: "string", description: "The strategy's runId, as returned by get_strategy_for_review." },
      fingerprint: { type: "string", description: "The fingerprint returned by get_strategy_for_review for that strategy." },
    },
    ["prospect_id", "run_id", "fingerprint"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: { subject: "strategy_run" },
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["prospect_id", "run_id", "fingerprint", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const prospect = asUuid(raw.prospect_id, "prospect_id");
    if (!prospect.ok) return prospect;
    const run = asUuid(raw.run_id, "run_id");
    if (!run.ok) return run;
    const fp = asFingerprint(raw.fingerprint);
    if (!fp.ok) return fp;
    return { ok: true, value: { authorizing_quote: quote.value, prospectId: prospect.value, runId: run.value, fingerprint: fp.value } };
  },
};

const APPROVE_DRAFT: CommandDef = {
  name: "approve_draft",
  kind: "gate",
  label: "Approve a draft",
  description:
    "Approve ONE draft exactly as it was shown to the user, when the user says to. It works only on a draft the user was shown in an EARLIER message of this conversation (call get_drafts first and pass its draftId and fingerprint), and only if the user's latest message says to approve it. Approving a draft only marks it approved; it does not deliver it to anyone.",
  parameters: withQuote(
    {
      prospect_id: { type: "string", description: "The prospect's id." },
      draft_id: { type: "string", description: "The draft's draftId, as returned by get_drafts." },
      fingerprint: { type: "string", description: "The fingerprint returned by get_drafts for that draft." },
    },
    ["prospect_id", "draft_id", "fingerprint"]
  ),
  allowlist: COMMAND_RESULT_KEYS,
  maxDurationMs: null,
  gate: { subject: "draft" },
  validate: (raw) => {
    const unknown = rejectUnknownKeys(raw, ["prospect_id", "draft_id", "fingerprint", "authorizing_quote"]);
    if (unknown) return { ok: false, error: unknown };
    const quote = takeQuote(raw);
    if (!quote.ok) return quote;
    const prospect = asUuid(raw.prospect_id, "prospect_id");
    if (!prospect.ok) return prospect;
    const draft = asUuid(raw.draft_id, "draft_id");
    if (!draft.ok) return draft;
    const fp = asFingerprint(raw.fingerprint);
    if (!fp.ok) return fp;
    return { ok: true, value: { authorizing_quote: quote.value, prospectId: prospect.value, draftId: draft.value, fingerprint: fp.value } };
  },
};

export const COMMAND_DEFS: readonly CommandDef[] = [
  ADD_PROSPECT,
  EDIT_DRAFT,
  REVISE_DRAFT,
  PUSH_BACK,
  GENERATE_DRAFT,
  UNAPPROVE_DRAFT,
  LOG_PROSPECT_INTERACTION,
  SET_NEXT_ACTION,
  LOG_SUPPORTER_INTERACTION,
  SET_ASK_AMOUNT,
  APPROVE_STRATEGY,
  APPROVE_DRAFT,
];

export const COMMAND_DEF_BY_NAME = new Map<string, CommandDef>(COMMAND_DEFS.map((d) => [d.name, d]));

// The one name the click-driven restore records itself under. It is NOT an
// ability -- the model cannot call it -- but it is in the database's closed
// list of recorded actions.
export const RESTORE_ACTION_NAME = "restore_draft_text";
