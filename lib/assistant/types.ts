// Server-side types for the assistant (STATE item 87, ruling 0037).
//
// Everything here is plain data. Nothing imports a client, a key or a write
// path: this file is safe to import from any assistant module and, because it
// is types only, from nothing that ships to the browser.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Strategy, OrganizationIntel } from "@/lib/strategy";
import type { InteractionKind } from "@/lib/interactions";

// Every ability is one of these, and the kind is DATA on the registry entry,
// asserted exactly by scripts/test-assistant.ts -- never inferred from a name.
//
//   read             looks something up (ruling 0037 clause 2)
//   act_on_approval  writes a PENDING PROPOSAL; only the user's click on the
//                    rendered proposal executes it (ruling 0037 clause 2,
//                    unchanged by ruling 0038: it is how the model's OWN
//                    suggestions work)
//   command          executes at once, as the signed-in user, on the user's
//                    own words in the current turn, through the single choke
//                    point lib/assistant/command.ts (ruling 0038 clause 2)
//   gate             a command that is one of the platform's decision gates:
//                    additionally decided only on a version shown in an
//                    EARLIER turn, pinned by content fingerprint (ruling 0038
//                    clause 3)
//
// `prepare` (starting a research or strategy run) is still not on the list.
export type AbilityKind = "read" | "act_on_approval" | "command" | "gate";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// What the client renders. Built by CODE from a tool's result (ruling 0037
// clause 3): the model's sentence never supplies a figure, a name or a date
// that appears in a card.
export type CardRow = { title: string; detail?: string; meta?: string; href?: string };

// A proposed strategy, rendered IN FULL (ruling 0038 clause 3: a gate is
// decided on what was shown, so what is pinned must be what is displayed --
// no field of a fingerprinted object is ever truncated on a card). The
// fingerprint rides in the card data; the card is persisted with its message,
// and the choke point reads it back from there to prove "shown earlier".
export type StrategyReviewCard = {
  kind: "strategy_review";
  ability: string;
  title: string;
  prospectId: string;
  prospectName: string;
  hasRun: boolean;
  runId: string | null;
  status: string | null;
  statusLabel: string;
  approved: boolean;
  fingerprint: string | null;
  strategy: { outreach_approach: string; ask_positioning: string; rationale: string; key_talking_points: string[]; evidence_to_highlight: string[] } | null;
  organizationIntel: { location: string; funder_type: string; geographic_focus: string; typical_grant_size: string; focus_areas: string[] } | null;
  note?: string;
  href: string;
};

export type DraftReviewItem = {
  draftId: string;
  kind: string;
  kindLabel: string;
  status: string;
  sent: boolean;
  subject: string | null;
  content: string;
  fingerprint: string;
};

export type DraftReviewCard = {
  kind: "draft_review";
  ability: string;
  title: string;
  prospectId: string;
  prospectName: string;
  drafts: DraftReviewItem[];
  total: number;
  note?: string;
  href: string;
};

// What a command did, written by code from the validated payload and the
// entry point's own return -- never from the model's sentence.
export type CommandResultCard = {
  kind: "command_result";
  ability: string;
  commandId: string;
  title: string;
  summary: string;
  // The user's own words that authorized it, verbatim.
  quote: string;
  fields: { label: string; value: string }[];
  // For a write that replaced something: what it replaced, as it was.
  replaced?: { label: string; value: string }[];
  // True when a click-driven Restore is offered (draft text only).
  restorable: boolean;
  href?: string;
  note?: string;
};

// Plainly: what was NOT done, and why.
export type RefusalCard = {
  kind: "refusal";
  ability: string;
  title: string;
  reason: string;
  quote?: string;
  href?: string;
};

export type Card =
  | { kind: "facts"; ability: string; title: string; items: { label: string; value: string }[]; note?: string; href?: string }
  | { kind: "rows"; ability: string; title: string; rows: CardRow[]; total: number; emptyText: string; note?: string }
  | StrategyReviewCard
  | DraftReviewCard
  | CommandResultCard
  | RefusalCard
  // A line written by the platform, not the model: why a turn stopped early.
  | { kind: "notice"; text: string };

export type ProposalStatus = "pending" | "executed" | "failed" | "dismissed" | "expired";

