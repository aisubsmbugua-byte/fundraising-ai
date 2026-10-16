// THE act choke point (STATE item 98, ruling 0039 clauses 3 and 4).
//
// runAgentAct is the only function that carries out an everyday act on an
// agent's call. It reuses -- by import, never by copy -- the assistant's
// per-ability validators (command-defs.ts) and guards (command-exec.ts
// `prepare`), and calls the SAME existing entry points the page and the
// assistant call. What it does NOT carry over from the in-platform command
// path is everything that belongs to a spoken conversation: no
// authorizing_quote, no per-turn cap, no earlier-turn rule. Authority here is
// delegation bounded by scope, a closed list, a write cap, a record and
// revocation (ruling 0039 clause 4) -- and the record never claims the user
// said anything.
//
// The order is fixed, and a refusal at any step stops there:
//
//   a. SCOPE.   The token must be an act token. A read token is refused, with
//               the way to get an act token.
//   b. CAP.     At most WRITE_CAP writes per WRITE_WINDOW_MS per token; the
//               refusal names when to retry. If the window cannot be counted
//               the call is refused (fail closed).
//   c. ARGS.    Validated by the assistant's own validators, quote removed.
//   d. TIME.    A long act (push_back_on_strategy) is refused BEFORE it starts
//               if the request has less time left than its stated maximum plus
//               a margin.
//   e. GUARDS.  The executor's `prepare` re-reads the live rows through the
//               user's client and applies every guard the ability promises.
//   f. RECORD.  The `started` row -- arguments, the agent's unverified
//               statement, what is about to be replaced -- is written BEFORE
//               the effect. If it cannot be written, or the table is absent,
//               nothing runs.
//   g. EFFECT.  The existing entry point, as the token's user, through the
//               request-scoped client override. Throws, {error} returns and
//               NEXT_REDIRECT are all handled.
//   h. OUTCOME. Exactly one terminal row (executed | failed).
//
// The two decision gates are not reachable from here: this module's executor
// table is a closed list of the eight everyday acts, and the entry points it is
// handed (act-entrypoints.ts) have the gate entries stubbed to throw.

import { randomUUID } from "node:crypto";
import { COMMAND_EXECUTORS, type Executor, type Field, type Prepared } from "@/lib/assistant/command-exec";
import { TIME_MARGIN_MS } from "@/lib/assistant/command";
import { isRedirectError } from "@/lib/assistant/redirect";
import { agentDef, isAgentActName, parseAgentArgs, AGENT_ACT_NAMES, type AgentActName } from "./act-args";
import { insertAgentEvent, windowUsage, retryAfterSeconds, describeWait, stopwatch, compactArgs, type AgentEventInsert } from "./log";
import { WRITE_CAP, WRITE_WINDOW_MS } from "./limits";
import type { ToolOutcome, ToolRunContext } from "./types";

export const READ_TOKEN_REFUSAL =
  "This token's scope is read: it can only look things up, so this was not done. To let the agent make changes, create a read-and-act token under Settings → Connect Muse and update the connector with it.";

export type ActDeps = {
  // The closed table of executors this module may run. Defaults to the
  // assistant's own, narrowed to the eight everyday acts.
  executors?: Readonly<Record<string, Executor>>;
  log?: typeof insertAgentEvent;
  usage?: typeof windowUsage;
  newCallId?: () => string;
};

export function agentExecutors(): Readonly<Record<string, Executor>> {
  const out: Record<string, Executor> = {};
  for (const name of AGENT_ACT_NAMES) out[name] = COMMAND_EXECUTORS[name];
  return out;
}

const FIELD_CLIP = 400;
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fieldsText(title: string, fields: Field[] | undefined): string[] {
  if (!fields || fields.length === 0) return [];
  return [title, ...fields.map((f) => `- ${f.label}: ${clip(f.value, FIELD_CLIP)}`)];
}

