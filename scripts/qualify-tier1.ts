// Run Tier 1 of the qualification pipeline against real prospects and report
// what it decides, and how fast.
//
// This is the acceptance measurement for two claims in the Build 1 plan that
// were arithmetic rather than evidence: that predicate 1 can be settled from
// structured data in about a second, and that a four-valued verdict is
// necessary rather than tidy. Both are now measurable per prospect.
//
// Read-only by default: it calls the public registry and prints. With
// --publish it also writes one atomic tier1 row per run, which requires
// migration 0064.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/qualify-tier1.ts
//   npx tsx --env-file=.env.local scripts/qualify-tier1.ts --only "Stewardship"

import { createClient } from "@supabase/supabase-js";

import { fetchAllRows } from "../lib/fetch-all-rows";
import { funderIdentityKey, evaluateGrantmaking, evaluateLegitimacy, nameQueryVariants, resolveRegistryIdentity } from "../lib/legitimacy";
import { impliedRegime, type SubjectType } from "../lib/qualification";
import { publishQualificationStage, tier1Payload, type QualificationStageState } from "../lib/qualification-stages";
import { getOrganization, registryFailed, searchOrganizationsMerged } from "../lib/registry/propublica";
import { allocateResearchRunVersion } from "../lib/research";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1]?.toLowerCase() : null;
const PUBLISH = process.argv.includes("--publish");

type Row = {
  id: string;
  name: string | null;
  legal_name: string | null;
  aliases: string[] | null;
  ein: string | null;
  location: string | null;
  opportunity_name: string | null;
  operating_identity_name: string | null;
  organization_id: string | null;
  website: string | null;
  operating_identity_domain: string | null;
};

// Tier 1 cannot classify a subject on its own -- that is the decision
// contract's job, and for now the only signal available before any retrieval
// is whether we hold an EIN at all. Everything unclassified is treated as
// filing-publishing so the registry is actually consulted; a subject that
// turns out to publish nothing surfaces as insufficient_evidence, which is the
// honest answer rather than a guess.
function assumedSubjectType(row: Row): SubjectType {
  return row.ein ? "private_foundation" : "unknown";
}

async function tier1(row: Row) {
  const started = Date.now();
  const hints = {
    ein: row.ein,
    legalName: row.legal_name ?? row.name,
    operatingName: row.operating_identity_name ?? row.name,
    aliases: row.aliases ?? [],
    location: row.location,
  };

  const regime = impliedRegime(assumedSubjectType(row));
  const publishes = regime !== "none_public";

  let identity;
  let searchedFor: string | null = null;
  let search: { candidates: unknown[]; totalResults: number; pagesFetched: number; complete: boolean } | null = null;
  if ((row.ein ?? "").replace(/\D/g, "").length === 9) {
    identity = resolveRegistryIdentity({ candidates: [], hints });
  } else {
    // Search the ORGANIZATION, not the opportunity. row.name routinely carries
    // a program qualifier the registry has never heard of; legal_name is the
    // layer this endpoint indexes.
    // The original name AND controlled variants, merged. A leading article is
    // not noise to this endpoint -- it changes the result set entirely -- so
    // both forms are asked rather than one being normalized away.
    const variants = nameQueryVariants(row.legal_name ?? row.operating_identity_name ?? row.name);
    searchedFor = variants.join(" | ");
    const outcome = await searchOrganizationsMerged(variants);
    if (registryFailed(outcome)) {
      return { row, ms: Date.now() - started, failure: outcome.detail, legitimacy: null, identity: null, org: null, searchedFor, search: null };
    }
    search = outcome;
    identity = resolveRegistryIdentity({ candidates: outcome.candidates, searchComplete: outcome.complete, hints });
  }

  let org = null;
  let grantmaking = null;
  if (identity.state === "established" && identity.ein) {
    const fetched = await getOrganization(identity.ein);
    if (registryFailed(fetched)) {
      return { row, ms: Date.now() - started, failure: fetched.detail, legitimacy: null, identity, org: null, searchedFor, search };
    }
    org = fetched;
    grantmaking = evaluateGrantmaking(org);
  }

  const legitimacy = evaluateLegitimacy({ identity, grantmaking, regimePublishesFilings: publishes });
  return { row, ms: Date.now() - started, failure: null as string | null, legitimacy, identity, org, searchedFor, search };
}

type Tier1Result = Awaited<ReturnType<typeof tier1>>;

