// Tier 2 end to end: discover, reduce, select, fetch, and hand identity
// evidence back to Tier 1.
//
// Tier 1 and Tier 2 are evidence-authority tiers, not pipeline stages. They
// run CONCURRENTLY here: Tier 2 does not wait for an identity, and when it
// finds an EIN on the funder's own site it reopens a Tier 1 verdict that was
// left conflicting or incomplete. That direction matters -- 14 of 30 funders
// could not be resolved from a name search because their display name matches
// no registered legal name, and their own footer usually states it.
//
// Read-only against our database. Makes one model call per prospect (page
// selection) and at most ~12 HTTP requests.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/qualify-tier2.ts --only "maclellan"
//   npx tsx --env-file=.env.local scripts/qualify-tier2.ts

import { createClient } from "@supabase/supabase-js";

import { fetchAllRows } from "../lib/fetch-all-rows";
import {
  corroborateRegistryRecord, evaluateGrantmaking, evaluateLegitimacy, funderIdentityKey,
  nameQueryVariants, resolveRegistryIdentity, searchableOrganizationName,
} from "../lib/legitimacy";
import { impliedRegime } from "../lib/qualification";
import { getOrganization, registryFailed, searchOrganizationsMerged } from "../lib/registry/propublica";
import { discoverSitePages, hostOf } from "../lib/tier2/discovery";
import { fetchSelectedPages, purposeCoverage } from "../lib/tier2/fetch";
import { completesIdentity, extractIdentityEvidence } from "../lib/tier2/identity-evidence";
import { buildManifest } from "../lib/tier2/manifest";
import { selectPages } from "../lib/tier2/select";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1]?.toLowerCase() : null;
const DETAIL = process.argv.includes("--detail");

type Row = {
  id: string; name: string | null; legal_name: string | null; aliases: string[] | null;
  ein: string | null; location: string | null; opportunity_name: string | null;
  operating_identity_name: string | null; website: string | null; operating_identity_domain: string | null;
};

async function tier1(
  row: Row,
  site?: { ein?: string | null; legalNames?: string[]; states?: string[]; domainConfirmed?: boolean } | null
) {
  // FIX 2: query the ORGANIZATION, never the display or opportunity name. A
  // registry indexes entities; "Hilton Foundation - Aviation Fund" is a
  // program and matches nothing.
  const operating = searchableOrganizationName(row.legal_name ?? row.operating_identity_name ?? row.name);

  const hints = {
    ein: site?.ein ?? row.ein,
    einSource: (site?.ein ? "site_evidence" : "prospect") as "site_evidence" | "prospect",
    legalName: row.legal_name ?? operating,
    operatingName: operating,
    aliases: row.aliases ?? [],
    location: row.location,
    siteEvidence: site ? { legalNames: site.legalNames, states: site.states, domainConfirmed: site.domainConfirmed } : null,
  };

  let identity;
  let searchedFor: string[] = [];
  if ((row.ein ?? "").replace(/\D/g, "").length === 9) {
    identity = resolveRegistryIdentity({ candidates: [], hints });
  } else {
    // FIX 3: run the operating-name query AND any site-derived name query, then
    // merge. Site evidence adds queries; it never replaces ours, so a wrongly
    // attributed website cannot steer the search away from the right answer.
    const queries = [...nameQueryVariants(operating)];
    if (site?.domainConfirmed) for (const n of site.legalNames ?? []) queries.push(...nameQueryVariants(n));
    searchedFor = [...new Set(queries)];
    const outcome = await searchOrganizationsMerged(searchedFor);
    if (registryFailed(outcome)) return null;
    identity = resolveRegistryIdentity({ candidates: outcome.candidates, searchComplete: outcome.complete, hints });
  }

  let grantmaking = null;
  let corroboration = null;
  if (identity.state === "established" && identity.ein) {
    const org = await getOrganization(identity.ein);
    if (!registryFailed(org)) {
      // A site-derived EIN must be corroborated by the record it points at.
      if (hints.einSource === "site_evidence") {
        corroboration = corroborateRegistryRecord(org, { names: [row.legal_name, row.name, operating], location: row.location });
        if (!corroboration.corroborated) {
          return {
            ...evaluateLegitimacy({ identity: { ...identity, state: "insufficient_evidence", ein: null, reason: corroboration.reason }, grantmaking: null, regimePublishesFilings: true }),
            searchedFor, corroboration,
          };
        }
      }
      grantmaking = evaluateGrantmaking(org);
    }
  }
  return {
    ...evaluateLegitimacy({ identity, grantmaking, regimePublishesFilings: impliedRegime(row.ein ? "private_foundation" : "unknown") !== "none_public" }),
    searchedFor,
    corroboration,
  };
}

