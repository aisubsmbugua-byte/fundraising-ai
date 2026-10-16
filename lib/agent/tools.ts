// The connector's closed tool registry (STATE item 98, ruling 0039 clause 3).
//
// This list is the whole of what an agent can do. It is written in code, it is
// asserted EXACTLY by scripts/test-agent.ts (names and scopes), and adding an
// entry is a visible, reviewed change to this file.
//
//   READ  (scope read)  looks something up; rendered by code from platform data
//                       through the assistant's own reads and allowlists.
//   ACT   (scope act)   an everyday change the user could have made by hand;
//                       carried out ONLY through runAgentAct (act.ts).
//   request_approval    makes a single-use approval LINK and executes nothing
//                       (approvals.ts). The decision is the owner's click.
//
// Deliberately absent, by name and by meaning (ruling 0039 clause 3): approving
// a strategy or a draft (an agent call decides no gate), delivering anything to
// a funder, moving a prospect between pipeline steps, approving or correcting a
// research claim, deleting, recording a gift, changing who a message goes to.
// A scan asserts that no tool's name, description or schema speaks of them and
// that nothing here imports the approve entry points.
//
// Schemas are deliberately plain (field note): flat objects, string / integer /
// boolean / enum properties, explicit required lists -- no unions, nested object
// arrays or patterns -- and descriptions of one to three sentences. Annotations
// are set honestly, but safety stays server-side: nothing here relies on them.

import { enforceAllowlist } from "@/lib/assistant/dispatch";
import {
  DASHBOARD_SUMMARY_ALLOWLIST,
  DRAFTS_ALLOWLIST,
  FOLLOWUPS_ALLOWLIST,
  GET_PROSPECT_ALLOWLIST,
  RECENT_ACTIVITY_ALLOWLIST,
  SEARCH_PROSPECTS_ALLOWLIST,
  STRATEGY_REVIEW_ALLOWLIST,
  SUPPORTER_STEWARDSHIP_ALLOWLIST,
  MAX_SEARCH_ROWS,
  getDashboardSummary,
  getDrafts,
  getProspect,
  getStrategyForReview,
  listFollowUpsDue,
  listRecentActivity,
  listSupportersNeedingStewardship,
  searchProspects,
  validateGetDrafts,
  validateGetProspect,
  validateGetStrategyForReview,
  validateNoArgs,
  validateSearchProspects,
  type ReadOutcome,
} from "@/lib/assistant/reads";
import type { Result } from "@/lib/assistant/types";
import { CHANNELS, STAGES } from "@/lib/prospects";
import { INTERACTION_KINDS } from "@/lib/interactions";
import { AGENT_ACT_NAMES, agentSchemaFor, type AgentActName } from "./act-args";
import { runAgentAct } from "./act";
import { runRequestApproval, APPROVAL_KINDS } from "./approvals";
import { MAX_AGENT_RESULT_BYTES, MAX_AGENT_STATEMENT_CHARS } from "./limits";
import { buildFundraisingReport, REPORT_ALLOWLIST } from "./report";
import { compactArgs, insertAgentEvent, stopwatch } from "./log";
import type { AgentTool, ToolAnnotations, ToolOutcome, ToolRunContext } from "./types";
import { randomUUID } from "node:crypto";
import type { JsonSchemaObject } from "@/lib/assistant/types";

// Said in every act tool's description and in the initialize instructions.
export const APPROVALS_NOTE = "Approvals are decided by the owner on the platform through a link, never by the agent.";

const NO_PARAMETERS: JsonSchemaObject = { type: "object", properties: {}, required: [], additionalProperties: false };

const READ_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const act = (idempotent: boolean): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });

// --- the read runner -------------------------------------------------------------------

type ReadSpec<A> = {
  name: string;
  allowlist: readonly string[];
  validate: (raw: Record<string, unknown>) => Result<A>;
  exec: (ctx: ToolRunContext, args: A) => Promise<ReadOutcome>;
};

