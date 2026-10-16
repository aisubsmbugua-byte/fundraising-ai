// Named bounds for the external-agent connector (STATE item 98, ruling 0039).
// Every figure the rest of lib/agent, the Connect Muse page and the tests
// refer to lives here, so a reader of one place sees them all and a test can
// assert them against the places that depend on them.

// --- the route's own time budget ------------------------------------------------
//
// app/api/mcp/route.ts declares `maxDuration = 300` as a literal (Next reads it
// statically). This is the same number, used for the remaining-time guard a
// long act needs (push_back_on_strategy takes up to ~75 s). A test asserts the
// route's literal equals this.
export const MCP_ROUTE_MAX_DURATION_S = 300;

// --- request bounds ----------------------------------------------------------------

// A request body larger than any legal call is refused before it is parsed.
// The largest legal argument is a draft's complete new text (12,000 characters).
export const MAX_REQUEST_BODY_CHARS = 100_000;
// A JSON-RPC batch (legal in protocol 2025-03-26) is bounded.
export const MAX_BATCH_MESSAGES = 8;
// HARD CAP on every tool result, measured in BYTES on the serialized result
// (field note: Muse reportedly cuts a result off around 24 KB, and a truncated
// JSON blob reads like a dropped connection). A result over this is never
// returned, never cut mid-structure: it is replaced by an isError result that
// tells the caller to narrow the request. The structured copy of a result is
// dropped first when only it pushes the total over.
export const MAX_AGENT_RESULT_BYTES = 20_000;

// --- tokens ---------------------------------------------------------------------------

export const TOKEN_PREFIX = "fai_";
export const TOKEN_RANDOM_BYTES = 32;
export const TOKEN_DISPLAY_PREFIX_CHARS = 8;
export const TOKEN_NAME_MAX_CHARS = 80;
// The Connect Muse page offers these; the default is the first marked default.
export const TOKEN_EXPIRY_CHOICES_DAYS = [30, 90, 180, 365] as const;
export const TOKEN_DEFAULT_EXPIRY_DAYS = 90;
export const TOKEN_MAX_EXPIRY_DAYS = 365;

// --- minted sessions ----------------------------------------------------------------------

// The default Supabase session lasts about an hour. A minted access token is
// cached per user for well under that, and refreshed on a 401.
export const MINT_CACHE_MS = 45 * 60 * 1000;
// Never serve a cached token this close to its own expiry.
export const MINT_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// --- rate limits (per token) ----------------------------------------------------------------

// Every tools/call counts. A window of 10 minutes, 120 calls.
export const CALL_WINDOW_MS = 10 * 60 * 1000;
export const CALL_CAP = 120;
// Writes (everything that changes something, including asking for an approval
// link) have their own, much tighter cap: 20 per hour.
export const WRITE_WINDOW_MS = 60 * 60 * 1000;
export const WRITE_CAP = 20;

// --- approval links ----------------------------------------------------------------------------

// The database enforces "within the hour"; the application uses this.
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

// --- text bounds ------------------------------------------------------------------------------------

export const MAX_AGENT_STATEMENT_CHARS = 500;
// The default report is compact: headline numbers and the top few of each list,
// with the count of the rest.
export const MAX_REPORT_ROWS = 5;

// --- protocol -----------------------------------------------------------------------------------------

// Latest first. initialize echoes the client's version when it is one of
// these; otherwise it answers with the first (the latest) and the client
// decides whether it can continue (MCP lifecycle: version negotiation).
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_NAME = "fundraising-ai";
export const SERVER_VERSION = "1.0.0";

// --- public address -----------------------------------------------------------------------

// The canonical deployment host. The documented endpoint must be the FINAL
// host with no redirect in front of it (a redirect makes some clients drop the
// Authorization header), so the address is configuration, not something read
// off a request that may have passed through a proxy. Override with
// AGENT_PUBLIC_ORIGIN.
export const AGENT_PUBLIC_ORIGIN_DEFAULT = "https://fundraising-ai.vercel.app";
export const MCP_PATH = "/api/mcp";

export function publicOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.AGENT_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+$/i.test(raw) ? raw : AGENT_PUBLIC_ORIGIN_DEFAULT;
}
