// The bounded tool loop (STATE item 87, ruling 0037; ledger ruling 0026).
//
// One turn is one user message in and one answer out, with at most MAX_STEPS
// model calls between. Every bound is a named constant and is enforced here,
// in code:
//
//   MAX_STEPS               model calls per turn. On the last step no tools
//                           are offered, so the model must answer in text.
//   PER_CALL_TIMEOUT_MS     one model call's ceiling.
//   TURN_DEADLINE_MS        wall clock for the whole loop. Once it passes, no
//                           new call is started; the turn finalizes with what
//                           it has and says so (a notice card, not model
//                           prose).
//   MAX_TOOL_CALLS_PER_STEP tool calls executed from one model reply.
//
// The route's `maxDuration` is 180 s. MAX_STEPS * PER_CALL_TIMEOUT_MS is
// 150 s and TURN_DEADLINE_MS is 120 s, so the loop cannot outlive the route;
// scripts/test-assistant.ts asserts the inequality against the route source.
//
// The ledger row for this turn already exists: `aiRunId` is a required
// argument, and the loop refuses to start without one, so "a model call with
// no birth row before it" is not a state this function can be put in
// (ruling 0026 clause 1). The caller owns finalization and calls it exactly
// once.
//
// What this file never does: execute a change. Tool handlers either read or
// insert a pending proposal. There is no import of executors.ts, any send
// module, or any service-role client here (source-scanned).

import { addUsage, type UsageAccumulator } from "@/lib/ai-runs";
import { toolDefinitions } from "./abilities";
import { dispatchToolCall } from "./dispatch";
import type { ProviderCallResult, ProviderMessage, ProviderToolDefinition } from "./provider";
import type { Ability, Card, ProposalView, ToolContext } from "./types";

export const MAX_STEPS = 5;
export const PER_CALL_TIMEOUT_MS = 30_000;
export const TURN_DEADLINE_MS = 120_000;
export const MAX_TOOL_CALLS_PER_STEP = 4;
// How many past text messages are sent with a new question. Raw tool results
// from earlier turns are never resent.
export const HISTORY_MESSAGE_CAP = 12;
export const MAX_ANSWER_CHARS = 8000;

export type Limits = { maxSteps: number; perCallTimeoutMs: number; deadlineMs: number };
export const DEFAULT_LIMITS: Limits = { maxSteps: MAX_STEPS, perCallTimeoutMs: PER_CALL_TIMEOUT_MS, deadlineMs: TURN_DEADLINE_MS };

export type HistoryMessage = { role: "user" | "assistant"; content: string };

export type ProviderCaller = (
  input: { messages: ProviderMessage[]; tools: ProviderToolDefinition[] },
  timeoutMs: number
) => Promise<ProviderCallResult>;

export type StopReason = "answered" | "step_cap" | "deadline" | "provider_error";

export type LoopOutput = {
  // The ledger outcome the caller should finalize with.
  outcome: "completed" | "empty" | "failed";
  stopReason: StopReason;
  // The model's own prose: AI-written, labelled so wherever it is shown.
  content: string;
  cards: Card[];
  proposals: ProposalView[];
  stepsUsed: number;
  toolCalls: number;
  toolErrors: number;
  // Plain sentence for the ledger and, on failure, the client.
  errorNote: string | null;
  // Present only for provider_error.
  providerError: { kind: string; message: string; detail: string } | null;
};

export function capHistory(history: readonly HistoryMessage[], cap: number = HISTORY_MESSAGE_CAP): HistoryMessage[] {
  const texty = history.filter((m) => m.content.trim() !== "");
  return texty.slice(Math.max(0, texty.length - cap));
}