export function sizeError(what: string): ToolOutcome {
  return {
    isError: true,
    text: `That result was too large to return (over ${MAX_AGENT_RESULT_BYTES} bytes), so nothing was returned. Narrow the request -- for example ask about one prospect or one draft -- and try again.${what ? ` (${what})` : ""}`,
  };
}

export function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// One compact terminal row per read, so the per-token call window can count it.
// The row holds the tool, the validated arguments and the size -- never the
// result. If it cannot be written the result is not returned (fail closed).
async function recordRead(
  ctx: ToolRunContext,
  tool: string,
  event: "executed" | "failed" | "refused",
  args: Record<string, unknown>,
  note: string | null,
  bytes: number | null,
  ms: number,
  log: typeof insertAgentEvent
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await log(ctx.supabase, {
    call_id: randomUUID(),
    token_id: ctx.principal.tokenId,
    event,
    origin: "agent",
    access: "read",
    tool,
    arguments: compactArgs(args),
    agent_statement: null,
    subject_table: null,
    subject_id: null,
    previous: null,
    result: event === "executed" ? { bytes } : null,
    error_note: event === "executed" ? null : (note ?? "The lookup did not complete.").slice(0, 1000),
    duration_ms: ms,
    restores_call_id: null,
  });
  return res.ok ? { ok: true } : { ok: false, message: res.message };
}

export type ReadDeps = { log?: typeof insertAgentEvent };

export async function runRead<A>(spec: ReadSpec<A>, ctx: ToolRunContext, rawArgs: Record<string, unknown>, deps: ReadDeps = {}): Promise<ToolOutcome> {
  const log = deps.log ?? insertAgentEvent;
  const elapsed = stopwatch();
  const valid = spec.validate(rawArgs ?? {});
  if (!valid.ok) {
    await recordRead(ctx, spec.name, "refused", rawArgs, valid.error, null, elapsed(), log);
    return { isError: true, text: `${valid.error} Nothing was looked up.` };
  }
  let res: ReadOutcome;
  try {
    res = await spec.exec(ctx, valid.value);
  } catch (err) {
    console.error(`[agent] read ${spec.name} threw:`, err instanceof Error ? err.message : err);
    await recordRead(ctx, spec.name, "failed", rawArgs, "The lookup failed.", null, elapsed(), log);
    return { isError: true, text: "That lookup failed just now. Nothing was changed. Try again shortly." };
  }
  if (!res.ok) {
    await recordRead(ctx, spec.name, "failed", rawArgs, res.error, null, elapsed(), log);
    return { isError: true, text: res.error };
  }
  const dropped: string[] = [];
  const cleaned = enforceAllowlist(res.modelResult, new Set(spec.allowlist), dropped) as Record<string, unknown>;
  if (dropped.length > 0) console.error(`[agent] allowlist stripped keys from ${spec.name}: ${[...new Set(dropped)].join(", ")}`);
  const text = JSON.stringify(cleaned);
  if (bytesOf(text) > MAX_AGENT_RESULT_BYTES) {
    await recordRead(ctx, spec.name, "failed", rawArgs, "The result was over the size limit.", null, elapsed(), log);
    return sizeError(spec.name);
  }
  const recorded = await recordRead(ctx, spec.name, "executed", rawArgs, null, bytesOf(text), elapsed(), log);
  if (!recorded.ok) return { isError: true, text: `${recorded.message} Nothing was returned.` };
  return { isError: false, text, structured: cleaned };
}

function readTool<A>(
  name: string,
  title: string,
  description: string,
  inputSchema: JsonSchemaObject,
  spec: Omit<ReadSpec<A>, "name">
): AgentTool {
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: READ_ANNOTATIONS,
    scope: "read",
    kind: "read",
    run: (ctx, raw) => runRead({ ...spec, name }, ctx, raw),
  };
}

// --- reads ------------------------------------------------------------------------------------

const STAGE_VALUES = STAGES.map((s) => s.value);
const CHANNEL_VALUES = CHANNELS.map((c) => c.value);

