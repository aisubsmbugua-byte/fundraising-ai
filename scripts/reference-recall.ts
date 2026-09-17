// The regression gate for retrieval.
//
// Measures the system against human-recorded ground truth: for each funder, a
// person browsed the site and recorded which URLs actually state each
// decision-critical fact. This script asks how many of those the system found,
// chose, and read.
//
// THREE RECALLS, REPORTED SEPARATELY AND NEVER COMBINED. A fact can be missed
// at three different stages -- it was never discovered, it was discovered and
// not selected, or it was selected and the fetch failed -- and a single
// blended "coverage" number hides which. That is exactly what an earlier 78%
// figure did: it counted keyword matches and was quoted as coverage.
//
// Also measures ABSENCE PRECISION. Where a human recorded "this funder does
// not publish eligibility rules", did the system say not_offered, or did it
// claim a find? Over-claiming an absence is how a user ends up trusting a
// qualification that rests on nothing.
//
// Per docs/reviews/0009: individual organizations here are diagnostic cases,
// not a roadmap. A change that improves one case and regresses another has not
// improved the system.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/reference-recall.ts
//   npx tsx --env-file=.env.local scripts/reference-recall.ts --case maclellan

import { readFileSync } from "fs";

import { canonicalizeUrl } from "../lib/tier2/manifest";
import { discoverSitePages, hostOf } from "../lib/tier2/discovery";
import { buildManifest } from "../lib/tier2/manifest";
import { selectPages, type SelectionPurpose } from "../lib/tier2/select";
import { fetchSelectedPages } from "../lib/tier2/fetch";

const FIXTURE = "docs/reference-set/cases.json";

type FactStatus = "unreviewed" | "stated" | "not_stated";
type Fact = { status: FactStatus; urls: string[]; note: string };
type Case = {
  id: string; funder: string; homepage: string; failureClass: string;
  groundTruth: Record<string, Fact>;
};
type Fixture = { schemaVersion: number; frozen: boolean; cases: Case[] };

// Which retrieval purpose is expected to surface each recorded fact. Recorded
// here rather than in the fixture so a human never has to think about our
// internal vocabulary while reading a funder's website.
const FACT_TO_PURPOSE: Record<string, SelectionPurpose> = {
  priorities: "priorities",
  geographic_restriction: "eligibility",
  recipient_restrictions: "eligibility",
  program_currency: "process",
  application_process: "process",
};

const caseIdx = process.argv.indexOf("--case");
const ONLY = caseIdx >= 0 ? process.argv[caseIdx + 1] : null;
// Discovery is deterministic and needs no model, so it can be measured on its
// own -- useful when an API key is unavailable, and useful anyway because
// discovery recall is the ceiling on every stage after it.
const DISCOVERY_ONLY = process.argv.includes("--discovery-only");

function canon(u: string): string {
  return canonicalizeUrl(u) ?? u;
}

