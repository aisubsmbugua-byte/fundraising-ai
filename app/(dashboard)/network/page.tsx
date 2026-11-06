import { createClient } from "@/lib/supabase/server";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import type { NetworkConnection } from "@/lib/network";
import { NETWORK_PAGE_SIZE, normalizeSearch, pageWindow, parsePage, searchOrFilter } from "@/lib/network-list";
import { countConnections } from "@/lib/network-store";
import { countIdentityStates, loadIdentityContext } from "@/lib/network-identity-store";
import NetworkWorkspace, { type IdentityPageData } from "./network-workspace";

// A look at one person (their "Find matches" button) is a web search plus a
// model call and runs inside this page's request; the same budget the prospect
// page gives its longest actions.
export const maxDuration = 450;

// One page of people at a time (STATE item 103): an exact total, an exact
// count of those matching the search, then only the requested page -- never
// the whole list, which can run to thousands.
export default async function NetworkPage({ searchParams }: { searchParams: { q?: string; page?: string } }) {
  const supabase = createClient();
  const q = normalizeSearch(searchParams.q);
  const requestedPage = parsePage(searchParams.page);

  const totalRecorded = await countConnections(supabase, "");
  const matching = totalRecorded === null ? null : q ? await countConnections(supabase, q) : totalRecorded;
  let connections: NetworkConnection[] = [];
  let failed = totalRecorded === null || matching === null;
  const win = pageWindow(requestedPage, matching ?? 0, NETWORK_PAGE_SIZE);
  if (!failed && (matching ?? 0) > 0) {
    let query = supabase
      .from("network_connections")
      .select("*")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .range(win.from, win.to);
    const or = searchOrFilter(q);
    if (or) query = query.or(or);
    const { data, error } = await query.returns<NetworkConnection[]>();
    if (error) failed = true;
    else connections = data ?? [];
  }

  // Who each person on this page is (ruling 0044): candidate counts, which were
  // looked at with nothing found, and the summary counts. All of it tolerates a
  // database without migration 0083 -- the identity controls are then hidden.
  const counts = failed ? null : await countIdentityStates(supabase);
  let identity: IdentityPageData = { available: counts !== null, counts, byId: {} };
  if (identity.available && connections.length > 0) {
    const ctx = await loadIdentityContext(supabase, connections.map((c) => c.id));
    if (ctx.available) {
      const byId: IdentityPageData["byId"] = {};
      for (const c of connections) byId[c.id] = { candidateCount: ctx.candidateCounts.get(c.id) ?? 0, lookedEmpty: ctx.lookedEmpty.has(c.id) };
      identity = { ...identity, byId };
    } else identity = { available: false, counts: null, byId: {} };
  }

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Network</h1>
      <p style={{ color: colors.textMuted, marginTop: spacing.xs, maxWidth: 640, fontSize: 14 }}>
        The people your team knows. Record them here by hand or import a file of people you already hold, and on a prospect
        the AI can suggest which of them might open a door to that funder. You decide every suggestion, and nobody on this
        list is ever contacted by this system.
      </p>
      {failed ? (
        <p style={{ color: colors.danger, marginTop: spacing.lg }}>
          Could not load your network just now. If this is a new install, the network tables may not be set up yet.
        </p>
      ) : (
        <NetworkWorkspace connections={connections} totalRecorded={totalRecorded ?? 0} matching={matching ?? 0} q={q} window={win} identity={identity} />
      )}
    </div>
  );
}
