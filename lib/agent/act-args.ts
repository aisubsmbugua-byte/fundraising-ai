// The agent-facing form of the assistant's command definitions (STATE item 98).
//
// The in-platform assistant's commands each REQUIRE `authorizing_quote`, a
// verbatim excerpt of the user's latest message that code checks against the
// message the platform itself stored. That mechanism does not exist for an
// external agent -- the platform cannot see what the user said to it (ruling
// 0039) -- so an agent tool takes the same arguments MINUS the quote, plus one
// optional field, `agent_statement`: any instruction text the agent says it
// relied on. That is stored as the agent's own, unverified statement; no code
// path treats it as the user's words.
//
// Validation reuses the assistant's own validators (command-defs.ts) -- one
// implementation of each bound, enum and date rule. Those validators demand a
// quote, so an internal placeholder is handed to them and dropped from the
// result; it is never stored, shown or sent anywhere. An agent that supplies
// `authorizing_quote` itself is refused, so the field cannot be confused with
// the in-platform mechanism.

import { COMMAND_DEF_BY_NAME, type CommandArgs, type CommandDef } from "@/lib/assistant/command-defs";
import type { JsonSchemaObject, Result } from "@/lib/assistant/types";
import { asOptionalBoundedString } from "@/lib/assistant/validate";
import { MAX_AGENT_STATEMENT_CHARS } from "./limits";

// The EXACT set of everyday acts an agent may carry out. Approving a strategy
// or a draft is not here, nor are the assistant's drafting commands that call a
// model for a long time (revise a draft, draft outreach): the list is closed
// and asserted by scripts/test-agent.ts.
export const AGENT_ACT_NAMES = [
  "add_prospect",
  "log_prospect_interaction",
  "log_supporter_interaction",
  "set_prospect_next_action",
  "set_prospect_ask_amount",
  "edit_draft",
  "push_back_on_strategy",
  "unapprove_draft",
] as const;
export type AgentActName = (typeof AGENT_ACT_NAMES)[number];

export function isAgentActName(name: string): name is AgentActName {
  return (AGENT_ACT_NAMES as readonly string[]).includes(name);
}

export function agentDef(name: AgentActName): CommandDef {
  const def = COMMAND_DEF_BY_NAME.get(name);
  if (!def) throw new Error(`no command definition named ${name}`);
  return def;
}

const STATEMENT_PARAM = {
  type: "string",
  description: `Optional. If you are relying on something the user told you, say what here (up to ${MAX_AGENT_STATEMENT_CHARS} characters). It is kept in the record as your own statement; the platform cannot verify it and does not treat it as the user's words.`,
} as const;

// The assistant's parameter schema with the quote removed and the agent's
// statement added.
export function agentSchemaFor(name: AgentActName): JsonSchemaObject {
  const def = agentDef(name);
  const { authorizing_quote: _quote, ...properties } = def.parameters.properties;
  void _quote;
  return {
    type: "object",
    properties: { ...properties, agent_statement: STATEMENT_PARAM },
    required: (def.parameters.required ?? []).filter((r) => r !== "authorizing_quote"),
    additionalProperties: false,
  };
}

// Never stored, shown or sent: it exists only to satisfy the assistant
// validators' required-quote field.
const INTERNAL_VALIDATION_PLACEHOLDER = "(agent call -- the platform holds no user words here)";

export type ParsedAgentArgs = {
  // Validated, in the assistant executors' argument shape, quote removed.
  args: CommandArgs;
  // The exact validated payload in the tool's own argument names (what the log
  // stores), without the agent's statement.
  payload: Record<string, unknown>;
  statement: string | null;
};

export function parseAgentArgs(name: AgentActName, raw: Record<string, unknown>, now: Date = new Date()): Result<ParsedAgentArgs> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The arguments must be an object." };
  if ("authorizing_quote" in raw) {
    return { ok: false, error: "Unknown argument(s): authorizing_quote. This connector takes no quotation of the user's words; use agent_statement for anything you relied on." };
  }
  const { agent_statement: rawStatement, ...rest } = raw;
  const statement = asOptionalBoundedString(rawStatement, "agent_statement", { max: MAX_AGENT_STATEMENT_CHARS });
  if (!statement.ok) return statement;

  const def = agentDef(name);
  const valid = def.validate({ ...rest, authorizing_quote: INTERNAL_VALIDATION_PLACEHOLDER }, now);
  if (!valid.ok) return valid;
  const { authorizing_quote: _drop, ...args } = valid.value as Record<string, unknown>;
  void _drop;
  return { ok: true, value: { args: args as unknown as CommandArgs, payload: { ...rest }, statement: statement.value } };
}