const whoamiTool: AgentTool = {
  name: "whoami",
  title: "Who am I connected as",
  description: "Shows this connection's token name, scope, expiry, the organization, and the tools it can use. Call it first to check the connection.",
  inputSchema: NO_PARAMETERS,
  annotations: READ_ANNOTATIONS,
  scope: "read",
  kind: "read",
  run: (ctx, raw) =>
    runRead(
      {
        name: "whoami",
        allowlist: ["tokenName", "scope", "expiresAt", "organization", "tools", "canMakeChanges", "note"],
        validate: (r) => validateNoArgs(r) as Result<Record<string, never>>,
        exec: async (c) => {
          const [tok, org] = await Promise.all([
            c.supabase.from("agent_tokens").select("name, scope, expires_at").eq("id", c.principal.tokenId).maybeSingle(),
            c.supabase.from("org_profile").select("name").limit(1).maybeSingle(),
          ]);
          if (tok.error || !tok.data) return { ok: false, error: "This token's details could not be read just now." };
          const t = tok.data as { name: string; scope: string; expires_at: string };
          const names = toolsForScope(c.principal.scope).map((x) => x.name);
          const modelResult = {
            tokenName: t.name,
            scope: t.scope,
            expiresAt: t.expires_at,
            organization: org.error || !org.data ? null : String((org.data as { name?: string | null }).name ?? "") || null,
            tools: names,
            canMakeChanges: c.principal.scope === "act",
            note: `${APPROVALS_NOTE} Nothing is ever delivered to a funder from here.`,
          };
          return { ok: true, modelResult, card: { kind: "notice", text: "whoami" } };
        },
      },
      ctx,
      raw
    ),
};

