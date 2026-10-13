// The assistant's closed ability registry (STATE item 87 + 92, rulings 0037
// and 0038).
//
// This list is the whole of what the model can do. It is written in code, it
// is asserted EXACTLY by scripts/test-assistant.ts (names and kinds), and
// adding an entry is therefore a visible, reviewed change to this file --
// not something a prompt or a model can bring about.
//
//   read              looks something up; returns an allowlisted projection
//   act_on_approval   writes a PENDING PROPOSAL and nothing else; the change
//                     happens only if the user confirms the rendered
//                     proposal, in code the model cannot call. This is how the
//                     model's OWN suggestions work (ruling 0038 keeps it).
//   command           executes at once, as the signed-in user, on the user's
//                     own words in this turn -- and ONLY through runCommand
//                     (command.ts), which verifies the quotation, the per-turn
//                     cap, the guards and the audit record. A handler here
//                     can do exactly one thing: call runCommand.
//   gate              a command that is one of the platform's decision gates
//                     (approve a strategy, approve a draft): additionally
//                     decided only on a version shown in an EARLIER turn,
//                     pinned by content fingerprint.
//
// There is no `prepare` entry: nothing here starts a research run or a
// strategy run.
//
// Deliberately absent, by name and by semantics (ruling 0038 clause 4):
// sending anything to a funder (hard rule 1, rulings 0029 and 0032), moving a
// prospect between stages (hard rule 2), approving or correcting a research
// claim, recording a gift, deleting anything, and changing the recipient of a
// message. None is reachable under any name; the test asserts that no
// ability's name, description or parameter schema speaks of them. Approving a
// draft is on the list because approval is not sending: the send is its own
// confirmed step on its own screen.
//
// This file imports no entry point and no server action. Its command handlers
// import nothing but runCommand.

import type { Ability, AbilityOutcome } from "./types";
import { COMMAND_DEFS, type CommandDef } from "./command-defs";
import { runCommand } from "./command";
import { INTERACTION_KINDS } from "@/lib/interactions";
import { STAGES, CHANNELS } from "@/lib/prospects";
import {
  DASHBOARD_SUMMARY_ALLOWLIST,
  FOLLOWUPS_ALLOWLIST,
  SUPPORTER_STEWARDSHIP_ALLOWLIST,
  SEARCH_PROSPECTS_ALLOWLIST,
  GET_PROSPECT_ALLOWLIST,
  RECENT_ACTIVITY_ALLOWLIST,
  getDashboardSummary,
  listFollowUpsDue,
  listSupportersNeedingStewardship,
  searchProspects,
  getProspect,
  listRecentActivity,
  getStrategyForReview,
  getDrafts,
  STRATEGY_REVIEW_ALLOWLIST,
  DRAFTS_ALLOWLIST,
  validateGetStrategyForReview,
  validateGetDrafts,
  validateNoArgs,
  validateSearchProspects,
  validateGetProspect,
  type SearchProspectsArgs,
  type GetProspectArgs,
  type GetStrategyForReviewArgs,
  type GetDraftsArgs,
  type ReadOutcome,
} from "./reads";
import {
  proposeLogProspectInteraction,
  proposeLogSupporterInteraction,
  proposeSetProspectNextAction,
  validateProposeInteraction,
  validateProposeNextAction,
  PROPOSAL_MODEL_NOTE,
  type ProposeInteractionArgs,
  type ProposeNextActionArgs,
} from "./proposals";

const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as const;

const KIND_ENUM = INTERACTION_KINDS.map((k) => k.value);

function asOutcome(r: ReadOutcome): AbilityOutcome {
  return r.ok ? { ok: true, modelResult: r.modelResult, card: r.card } : { ok: false, error: r.error };
}

const PROPOSAL_RESULT_KEYS = ["proposalId", "status", "summary", "note"] as const;

// A command or gate registry entry. The handler receives the dispatcher's
// validated arguments, but passes the ORIGINAL argument object on: runCommand
// validates it again itself, because it must be safe whoever calls it.
function commandAbility(def: CommandDef): Ability {
  return {
    name: def.name,
    kind: def.kind,
    description: def.description,
    parameters: def.parameters,
    allowlist: def.allowlist,
    validate: (raw) => {
      const v = def.validate(raw);
      // The validated value is not used by the handler; the raw object is,
      // so that the choke point is the one place arguments are interpreted.
      return v.ok ? { ok: true, value: raw } : v;
    },
    handler: async (args, ctx) => runCommand(def.name, args as Record<string, unknown>, ctx),
  };
}

