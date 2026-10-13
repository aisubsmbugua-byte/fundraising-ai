// Server-side types for the assistant (STATE item 87, ruling 0037).
//
// Everything here is plain data. Nothing imports a client, a key or a write
// path: this file is safe to import from any assistant module and, because it
// is types only, from nothing that ships to the browser.

import type { SupabaseClient } from "@supabase/supabase-js";

// Ruling 0037 clause 2: every ability is one of these. `prepare` (starting a
// research or strategy run) is the third kind the ruling names; it is not on
// today's list -- see abilities.ts -- so it is not representable here, and
// adding it is a visible change to this union as well as to the registry.
export type AbilityKind = "read" | "act_on_approval";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// What the client renders. Built by CODE from a tool's result (ruling 0037
// clause 3): the model's sentence never supplies a figure, a name or a date
// that appears in a card.
export type CardRow = { title: string; detail?: string; meta?: string; href?: string };
export type Card =
  | { kind: "facts"; ability: string; title: string; items: { label: string; value: string }[]; note?: string; href?: string }
  | { kind: "rows"; ability: string; title: string; rows: CardRow[]; total: number; emptyText: string; note?: string }
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
};

export type AbilityOutcome =
  | { ok: true; modelResult: Record<string, unknown>; card?: Card; proposal?: ProposalView }
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
