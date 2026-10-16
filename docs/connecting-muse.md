# Connecting Muse

How to connect the owner's desktop Muse agent to Fundraising AI (STATE item 98,
ruling 0039). This is a how-to, not a ruling: the rules are in
`docs/ledger/rulings/0039-*.md`.

## What it is

The platform hosts an MCP server at

    https://fundraising-ai.vercel.app/api/mcp

(the canonical host; override with `AGENT_PUBLIC_ORIGIN`). Use this exact
address -- a redirect in front of it makes some clients drop the
`Authorization` header. It speaks stateless JSON-RPC over streamable HTTP and
authenticates with a bearer token the owner creates under
**Settings -> Connect Muse**. OAuth is not built.

An agent can look things up and make everyday changes as the token's user, within
the token's scope. It can never approve a strategy or a draft: it can ask for a
single-use link, and the owner approves on the platform after reading the full
content. It can never deliver anything to a funder, move a prospect between
pipeline steps, delete, record a gift, or change who a message goes to.

## Steps

1. **Create a token.** Settings -> Connect Muse. Name it, choose "look things up
   only" or "look up and make everyday changes", choose how long it lasts
   (default 90 days). Copy it: it is shown once.
2. **Tell Muse the address.** In Muse: Settings -> Connectors -> Add custom
   connector -- or ask Muse in chat to add a connector with transport "remote
   streamable HTTP", the address above, and authentication "bearer token".
3. **Give Muse the token through its secure credential page** -- never paste it
   into a chat message.
4. **Verify.** Ask Muse to call `whoami` (shows the token name, scope, expiry,
   organization and the tools it can use), then to list the connector's tools. A
   read token lists only the read tools.
5. **Set Muse's permissions** for the connector to **ask before actions**.
   Safety is enforced on the server whatever Muse's setting is, but asking first
   is the right default.
6. **Refresh after changes.** After you change the token or its scope, ask Muse
   to refresh the connector so its tool list is current.

## If something goes wrong

- *"access token is not valid"* -- the token was mistyped, revoked, or expired.
  Make a new one and update the connector.
- *"setup pending"* -- migration `0082` has not been applied in the Supabase SQL
  editor yet.
- A long action (`push_back_on_strategy`) runs for about a minute inside one
  call. If Muse gives up first, check Connect Muse -> Recent calls: a call with
  "no outcome recorded" did not finish, and nothing is assumed about it.
- Revoking a token takes effect on its very next call.

## Testing it from a terminal

    MCP_URL=https://fundraising-ai.vercel.app/api/mcp MCP_TOKEN=... npx tsx scripts/mcp-smoke.ts

(`scripts/mcp-smoke.ts` initializes, lists tools and calls `whoami` and
`fundraising_report`; it never prints the token.)
