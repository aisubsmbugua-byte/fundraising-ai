// OAuth discovery is NOT built (STATE item 98): this connector authenticates
// with a bearer token. A client that probes the well-known OAuth documents
// before connecting gets a plain 404 JSON answer, so it falls back to the
// bearer path instead of hanging or choking on an HTML page.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return new Response(
    JSON.stringify({ error: "not_found", error_description: "This server uses bearer-token authentication, not OAuth. Send 'Authorization: Bearer <token>' to /api/mcp." }),
    { status: 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
