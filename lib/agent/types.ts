// Shared shapes for the external-agent connector (STATE item 98).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommandEntryPoints, JsonSchemaObject } from "@/lib/assistant/types";
import type { Principal } from "./verify";

export type { Principal } from "./verify";

// What a tool returns to the MCP layer. `text` is what a person (or the agent)
// reads; `structured` is the same facts as data, for protocol versions that
// carry it. A tool failure is isError:true with a plain message -- it is a
// result the agent can show, not a transport error.
export type ToolOutcome = {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
};

export type ToolRunContext = {
  // The token's user's own row-level-security client (minted). Never a
  // service-role client.
  supabase: SupabaseClient;
  principal: Principal;
  now: Date;
  // Milliseconds left in this request's own deadline.
  remainingMs: () => number;
  // The deployment's public origin, for links in results.
  origin: string;
  // Resolves the entry points an act may call (lazily; gates are stubbed).
  loadEntryPoints: () => Promise<CommandEntryPoints>;
};

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
};

export type ToolKind = "read" | "act" | "approval_request";

export type AgentTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations: ToolAnnotations;
  // The scope a token needs to call it.
  scope: "read" | "act";
  kind: ToolKind;
  run: (ctx: ToolRunContext, rawArgs: Record<string, unknown>) => Promise<ToolOutcome>;
};
