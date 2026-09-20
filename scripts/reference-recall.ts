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
// The three absences are three facts (ruling 0024) and are never collapsed
// into one correct outcome: DECLARED (the model abstained via
// unavailablePurposes -- the abstention channel firing), SILENT (selection ran
// and claimed no page -- silence, not abstention), and NEVER COVERED
// (selection never ran -- a fact about the run, not the model). Only the
// over-claim is a failure, but a reader must be able to see how often
// correctness was earned by abstention vs. arrived at by accident.
//
// SELECTION RECALL IS SPLIT BY THE ADVERTISED AXIS (ruling 0025). A true
// page whose manifest line advertises its purpose (mandatory-flagged or
// opportunity-promoted -- both set at manifest construction, read back here,
// never recomputed) and one whose line does not are different populations:
// review 0020 measured 8/8 selected against 0/5 on the same run. The split is
// derived per URL from the manifest the run built, so it prints under
// --discovery-only too; a URL that never reached the manifest has no
// advertised status at all. A manifest offering zero advertised entries
// (mariners: 0 of 60) is named wherever it bears on the numbers, because
// selection recall over such a site is name-blind guessing.
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
  // Ruling 0025 clause 1: selection recall is split by whether the true URL's
  // manifest line advertises its purpose. Advertised = the entry the run
  // already built is mandatory-flagged (isMandatoryPath, applied at manifest
  // construction) or opportunity-promoted (present in
  // manifest.opportunityMatches). Both read off the built manifest -- never
  // recomputed here a second way, never hard-coded.
  let selAdvFound = 0, selAdvTotal = 0, selUnadvFound = 0, selUnadvTotal = 0;
  // The advertised status of every distinct stated (case, URL) pair. A URL
  // that never reached the manifest has NO advertised status -- it never
  // reached selection -- and that is a third value, not a forced member of
  // either class ("not evaluated" and "evaluated" must not collapse).
  type AdvertisedStatus = "advertised" | "unadvertised" | "no_manifest_entry";
  const advertisedAxis = new Map<string, AdvertisedStatus>();
  // Each contributing case's name-signal profile: how many of its manifest
  // entries carry any advertised signal at all (ruling 0025 clause 3). A
  // manifest with zero offers a name-reading selector nothing to read.
  const nameSignal: { id: string; advertised: number; total: number }[] = [];
  // Ruling 0024 clause 3: the three absences are three facts, and the
  // over-claim is the fourth outcome. Never `declared || !claimed` as one.
  type AbsenceOutcome = "declared" | "silent" | "neverCovered" | "overClaimed";
  const absence: Record<AbsenceOutcome, number> = { declared: 0, silent: 0, neverCovered: 0, overClaimed: 0 };
  const absPerCase = new Map<string, Record<AbsenceOutcome, number>>();
  const rows: string[] = [];

  // Per-case tallies behind each recall, accumulated from the same t/d/s/r
  // counts that print in the per-fact rows -- never computed a second way.
  // Ruling 0022: a rate aggregated over cases carries its per-case
  // distribution, so a bimodal result is visible in this run's own output.
  // Computed independently per stage, because the stages genuinely differ:
  // cma is complete at retrieval and zero at shortlist.
  type CaseTally = { found: number; total: number };
  const perCase: Record<"retrieval" | "shortlist" | "selection" | "selectionAdvertised" | "selectionUnadvertised" | "fetch", Map<string, CaseTally>> = {
    retrieval: new Map(), shortlist: new Map(), selection: new Map(),
    selectionAdvertised: new Map(), selectionUnadvertised: new Map(), fetch: new Map(),
  };
  const tally = (stage: keyof typeof perCase, caseId: string, found: number, total: number) => {
    const t = perCase[stage].get(caseId) ?? { found: 0, total: 0 };
    t.found += found; t.total += total;
    perCase[stage].set(caseId, t);
  };
  // A contributing case is one with at least one `stated` judgement -- the
  // maps only ever receive entries from the stated loop, so map size IS the
  // contributing-case count (ruling 0021: the line names its denominator).
  const distribution = (stage: keyof typeof perCase) => {
    let complete = 0, partial = 0, zero = 0;
    for (const { found, total } of perCase[stage].values()) {
      if (found === total) complete++;
      else if (found === 0) zero++;
      else partial++;
    }
    return `per case: ${complete} complete, ${partial} partial, ${zero} zero, of ${perCase[stage].size} contributing`;
  };

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
    // Advertised, per ruling 0025: this entry's one line of evidence (URL +
    // title) carries a name signal -- the mandatory flag the manifest builder
    // set, or promotion into manifest.opportunityMatches. Derived from the
    // entries this run just constructed; no second code path, no model call,
    // so it prints under --discovery-only too.
    const oppUrls = new Set(manifest.opportunityMatches.map((e) => canon(e.url)));
    const advertisedUrls = new Set(
      manifest.entries.filter((e) => e.mandatory || oppUrls.has(canon(e.url))).map((e) => canon(e.url))
    );
    nameSignal.push({ id: c.id, advertised: advertisedUrls.size, total: manifest.entries.length });

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
      tally("retrieval", c.id, t, wanted.length);
      tally("shortlist", c.id, d, wanted.length);
      tally("selection", c.id, s, wanted.length);
      tally("fetch", c.id, r, wanted.length);
      // Split the in-manifest URLs by the advertised axis. Only URLs that
      // reached the manifest have a status; the rest never reached selection
      // and belong to neither population.
      const inManifest = wanted.filter((u) => manifestUrls.has(u));
      const adv = inManifest.filter((u) => advertisedUrls.has(u));
      const unadv = inManifest.filter((u) => !advertisedUrls.has(u));
      for (const u of wanted) {
        advertisedAxis.set(`${c.id} ${u}`,
          !manifestUrls.has(u) ? "no_manifest_entry"
          : advertisedUrls.has(u) ? "advertised"
          : "unadvertised");
      }
      const sAdv = adv.filter((u) => selectedUrls.has(u)).length;
      const sUnadv = unadv.filter((u) => selectedUrls.has(u)).length;
      if (adv.length > 0) { selAdvTotal += adv.length; selAdvFound += sAdv; tally("selectionAdvertised", c.id, sAdv, adv.length); }
      if (unadv.length > 0) { selUnadvTotal += unadv.length; selUnadvFound += sUnadv; tally("selectionUnadvertised", c.id, sUnadv, unadv.length); }
      const verdict = r > 0 ? "READ"
        : s > 0 ? "selected, not read"
        : d > 0 ? "in manifest, not selected"
        : t > 0 ? "RETRIEVED, DROPPED BY REDUCTION"
        : "NEVER RETRIEVED";
      // "adv a/d": of the d in-manifest URLs, a are advertised. "adv n/a"
      // when no URL reached the manifest -- no status, not a zero.
      const advCol = d === 0 ? "adv n/a" : `adv ${adv.length}/${d}`;
      rows.push(`  ${c.id.padEnd(14)} ${fact.padEnd(24)} ${t}/${wanted.length} retr  ${d}/${wanted.length} manif  ${advCol.padEnd(7)}  ${s}/${wanted.length} sel  ${r}/${wanted.length} read   ${verdict}`);
    }
    // Clause 3 of ruling 0025, beside the rows it bears on: a manifest with
    // zero advertised entries gives a name-reading selector nothing to read,
    // so this case's selection numbers are guesses among unlabeled doors.
    if (stated.length > 0 && manifest.entries.length > 0 && advertisedUrls.size === 0) {
      rows.push(`  ${c.id.padEnd(14)} ^ this manifest has 0 advertised entries of ${manifest.entries.length} — no name signal anywhere for selection to read (ruling 0025 clause 3)`);
    }

    // Where a human found nothing, the system must not claim something -- and
    // where it claimed nothing, HOW it claimed nothing is a second fact. A row
    // per judgement, not just per failure, so declared vs silent is legible
    // per case.
    const selectionRan = manifest.entries.length > 0 && !DISCOVERY_ONLY;
    for (const [fact] of absent) {
      const purpose = FACT_TO_PURPOSE[fact];
      const claimed = selection.selected.some((s) => s.purposes.includes(purpose));
      const declared = selection.unavailablePurposes.includes(purpose);
      // A claimed page is an over-claim whatever else the model said: a
      // declaration contradicted by a selection is not an abstention.
      const outcome: AbsenceOutcome = !selectionRan ? "neverCovered"
        : claimed ? "overClaimed"
        : declared ? "declared"
        : "silent";
      absence[outcome]++;
      const t = absPerCase.get(c.id) ?? { declared: 0, silent: 0, neverCovered: 0, overClaimed: 0 };
      t[outcome]++;
      absPerCase.set(c.id, t);
      const verdict = outcome === "overClaimed"
        ? `system selected a page for it — OVER-CLAIM${declared ? " (despite also declaring it unavailable)" : ""}`
        : outcome === "declared" ? "model declared it unavailable — DECLARED ABSENT"
        : outcome === "silent" ? "selection ran, no page claimed for it — SILENT (not an abstention)"
        : "selection never ran — NEVER COVERED (silence, not abstention)";
      rows.push(`  ${c.id.padEnd(14)} ${fact.padEnd(24)} human: not published · ${verdict}`);
    }
  }

  console.log(rows.join("\n"));
  const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "—");
  console.log("\n" + "=".repeat(60));
  console.log("Reported separately. These are three different failures.");
  console.log(`  retrieval recall   ${pct(retrFound, discTotal)}   discovery actually fetched the URL`);
  console.log(`                     ${distribution("retrieval")}`);
  console.log(`  shortlist recall   ${pct(discFound, discTotal)}   ...and it survived cleaning, grouping and the cap`);
  console.log(`                     ${distribution("shortlist")}`);
  // The advertised axis (ruling 0025), derivable without a model call so it
  // prints in every mode. Population: distinct stated (case, URL) pairs;
  // only pairs whose URL is in a built manifest carry a status.
  const axis = { advertised: 0, unadvertised: 0, no_manifest_entry: 0 };
  for (const v of advertisedAxis.values()) axis[v]++;
  const inManifestPairs = axis.advertised + axis.unadvertised;
  console.log("");
  console.log(`  advertised axis    ${inManifestPairs} distinct in-manifest true (case, URL) pairs: ${axis.advertised} advertised, ${axis.unadvertised} unadvertised`);
  console.log(`                     advertised = the run's own manifest entry is mandatory-flagged or opportunity-promoted;`);
  console.log(`                     ${axis.no_manifest_entry} further stated pairs never reached a manifest — no advertised status, outside both populations`);
  // Clause 3: each contributing case's name-signal profile -- how many of its
  // manifest entries advertise anything at all. Zero means selection recall
  // on that site is name-blind guessing, knowable before any model call.
  console.log(`  name signal        advertised entries per built manifest (${nameSignal.length} cases reached discovery): ${nameSignal.map((p) => `${p.id} ${p.advertised}/${p.total}`).join(" · ")}`);
  const zeroSignal = nameSignal.filter((p) => p.total > 0 && p.advertised === 0);
  if (zeroSignal.length > 0) {
    console.log(`                     zero advertised entries: ${zeroSignal.map((p) => `${p.id} (0 of ${p.total})`).join(", ")} — selection there reads names that do not exist (ruling 0025 clause 3)`);
  }
  console.log("");
  console.log("  These are REFERENCE-PAGE SHORTLIST RECALL. Not research coverage, and");
  console.log("  not decision accuracy: a page reaching the shortlist is not evidence");
  console.log("  that the fact was read, understood, or correctly acted on.");
  if (DISCOVERY_ONLY) console.log("  selection / fetch     not measured (--discovery-only)");
  else {
    // Ruling 0025 clause 1: the blended number may stand as the total, but
    // selection recall is REPORTED SPLIT by the advertised axis, each
    // population with its own denominator and per-case distribution. The
    // blended denominator counts every stated (fact, URL) pair; the split
    // covers the pairs whose URL is in a manifest -- the remainder never
    // reached selection and can be missed by no selector.
    console.log(`  selection recall   ${pct(selFound, selTotal)}   ...and the model chose to read it (total, both populations blended)`);
    console.log(`                     ${distribution("selection")}`);
    console.log(`    advertised       ${pct(selAdvFound, selAdvTotal)}   in-manifest (fact, URL) pairs whose entry is mandatory-flagged or opportunity-promoted`);
    console.log(`                     ${distribution("selectionAdvertised")}`);
    console.log(`    unadvertised     ${pct(selUnadvFound, selUnadvTotal)}   in-manifest (fact, URL) pairs with neither name signal — the known ceiling (ruling 0025 clause 2)`);
    console.log(`                     ${distribution("selectionUnadvertised")}`);
    console.log(`                     (${selTotal - selAdvTotal - selUnadvTotal} of the blended ${selTotal} pairs are in neither population: URL never reached a manifest)`);
  }
  if (!DISCOVERY_ONLY) {
    console.log(`  fetch recall       ${pct(fetchFound, fetchTotal)}   ...and it was actually read`);
    console.log(`                     ${distribution("fetch")}`);
  }
  // Absence precision, numerator broken down (ruling 0024): "no find claimed"
  // is true of an abstention, of silence, and of a run where selection never
  // happened -- three different facts, and only the first is the abstention
  // channel firing. The denominator is all recorded not_stated judgements.
  const absenceTotal = absence.declared + absence.silent + absence.neverCovered + absence.overClaimed;
  const absenceCorrect = absenceTotal - absence.overClaimed;
  const absenceDistribution = () => {
    let respected = 0, mixed = 0, allOverClaimed = 0, abstained = 0;
    for (const t of absPerCase.values()) {
      const correct = t.declared + t.silent + t.neverCovered;
      if (t.overClaimed === 0) respected++;
      else if (correct === 0) allOverClaimed++;
      else mixed++;
      if (t.declared > 0) abstained++;
    }
    return `per case: ${respected} fully respected, ${mixed} mixed, ${allOverClaimed} fully over-claimed, of ${absPerCase.size} contributing; abstention fired in ${abstained} of ${absPerCase.size}`;
  };
  if (DISCOVERY_ONLY) {
    // Selection never ran, so nothing here is an abstention and precision is
    // not a property of the model -- saying 100% would be scoring the run's
    // own inactivity as caution.
    console.log(`  absence            not scored (--discovery-only: selection never ran; ${absence.neverCovered}/${absenceTotal} judgements never-covered — silence, not abstention)`);
  } else {
    console.log(`  absence precision  ${pct(absenceCorrect, absenceTotal)} — ${absence.declared} declared, ${absence.silent} silent, ${absence.neverCovered} never-covered, ${absence.overClaimed} over-claimed   no find claimed where a human found nothing`);
    console.log(`                     ${absenceDistribution()}`);
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
