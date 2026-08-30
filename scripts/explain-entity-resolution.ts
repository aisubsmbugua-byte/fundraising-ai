// What the resolver actually RECEIVED, and what it did with it.
//
// "The resolver is not consuming all available context" and "this prospect was
// never backfilled" produce an identical screen: an unresolved identity and a
// form asking the user for something already on the page. They call for
// opposite fixes, and nothing in the UI distinguishes them.
//
// So this prints the inputs before the outputs. Every signal the scorer can
// use is listed with its value or a loud MISSING, then the tokens and their
// weights, then each candidate's score. A signal that is null here was never
// scored, whatever the code claims to support.
//
// Deliberately calls the real buildEntityCandidates and scoreEntityCandidates
// rather than reimplementing them. A copy would drift from the resolver, and a
// diagnostic that drifts from the thing it diagnoses is worse than none.
//
// Usage: npx tsx --env-file=.env.local scripts/explain-entity-resolution.ts "Discipleship"

import { createClient } from "@supabase/supabase-js";
import {
  buildEntityCandidates,
  scoreEntityCandidates,
  deriveEntityNameToken,
  identityTokens,
  acronymsIn,
  tokenDiscrimination,
  classifySourceDomain,
  MIN_LEADER_SCORE,
  MIN_LEADER_MARGIN,
  MIN_CANDIDATE_ATTRIBUTES,
} from "../lib/research";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const show = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(20)} ${value === null || value === undefined || value === "" ? "\x1b[31mMISSING\x1b[0m" : value}`);

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: explain-entity-resolution.ts "<prospect name>"');
    process.exit(1);
  }

  const { data: prospects } = await admin
    .from("prospects")
    .select("id, name, legal_name, opportunity_name, source_domain, location, website, website_status, ein, contact_email")
    .ilike("name", `%${query}%`);
  if (!prospects?.length) throw new Error(`No prospect matching "${query}".`);
  if (prospects.length > 1) {
    console.error(`Ambiguous -- ${prospects.length} match:`);
    for (const p of prospects) console.error(`  ${p.name}`);
    process.exit(1);
  }
  const p = prospects[0];

  console.log(`\n=== ${p.name} ===\n`);
  console.log("SIGNALS THE RESOLVER RECEIVED");
  show("name", p.name);
  show("legal_name", p.legal_name);
  show("opportunity_name", p.opportunity_name);
  show("source_domain", p.source_domain);
  show("location", p.location);
  show("website", p.website);
  show("stored ein", p.ein);

  const { data: run } = await admin
    .from("research_runs")
    .select("id, version, confirmed_ein, entity_resolution_method, operating_identity_name, operating_identity_method, operating_identity_evidence")
    .eq("prospect_id", p.id)
    .eq("status", "ready")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) throw new Error("No completed research run for this prospect.");

  console.log(`\nLATEST RUN v${run.version}`);
  show("legal ein", run.confirmed_ein);
  show("legal method", run.entity_resolution_method);
  show("operating name", run.operating_identity_name);
  show("operating method", run.operating_identity_method);

  const { data: sources } = await admin
    .from("research_sources")
    .select("id, url, title, source_ein, entity_validation_status")
    .eq("research_run_id", run.id);
  const { data: evidence } = await admin.from("research_evidence").select("source_id, exact_text").eq("research_run_id", run.id);

  const textsBySource = new Map<string, string[]>();
  for (const e of evidence ?? []) {
    const list = textsBySource.get(e.source_id as string) ?? [];
    list.push(e.exact_text as string);
    textsBySource.set(e.source_id as string, list);
  }

  console.log(`\nSOURCES  ${sources?.length ?? 0} captured, ${(sources ?? []).filter((s) => s.source_ein).length} carrying an EIN`);
  for (const s of sources ?? []) {
    const host = (() => {
      try {
        return new URL(s.url as string).hostname.replace(/^www\./, "");
      } catch {
        return s.url as string;
      }
    })();
    console.log(`  ${(s.source_ein as string) ?? "no-ein   "}  ${host}  ${(s.entity_validation_status as string) ?? "-"}`);
  }

  const candidates = buildEntityCandidates({
    sources: (sources ?? []).map((s) => ({
      url: s.url as string,
      title: (s.title as string | null) ?? null,
      sourceEin: (s.source_ein as string | null) ?? null,
      status: (s.entity_validation_status as string | null) ?? null,
      texts: textsBySource.get(s.id as string) ?? [],
    })),
    nameToken: deriveEntityNameToken(p.name as string),
    prospectLocation: (p.location as string | null) ?? null,
    prospectWebsite: (p.website as string | null) ?? null,
    funderName: (p.legal_name as string | null) ?? null,
    opportunityName: (p.opportunity_name as string | null) ?? null,
    captureDomain: (p.source_domain as string | null) ?? null,
  });

  console.log("\nTOKENS FROM WHAT WE HOLD");
  const idf = tokenDiscrimination(candidates.map((c) => `${c.name ?? ""} ${c.matchText}`));
  const all = [
    ...identityTokens(p.name as string),
    ...identityTokens(p.legal_name as string | null),
    ...identityTokens(p.opportunity_name as string | null),
  ];
  for (const t of [...new Set(all)]) {
    const power = idf(t);
    console.log(`  ${t.padEnd(18)} discriminating power ${power.toFixed(3)}${power === 0 ? "  (in every candidate, or in none)" : ""}`);
  }
  const acronyms = [...new Set([...acronymsIn(p.name as string), ...acronymsIn(p.opportunity_name as string | null)])];
  console.log(`  acronyms: ${acronyms.length ? acronyms.map((a) => a.toUpperCase()).join(", ") : "\x1b[31mnone found\x1b[0m"}`);
  if (p.source_domain) {
    console.log(`  capture domain "${p.source_domain}" classifies as:`);
    for (const c of candidates) {
      console.log(`    vs ${(c.name ?? "(unnamed)").slice(0, 50).padEnd(52)} ${classifySourceDomain(p.source_domain as string, { entityName: c.name })}`);
    }
  }

  const ranking = scoreEntityCandidates(candidates, {
    prospectName: p.name as string,
    funderName: (p.legal_name as string | null) ?? null,
    opportunityName: (p.opportunity_name as string | null) ?? null,
    prospectWebsite: (p.website as string | null) ?? null,
    prospectLocation: (p.location as string | null) ?? null,
    captureDomain: (p.source_domain as string | null) ?? null,
  });

  console.log(`\nRANKING  (${candidates.length} candidates)`);
  for (const c of ranking.ranked) {
    console.log(`  ${c.score.toFixed(2).padStart(6)}  ${c.name ?? "(unnamed)"}  [${c.ein}]  attrs=${c.attributeCount}${c.attributeCount < MIN_CANDIDATE_ATTRIBUTES ? " (below display floor)" : ""}`);
    for (const e of c.evidence) console.log(`          - ${e}`);
    if (c.evidence.length === 0) console.log("          - nothing scored");
  }

  console.log(`\nVERDICT`);
  console.log(`  leader     ${ranking.leader?.name ?? "(none)"}`);
  console.log(`  score      ${ranking.leader?.score ?? 0} (needs >= ${MIN_LEADER_SCORE})`);
  console.log(`  margin     ${ranking.margin} (needs >= ${MIN_LEADER_MARGIN})`);
  console.log(`  confident  ${ranking.confident}`);
  if (!ranking.confident) {
    const reasons: string[] = [];
    if (!ranking.leader) reasons.push("no candidates were built at all");
    else {
      if (ranking.leader.score < MIN_LEADER_SCORE) reasons.push(`leader scored ${ranking.leader.score}, below ${MIN_LEADER_SCORE}`);
      if (ranking.margin < MIN_LEADER_MARGIN) reasons.push(`margin ${ranking.margin} below ${MIN_LEADER_MARGIN}`);
    }
    if (!p.opportunity_name) reasons.push("opportunity_name MISSING -- the programme name could not be scored");
    if (!p.source_domain) reasons.push("source_domain MISSING -- capture provenance could not be scored");
    console.log(`  because:   ${reasons.join("\n             ")}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