type Timings = { discoveryMs: number; selectionMs: number; fetchMs: number; firstPriorityMs: number | null; allPagesMs: number };

async function tier2(row: Row) {
  const empty: Timings = { discoveryMs: 0, selectionMs: 0, fetchMs: 0, firstPriorityMs: null, allPagesMs: 0 };
  const host = hostOf(row.website ?? row.operating_identity_domain);
  if (!host) return { host: null, manifest: null, selection: null, pages: [], evidence: null, note: "no website", timings: empty };

  const t0 = Date.now();
  const found = await discoverSitePages(host);
  const manifest = buildManifest(found.urls, { host });
  const discoveryMs = Date.now() - t0;
  if (manifest.entries.length === 0) {
    return { host, manifest, selection: null, pages: [], evidence: null, note: found.failure ?? found.note, timings: { ...empty, discoveryMs } };
  }

  const t1 = Date.now();
  const selection = await selectPages({
    manifest,
    funderName: searchableOrganizationName(row.legal_name ?? row.name ?? host),
    opportunityName: row.opportunity_name,
  });
  const selectionMs = Date.now() - t1;

  // Time to ENOUGH evidence matters more than time to every page. The pages
  // that carry priorities are timed separately from the tail, because a fit
  // assessment can be published once those land.
  const t2 = Date.now();
  const priorityFirst = [...selection.selected].sort(
    (a, b) => Number(b.purposes.includes("priorities")) - Number(a.purposes.includes("priorities"))
  );
  const priorityCount = priorityFirst.filter((p) => p.purposes.includes("priorities")).length;
  const priorityPages = priorityCount ? await fetchSelectedPages(priorityFirst.slice(0, priorityCount)) : [];
  const firstPriorityMs = priorityCount ? Date.now() - t2 : null;
  const restPages = await fetchSelectedPages(priorityFirst.slice(priorityCount));
  const pages = [...priorityPages, ...restPages];
  const fetchMs = Date.now() - t2;

  const evidence = extractIdentityEvidence(pages.filter((p) => p.state === "found"));
  return {
    host, manifest, selection, pages, evidence, note: found.note,
    timings: { discoveryMs, selectionMs, fetchMs, firstPriorityMs, allPagesMs: fetchMs },
  };
}

async function run(row: Row) {
  const started = Date.now();
  // CONCURRENT. Tier 2 does not wait for an identity it may itself supply.
  const [before, t2] = await Promise.all([tier1(row), tier2(row)]);

  // The exchange: an EIN found on the funder's own site reopens Tier 1.
  let after = before;
  let reopened = false;
  let reopenDiscarded = false;
  const domainConfirmed = Boolean(row.operating_identity_domain);
  const hasNarrowing = Boolean(t2.evidence && ((t2.evidence.legalNames.length && domainConfirmed) || t2.evidence.states.length));
  if (t2.evidence && (completesIdentity(t2.evidence, row.ein) || (hasNarrowing && before?.identity.state !== "established"))) {
    reopened = true;
    const retried = await tier1(row, {
      ein: completesIdentity(t2.evidence, row.ein) ? t2.evidence.agreedEin : null,
      legalNames: t2.evidence.legalNames,
      states: t2.evidence.states,
      domainConfirmed,
    });

    // MONOTONIC. Reopening may resolve an unresolved identity; it may never
    // unresolve a resolved one.
    //
    // Merging site-derived queries with our own is correct -- it stops a
    // wrongly attributed site steering the search -- but merging ENLARGES the
    // candidate pool, and a larger pool can turn a unique match into an
    // ambiguous one. Measured: one funder went established -> insufficient
    // this way, with corroboration never firing, because nothing was wrong
    // except that we had looked harder.
    if (retried?.identity.state === "established" || before === null || before.identity.state !== "established") {
      after = retried;
    } else {
      reopenDiscarded = true;
    }
  }
  return { row, before, after, reopened, reopenDiscarded, t2, ms: Date.now() - started };
}