export const ABILITIES: readonly Ability[] = [
  {
    name: "get_dashboard_summary",
    kind: "read",
    description:
      "Counts and totals for the whole organization as of today: opportunities waiting, active prospects, follow-ups due in the next 7 days, strategies awaiting review, supporters count and projected annual supporter giving, and pipeline potential by stage.",
    parameters: NO_PARAMETERS,
    allowlist: DASHBOARD_SUMMARY_ALLOWLIST,
    validate: (raw) => validateNoArgs(raw),
    handler: async (_args, ctx) => asOutcome(await getDashboardSummary(ctx.supabase, ctx.now)),
  } as Ability,
  {
    name: "list_followups_due",
    kind: "read",
    description:
      "Prospects that need attention: next actions due soon or overdue, declined funders whose revisit date has arrived, and prospects that said yes but have gone quiet. Each row has the prospect's id, name, stage and dates.",
    parameters: NO_PARAMETERS,
    allowlist: FOLLOWUPS_ALLOWLIST,
    validate: (raw) => validateNoArgs(raw),
    handler: async (_args, ctx) => asOutcome(await listFollowUpsDue(ctx.supabase, ctx.now)),
  } as Ability,
  {
    name: "list_supporters_needing_stewardship",
    kind: "read",
    description:
      "Individual supporters who have gone longer without a donation or contact than their tier allows, quietest first. Returns each supporter's id, name, tier label and days since last contact. Pledge amounts and contact details are not available.",
    parameters: NO_PARAMETERS,
    allowlist: SUPPORTER_STEWARDSHIP_ALLOWLIST,
    validate: (raw) => validateNoArgs(raw),
    handler: async (_args, ctx) => asOutcome(await listSupportersNeedingStewardship(ctx.supabase, ctx.now)),
  } as Ability,
  {
    name: "search_prospects",
    kind: "read",
    description:
      "Find prospects by part of their name, and optionally by stage or channel. Returns id, name, channel and stage for each match. Use the id with get_prospect for detail.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the prospect's name (up to 80 characters)." },
        stage: { type: "string", enum: STAGES.map((s) => s.value), description: "Limit to one pipeline stage." },
        channel: { type: "string", enum: CHANNELS.map((c) => c.value), description: "Limit to one funder channel." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "How many to return (default 10)." },
      },
      additionalProperties: false,
    },
    allowlist: SEARCH_PROSPECTS_ALLOWLIST,
    validate: (raw) => validateSearchProspects(raw),
    handler: async (args, ctx) => asOutcome(await searchProspects(ctx.supabase, args as SearchProspectsArgs)),
  } as Ability,
  {
    name: "get_prospect",
    kind: "read",
    description:
      "One prospect's id, name, channel, stage, ask amount, next action and due date, health, any recorded decline, and the research claims that have cleared review for use. Contact details and notes are not available.",
    parameters: {
      type: "object",
      properties: { prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." } },
      required: ["prospect_id"],
      additionalProperties: false,
    },
    allowlist: GET_PROSPECT_ALLOWLIST,
    validate: (raw) => validateGetProspect(raw),
    handler: async (args, ctx) => asOutcome(await getProspect(ctx.supabase, args as GetProspectArgs)),
  } as Ability,
  {
    name: "list_recent_activity",
    kind: "read",
    description: "The most recent opportunity searches (channel, status, how many found) and the most recently reviewed opportunities.",
    parameters: NO_PARAMETERS,
    allowlist: RECENT_ACTIVITY_ALLOWLIST,
    validate: (raw) => validateNoArgs(raw),
    handler: async (_args, ctx) => asOutcome(await listRecentActivity(ctx.supabase)),
  } as Ability,
  {
    name: "get_strategy_for_review",
    kind: "read",
    description:
      "A prospect's CURRENT strategy -- the latest one -- in full: whether it is waiting for review or already approved, the proposed approach, ask positioning, rationale, talking points and evidence, the funder facts, and a fingerprint of exactly that content. It is also shown to the user in full on a card. Needed before a strategy can be approved or pushed back on.",
    parameters: {
      type: "object",
      properties: { prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." } },
      required: ["prospect_id"],
      additionalProperties: false,
    },
    allowlist: STRATEGY_REVIEW_ALLOWLIST,
    validate: (raw) => validateGetStrategyForReview(raw),
    handler: async (args, ctx) => asOutcome(await getStrategyForReview(ctx.supabase, args as GetStrategyForReviewArgs)),
  } as Ability,
  {
    name: "get_drafts",
    kind: "read",
    description:
      "A prospect's drafts in full: each draft's id, kind, status, subject and text, whether it has already gone out, and a fingerprint of exactly that text. They are also shown to the user in full on a card. Needed before a draft can be edited, revised or approved. Pass draft_id to look at just one.",
    parameters: {
      type: "object",
      properties: {
        prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." },
        draft_id: { type: "string", description: "Optional: one draft's id, to read only that draft." },
      },
      required: ["prospect_id"],
      additionalProperties: false,
    },
    allowlist: DRAFTS_ALLOWLIST,
    validate: (raw) => validateGetDrafts(raw),
    handler: async (args, ctx) => asOutcome(await getDrafts(ctx.supabase, args as GetDraftsArgs)),
  } as Ability,
  {
    name: "propose_log_prospect_interaction",
    kind: "act_on_approval",
    description:
      "Propose recording an email, call, meeting or note against a prospect. This only creates a proposal that the user reads and must confirm; it does not record anything itself. Use only for something the user told you happened.",
    parameters: {
      type: "object",
      properties: {
        prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." },
        kind: { type: "string", enum: KIND_ENUM },
        summary: { type: "string", description: "What happened, in the user's words (up to 1000 characters)." },
        occurred_at: { type: "string", description: "The date it happened, YYYY-MM-DD." },
      },
      required: ["prospect_id", "kind", "summary", "occurred_at"],
      additionalProperties: false,
    },
    allowlist: PROPOSAL_RESULT_KEYS,
    validate: (raw) => validateProposeInteraction("prospect_id")(raw),
    handler: async (args, ctx) => proposeLogProspectInteraction(args as ProposeInteractionArgs, ctx),
  } as Ability,
  {
    name: "propose_set_prospect_next_action",
    kind: "act_on_approval",
    description:
      "Propose a new next action, and optionally a due date, for a prospect. This only creates a proposal that the user reads and must confirm; the prospect is not changed by this call.",
    parameters: {
      type: "object",
      properties: {
        prospect_id: { type: "string", description: "The prospect's id, as returned by another lookup." },
        next_action: { type: "string", description: "The next action in plain words (up to 200 characters)." },
        next_action_due: { type: "string", description: "Due date, YYYY-MM-DD. Omit for no due date." },
      },
      required: ["prospect_id", "next_action"],
      additionalProperties: false,
    },
    allowlist: PROPOSAL_RESULT_KEYS,
    validate: (raw) => validateProposeNextAction(raw),
    handler: async (args, ctx) => proposeSetProspectNextAction(args as ProposeNextActionArgs, ctx),
  } as Ability,
  {
    name: "propose_log_supporter_interaction",
    kind: "act_on_approval",
    description:
      "Propose recording an email, call, meeting or note against an individual supporter. This only creates a proposal that the user reads and must confirm; it does not record anything itself. Use only for something the user told you happened.",
    parameters: {
      type: "object",
      properties: {
        supporter_id: { type: "string", description: "The supporter's id, as returned by list_supporters_needing_stewardship." },
        kind: { type: "string", enum: KIND_ENUM },
        summary: { type: "string", description: "What happened, in the user's words (up to 1000 characters)." },
        occurred_at: { type: "string", description: "The date it happened, YYYY-MM-DD." },
      },
      required: ["supporter_id", "kind", "summary", "occurred_at"],
      additionalProperties: false,
    },
    allowlist: PROPOSAL_RESULT_KEYS,
    validate: (raw) => validateProposeInteraction("supporter_id")(raw),
    handler: async (args, ctx) => proposeLogSupporterInteraction(args as ProposeInteractionArgs, ctx),
  } as Ability,
  // Commands and gates (ruling 0038). Every one is built by the same function
  // from its definition in command-defs.ts, and its handler is the single
  // statement `runCommand(name, raw, ctx)`.
  ...COMMAND_DEFS.map(commandAbility),
];

export const ABILITY_NAMES = ABILITIES.map((a) => a.name);

const BY_NAME = new Map<string, Ability>(ABILITIES.map((a) => [a.name, a]));

export function findAbility(name: string): Ability | null {
  return BY_NAME.get(name) ?? null;
}

// What the provider is told it may call.
export function toolDefinitions(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return ABILITIES.map((a) => ({ name: a.name, description: a.description, parameters: a.parameters as unknown as Record<string, unknown> }));
}

// Re-exported for the prompt, which tells the model what a proposal result
// means in the same words the tool result carries.
export { PROPOSAL_MODEL_NOTE };
