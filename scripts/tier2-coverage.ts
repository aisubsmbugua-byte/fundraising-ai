// Can code find a funder's own material without a search engine?
//
// Tier 2 of the proposed qualification pipeline fetches the funder's own pages
// over plain HTTP and reads its stated priorities and eligibility rules from
// them. That whole tier rests on one unproven assumption: that the RIGHT pages
// can be DISCOVERED deterministically, with no model and no search provider.
//
// Two sites were probed by hand before this script existed and disagreed --
// one had a sitemap index yielding nine relevant pages, the other returned 404
// and served a site aimed at donors rather than grantseekers. Two is not a
// sample. This measures the whole pipeline.
//
// Discovery order, matching the proposed design:
//   1. sitemap.xml, following a sitemap index one hop
//   2. homepage link extraction, filtered by anchor text and href
//   3. neither -- recorded as an availability fact, not a failure
//
// robots.txt is also checked and reported. A funder that disallows crawling is
// a Tier 2 blocker we need to know about before designing around fetching.
//
// Read-only against our database, and only GETs against funder sites: at most
// four requests per prospect (robots, sitemap, one nested sitemap, homepage).
//
// Usage: npx tsx --env-file=.env.local scripts/tier2-coverage.ts [--detail]

import { createClient } from "@supabase/supabase-js";

import { fetchAllRows } from "../lib/fetch-all-rows";
import { discoverSitePages, hostOf } from "../lib/tier2/discovery";
import { buildManifest } from "../lib/tier2/manifest";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const DETAIL = process.argv.includes("--detail");
const CONCURRENCY = 5;

type Row = { id: string; name: string | null; website: string | null; operating_identity_domain: string | null };

type Result = {
  name: string;
  host: string | null;
  robots: string;
  method: string;
  discovered: number;
  afterCleaning: number;
  entries: number;
  mandatory: number;
  collapsed: number;
  droppedByCap: number;
  failure: string | null;
  note: string;
};

async function measure(row: Row): Promise<Result> {
  const name = (row.name ?? "(unnamed)").slice(0, 44);
  const host = hostOf(row.website ?? row.operating_identity_domain);
  if (!host) {
    return { name, host: null, robots: "absent", method: "none", discovered: 0, afterCleaning: 0, entries: 0, mandatory: 0, collapsed: 0, droppedByCap: 0, failure: null, note: "no website on the prospect row" };
  }
  const found = await discoverSitePages(host);
  const manifest = buildManifest(found.urls, { host });
  return {
    name,
    host,
    robots: found.robots,
    method: found.method,
    discovered: manifest.discovered,
    afterCleaning: manifest.afterCleaning,
    entries: manifest.entries.length,
    mandatory: manifest.entries.filter((e) => e.mandatory).length,
    collapsed: manifest.collapsed.reduce((n, c) => n + c.count, 0),
    droppedByCap: manifest.droppedByCap,
    failure: found.failure,
    note: found.note,
  };
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

function pct(n: number, total: number) {
  return total ? `${Math.round((n / total) * 100)}%` : "—";
}

async function main() {
  const { count, error } = await admin.from("prospects").select("id", { count: "exact", head: true });
  if (error) throw new Error(`prospect count: ${error.message}`);

  const rows = await fetchAllRows<Row>(
    () => admin.from("prospects").select("id, name, website, operating_identity_domain").order("id"),
    count,
    "prospects"
  );

  console.log(`Measuring Tier 2 page discovery across ${rows.length} prospects (concurrency ${CONCURRENCY})...\n`);
  const results = await pool(rows, CONCURRENCY, measure);

  const withSite = results.filter((r) => r.host);
  const by = (m: Result["method"]) => results.filter((r) => r.method === m);

  console.log("=".repeat(78));
  console.log(`prospects:            ${results.length}`);
  console.log(`  with a website:     ${withSite.length}`);
  console.log(`  no website at all:  ${results.length - withSite.length}`);
  console.log();
  console.log("discovery method that worked:");
  console.log(`  sitemap.xml:        ${by("sitemap").length.toString().padStart(3)}  (${pct(by("sitemap").length, withSite.length)} of sites)`);
  console.log(`  homepage links:     ${by("links").length.toString().padStart(3)}  (${pct(by("links").length, withSite.length)})`);
  console.log(`  BOTH, merged:       ${by("sitemap+links").length.toString().padStart(3)}  (${pct(by("sitemap+links").length, withSite.length)})`);
  console.log(`  nothing found:      ${by("none").filter((r) => r.host).length.toString().padStart(3)}`);
  console.log(`  unreachable:        ${by("unreachable").length.toString().padStart(3)}`);
  console.log();

  const reduced = results.filter((r) => r.discovered > 0);
  const totalDiscovered = reduced.reduce((n, r) => n + r.discovered, 0);
  const totalEntries = reduced.reduce((n, r) => n + r.entries, 0);
  const withMandatory = reduced.filter((r) => r.mandatory > 0).length;
  const sizes = reduced.map((r) => r.entries).sort((a, b) => a - b);
  const at = (q: number) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))] : 0);

  console.log(`sites yielding any URLs: ${reduced.length} of ${results.length}`);
  console.log(`raw URLs discovered:     ${totalDiscovered}`);
  console.log(`manifest entries:        ${totalEntries}  (${totalDiscovered ? (100 - Math.round((totalEntries / totalDiscovered) * 100)) : 0}% reduction)`);
  console.log(`entries per site:        min ${sizes[0] ?? 0}  median ${at(0.5)}  max ${sizes[sizes.length - 1] ?? 0}`);
  console.log(`sites with >=1 mandatory page: ${withMandatory} (${pct(withMandatory, results.length)} of all prospects)`);
  console.log();

  const robots = (v: Result["robots"]) => withSite.filter((r) => r.robots === v).length;
  console.log(`robots.txt: allows ${robots("allows")} · absent ${robots("absent")} · DISALLOWS ALL ${robots("disallows-all")} · error ${robots("error")}`);
  console.log("=".repeat(78));
  console.log();

  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  console.log(`${pad("prospect", 44)} ${pad("method", 11)} ${"raw".padStart(6)} ${"clean".padStart(6)} ${"entries".padStart(7)} ${"must".padStart(5)}  note`);
  console.log("-".repeat(114));
  for (const r of [...results].sort((a, b) => b.discovered - a.discovered)) {
    console.log(
      `${pad(r.name, 44)} ${pad(r.method, 11)} ${String(r.discovered).padStart(6)} ${String(r.afterCleaning).padStart(6)} ${String(r.entries).padStart(7)} ${String(r.mandatory).padStart(5)}  ${r.failure ?? r.note}`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