const READ_TOOLS: AgentTool[] = [
  whoamiTool,
  {
    name: "fundraising_report",
    title: "Fundraising report",
    description: "A compact report of where fundraising stands: headline numbers, what is due, what is waiting for the owner, who has gone quiet, and recent activity. Built from platform data, not written by a model.",
    inputSchema: NO_PARAMETERS,
    annotations: READ_ANNOTATIONS,
    scope: "read",
    kind: "read",
    run: async (ctx, raw) => {
      const elapsed = stopwatch();
      const bad = validateNoArgs(raw ?? {});
      if (!bad.ok) {
        await recordRead(ctx, "fundraising_report", "refused", raw, bad.error, null, elapsed(), insertAgentEvent);
        return { isError: true, text: `${bad.error} Nothing was looked up.` };
      }
      let report;
      try {
        report = await buildFundraisingReport(ctx.supabase, ctx.now);
      } catch (err) {
        console.error("[agent] report threw:", err instanceof Error ? err.message : err);
        await recordRead(ctx, "fundraising_report", "failed", raw, "The report failed.", null, elapsed(), insertAgentEvent);
        return { isError: true, text: "The report could not be built just now. Nothing was changed. Try again shortly." };
      }
      const data = enforceAllowlist(report.data, new Set(REPORT_ALLOWLIST), []) as Record<string, unknown>;
      if (bytesOf(report.text) > MAX_AGENT_RESULT_BYTES) {
        await recordRead(ctx, "fundraising_report", "failed", raw, "The result was over the size limit.", null, elapsed(), insertAgentEvent);
        return sizeError("fundraising_report");
      }
      const recorded = await recordRead(ctx, "fundraising_report", "executed", raw, null, bytesOf(report.text), elapsed(), insertAgentEvent);
      if (!recorded.ok) return { isError: true, text: `${recorded.message} Nothing was returned.` };
      return { isError: false, text: report.text, structured: data };
    },
  },
  readTool("get_dashboard_summary", "Dashboard numbers", "The headline numbers: prospects, follow-ups due, strategies awaiting review, supporters, and pipeline potential by step.", NO_PARAMETERS, {
    allowlist: DASHBOARD_SUMMARY_ALLOWLIST,
    validate: (r) => validateNoArgs(r) as Result<Record<string, never>>,
    exec: (c) => getDashboardSummary(c.supabase, c.now),
  }),
  readTool("list_followups_due", "Follow-ups due", "Prospects needing attention: next actions due or overdue, declined funders whose revisit date has arrived, and prospects that have gone quiet.", NO_PARAMETERS, {
    allowlist: FOLLOWUPS_ALLOWLIST,
    validate: (r) => validateNoArgs(r) as Result<Record<string, never>>,
    exec: (c) => listFollowUpsDue(c.supabase, c.now),
  }),
  readTool("list_supporters_needing_stewardship", "Supporters gone quiet", "Individual supporters who have gone longer without a donation or contact than their tier allows, quietest first. Pledge amounts and personal details are not available.", NO_PARAMETERS, {
    allowlist: SUPPORTER_STEWARDSHIP_ALLOWLIST,
    validate: (r) => validateNoArgs(r) as Result<Record<string, never>>,
    exec: (c) => listSupportersNeedingStewardship(c.supabase, c.now),
  }),
  readTool(
    "search_prospects",
    "Search prospects",
    "Finds prospects by part of a name, optionally narrowed by pipeline step or funder channel. Returns each match's id, name, channel and step.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the prospect's name." },
        stage: { type: "string", enum: STAGE_VALUES, description: "Only prospects at this pipeline step." },
        channel: { type: "string", enum: CHANNEL_VALUES, description: "Only prospects in this funder channel." },
        limit: { type: "integer", description: `How many to return, 1 to ${MAX_SEARCH_ROWS}. Default 10.` },
      },
      required: [],
      additionalProperties: false,
    },
    {
      allowlist: SEARCH_PROSPECTS_ALLOWLIST,
      validate: validateSearchProspects,
      exec: (c, a) => searchProspects(c.supabase, a),
    }
  ),
  readTool(
    "get_prospect",
    "Prospect details",
    "One prospect's channel, pipeline step, ask amount, next action and due date, outcome, and human-approved research claims. Contact details and notes are not available.",
    { type: "object", properties: { prospect_id: { type: "string", description: "The prospect's id, from search_prospects or another lookup." } }, required: ["prospect_id"], additionalProperties: false },
    { allowlist: GET_PROSPECT_ALLOWLIST, validate: validateGetProspect, exec: (c, a) => getProspect(c.supabase, a) }
  ),
  readTool("list_recent_activity", "Recent activity", "Recent donor searches and recently reviewed opportunities.", NO_PARAMETERS, {
    allowlist: RECENT_ACTIVITY_ALLOWLIST,
    validate: (r) => validateNoArgs(r) as Result<Record<string, never>>,
    exec: (c) => listRecentActivity(c.supabase),
  }),
  readTool(
    "get_strategy_for_review",
    "Strategy waiting for review",
    "One prospect's current proposed strategy in full, and whether it is waiting for review or approved. To have it approved, use request_approval.",
    { type: "object", properties: { prospect_id: { type: "string", description: "The prospect's id." } }, required: ["prospect_id"], additionalProperties: false },
    { allowlist: STRATEGY_REVIEW_ALLOWLIST, validate: validateGetStrategyForReview, exec: (c, a) => getStrategyForReview(c.supabase, a) }
  ),
  readTool(
    "get_drafts",
    "A prospect's drafts",
    "One prospect's drafts: kind, status, subject and text. Pass draft_id to read a single draft when the whole list is too long.",
    {
      type: "object",
      properties: {
        prospect_id: { type: "string", description: "The prospect's id." },
        draft_id: { type: "string", description: "Optional. One draft's id." },
      },
      required: ["prospect_id"],
      additionalProperties: false,
    },
    { allowlist: DRAFTS_ALLOWLIST, validate: validateGetDrafts, exec: (c, a) => getDrafts(c.supabase, a) }
  ),
];

// --- acts -------------------------------------------------------------------------------------------

