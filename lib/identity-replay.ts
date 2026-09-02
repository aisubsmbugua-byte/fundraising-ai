// Re-deciding identity from a run's stored sources, in ONE place.
//
// Three callers now need the answer to "who is this funder, given what that
// run captured": the prospect page (live, every render), the replay corpus,
// and the readiness report. They must not each rebuild it.
//
// The reason is not tidiness. A stored run row records what the resolver
// concluded ON THE DAY IT RAN, and a run is immutable -- so the moment the
// resolver improves, every stored operating_identity_method is stale. A
// report that reads the column says the platform is still broken; the page,
// which recomputes, shows it working. Both are honest readings of different
// things, and having two of them is how a fix looks like a no-op.
//
// So: the column is history (what a person was shown at the time), and this
// is the current answer. Anything asking "where do we stand" wants this one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "./fetch-all-rows";
import {
  buildEntityCandidates,
  scoreEntityCandidates,
  deriveEntityNameToken,
  contactEmailDomain,
  type EntityRanking,
} from "./research";

export type IdentityReplayProspect = {
  name: string;
  legal_name: string | null;
  opportunity_name: string | null;
  source_domain: string | null;
  location: string | null;
  website: string | null;
  contact_email: string | null;
};

// Reads only. A replay is not a run: it must never write a row, and never
// pollute the history it is measured against.
export async function replayIdentity(
  admin: SupabaseClient,
  runId: string,
  p: IdentityReplayProspect
): Promise<EntityRanking> {
  // Paged: a dossier run can capture more evidence fragments than PostgREST
  // returns in one unbounded select, and losing the tail would silently change
  // which organization wins.
  const countFor = async (table: string) =>
    (await admin.from(table).select("id", { count: "exact", head: true }).eq("research_run_id", runId)).count ?? null;

  const sources = await fetchAllRows<any>(
    () =>
      admin
        .from("research_sources")
        .select("id, url, title, source_ein, entity_validation_status")
        .eq("research_run_id", runId)
        .order("id") as any,
    await countFor("research_sources"),
    `research_sources for run ${runId}`
  );
  const evidence = await fetchAllRows<any>(
    () =>
      admin
        .from("research_evidence")
        .select("source_id, exact_text")
        .eq("research_run_id", runId)
        .order("id") as any,
    await countFor("research_evidence"),
    `research_evidence for run ${runId}`
  );

  const textsBySource = new Map<string, string[]>();
  for (const e of evidence ?? []) {
    const list = textsBySource.get(e.source_id as string) ?? [];
    list.push(e.exact_text as string);
    textsBySource.set(e.source_id as string, list);
  }

  // Exactly the inference the live path uses, so a replay cannot flatter the
  // resolver by handing it a signal production would not have had.
  const website =
    p.website ?? (contactEmailDomain(p.contact_email) ? `https://${contactEmailDomain(p.contact_email)}` : null);

  const candidates = buildEntityCandidates({
    sources: (sources ?? []).map((s) => ({
      url: s.url as string,
      title: (s.title as string | null) ?? null,
      sourceEin: (s.source_ein as string | null) ?? null,
      status: (s.entity_validation_status as string | null) ?? null,
      texts: textsBySource.get(s.id as string) ?? [],
    })),
    nameToken: deriveEntityNameToken(p.name),
    prospectLocation: p.location,
    prospectWebsite: website,
    funderName: p.legal_name,
    opportunityName: p.opportunity_name,
    captureDomain: p.source_domain,
  });

  return scoreEntityCandidates(candidates, {
    prospectName: p.name,
    funderName: p.legal_name,
    opportunityName: p.opportunity_name,
    prospectWebsite: website,
    prospectLocation: p.location,
    captureDomain: p.source_domain,
  });
}

export const IDENTITY_REPLAY_PROSPECT_COLUMNS =
  "name, legal_name, opportunity_name, source_domain, location, website, contact_email";