export async function runAgentAct(toolName: string, rawArgs: Record<string, unknown>, ctx: ToolRunContext, deps: ActDeps = {}): Promise<ToolOutcome> {
  const log = deps.log ?? insertAgentEvent;
  const usage = deps.usage ?? windowUsage;
  const executors = deps.executors ?? agentExecutors();
  const callId = (deps.newCallId ?? randomUUID)();
  const elapsed = stopwatch();

  if (!isAgentActName(toolName)) return { isError: true, text: `There is no change named "${String(toolName).slice(0, 60)}". Nothing was done.` };
  const name: AgentActName = toolName;
  const def = agentDef(name);
  const exec = executors[name];
  if (!exec) return { isError: true, text: "That change is not available. Nothing was done." };

  const argsForLog = (): Record<string, unknown> => compactArgs(rawArgs, 20_000);
  const base = () => ({
    call_id: callId,
    token_id: ctx.principal.tokenId,
    origin: "agent" as const,
    access: "write" as const,
    tool: name,
  });

  // One terminal row, best effort: a refusal never turns into anything else
  // because its record could not be written.
  async function refused(code: string, reason: string, opts: { statement?: string | null; subject?: { table: string; id: string } | null; href?: string } = {}): Promise<ToolOutcome> {
    await log(ctx.supabase, {
      ...base(),
      event: "refused",
      arguments: argsForLog(),
      agent_statement: opts.statement ?? null,
      subject_table: opts.subject?.table ?? null,
      subject_id: opts.subject?.id ?? null,
      previous: null,
      result: { code },
      error_note: reason.slice(0, 1000),
      duration_ms: elapsed(),
      restores_call_id: null,
    });
    return {
      isError: true,
      text: `Not done: ${reason}${opts.href ? ` (${ctx.origin}${opts.href})` : ""}`,
      structured: { status: "refused", nothingWasDone: true, code, reason, callId },
    };
  }

  // a. scope
  if (ctx.principal.scope !== "act") return refused("scope", READ_TOKEN_REFUSAL);

  // b. cap
  const used = await usage(ctx.supabase, ctx.principal.tokenId, "writes", WRITE_WINDOW_MS, ctx.now);
  if (!used.ok) {
    return {
      isError: true,
      text: "The number of recent changes could not be checked just now, so nothing was done. Try again shortly.",
      structured: { status: "refused", nothingWasDone: true, code: "cap_unreadable", callId },
    };
  }
  if (used.usage.count >= WRITE_CAP) {
    const wait = describeWait(retryAfterSeconds(used.usage.oldestAt, WRITE_WINDOW_MS, ctx.now));
    return refused("write_cap", `This token has made its limit of ${WRITE_CAP} changes for the hour, so this one was not made. Try again in ${wait}.`);
  }

  // c. arguments
  const parsed = parseAgentArgs(name, rawArgs, ctx.now);
  if (!parsed.ok) return refused("invalid_arguments", `${parsed.error} Nothing was done.`);
  const { args, payload, statement } = parsed.value;

  // d. time
  if (def.maxDurationMs !== null) {
    const left = ctx.remainingMs();
    if (!(left >= def.maxDurationMs + TIME_MARGIN_MS)) {
      return refused("not_enough_time", "There is not enough time left in this request to do that safely, so it was not started. Ask for it again on its own.", { statement });
    }
  }

  // e. guards, against the live rows
  let prepared: Prepared;
  try {
    const res = await exec(args, { supabase: ctx.supabase, userId: ctx.principal.userId, now: ctx.now });
    if ("refused" in res) return refused(res.refused.code, res.refused.reason, { statement, href: res.refused.href });
    prepared = res.prepared;
  } catch (err) {
    console.error(`[agent] ${name} guard step threw:`, err instanceof Error ? err.message : err);
    return refused("read_failed", "The records needed to check that could not be read just now, so nothing was done.", { statement });
  }

  // f. the record, BEFORE the effect
  const started = await log(ctx.supabase, {
    ...base(),
    event: "started",
    arguments: payload,
    agent_statement: statement,
    subject_table: prepared.subject?.table ?? null,
    subject_id: prepared.subject?.id ?? null,
    previous: prepared.previous,
    result: null,
    error_note: null,
    duration_ms: null,
    restores_call_id: null,
  });
  if (!started.ok) {
    return {
      isError: true,
      text: `Not done: ${started.setupPending ? started.message : "That could not be recorded, and a change is never made unrecorded, so nothing was done."}`,
      structured: { status: "refused", nothingWasDone: true, code: started.setupPending ? "setup_pending" : "record_failed", callId },
    };
  }

  async function terminal(event: "executed" | "failed", result: Record<string, unknown> | null, note: string | null, subject: { table: string; id: string } | null): Promise<boolean> {
    const row: AgentEventInsert = {
      ...base(),
      event,
      arguments: payload,
      agent_statement: statement,
      subject_table: subject?.table ?? prepared.subject?.table ?? null,
      subject_id: subject?.id ?? prepared.subject?.id ?? null,
      previous: null,
      result,
      error_note: note,
      duration_ms: elapsed(),
      restores_call_id: null,
    };
    return (await log(ctx.supabase, row)).ok;
  }

  // g. the effect, through the existing entry point, as the token's user
  let effect;
  try {
    const eps = await ctx.loadEntryPoints();
    effect = await prepared.effect(eps);
  } catch (err) {
    const note = isRedirectError(err)
      ? "The session for this token's owner was not accepted, so nothing was done."
      : err instanceof Error && err.message
        ? err.message
        : "The change failed.";
    console.error(`[agent] ${name} threw:`, note);
    effect = { ok: false as const, error: note };
  }

  // h. the outcome, written once
  if (!effect.ok) {
    const recorded = await terminal("failed", null, effect.error.slice(0, 1000), null);
    return {
      isError: true,
      text: `Not completed: ${effect.error}${recorded ? "" : " (This failure could not be recorded.)"}`,
      structured: { status: "failed", callId, reason: effect.error },
    };
  }
  const recorded = await terminal("executed", { ...effect.result, summary: effect.summary, callId }, null, effect.subject ?? null);

  const lines = [
    `Done: ${effect.summary}`,
    ...fieldsText("What it is now:", effect.fields),
    ...fieldsText("What it replaced:", effect.replaced),
    ...(effect.href ? [`Open it: ${ctx.origin}${effect.href}`] : []),
    ...(effect.restorable ? ["The owner can put the earlier text back from Settings → Connect Muse."] : []),
    ...(effect.warning ? [`Note: ${effect.warning}`] : []),
    ...(recorded ? [] : ["Note: the record of this call could not be completed; the change itself was made."]),
  ];
  return {
    isError: false,
    text: lines.join("\n"),
    structured: {
      status: "done",
      callId,
      summary: effect.summary,
      ...(effect.href ? { url: `${ctx.origin}${effect.href}` } : {}),
      ...(effect.replaced ? { replaced: effect.replaced.map((f) => ({ label: f.label, value: clip(f.value, FIELD_CLIP) })) } : {}),
    },
  };
}