const ACT_META: Record<AgentActName, { title: string; description: string; idempotent: boolean }> = {
  add_prospect: {
    title: "Add a prospect",
    description: `Adds one new prospect at the very start of the pipeline, by name and funder channel. A name that already exists is refused. ${APPROVALS_NOTE}`,
    idempotent: false,
  },
  log_prospect_interaction: {
    title: "Log a prospect interaction",
    description: `Records an email, call, meeting or note the owner says happened with a prospect, with its date. Do not invent what happened. ${APPROVALS_NOTE}`,
    idempotent: false,
  },
  log_supporter_interaction: {
    title: "Log a supporter interaction",
    description: `Records an email, call, meeting or note the owner says happened with an individual supporter, with its date. Do not invent what happened. ${APPROVALS_NOTE}`,
    idempotent: false,
  },
  set_prospect_next_action: {
    title: "Set a next action",
    description: `Sets the next action, and optionally its due date, on one prospect. The previous value is reported back. ${APPROVALS_NOTE}`,
    idempotent: true,
  },
  set_prospect_ask_amount: {
    title: "Set an ask amount",
    description: `Sets the ask amount on one prospect to a figure in dollars, or clears it. The previous value is reported back. ${APPROVALS_NOTE}`,
    idempotent: true,
  },
  edit_draft: {
    title: "Edit a draft",
    description: `Replaces the complete text (and, for an intro note, the subject) of one outreach draft that is still a draft. The earlier text is kept and the owner can restore it. ${APPROVALS_NOTE}`,
    idempotent: true,
  },
  push_back_on_strategy: {
    title: "Push back on a strategy",
    description: `Has the platform revise the strategy waiting for review to address your feedback; the result is a new strategy waiting for review. This can take about a minute, so call it on its own. ${APPROVALS_NOTE}`,
    idempotent: false,
  },
  unapprove_draft: {
    title: "Reopen a draft",
    description: `Reopens one approved draft that has not been delivered, so it can be edited again; its text is unchanged. ${APPROVALS_NOTE}`,
    idempotent: true,
  },
};

const ACT_TOOLS: AgentTool[] = AGENT_ACT_NAMES.map((name) => ({
  name,
  title: ACT_META[name].title,
  description: ACT_META[name].description,
  inputSchema: agentSchemaFor(name),
  annotations: act(ACT_META[name].idempotent),
  scope: "act" as const,
  kind: "act" as const,
  run: (ctx: ToolRunContext, raw: Record<string, unknown>) => runAgentAct(name, raw, ctx),
}));

const REQUEST_APPROVAL: AgentTool = {
  name: "request_approval",
  title: "Ask for an approval link",
  description: `Asks for a single-use link where the owner can approve one strategy or one draft after seeing it in full. This approves nothing, and the link expires in about 30 minutes. ${APPROVALS_NOTE}`,
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...APPROVAL_KINDS], description: "strategy for a proposed strategy, draft for an outreach draft." },
      subject_id: { type: "string", description: "The strategy's run id (from get_strategy_for_review) or the draft's id (from get_drafts)." },
      agent_statement: { type: "string", description: `Optional. Anything you relied on, up to ${MAX_AGENT_STATEMENT_CHARS} characters. Kept as your own unverified statement.` },
    },
    required: ["kind", "subject_id"],
    additionalProperties: false,
  },
  annotations: act(false),
  scope: "act",
  kind: "approval_request",
  run: (ctx, raw) => runRequestApproval(raw, ctx),
};

// Interaction-kind words are enum values on the act schemas; referenced here so
// a rename in lib/interactions fails the build rather than the schema.
void INTERACTION_KINDS;

export const AGENT_TOOLS: readonly AgentTool[] = [...READ_TOOLS, ...ACT_TOOLS, REQUEST_APPROVAL];

export function findTool(name: string): AgentTool | null {
  return AGENT_TOOLS.find((t) => t.name === name) ?? null;
}

// tools/list is filtered by scope: a read token lists only the reads, so the
// agent reports accurately what it cannot do; an act token lists reads, acts
// and request_approval. (A call to a tool outside the scope is still refused
// when it is made.)
export function toolsForScope(scope: "read" | "act"): AgentTool[] {
  return AGENT_TOOLS.filter((t) => scope === "act" || t.scope === "read");
}
