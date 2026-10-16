// The JSON-RPC 2.0 surface of the MCP server (STATE item 98), hand-rolled and
// stateless: initialize, notifications/initialized, ping, tools/list,
// tools/call. No sessions, no streaming, plain JSON responses.
//
// Why not the official SDK. Its streamable-HTTP transport is built around
// sessions and Node request/response objects (or an extra Web-Standard shim and
// a schema library), and this endpoint must be a pure function of one request
// inside a Next route with no long-lived state. The surface needed is five
// methods. Hand-rolling keeps the dependency tree unchanged and every byte of
// the wire format readable in one file and testable offline.
//
// Version negotiation (MCP lifecycle): the client sends the version it wants;
// if this server supports it, the server answers with the same version,
// otherwise with the latest it supports (SUPPORTED_PROTOCOL_VERSIONS[0]) and
// the client decides whether it can continue.
//
// Batches (legal in 2025-03-26) are answered entry by entry; notifications and
// client responses in a batch produce no entry, and a batch with nothing to
// answer is a 202 with no body.
//
// A tool failure is a tool RESULT with isError:true and a plain message (so the
// agent can show it), never a transport error. Transport/protocol errors are
// JSON-RPC errors. Every tool result is capped at MAX_AGENT_RESULT_BYTES
// (serialized); an oversize one is replaced, never cut.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommandEntryPoints } from "@/lib/assistant/types";
import { runWithAgentClient } from "@/lib/supabase/server";
import { MAX_AGENT_RESULT_BYTES, MAX_BATCH_MESSAGES, SERVER_NAME, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./limits";
import { APPROVALS_NOTE, bytesOf, findTool, sizeError, toolsForScope } from "./tools";
import type { Principal, ToolOutcome } from "./types";

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  rateLimited: -32000,
  setupPending: -32002,
} as const;

export type RpcId = string | number | null;
export type RpcResponse = { jsonrpc: "2.0"; id: RpcId; result: unknown } | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string; data?: unknown } };

