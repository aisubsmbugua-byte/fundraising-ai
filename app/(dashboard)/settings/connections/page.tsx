import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSetupPending, AGENT_SETUP_PENDING_MESSAGE } from "@/lib/agent/setup";
import { MCP_PATH, publicOrigin } from "@/lib/agent/limits";
import { AGENT_LOG_TABLE } from "@/lib/agent/log";
import { buildCallLines, CALL_LIST_COLUMNS, type CallLogRow } from "@/lib/agent/calls-view";
import { spacing, colors, sectionStyle, type as typeScale } from "@/lib/ui";
import ConnectionsPanel, { type TokenView } from "./connections-panel";

export const dynamic = "force-dynamic";

const CALLS_SHOWN = 60;

// STATE item 98, ruling 0039. The only place a delegate token can be made, and
// where the owner sees what their agent has done. It states plainly where the
// data goes and what each scope can see (clause 5).
export default async function ConnectMusePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const endpoint = `${publicOrigin()}${MCP_PATH}`;
  const [tokensRes, callsRes] = await Promise.all([
    supabase.from("agent_tokens").select("id, name, token_prefix, scope, created_at, last_used_at, expires_at, revoked_at").order("created_at", { ascending: false }),
    supabase.from(AGENT_LOG_TABLE).select(CALL_LIST_COLUMNS).order("created_at", { ascending: false }).limit(CALLS_SHOWN * 2),
  ]);
  const pending = isSetupPending(tokensRes.error) || isSetupPending(callsRes.error);

  const now = Date.now();
  const tokenRows = (tokensRes.data ?? []) as { id: string; name: string; token_prefix: string; scope: "read" | "act"; created_at: string; last_used_at: string | null; expires_at: string; revoked_at: string | null }[];
  const tokens: TokenView[] = tokenRows.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.token_prefix,
    scope: t.scope,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
    expiresAt: t.expires_at,
    status: t.revoked_at ? "revoked" : Date.parse(t.expires_at) <= now ? "expired" : "live",
  }));
  const names = new Map(tokenRows.map((t) => [t.id, t.name]));
  const calls = buildCallLines((callsRes.data ?? []) as unknown as CallLogRow[], names).slice(0, CALLS_SHOWN);

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Connect Muse</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
        Let your own desktop agent (Meta&apos;s Muse) report on where fundraising stands and carry out your everyday decisions. It acts as you, with a token you create here, that you can revoke at any time.
      </p>

      {pending && (
        <div style={{ ...sectionStyle, marginTop: spacing.xl, borderColor: colors.amber700 }}>
          <strong>Setup pending</strong>
          <p style={{ margin: 0, fontSize: 14 }}>{AGENT_SETUP_PENDING_MESSAGE}</p>
        </div>
      )}

      <div style={{ ...sectionStyle, marginTop: spacing.xl }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Where it connects</h2>
        <p style={{ margin: 0, fontSize: 14 }}>
          Endpoint address: <code style={{ wordBreak: "break-all" }}>{endpoint}</code>
        </p>
        <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
          This is the final address, with no redirect in front of it -- use it exactly. Authentication is a bearer token (<code>Authorization: Bearer &lt;token&gt;</code>).
        </p>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, display: "grid", gap: spacing.xs }}>
          <li>Create a token below and copy it. Start with &quot;look things up only&quot; until you trust the setup.</li>
          <li>In Muse, open Settings, then Connectors, then Add custom connector. (Or ask Muse in a chat to add a connector with transport &quot;remote streamable HTTP&quot;, the address above, and authentication &quot;bearer token&quot;.)</li>
          <li>Give Muse the token through its secure credential prompt. Never paste the token into a chat message.</li>
          <li>Check it: ask Muse to call <code>whoami</code>, then to list the connector&apos;s tools.</li>
          <li>In Muse&apos;s permissions for this connector, choose to ask before it takes actions.</li>
          <li>After you change the token or its scope, ask Muse to refresh the connector.</li>
        </ol>
      </div>

      <ConnectionsPanel tokens={tokens} calls={calls} />

      <div style={{ ...sectionStyle, marginTop: spacing.xl }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Where the data goes, and what each choice can see</h2>
        <p style={{ margin: 0, fontSize: 14 }}>
          <strong>Look things up only</strong> can read: headline numbers, prospect and supporter names, funder channel and pipeline step, ask amounts, next actions and due dates, outcomes, research claims a person has approved, strategies and drafts in full, and recent search activity. A supporter&apos;s pledge is shown only as a tier.
        </p>
        <p style={{ margin: 0, fontSize: 14 }}>
          <strong>Look up and make everyday changes</strong> can also add a prospect, log an interaction, set a next action or ask amount, edit a draft, push back on a strategy, reopen an approved draft, and ask for an approval link.
        </p>
        <p style={{ margin: 0, fontSize: 14 }}>
          Neither can see email addresses, phone numbers, notes or the text of logged interactions. Neither can approve anything: approving a strategy or a draft happens only when you open a link, read the full content here, and click. Neither can deliver anything to a funder, move a prospect between steps, delete anything, record a gift, or change who a message goes to.
        </p>
        <p style={{ margin: 0, fontSize: 14 }}>
          <strong>What leaves the platform:</strong> whatever the agent asks for, within the lists above, goes to Meta&apos;s Muse. Meta holds what it receives under its own terms, which this platform does not read and cannot enforce. Do not connect an agent you would not trust with that information.
        </p>
        <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
          A changing call is limited per token (20 changes an hour; 120 calls in ten minutes), is recorded before it takes effect, and text it replaces can be restored from the list above. The platform cannot see what you say to the agent, so an agent&apos;s call is recorded as the agent&apos;s, not as your instruction.
        </p>
      </div>
    </div>
  );
}