// Create a qualification run and publish tier 1 into it, atomically.
//
// The run is created on research_runs with pipeline='qualification', so both
// pipelines live on the same table and can be compared per prospect. No
// environment flag: a flag would make them mutually exclusive, which is the
// opposite of what a comparison needs.
async function publish(result: Tier1Result): Promise<string> {
  const orgId = result.row.organization_id;
  if (!orgId) return "skipped: prospect has no organization_id";

  // created_by is not null and references a real user. A service-role script
  // has none, so attribute to a member of the prospect's own organization
  // rather than inventing an identity -- and say so in the status message.
  const { data: profile } = await admin
    .from("profiles").select("id").eq("organization_id", orgId).limit(1).maybeSingle();
  if (!profile) return "skipped: no profile in this organization to attribute to";

  const runId = await allocateResearchRunVersion(
    admin,
    result.row.id,
    null,
    profile.id as string,
    "Qualification pipeline (tier 1, scripts/qualify-tier1.ts)",
    { pipeline: "qualification", organizationId: orgId }
  );

  const state: QualificationStageState = result.failure ? "retrieval_failed" : (result.legitimacy?.state ?? "insufficient_evidence");
  const payload = result.legitimacy
    ? tier1Payload({
        legitimacy: result.legitimacy,
        organization: result.org
          ? {
              ein: result.org.ein, name: result.org.name, city: result.org.city, state: result.org.state,
              foundationCode: result.org.foundationCode, pfFilingRequirementCode: result.org.pfFilingRequirementCode,
              assetAmount: result.org.assetAmount, incomeAmount: result.org.incomeAmount,
              filingYears: result.org.filings.map((f) => f.taxYear).filter((y): y is number => y !== null),
            }
          : null,
        searchedFor: result.searchedFor ?? null,
      })
    : { retrievalFailure: result.failure, searchedFor: result.searchedFor ?? null };

  const outcome = await publishQualificationStage(admin, {
    researchRunId: runId,
    organizationId: orgId,
    tier: "tier1_registry",
    state,
    result: payload,
    durationMs: result.ms,
  });

  return outcome.published ? `run ${runId.slice(0, 8)} · stage ${outcome.id.slice(0, 8)}` : `run ${runId.slice(0, 8)} · ${outcome.reason}`;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function main() {
  const { count, error } = await admin.from("prospects").select("id", { count: "exact", head: true });
  if (error) throw new Error(`prospect count: ${error.message}`);

  let rows = await fetchAllRows<Row>(
    () =>
      admin
        .from("prospects")
        .select("id, name, legal_name, aliases, ein, location, opportunity_name, operating_identity_name, organization_id, website, operating_identity_domain")
        .order("id"),
    count,
    "prospects"
  );
  if (ONLY) rows = rows.filter((r) => (r.name ?? "").toLowerCase().includes(ONLY));

  console.log(`Tier 1 across ${rows.length} prospects\n`);
  const results = await pool(rows, 4, tier1);

  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  console.log(`${pad("prospect", 44)} ${pad("legitimacy", 21)} ${pad("identity", 21)} ${pad("grantmaking", 20)} ${"ms".padStart(6)}`);
  console.log("-".repeat(118));
  for (const r of results) {
    const legit = r.failure ? "retrieval_failed" : (r.legitimacy?.state ?? "-");
    const ident = r.identity?.state ?? "-";
    const grant = r.legitimacy?.grantmaking?.state ?? "-";
    console.log(`${pad(r.row.name ?? "(unnamed)", 44)} ${pad(legit, 21)} ${pad(ident, 21)} ${pad(grant, 20)} ${String(r.ms).padStart(6)}`);
  }

  if (PUBLISH) {
    console.log("\nPublishing tier 1 (one atomic row per run)...");
    // Serial on purpose. Version allocation is a select-max-then-insert with a
    // retry loop, so running it concurrently against the same prospect is the
    // exact race that loop exists to survive -- not something to provoke while
    // verifying the write path.
    for (const r of results) {
      console.log(`  ${pad(r.row.name ?? "(unnamed)", 44)} ${await publish(r)}`);
    }
  }

  // Group by distinct FUNDER, not raw prospect row. Three NCF rows are one
  // organization, and counting them as three inflates every rate in this
  // report -- the conflict rate most of all.
  const funderKey = (r: Tier1Result) =>
    funderIdentityKey({ ...r.row, ein: r.row.ein ?? r.identity?.ein ?? null }).key;
  const funders = new Map<string, Tier1Result[]>();
  for (const r of results) {
    const k = funderKey(r);
    funders.set(k, [...(funders.get(k) ?? []), r]);
  }
  // One verdict per funder: its rows agree by construction (same key, same
  // query), so the first is representative.
  const perFunder = [...funders.values()].map((rows) => rows[0]);

  const tally = (get: (r: (typeof results)[number]) => string) =>
    perFunder.reduce<Record<string, number>>((acc, r) => {
      const k = get(r);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

  const times = perFunder.map((r) => r.ms).sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))];

  console.log("\n" + "=".repeat(64));
  console.log(`prospect rows: ${results.length}   distinct funders: ${perFunder.length}`);
  console.log("legitimacy:", JSON.stringify(tally((r) => (r.failure ? "retrieval_failed" : r.legitimacy?.state ?? "-"))));
  console.log("identity:  ", JSON.stringify(tally((r) => r.identity?.state ?? "-")));
  console.log("grantmaking:", JSON.stringify(tally((r) => r.legitimacy?.grantmaking?.state ?? "-")));
  console.log(`\nlatency ms: min ${times[0]}  p50 ${at(0.5)}  p95 ${at(0.95)}  max ${times[times.length - 1]}`);
  console.log(`acceptance target for the first rung: p95 < 3000ms -> ${at(0.95) < 3000 ? "PASS" : "FAIL"}`);
  console.log("=".repeat(64));

  const conflicts = perFunder.filter((r) => r.identity?.state === "conflicting" || r.identity?.state === "incomplete_search");
  if (conflicts.length) {
    console.log("\nUnresolved (per distinct funder):");
    for (const c of conflicts) {
      console.log(`  ${c.row.name}`);
      console.log(`    ${c.identity?.reason}`);
      for (const alt of (c.identity?.alternatives ?? []).slice(0, 4)) {
        console.log(`      ${alt.ein}  ${alt.name} — ${alt.city}, ${alt.state}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
