// One tool call, from the model's name and argument string to a result the
// model is shown (STATE item 87, ruling 0037 clauses 2, 3 and 5).
//
// Everything the model sends is untrusted. The order is fixed:
//
//   1. the name must be in the closed registry        else unknown_tool
//   2. the argument string must be a JSON object      else invalid_arguments
//   3. the ability's own validator must accept it     else validation
//   4. only then does the handler run (a read, a proposal insert, or -- for
//      a command or gate -- the single call into runCommand, which does its
//      own quote, cap, display and guard checks before anything executes)
//   5. the handler's result is cut down to the ability's allowlist, at any
//      depth, before the model ever sees it
//
// A failure at any step becomes a structured error result handed back to the
// model. It is never executed and never thrown.

import { findAbility } from "./abilities";
import { parseArgumentsJson } from "./validate";
import type { Ability, Card, ProposalView, ToolContext } from "./types";

// A result larger than this is not handed to the model at all; every read is
// capped well below it, so reaching it means a defect, and the model is told
// the lookup failed rather than being sent a truncated, misleading list.
export const MAX_TOOL_RESULT_CHARS = 16000;

export type DispatchErrorKind = "unknown_tool" | "invalid_arguments" | "validation" | "ability_error" | "handler_error" | "result_too_large";

export type DispatchResult = {
  ok: boolean;
  errorKind?: DispatchErrorKind;
  // The string put in the model's `tool` message.
  toolMessage: string;
  card?: Card;
  // Further cards the same call produced (a revision's new strategy, a new
  // draft), rendered by code from reads -- never from the model.
  cards?: Card[];
  proposal?: ProposalView;
  // Keys the allowlist removed (empty in a correct handler). Logged, and
  // asserted empty by tests against deliberately contaminated fixtures.
  strippedKeys: string[];
  ability: Ability | null;
};

function errorResult(kind: DispatchErrorKind, message: string, ability: Ability | null): DispatchResult {
  return { ok: false, errorKind: kind, toolMessage: JSON.stringify({ error: message }), strippedKeys: [], ability };
}

// Recursively removes every object key not on the allowlist. Arrays are
// walked; primitives pass through. Returns the cleaned value and records what
// it dropped.
export function enforceAllowlist(value: unknown, allowed: ReadonlySet<string>, dropped: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => enforceAllowlist(v, allowed, dropped));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.has(k)) {
        dropped.push(k);
        continue;
      }
      out[k] = enforceAllowlist(v, allowed, dropped);
    }
    return out;
  }
  return value;
}

// Every key, at any depth, of a value -- the test's way of asserting a result
// is a subset of its allowlist without trusting the dispatcher to have done it.
export function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, into));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
  return into;
}

export async function dispatchToolCall(
  call: { name: string; argumentsRaw: string },
  ctx: ToolContext,
  lookup: (name: string) => Ability | null = findAbility
): Promise<DispatchResult> {
  const ability = lookup(call.name);
  if (!ability) return errorResult("unknown_tool", `There is no tool named "${call.name.slice(0, 60)}". Use only the tools you were given.`, null);

  const parsed = parseArgumentsJson(call.argumentsRaw);
  if (!parsed.ok) return errorResult("invalid_arguments", parsed.error, ability);

  const valid = ability.validate(parsed.value);
  if (!valid.ok) return errorResult("validation", valid.error, ability);

  let outcome;
  try {
    outcome = await ability.handler(valid.value, ctx);
  } catch (err) {
    // The detail stays in the server log; the model is told only that the
    // lookup failed, so a database error message never reaches the provider.
    console.error(`[assistant] tool ${ability.name} threw:`, err instanceof Error ? err.message : err);
    if (ability.kind === "command" || ability.kind === "gate") {
      return errorResult(
        "handler_error",
        "That action hit an unexpected error and may not have completed. Do not say it was done; tell the user to check the record before asking again.",
        ability
      );
    }
    return errorResult("handler_error", "That lookup failed. Tell the user it could not be completed.", ability);
  }

  if (!outcome.ok) return errorResult("ability_error", outcome.error, ability);

  const dropped: string[] = [];
  const cleaned = enforceAllowlist(outcome.modelResult, new Set(ability.allowlist), dropped);
  if (dropped.length > 0) {
    console.error(`[assistant] allowlist stripped keys from ${ability.name}: ${[...new Set(dropped)].join(", ")}`);
  }
  const toolMessage = JSON.stringify(cleaned);
  if (toolMessage.length > MAX_TOOL_RESULT_CHARS) {
    return { ...errorResult("result_too_large", "That result was too large to use. Tell the user it could not be completed.", ability), strippedKeys: dropped };
  }
  return { ok: true, toolMessage, card: outcome.card, cards: outcome.cards, proposal: outcome.proposal, strippedKeys: dropped, ability };
}