async function main() {
  const fixture: Fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const cases = ONLY ? fixture.cases.filter((c) => c.id === ONLY) : fixture.cases;

  const reviewed = fixture.cases.flatMap((c) => Object.values(c.groundTruth)).filter((f) => f.status !== "unreviewed");
  const total = fixture.cases.length * Object.keys(fixture.cases[0].groundTruth).length;
  console.log(`Reference set: ${fixture.cases.length} cases · ${reviewed.length}/${total} judgements recorded · frozen: ${fixture.frozen}\n`);
  if (reviewed.length === 0) {
    console.log("Nothing to measure yet. Populate docs/reference-set/cases.json first —");
    console.log("browse each funder's site directly, WITHOUT looking at what the system found.");
    return;
  }

  let retrFound = 0, discFound = 0, discTotal = 0, selFound = 0, selTotal = 0, fetchFound = 0, fetchTotal = 0;
  let absenceCorrect = 0, absenceTotal = 0;
  const rows: string[] = [];

  for (const c of cases) {
    const stated = Object.entries(c.groundTruth).filter(([, f]) => f.status === "stated");
    const absent = Object.entries(c.groundTruth).filter(([, f]) => f.status === "not_stated");
    if (stated.length === 0 && absent.length === 0) continue;

    const host = hostOf(c.homepage);
    if (!host) continue;
    const found = await discoverSitePages(host);
    const manifest = buildManifest(found.urls, { host, opportunityName: /\s[—–-]\s/.test(c.funder) ? c.funder.split(/\s[—–-]\s/)[1]?.trim() ?? null : null });
    // RETRIEVED and IN THE MANIFEST are different facts. Conflating them
    // reported EAA and C&MA as "not discovered" when both pages were retrieved
    // and then dropped by reduction -- which is a completely different bug with
    // a completely different fix.
    const retrievedUrls = new Set(found.urls.map((u) => canon(u.url)));
    const manifestUrls = new Set(manifest.entries.map((e) => canon(e.url)));

    const selection = manifest.entries.length && !DISCOVERY_ONLY
      ? await selectPages({ manifest, funderName: c.funder })
      : { selected: [], unavailablePurposes: [] as SelectionPurpose[], promptVersion: 0, model: "", inputTokens: 0, outputTokens: 0 };
    const selectedUrls = new Set(selection.selected.map((s) => canon(s.url)));

    const pages = DISCOVERY_ONLY ? [] : await fetchSelectedPages(selection.selected);
    const readUrls = new Set(pages.filter((p) => p.state === "found").map((p) => canon(p.url)));

    for (const [fact, f] of stated) {
      const wanted = f.urls.map(canon);
      const t = wanted.filter((u) => retrievedUrls.has(u)).length;
      const d = wanted.filter((u) => manifestUrls.has(u)).length;
      const s = wanted.filter((u) => selectedUrls.has(u)).length;
      const r = wanted.filter((u) => readUrls.has(u)).length;
      discTotal += wanted.length; retrFound += t; discFound += d;
      selTotal += wanted.length; selFound += s;
      fetchTotal += wanted.length; fetchFound += r;
      const verdict = r > 0 ? "READ"
        : s > 0 ? "selected, not read"
        : d > 0 ? "in manifest, not selected"
        : t > 0 ? "RETRIEVED, DROPPED BY REDUCTION"
        : "NEVER RETRIEVED";
      rows.push(`  ${c.id.padEnd(14)} ${fact.padEnd(24)} ${t}/${wanted.length} retr  ${d}/${wanted.length} manif  ${s}/${wanted.length} sel  ${r}/${wanted.length} read   ${verdict}`);
    }

    // Where a human found nothing, the system must not claim something.
    for (const [fact] of absent) {
      absenceTotal++;
      const purpose = FACT_TO_PURPOSE[fact];
      const claimed = selection.selected.some((s) => s.purposes.includes(purpose));
      const declared = selection.unavailablePurposes.includes(purpose);
      if (declared || !claimed) absenceCorrect++;
      else rows.push(`  ${c.id.padEnd(14)} ${fact.padEnd(24)} human: not published · system selected a page for it — OVER-CLAIM`);
    }
  }

  console.log(rows.join("\n"));
  const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "—");
  console.log("\n" + "=".repeat(60));
  console.log("Reported separately. These are three different failures.");
  console.log(`  retrieval recall   ${pct(retrFound, discTotal)}   discovery actually fetched the URL`);
  console.log(`  shortlist recall   ${pct(discFound, discTotal)}   ...and it survived cleaning, grouping and the cap`);
  console.log("");
  console.log("  These are REFERENCE-PAGE SHORTLIST RECALL. Not research coverage, and");
  console.log("  not decision accuracy: a page reaching the shortlist is not evidence");
  console.log("  that the fact was read, understood, or correctly acted on.");
  if (DISCOVERY_ONLY) console.log("  selection / fetch     not measured (--discovery-only)");
  else console.log(`  selection recall   ${pct(selFound, selTotal)}   ...and the model chose to read it`);
  if (!DISCOVERY_ONLY) console.log(`  fetch recall       ${pct(fetchFound, fetchTotal)}   ...and it was actually read`);
  if (!DISCOVERY_ONLY) console.log(`  absence precision  ${pct(absenceCorrect, absenceTotal)}   no find claimed where a human found nothing`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