// Mirrors lib/ai-runs.ts addUsage, tolerant of a response that names no model
// or carries no usage block: "not reported" stays null, never a zero or a
// configured-and-assumed value (ruling 0026 clause 3).
function recordUsage(acc: UsageAccumulator, r: { model: string | null; usage: { inputTokens: number; outputTokens: number } | null }) {
  if (r.model && r.usage) {
    addUsage(acc, { model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
    return;
  }
  if (acc.model === null && r.model) acc.model = r.model;
  if (r.usage) {
    acc.inputTokens = (acc.inputTokens ?? 0) + r.usage.inputTokens;
    acc.outputTokens = (acc.outputTokens ?? 0) + r.usage.outputTokens;
  }
}

export async function runAssistantLoop(input: {
  aiRunId: string;
  system: string;
  history: readonly HistoryMessage[];
  ctx: ToolContext;
  usage: UsageAccumulator;
  call: ProviderCaller;
  abilities?: readonly Ability[];
  clock?: () => number;
  limits?: Partial<Limits>;
}): Promise<LoopOutput> {
  if (!input.aiRunId) {
    throw new Error("runAssistantLoop requires the turn's ledger row: a model call must have a birth row before it (ruling 0026).");
  }
  const limits: Limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const defs: ProviderToolDefinition[] = input.abilities
    ? input.abilities.map((a) => ({ name: a.name, description: a.description, parameters: a.parameters as unknown as Record<string, unknown> }))
    : toolDefinitions();
  const lookup = input.abilities
    ? (name: string) => input.abilities!.find((a) => a.name === name) ?? null
    : undefined;

  const transcript: ProviderMessage[] = [
    { role: "system", content: input.system },
    ...capHistory(input.history).map((m) => ({ role: m.role, content: m.content }) as ProviderMessage),
  ];

  const cards: Card[] = [];
  const proposals: ProposalView[] = [];
  let finalText = "";
  let stepsUsed = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let stopReason: StopReason = "step_cap";

  for (let step = 1; step <= limits.maxSteps; step++) {
    const elapsed = clock() - startedAt;
    if (elapsed >= limits.deadlineMs) {
      stopReason = "deadline";
      break;
    }
    const timeoutMs = Math.max(1, Math.min(limits.perCallTimeoutMs, limits.deadlineMs - elapsed));
    // The last step offers no tools, so the model has to answer in text.
    const offered = step < limits.maxSteps ? defs : [];

    stepsUsed = step;
    const res = await input.call({ messages: transcript, tools: offered }, timeoutMs);
    if (!res.ok) {
      return {
        outcome: "failed",
        stopReason: "provider_error",
        content: "",
        cards,
        proposals,
        stepsUsed,
        toolCalls,
        toolErrors,
        errorNote: res.error.detail ? `${res.error.message} (${res.error.detail})` : res.error.message,
        providerError: { kind: res.error.kind, message: res.error.message, detail: res.error.detail },
      };
    }
    const reply = res.result;
    recordUsage(input.usage, reply);
    if (reply.content.trim() !== "") finalText = reply.content.trim();

    if (reply.toolCalls.length === 0 || offered.length === 0) {
      // A text answer. (If tools were not offered on the last step and the
      // model asked for one anyway, nothing is executed.)
      stopReason = reply.toolCalls.length === 0 ? "answered" : "step_cap";
      break;
    }

    transcript.push({
      role: "assistant",
      content: reply.content.trim() === "" ? null : reply.content,
      tool_calls: reply.toolCalls,
    });

    for (let i = 0; i < reply.toolCalls.length; i++) {
      const call = reply.toolCalls[i];
      if (i >= MAX_TOOL_CALLS_PER_STEP) {
        toolErrors++;
        transcript.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: `At most ${MAX_TOOL_CALLS_PER_STEP} tool calls are handled per step; this one was not run.` }),
        });
        continue;
      }
      toolCalls++;
      const result = await dispatchToolCall(call, input.ctx, lookup);
      if (!result.ok) toolErrors++;
      if (result.card) cards.push(result.card);
      if (result.proposal) proposals.push(result.proposal);
      transcript.push({ role: "tool", tool_call_id: call.id, content: result.toolMessage });
    }
    // A model that keeps calling tools and never answers ends here, at the
    // cap, not by running forever.
    stopReason = "step_cap";
  }

  const answer = finalText.length > MAX_ANSWER_CHARS ? `${finalText.slice(0, MAX_ANSWER_CHARS - 1)}…` : finalText;

  if (stopReason === "answered") {
    const produced = answer !== "" || cards.length > 0 || proposals.length > 0;
    return {
      outcome: produced ? "completed" : "empty",
      stopReason,
      content: answer,
      cards,
      proposals,
      stepsUsed,
      toolCalls,
      toolErrors,
      errorNote: produced ? null : "The model returned no answer.",
      providerError: null,
    };
  }

  // step_cap or deadline: finalize with what exists, and say so in a
  // platform-written notice -- not in the model's voice.
  const why =
    stopReason === "deadline"
      ? `This reply was stopped at the time limit (${Math.round(limits.deadlineMs / 1000)} seconds).`
      : `This reply was stopped at the step limit (${limits.maxSteps} model calls).`;
  cards.push({ kind: "notice", text: `${why} What was retrieved so far is shown; ask again to continue.` });
  const produced = answer !== "" || cards.length > 1 || proposals.length > 0;
  return {
    outcome: produced ? "completed" : "empty",
    stopReason,
    content: answer,
    cards,
    proposals,
    stepsUsed,
    toolCalls,
    toolErrors,
    errorNote: why,
    providerError: null,
  };
}
