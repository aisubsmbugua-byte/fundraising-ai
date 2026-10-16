// The connector's permanent live smoke test (STATE item 98).
//
// WHY THIS EXISTS. scripts/test-agent.ts proves the connector against fakes.
// Nothing offline can prove the live pieces: the Supabase session exchange,
// migration 0082 in a real database, the deployment's public address, or that
// a real MCP client can talk to it. This script is how the owner (or anyone)
// makes the first real call and re-checks the connection later -- after a
// deploy, a rotated token, or a database change.
//
// WHAT IT DOES. Acts as an MCP client over plain HTTPS with ONE bearer token:
//   1. initialize          (prints the negotiated protocol version and server)
//   2. notifications/initialized
//   3. tools/list          (prints the tool names the token can see)
//   4. tools/call whoami
//   5. tools/call fundraising_report  (prints the report text)
// It calls only READ tools. It changes nothing, asks for no approval link and
// cannot decide anything. The token is read from the environment and is NEVER
// printed (it appears only in the Authorization header).
//
// USAGE (from the project folder):
//
//   cd "/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai"
//   MCP_URL=https://fundraising-ai.vercel.app/api/mcp MCP_TOKEN=fai_... npx tsx scripts/mcp-smoke.ts
//
// MCP_URL defaults to nothing: it must be given, so a typo cannot silently hit
// the wrong host. Use the final canonical address -- a redirect makes some
// clients drop the Authorization header, and this script refuses to follow one.
//
// Exit 0: every step answered and was readable. Exit 1: a step failed or an
// answer was not what a client can use. Exit 2: MCP_URL or MCP_TOKEN is not set
// (nothing was sent).

const url = process.env.MCP_URL;
const token = process.env.MCP_TOKEN;
if (!url) {
  console.error("MCP_URL is not set. Give the endpoint address, e.g. https://fundraising-ai.vercel.app/api/mcp. Nothing was sent.");
  process.exit(2);
}
if (!token) {
  console.error("MCP_TOKEN is not set. Create a token under Settings -> Connect Muse. Nothing was sent.");
  process.exit(2);
}

let nextId = 1;
let protocolVersion: string | null = null;

async function rpc(method: string, params?: Record<string, unknown>, notification = false): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const message: Record<string, unknown> = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notification ? {} : { id: nextId++ }) };
  const res = await fetch(url!, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(message),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`The address redirected (HTTP ${res.status}) to ${res.headers.get("location") ?? "somewhere"}. Use the final address; a redirect makes clients drop the Authorization header.`);
  }
  const text = await res.text();
  let body: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} answered with something that is not JSON (${text.slice(0, 80).replace(/\s+/g, " ")}).`);
    }
  }
  return { status: res.status, body };
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log(`Endpoint: ${url}`);
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-smoke", version: "1" } });
  if (init.status !== 200 || !init.body?.result) fail(`initialize: HTTP ${init.status} ${init.body?.error?.message ?? ""}`);
  protocolVersion = init.body.result.protocolVersion;
  console.log(`initialize: protocol ${protocolVersion}, server ${init.body.result.serverInfo?.name} ${init.body.result.serverInfo?.version}`);

  const note = await rpc("notifications/initialized", undefined, true);
  if (note.status !== 202) fail(`notifications/initialized: expected 202, got ${note.status}`);
  console.log("notifications/initialized: 202");

  const list = await rpc("tools/list");
  if (list.status !== 200 || !Array.isArray(list.body?.result?.tools)) fail(`tools/list: HTTP ${list.status} ${list.body?.error?.message ?? ""}`);
  console.log(`tools/list: ${list.body.result.tools.length} tools -- ${list.body.result.tools.map((t: { name: string }) => t.name).join(", ")}`);

  for (const name of ["whoami", "fundraising_report"]) {
    const r = await rpc("tools/call", { name, arguments: {} });
    if (r.status !== 200 || !r.body?.result) fail(`${name}: HTTP ${r.status} ${r.body?.error?.message ?? ""}`);
    const { isError, content } = r.body.result;
    const text = (content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
    console.log(`\n--- ${name} (${isError ? "ERROR" : "ok"}, ${Buffer.byteLength(text, "utf8")} bytes) ---\n${text}`);
    if (isError) fail(`${name} returned an error result.`);
  }
  console.log("\nAll steps answered.");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