type RunResult = Awaited<ReturnType<typeof run>>;

async function main() {
  const { count, error } = await admin.from("prospects").select("id", { count: "exact", head: true });
  if (error) throw new Error(`prospect count: ${error.message}`);
  let rows = await fetchAllRows<Row>(
    () => admin.from("prospects").select("id, name, legal_name, aliases, ein, location, opportunity_name, operating_identity_name, website, operating_identity_domain").order("id"),
    count, "prospects"
  );
  if (ONLY) rows = rows.filter((r) => (r.name ?? "").toLowerCase().includes(ONLY));

  // One row per distinct funder: three NCF rows are one organization and one
  // set of pages, and running them thrice inflates every number here.
  const byFunder = new Map<string, Row>();
  for (const r of rows) if (!byFunder.has(funderIdentityKey(r).key)) byFunder.set(funderIdentityKey(r).key, r);
  const subjects = [...byFunder.values()];

  console.log(`Tier 2 across ${subjects.length} distinct funders (${rows.length} prospect rows)\n`);

  const results: RunResult[] = [];
  for (const row of subjects) {
    const r = await run(row);
    results.push(r);
    const cov = purposeCoverage(r.t2.pages, r.t2.selection?.unavailablePurposes ?? []);
    const found = r.t2.pages.filter((p) => p.state === "found").length;
    const failed = r.t2.pages.filter((p) => p.state === "retrieval_failed").length;
    console.log(
      `${(row.name ?? "").slice(0, 40).padEnd(42)} ${String(r.t2.manifest?.entries.length ?? 0).padStart(3)} entries` +
      ` → ${String(r.t2.selection?.selected.length ?? 0).padStart(2)} selected` +
      ` → ${String(found).padStart(2)} read${failed ? `, ${failed} failed` : "        "}` +
      `  prio=${cov.priorities.padEnd(16)} elig=${cov.eligibility.padEnd(16)} ${r.reopened ? "IDENTITY REOPENED" : ""}`
    );
    if (DETAIL) {
      for (const p of r.t2.pages) console.log(`      ${p.state.padEnd(16)} ${String(p.chars).padStart(6)}c  ${p.url.slice(0, 78)}  [${p.purposes.join(",")}]`);
      if (r.t2.evidence?.eins.length) console.log(`      EINs on site: ${JSON.stringify(r.t2.evidence.eins.slice(0, 3))}`);
    }
  }

  const tally = (get: (r: (typeof results)[number]) => string | undefined) =>
    results.reduce<Record<string, number>>((a, r) => { const k = get(r) ?? "-"; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const covTally = (p: "priorities" | "eligibility" | "process" | "grants" | "identity") =>
    tally((r) => purposeCoverage(r.t2.pages, r.t2.selection?.unavailablePurposes ?? [])[p]);

  const allPages = results.flatMap((r) => r.t2.pages);

  const pctOf = (n: number) => `${n}/${results.length} (${Math.round((n / results.length) * 100)}%)`;
  const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);
  const stage = (get: (r: RunResult) => number | null) => results.map(get).filter((n): n is number => n !== null && n > 0);

  console.log("\n" + "=".repeat(72));
  console.log("Reported separately. A retrieval-process metric is not evidence.\n");

  // 1-5 are about the PROCESS: did we reach, find, choose and read pages.
  console.log(`1. website reachable:      ${pctOf(results.filter((r) => r.t2.host && (r.t2.manifest?.discovered ?? 0) > 0).length)}`);
  console.log(`2. pages discovered:       ${pctOf(results.filter((r) => (r.t2.manifest?.entries.length ?? 0) > 0).length)}  (${results.reduce((n, r) => n + (r.t2.manifest?.entries.length ?? 0), 0)} manifest entries)`);
  console.log(`3. pages selected:         ${pctOf(results.filter((r) => (r.t2.selection?.selected.length ?? 0) > 0).length)}  (${results.reduce((n, r) => n + (r.t2.selection?.selected.length ?? 0), 0)} pages)`);
  console.log(`4. fetch success:          ${allPages.filter((p) => p.state === "found").length}/${allPages.length} pages, ${allPages.filter((p) => p.state === "retrieval_failed").length} failed`);
  console.log(`5. evidence yield:         ${pctOf(results.filter((r) => (r.t2.evidence?.eins.length ?? 0) > 0 || (r.t2.evidence?.legalNames.length ?? 0) > 0).length)} yielded identity evidence`);

  // 6 is NOT coverage. It counts pages tagged with a purpose that loaded with
  // substance -- whether they STATE the fact is what the reference set decides.
  console.log();
  console.log("6. decision-critical fact coverage: NOT MEASURED -- requires the manually reviewed reference set (task #11).");
  console.log("   Retrieval-process proxy only, do not quote as coverage:");
  for (const p of ["priorities", "eligibility", "process", "grants"] as const) {
    console.log(`     ${p.padEnd(12)} ${JSON.stringify(tally((r) => purposeCoverage(r.t2.pages, r.t2.selection?.unavailablePurposes ?? [])[p]))}`);
  }

  console.log();
  console.log(`7. qualification sufficiency (identity resolved):`);
  console.log(`   before tier 2: ${JSON.stringify(tally((r) => r.before?.identity.state))}`);
  console.log(`   after  tier 2: ${JSON.stringify(tally((r) => r.after?.identity.state))}`);
  console.log(`   reopened: ${results.filter((r) => r.reopened).length}   corroboration rejected: ${results.filter((r) => r.after && "corroboration" in r.after && (r.after as { corroboration?: { corroborated: boolean } }).corroboration?.corroborated === false).length}   reopen discarded as a downgrade: ${results.filter((r) => r.reopenDiscarded).length}`);

  console.log();
  console.log("stage timings (ms, p50 / p95):");
  console.log(`  discovery              ${q(stage((r) => r.t2.timings.discoveryMs), 0.5)} / ${q(stage((r) => r.t2.timings.discoveryMs), 0.95)}`);
  console.log(`  page selection         ${q(stage((r) => r.t2.timings.selectionMs), 0.5)} / ${q(stage((r) => r.t2.timings.selectionMs), 0.95)}`);
  console.log(`  fetch (all pages)      ${q(stage((r) => r.t2.timings.allPagesMs), 0.5)} / ${q(stage((r) => r.t2.timings.allPagesMs), 0.95)}`);
  console.log(`  → enough priority evidence  ${q(stage((r) => r.t2.timings.firstPriorityMs), 0.5)} / ${q(stage((r) => r.t2.timings.firstPriorityMs), 0.95)}`);
  console.log(`  whole tier 1 + tier 2  ${q(results.map((r) => r.ms), 0.5)} / ${q(results.map((r) => r.ms), 0.95)}`);
  console.log("=".repeat(72));

  const stuck = results.filter((r) => r.after && r.after.identity.state !== "established");
  if (stuck.length) {
    console.log(`\nStill unresolved after both tiers (${stuck.length}):`);
    for (const r of stuck) console.log(`  ${(r.row.name ?? "").slice(0, 46).padEnd(48)} ${r.after!.identity.state}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