// A proposal as the client sees it. `fields` is the stored payload rendered
// to labelled lines by code -- exactly what approval will execute.
export type ProposalView = {
  id: string;
  messageId: string;
  actionKey: string;
  summary: string;
  fields: { label: string; value: string }[];
  status: ProposalStatus;
  expiresAt: string;
  decidedAt: string | null;
  errorNote: string | null;
  subjectHref: string | null;
};

// The existing entry points a command may call -- the same functions a person
// using the page would use, each reading the signed-in user from the session
// itself. Wired in command-entrypoints.ts (the only file that imports them)
// and injected, so the choke point and every spec are testable offline and
// the server actions are loaded only when a command actually executes.
export type CommandEntryPoints = {
  // createProspect redirect()s on success and returns no id (it throws a
  // NEXT_REDIRECT carrying the new prospect's path): the choke point handles
  // that structurally.
  createProspect: (formData: FormData) => Promise<unknown>;
  updateDraft: (draftId: string, prospectId: string, subject: string | null, content: string) => Promise<{ ok: true } | { error: string }>;
  reviseDraftWithFeedback: (draftId: string, feedback: string) => Promise<{ ok: true; content: string } | { error: string }>;
  reviseStrategyWithFeedback: (runId: string, feedback: string) => Promise<{ ok: true; runId: string } | { error: string }>;
  generateDraft: (prospectId: string, strategyRunId: string, kind: "intro_email" | "call_prep") => Promise<unknown>;
  unapproveDraft: (draftId: string, prospectId: string) => Promise<{ ok: true } | { error: string }>;
  approveDraft: (draftId: string, prospectId: string) => Promise<unknown>;
  approveStrategy: (
    runId: string,
    prospectId: string,
    approvedStrategy: Strategy,
    approvedIntel: OrganizationIntel
  ) => Promise<unknown>;
  logInteraction: (prospectId: string, kind: InteractionKind, summary: string, occurredAt: string) => Promise<unknown>;
  updateNextAction: (prospectId: string, nextAction: string, nextActionDue: string) => Promise<unknown>;
  logSupporterInteraction: (supporterId: string, kind: InteractionKind, summary: string, occurredAt: string) => Promise<unknown>;
  updateAskAmount: (prospectId: string, askAmount: number | null) => Promise<unknown>;
};

export type ToolContext = {
  // The signed-in user's own session client. Never the service-role client
  // (ruling 0037 clause 1).
  supabase: SupabaseClient;
  userId: string;
  threadId: string;
  // The assistant message row this turn was born under; proposals point at it.
  messageId: string;
  now: Date;
  // Proposals written so far this turn, so a looping model cannot flood the
  // user with them (enforced in proposals.ts, not in the prompt).
  proposalsCreated: number;

  // --- Command mode (ruling 0038). Everything below is held by the turn
  // handler and the loop; none of it is ever taken from the model. ----------
  // The user's latest message of THIS turn, exactly as stored. The quotation
  // check runs against this and nothing else.
  userMessage: string;
  // The user message's row id and the stamp it was recorded with. A gate's
  // "shown in an earlier turn" is decided against these.
  userMessageId: string;
  userMessageAt: string;
  // Commands that reached execution this turn (enforced in command.ts).
  commandsRun: number;
  // Milliseconds left in this turn's own deadline. Set by the loop; a long
  // ability refuses before it starts if this is less than it may need.
  remainingMs: () => number;
  // Resolves the entry points on first need.
  loadEntryPoints: () => Promise<CommandEntryPoints>;
};

export type AbilityOutcome =
  | { ok: true; modelResult: Record<string, unknown>; card?: Card; cards?: Card[]; proposal?: ProposalView }
  | { ok: false; error: string };

export type JsonSchemaObject = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

export type Ability<A = unknown> = {
  // The model-facing tool name.
  name: string;
  // Data on the entry, never inferred from the name (ruling 0037 clause 2).
  kind: AbilityKind;
  description: string;
  parameters: JsonSchemaObject;
  // Every key that may appear ANYWHERE in this ability's result to the model
  // (ruling 0037 clause 5). Enforced at runtime by the dispatcher, which
  // strips anything else, as well as asserted in tests.
  allowlist: readonly string[];
  validate: (raw: Record<string, unknown>) => Result<A>;
  handler: (args: A, ctx: ToolContext) => Promise<AbilityOutcome>;
};

// What an execution reports back to the approve path. Defined here, not in
// executors.ts, so that nothing but the approve action has to import that file
// -- not even for a type.
export type ExecutionResult = { ok: true; result: { entryPoint: string } } | { ok: false; error: string };