export function rpcError(id: RpcId, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export const INSTRUCTIONS = [
  "This connection lets you look up where fundraising stands and carry out the owner's everyday changes. Reads are built from platform data: report what they return and do not invent figures.",
  "Changes need an act token, and every call is recorded against the token.",
  APPROVALS_NOTE + " To get a strategy or a draft approved, call request_approval, give the owner the link it returns, and tell them it is waiting for their decision.",
  "Nothing is ever delivered to a funder from here. Start with whoami to check the connection.",
].join(" ");

export type McpContext = {
  principal: Principal;
  // The MCP-Protocol-Version request header, when present.
  protocolHeader: string | null;
  origin: string;
  now: () => Date;
  remainingMs: () => number;
  loadEntryPoints: () => Promise<CommandEntryPoints>;
  // Resolves the token's user's client (minted). Memoised by the caller.
  getClient: () => Promise<SupabaseClient>;
  // Enters the request-scoped client override. EXACTLY ONE call site in the
  // codebase enters it -- the one below.
  enter?: typeof runWithAgentClient;
  // One structured line per call, to the host logs. Never arguments, results
  // or the token.
  logLine?: (line: Record<string, unknown>) => void;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

// --- tool results ---------------------------------------------------------------------

export type ToolResultPayload = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
};

// Turns a tool's outcome into the wire payload, enforcing the hard size cap on
// the SERIALIZED result: the structured copy (only sent to a 2025-06-18 client)
// is dropped first when it alone pushes the total over; if the text itself does
// not fit the whole result is replaced with a plain "narrow the request" error.
export function shapeToolResult(outcome: ToolOutcome, protocolHeader: string | null): { payload: ToolResultPayload; bytes: number } {
  const wantsStructured = protocolHeader === "2025-06-18" && outcome.structured !== undefined;
  const build = (withStructured: boolean): ToolResultPayload => ({
    content: [{ type: "text", text: outcome.text }],
    isError: outcome.isError,
    ...(withStructured && outcome.structured ? { structuredContent: outcome.structured } : {}),
  });
  let payload = build(wantsStructured);
  let bytes = bytesOf(JSON.stringify(payload));
  if (bytes > MAX_AGENT_RESULT_BYTES && wantsStructured) {
    payload = build(false);
    bytes = bytesOf(JSON.stringify(payload));
  }
  if (bytes > MAX_AGENT_RESULT_BYTES) {
    const replaced = sizeError("");
    payload = { content: [{ type: "text", text: replaced.text }], isError: true };
    bytes = bytesOf(JSON.stringify(payload));
  }
  return { payload, bytes };
}

async function callTool(params: unknown, ctx: McpContext, id: RpcId): Promise<RpcResponse> {
  if (!isObject(params) || typeof params.name !== "string" || params.name === "") {
    return rpcError(id, RPC.invalidParams, "tools/call needs a tool name.");
  }
  const tool = findTool(params.name);
  const logLine = ctx.logLine ?? (() => {});
  if (!tool) {
    logLine({ evt: "agent_call", tool: "(unknown)", status: "unknown_tool", bytes: 0, durationMs: 0, tokenId: ctx.principal.tokenId });
    return rpcError(id, RPC.invalidParams, `Unknown tool: ${params.name.slice(0, 60)}. Use tools/list to see what this token can use.`);
  }
  const started = Date.now();
  let outcome: ToolOutcome;
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (!isObject(args)) {
    outcome = { isError: true, text: "The tool's arguments must be an object. Nothing was done." };
  } else {
    try {
      const client = await ctx.getClient();
      const enter = ctx.enter ?? runWithAgentClient;
      // THE one place the request-scoped client override is entered: around a
      // single tool execution, for the token's user, and nowhere else.
      outcome = await enter(client, () =>
        tool.run(
          {
            supabase: client,
            principal: ctx.principal,
            now: ctx.now(),
            remainingMs: ctx.remainingMs,
            origin: ctx.origin,
            loadEntryPoints: ctx.loadEntryPoints,
          },
          args
        )
      );
    } catch (err) {
      console.error(`[agent] tool ${tool.name} threw:`, err instanceof Error ? err.message : err);
      outcome = {
        isError: true,
        text: tool.scope === "act" ? "That hit an unexpected error and may not have completed. Do not say it was done; ask the owner to check the record before asking again." : "That lookup failed. Nothing was changed.",
      };
    }
  }
  const { payload, bytes } = shapeToolResult(outcome, ctx.protocolHeader);
  logLine({ evt: "agent_call", tool: tool.name, status: payload.isError ? "error" : "ok", bytes, durationMs: Date.now() - started, tokenId: ctx.principal.tokenId });
  return { jsonrpc: "2.0", id, result: payload };
}

// --- one message ----------------------------------------------------------------------

export async function handleMessage(msg: unknown, ctx: McpContext): Promise<RpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return rpcError(null, RPC.invalidRequest, "That is not a JSON-RPC 2.0 message.");

  const hasId = "id" in msg && msg.id !== undefined;
  const id: RpcId = hasId && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
  if (hasId && id === null && msg.id !== null) return rpcError(null, RPC.invalidRequest, "The message id must be a string or a number.");

  // A response sent by the client (to a server request we never make) or a
  // notification: acknowledged, no entry.
  if (typeof msg.method !== "string") {
    return "result" in msg || "error" in msg ? null : rpcError(id, RPC.invalidRequest, "The message has no method.");
  }
  const isNotification = !hasId;
  if (isNotification) return null;

  switch (msg.method) {
    case "initialize": {
      const params = msg.params;
      if (!isObject(params) || typeof params.protocolVersion !== "string") {
        return rpcError(id, RPC.invalidParams, "initialize needs a protocolVersion.");
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": {
      const tools = toolsForScope(ctx.principal.scope).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      }));
      return { jsonrpc: "2.0", id, result: { tools } };
    }
    case "tools/call":
      return callTool(msg.params, ctx, id);
    default:
      return rpcError(id, RPC.methodNotFound, `Method not found: ${msg.method.slice(0, 60)}.`);
  }
}

// --- a whole body: one message or a batch ------------------------------------------------

export type BodyResult = { status: number; body: unknown | null };

export async function handleBody(parsed: unknown, ctx: McpContext): Promise<BodyResult> {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 400, body: rpcError(null, RPC.invalidRequest, "An empty batch is not a valid request.") };
    if (parsed.length > MAX_BATCH_MESSAGES) {
      return { status: 400, body: rpcError(null, RPC.invalidRequest, `A batch can hold at most ${MAX_BATCH_MESSAGES} messages.`) };
    }
    const out: RpcResponse[] = [];
    for (const m of parsed) {
      const r = await handleMessage(m, ctx);
      if (r) out.push(r);
    }
    return out.length === 0 ? { status: 202, body: null } : { status: 200, body: out };
  }
  const r = await handleMessage(parsed, ctx);
  if (!r) return { status: 202, body: null };
  if ("error" in r && (r.error.code === RPC.invalidRequest)) return { status: 400, body: r };
  return { status: 200, body: r };
}

// How many tools/call messages a body holds (the rate limit counts each).
export function countToolCalls(parsed: unknown): number {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.filter((m) => isObject(m) && m.method === "tools/call" && m.id !== undefined).length;
}
