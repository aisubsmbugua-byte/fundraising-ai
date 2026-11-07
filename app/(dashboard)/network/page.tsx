import { createClient } from "@/lib/supabase/server";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import type { NetworkConnection } from "@/lib/network";
import { NETWORK_PAGE_SIZE, normalizeSearch, pageWindow, parsePage, searchOrFilter } from "@/lib/network-list";
import { countConnections } from "@/lib/network-store";
import { planBulkLook } from "@/lib/network-identity";
import { countIdentityStates, loadIdentityContext, loadIdentityOverview } from "@/lib/network-identity-store";
import { buildReviewFinding, researchAgeText } from "@/lib/network-research";
import { loadFindingsFor, loadResearchOverview } from "@/lib/network-research-store";
import NetworkWorkspace, { type IdentityPageData, type ResearchPageData } from "./network-workspace";

// A look at one person (their "Find matches" button) is a web search plus a
// model call and runs inside this page's request; so is researching one confirmed
// person (STATE item 112: "Research this person", "Research your network", and the
// research that follows a click on "Confirm this person"); the same budget the
// prospect page gives its longest actions.
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

  // How many people are waiting to be looked up: the count on the "Confirm your
  // network" button. Read-only; nothing is looked up by loading this page.
  if (identity.available && !failed && (totalRecorded ?? 0) > 0) {
    const overview = await loadIdentityOverview(supabase);
    if (overview.ok) {
      const candidateCounts = new Map<string, number>();
      for (const [id, list] of overview.candidates) candidateCounts.set(id, list.length);
      identity = { ...identity, eligible: planBulkLook(overview.people, candidateCounts, overview.lookedEmpty).eligible.length };
    }
  }

  // Researching confirmed people (STATE item 112, ruling 0044): how many confirmed
  // people are waiting (the count on "Research your network") and, for the confirmed
  // people on this page, what was found. Read-only; nothing is researched by loading
  // this page. Tolerates a database without migration 0085: the controls are hidden.
  let research: ResearchPageData = { available: false, eligible: null, byId: {} };
  if (identity.available && !failed && (totalRecorded ?? 0) > 0) {
    const overview = await loadResearchOverview(supabase);
    if (overview.ok) {
      const confirmedHere = connections.filter((c) => c.identity_status === "confirmed" && c.do_not_research !== true).map((c) => c.id);
      const held = await loadFindingsFor(supabase, confirmedHere);
      if (held) {
        const byId: ResearchPageData["byId"] = {};
        const now = new Date();
        for (const id of confirmedHere) {
          const researchedAt = overview.researchedAt.get(id) ?? null;
          byId[id] = { findings: (held.get(id) ?? []).map(buildReviewFinding), researchedAt, ageText: researchAgeText(researchedAt, now) };
        }
        research = { available: true, eligible: overview.plan.eligible.length, byId };
      }
    }
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
        <NetworkWorkspace connections={connections} totalRecorded={totalRecorded ?? 0} matching={matching ?? 0} q={q} window={win} identity={identity} research={research} />
      )}
    </div>
  );
}
