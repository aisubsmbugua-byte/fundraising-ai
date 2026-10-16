// The HTTP layer of the MCP endpoint (STATE item 98, ruling 0039 clause 1).
//
// POST only. The order is fixed and a refusal at any step stops there, BEFORE
// any data is read:
//
//   1. the bearer token is parsed, hashed and verified (verify_agent_token, an
//      anon-key RPC, no session) -- else 401 with a Bearer challenge, or a
//      plain 503 "setup pending" when migration 0082 is not applied
//   2. the MCP-Protocol-Version header, when present, must be one we speak
//   3. the body is read (bounded) and parsed
//   4. for a body holding tools/call: the user's client is minted, and the
//      per-token call window is checked (429 naming when to retry)
//   5. the JSON-RPC dispatch (mcp.ts)
//
// NEVER AN HTML ERROR PAGE (field note): handleMcpPost never throws, and
// safeHandle wraps even the construction of its dependencies, so an uncaught
// error at any layer -- parse, verify, mint, dispatch, handler -- becomes a
// well-formed JSON-RPC error body with a proper status.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommandEntryPoints } from "@/lib/assistant/types";
import { runWithAgentClient } from "@/lib/supabase/server";
import { loadAgentActEntryPoints } from "./act-entrypoints";
import { CALL_CAP, CALL_WINDOW_MS, MAX_REQUEST_BODY_CHARS, MCP_ROUTE_MAX_DURATION_S, SUPPORTED_PROTOCOL_VERSIONS, publicOrigin } from "./limits";
import { describeWait, retryAfterSeconds, windowUsage } from "./log";
import { countToolCalls, handleBody, rpcError, RPC, type BodyResult, type McpContext } from "./mcp";
import { mintClientForUser } from "./mint";
import { AGENT_SETUP_PENDING_MESSAGE } from "./setup";
import { anonVerifyRpc, authenticate, type VerifyRpc } from "./verify";

export type HttpDeps = {
  verifyRpc: VerifyRpc;
  mint: (userId: string) => Promise<SupabaseClient>;
  usage: typeof windowUsage;
  loadEntryPoints: () => Promise<CommandEntryPoints>;
  enter: typeof runWithAgentClient;
  handleBody: (parsed: unknown, ctx: McpContext) => Promise<BodyResult>;
  origin: string;
  now: () => Date;
  nowMs: () => number;
  logLine: (line: Record<string, unknown>) => void;
};

export function defaultHttpDeps(): HttpDeps {
  return {
    verifyRpc: anonVerifyRpc(),
    mint: mintClientForUser,
    usage: windowUsage,
    loadEntryPoints: loadAgentActEntryPoints,
    enter: runWithAgentClient,
    handleBody,
    origin: publicOrigin(),
    now: () => new Date(),
    nowMs: () => Date.now(),
    // One structured line per call: tool, status, bytes, duration, token id.
    logLine: (line) => console.log(JSON.stringify(line)),
  };
}

const BASE_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

export function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  if (body === null || status === 202) return new Response(null, { status, headers: { "Cache-Control": "no-store", ...extra } });
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

export function methodNotAllowed(): Response {
  return jsonResponse(405, rpcError(null, RPC.invalidRequest, "This endpoint accepts POST only (JSON-RPC over HTTP)."), { Allow: "POST" });
}

export function internalError(): Response {
  return jsonResponse(500, rpcError(null, RPC.internal, "The connector hit an unexpected error. Nothing was changed. Try again shortly."));
}

export async function handleMcpPost(request: Request, deps: HttpDeps): Promise<Response> {
  const startedAt = deps.nowMs();

  // 1. who is calling
  const auth = await authenticate(request.headers.get("authorization"), deps.verifyRpc, deps.now());
  if (!auth.ok) {
    const code = auth.status === 401 ? RPC.unauthorized : auth.status === 503 ? RPC.setupPending : RPC.internal;
    return jsonResponse(auth.status, rpcError(null, code, auth.message), auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="fundraising-ai"' } : {});
  }
  const principal = auth.principal;

  // 2. the protocol version header
  const protocolHeader = request.headers.get("mcp-protocol-version");
  if (protocolHeader !== null && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolHeader)) {
    return jsonResponse(400, rpcError(null, RPC.invalidRequest, `Unsupported MCP protocol version "${protocolHeader.slice(0, 40)}". Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`));
  }

  // 3. the body
  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonResponse(400, rpcError(null, RPC.parse, "The request body could not be read."));
  }
  if (text.length > MAX_REQUEST_BODY_CHARS) return jsonResponse(413, rpcError(null, RPC.invalidRequest, "That request is too large."));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse(400, rpcError(null, RPC.parse, "The request was not valid JSON."));
  }

  // 4. mint the user's client and check the call window (tools/call only: the
  // protocol-only methods read no data and need no session)
  let clientPromise: Promise<SupabaseClient> | null = null;
  const getClient = () => (clientPromise ??= deps.mint(principal.userId));
  const calls = countToolCalls(parsed);
  if (calls > 0) {
    let client: SupabaseClient;
    try {
      client = await getClient();
    } catch (err) {
      console.error("[agent] could not start a session for the token's owner:", err instanceof Error ? err.message : err);
      return jsonResponse(503, rpcError(null, RPC.internal, "The connector could not start a session for this token's owner, so nothing was done. Try again shortly."));
    }
    const used = await deps.usage(client, principal.tokenId, "calls", CALL_WINDOW_MS, deps.now());
    if (!used.ok) {
      return used.setupPending
        ? jsonResponse(503, rpcError(null, RPC.setupPending, AGENT_SETUP_PENDING_MESSAGE))
        : jsonResponse(503, rpcError(null, RPC.internal, "The number of recent calls could not be checked just now, so nothing was done. Try again shortly."));
    }
    if (used.usage.count + calls > CALL_CAP) {
      const wait = retryAfterSeconds(used.usage.oldestAt, CALL_WINDOW_MS, deps.now());
      return jsonResponse(
        429,
        rpcError(null, RPC.rateLimited, `This token has used its limit of ${CALL_CAP} calls for the last ${Math.round(CALL_WINDOW_MS / 60000)} minutes. Try again in ${describeWait(wait)}.`, { retryAfterSeconds: wait }),
        { "Retry-After": String(wait) }
      );
    }
  }

  // 5. dispatch
  const ctx: McpContext = {
    principal,
    protocolHeader,
    origin: deps.origin,
    now: deps.now,
    remainingMs: () => MCP_ROUTE_MAX_DURATION_S * 1000 - (deps.nowMs() - startedAt),
    loadEntryPoints: deps.loadEntryPoints,
    getClient,
    enter: deps.enter,
    logLine: deps.logLine,
  };
  const result = await deps.handleBody(parsed, ctx);
  return jsonResponse(result.status, result.body);
}

// The route's whole body. Never throws; never an HTML page.
export async function safeHandle(request: Request, make: () => HttpDeps = defaultHttpDeps): Promise<Response> {
  try {
    return await handleMcpPost(request, make());
  } catch (err) {
    console.error("[agent] unhandled error in the MCP route:", err instanceof Error ? err.message : err);
    try {
      return internalError();
    } catch {
      return new Response('{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Unexpected error."}}', {
        status: 500,
        headers: BASE_HEADERS,
      });
    }
  }
}
