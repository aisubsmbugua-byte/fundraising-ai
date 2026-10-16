// POST /api/mcp -- the MCP server the owner's desktop agent (Meta's Muse)
// connects to (STATE item 98, ruling 0039).
//
// A plain route handler: Muse connects from Meta's cloud, so this endpoint is
// public HTTPS and authenticates every request itself with a bearer token the
// owner created under Settings -> Connect Muse (middleware.ts leaves /api/*
// alone, as it does /api/assistant/turn). Stateless JSON-RPC over streamable
// HTTP: POST only; GET and DELETE answer 405.
//
// All behaviour lives in lib/agent/http.ts, which never throws -- an uncaught
// error at any layer is a JSON-RPC error body, never an HTML error page.
//
// 300 s, the same as the assistant turn route: push_back_on_strategy can take
// up to ~75 s and refuses to start unless the request has that much time left.
// The literal below must stay a literal (Next reads it statically);
// scripts/test-agent.ts asserts it equals MCP_ROUTE_MAX_DURATION_S.

import { internalError, methodNotAllowed, safeHandle } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  return safeHandle(request);
}

export async function GET() {
  try {
    return methodNotAllowed();
  } catch {
    return internalError();
  }
}

export async function DELETE() {
  try {
    return methodNotAllowed();
  } catch {
    return internalError();
  }
}
