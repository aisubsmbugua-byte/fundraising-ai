// Step 2 acceptance tests: predicate 1, decided from registry data.
//
// Pure logic, no network. Every fixture below is a real shape observed from
// the live registry during this build, not an invented one -- including the
// two cases that make the four-valued verdict necessary rather than tidy:
//
//   * "national christian foundation" returns six near-identical names in six
//     states, and the top-scored has zero filings
//   * a 990 filer's extract carries grants RECEIVED and nothing about grants
//     made, so grantmaking is unanswerable at this source for public
//     charities, denominational funds and DAF sponsors
//
// Run: npx tsx scripts/test-legitimacy.ts

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  resolveRegistryIdentity,
  evaluateGrantmaking,
  evaluateLegitimacy,
  searchableOrganizationName,
  nameQueryVariants,
  funderIdentityKey,
  corroborateRegistryRecord,
  type GrantmakingOutcome,
} from "../lib/legitimacy";
import { padEin, PF_FILING_REQUIRED, FORMTYPE_990PF, type RegistryCandidate, type RegistryOrganization } from "../lib/registry/propublica";

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function section(t: string) {
  console.log(`\n${t}`);
}

const SRC_DIRS = ["lib", "app"];
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const cand = (ein: string, name: string, city: string, state: string, score = 80): RegistryCandidate => ({ ein, name, city, state, score });

// Observed live, verbatim ordering: the registry's own relevance score puts a
// Houston affiliate with no filings above the national body in Alpharetta.
const NCF_CANDIDATES = [
  cand("334799888", "National Christian Foundations", "Houston", "TX", 88),
  cand("300209280", "National Christian Foundation Inc", "Alpharetta", "GA", 85),
  cand("850466529", "National Christian Foundation Southwest", "Phoenix", "AZ", 84),
  cand("582633177", "National Christian Foundation Raleigh", "Raleigh", "NC", 83),
];

const STEWARDSHIP_CANDIDATES = [
  cand("916020515", "Stewardship Foundation C D A B & W T Weyerhaeuser Ttees", "Tacoma", "WA", 86),
  cand("330273191", "Stewardship Foundation", "Escondido", "CA", 86),
  cand("845177179", "Stewardship Foundation", "Chalfont", "PA", 86),
  cand("383355391", "Stewardship Foundation", "Grand Rapids", "MI", 86),
];

const org = (over: Partial<RegistryOrganization> = {}): RegistryOrganization => ({
  ein: "916020515",
  name: "Stewardship Foundation",
  careOfName: null,
  city: "Tacoma",
  state: "WA",
  subsectionCode: 3,
  foundationCode: 4,
  pfFilingRequirementCode: PF_FILING_REQUIRED,
  assetAmount: 97063615,
  incomeAmount: 23880345,
  dataSource: "current_2026_08_19",
  filings: [],
  filingsWithoutDataCount: 0,
  ...over,
});

const filing = (taxYear: number, grantsPaid: number | null, formType = FORMTYPE_990PF) => ({
  taxYear, formType, grantsPaid, totalAssetsEnd: 99055709, totalRevenue: 2400057, pdfUrl: null,
});

const NOW = new Date("2026-09-02T00:00:00Z");

// ---------------------------------------------------------------------------
section("EIN normalization");
// ---------------------------------------------------------------------------

// The registry returns EINs as integers, so a leading zero is simply gone.
check("a leading zero is restored", padEin(12345678), "012345678");
check("a formatted EIN is accepted", padEin("91-6020515"), "916020515");
check("something that is not an EIN is null", padEin("not an ein"), null);
check("empty is null", padEin(null), null);

// ---------------------------------------------------------------------------
section("What to actually search for");
// ---------------------------------------------------------------------------

// Every one of these was a live 404 that reported as a retrieval failure until
// the display name stopped being used as the query.
check("a parenthetical qualifier is dropped", searchableOrganizationName("The Signatry (Servant Foundation)"), "The Signatry");
check("an acronym parenthetical is dropped", searchableOrganizationName("National Christian Foundation (NCF)"), "National Christian Foundation");
check("an em-dash opportunity suffix is dropped", searchableOrganizationName("Ronald Blue Trust — Ministry Services"), "Ronald Blue Trust");
check("a hyphen separator with spaces is dropped", searchableOrganizationName("Mission to the World - Donor Advised Fund"), "Mission to the World");
check("both shapes at once", searchableOrganizationName("One Challenge (OC International) — Seed Fund"), "One Challenge");

// It must NOT try to shorten a name that is merely long. Guessing a shorter
// query risks resolving to a different organization, which is the worst
// failure available; no candidates is the honest answer.
check(
  "an over-long name is left alone rather than guessed at",
  searchableOrganizationName("Mariners Church High-Capacity Giving Community"),
  "Mariners Church High-Capacity Giving Community"
);
check("an internal hyphen is not a separator", searchableOrganizationName("High-Capacity Fund"), "High-Capacity Fund");
check("a clean name is unchanged", searchableOrganizationName("Maclellan Foundation"), "Maclellan Foundation");
check("null is empty", searchableOrganizationName(null), "");

// ---------------------------------------------------------------------------
section("Identity: refusing to guess");
// ---------------------------------------------------------------------------

// The case that makes this whole function necessary.
check(
  "NCF with no location known: conflicting, not the top-scored guess",
  resolveRegistryIdentity({ candidates: NCF_CANDIDATES, searchComplete: true, hints: { legalName: "National Christian Foundation" } }).state,
  "conflicting"
);
check(
  "...and it names what it is conflicting between",
  resolveRegistryIdentity({ candidates: NCF_CANDIDATES, searchComplete: true, hints: { legalName: "National Christian Foundation" } }).alternatives.length,
  4
);
check(
  "...and resolves to no EIN at all",
  resolveRegistryIdentity({ candidates: NCF_CANDIDATES, searchComplete: true, hints: { legalName: "National Christian Foundation" } }).ein,
  null
);

// A location settles it, because only one shares the token in that state.
check(
  "NCF with a state: resolves to the Georgia entity",
  resolveRegistryIdentity({
    candidates: NCF_CANDIDATES,
    hints: { legalName: "National Christian Foundation", location: "Alpharetta, GA" },
  }).ein,
  "300209280"
);

// 80 results for "stewardship foundation"; the state is what disambiguates.
check(
  "Stewardship resolves by state, not by score",
  resolveRegistryIdentity({
    candidates: STEWARDSHIP_CANDIDATES,
    hints: { legalName: "The Stewardship Foundation", location: "Tacoma, WA" },
  }).ein,
  "916020515"
);
check(
  "the same search without a location is conflicting",
  resolveRegistryIdentity({ candidates: STEWARDSHIP_CANDIDATES, searchComplete: true, hints: { legalName: "The Stewardship Foundation" } }).state,
  "conflicting"
);

// An exact full-name match breaks a tie that state cannot.
check(
  "exact name breaks a tie among token matches",
  resolveRegistryIdentity({
    candidates: [cand("111111111", "Maclellan Foundation", "Chattanooga", "TN"), cand("222222222", "Maclellan Family Foundation", "Chattanooga", "TN")],
    hints: { legalName: "Maclellan Foundation", location: "Chattanooga, TN" },
  }).ein,
  "111111111"
);

// A confirmed EIN outranks everything.
check(
  "a confirmed EIN is taken as given",
  resolveRegistryIdentity({ candidates: NCF_CANDIDATES, hints: { ein: "30-0209280", legalName: "National Christian Foundation" } }),
  { state: "established", ein: "300209280", matched: NCF_CANDIDATES[1], alternatives: [], reason: "confirmed EIN matched a registry record" }
);

// Near-miss names must not resolve. This is the real Mary McClellan case: a
// fuzzy score would rate it close enough, and it is a different organization.
check(
  "a similar but distinct name does not resolve",
  resolveRegistryIdentity({
    candidates: [cand("333333333", "Mary McClellan Foundation", "Cambridge", "NY")],
    searchComplete: true,
    hints: { legalName: "Maclellan Foundation", location: "Chattanooga, TN" },
  }).state,
  "insufficient_evidence"
);
check("no candidates at all is insufficient, not conflicting", resolveRegistryIdentity({ candidates: [], searchComplete: true, hints: { legalName: "Anything" } }).state, "insufficient_evidence");
check("no name to search on is insufficient", resolveRegistryIdentity({ candidates: NCF_CANDIDATES, searchComplete: true, hints: {} }).state, "insufficient_evidence");

// ---------------------------------------------------------------------------
section("Query variants: ask both forms, never normalize one away");
// ---------------------------------------------------------------------------

// Measured live: "The Stewardship Foundation" returns 6 organizations and
// "Stewardship Foundation" returns 80 -- and only the second contains the
// right funder. A leading article is not noise to this endpoint, so it is
// asked both ways rather than stripped.
check("the original name is asked first", nameQueryVariants("The Stewardship Foundation")[0], "The Stewardship Foundation");
check(
  "and the article-less form is asked too",
  nameQueryVariants("The Stewardship Foundation").includes("Stewardship Foundation"),
  true
);
check(
  "a qualifier produces both the full and the organization-only form",
  nameQueryVariants("The Signatry (Servant Foundation)"),
  ["The Signatry (Servant Foundation)", "The Signatry", "Signatry (Servant Foundation)", "Signatry"]
);
check("a clean name yields exactly one query", nameQueryVariants("Maclellan Foundation"), ["Maclellan Foundation"]);
check("nothing in, nothing out", nameQueryVariants(null), []);

// ---------------------------------------------------------------------------
section("Truncation is not ambiguity");
// ---------------------------------------------------------------------------

// The failure this state exists for: the registry reported 80 results, returned
// 25, and the right funder was on page 3. Every downstream decision ran on a
// page that could not contain the answer -- and the verdict said "conflicting",
// which asserts we saw the alternatives and could not choose.
check(
  "unresolved over a truncated sweep is incomplete_search, not conflicting",
  resolveRegistryIdentity({ candidates: STEWARDSHIP_CANDIDATES, searchComplete: false, hints: { legalName: "The Stewardship Foundation" } }).state,
  "incomplete_search"
);
check(
  "...and says so, so nobody reads it as a settled ambiguity",
  resolveRegistryIdentity({ candidates: STEWARDSHIP_CANDIDATES, searchComplete: false, hints: { legalName: "The Stewardship Foundation" } }).reason.includes("truncated"),
  true
);
check(
  "no candidates over a truncated sweep is also incomplete_search",
  resolveRegistryIdentity({ candidates: [], searchComplete: false, hints: { legalName: "Anything" } }).state,
  "incomplete_search"
);
// A truncated sweep that still resolves uniquely is settled -- truncation only
// matters when it could have hidden the answer.
check(
  "a unique match on a truncated sweep still resolves",
  resolveRegistryIdentity({
    candidates: STEWARDSHIP_CANDIDATES, searchComplete: false,
    hints: { legalName: "The Stewardship Foundation", location: "Tacoma, WA" },
  }).state,
  "established"
);
// And it must never be mistaken for a settled predicate downstream.
check(
  "incomplete_search leaves the predicate open, not conflicting",
  evaluateLegitimacy({
    identity: resolveRegistryIdentity({ candidates: [], searchComplete: false, hints: { legalName: "X Foundation" } }),
    grantmaking: null, regimePublishesFilings: true,
  }).state,
  "insufficient_evidence"
);

// ---------------------------------------------------------------------------
section("Legal-name ranking: trailing apparatus vs a different entity");
// ---------------------------------------------------------------------------

// The real WA candidate set for "Stewardship Foundation", verbatim. Seven
// organizations, all containing our only distinctive token, all in Tacoma's
// state. State and containment alone cannot separate them.
const WA_STEWARDSHIP = [
  cand("261088224", "Asset Stewardship Foundation", "Tacoma", "WA"),
  cand("830486316", "Olympic Stewardship Foundation", "Port Hadlock", "WA"),
  cand("911995740", "Johnson Family Stewardship Foundation", "Tacoma", "WA"),
  cand("862245115", "Timothy Christian Stewardship Foundation", "Camano Island", "WA"),
  cand("873696497", "Williams Family Stewardship Foundation", "Bellevue", "WA"),
  cand("911924333", "Lake Forest Park Stewardship Foundation", "Kenmore", "WA"),
  cand("916020515", "Stewardship Foundation C D A B & W T Weyerhaeuser Ttees", "Tacoma", "WA"),
];

// A registry legal name appends trustee and registration apparatus to the
// operating name. Our name appearing as a PREFIX means the extra tokens are
// that apparatus; our name appearing after a qualifier means someone made a
// different organization. That asymmetry is the whole signal.
const stewardship = resolveRegistryIdentity({
  candidates: WA_STEWARDSHIP, searchComplete: true,
  hints: { legalName: "The Stewardship Foundation", location: "Tacoma, Washington" },
});
check("the real WA set resolves to the Weyerhaeuser trust", stewardship.ein, "916020515");

// NARROW BY DESIGN. Trailing words are not universally legal boilerplate --
// "Redwood Trust Foundation of Oregon" extends "Redwood Trust" and is a
// different organization. The prefix rule only decides when the candidate is
// independently corroborated; with no known location the tie must stand.
check(
  "the prefix rule does not fire without corroborating location",
  resolveRegistryIdentity({
    candidates: WA_STEWARDSHIP, searchComplete: true,
    hints: { legalName: "The Stewardship Foundation" },
  }).state,
  "conflicting"
);
check(
  "...and the same set with a location does resolve",
  resolveRegistryIdentity({
    candidates: WA_STEWARDSHIP, searchComplete: true,
    hints: { legalName: "The Stewardship Foundation", location: "Tacoma, Washington" },
  }).state,
  "established"
);
check("...on the prefix rule, not on a score", stewardship.reason.includes("extends our name"), true);
check("...and keeps the six it ruled out", stewardship.alternatives.length, 6);

// The asymmetry must hold in the other direction: a qualifier in FRONT is a
// different entity and must never be selected.
check(
  "a prefixed qualifier does not count as extending our name",
  resolveRegistryIdentity({
    candidates: [cand("261088224", "Asset Stewardship Foundation", "Tacoma", "WA"), cand("911995740", "Johnson Family Stewardship Foundation", "Tacoma", "WA")],
    searchComplete: true,
    hints: { legalName: "The Stewardship Foundation", location: "Tacoma, Washington" },
  }).state,
  "conflicting"
);
// Anchored at a token boundary, or "Stewardshipfoundation Trust" would match.
check(
  "the prefix must end on a token boundary",
  resolveRegistryIdentity({
    candidates: [cand("111111111", "Stewardship Foundational Services", "Tacoma", "WA"), cand("222222222", "Redwood Stewardship Foundation", "Tacoma", "WA")],
    searchComplete: true,
    hints: { legalName: "Stewardship Foundation", location: "Tacoma, Washington" },
  }).state,
  "conflicting"
);

// ---------------------------------------------------------------------------
section("Grantmaking: what each form type can and cannot say");
// ---------------------------------------------------------------------------

check(
  "a 990-PF with grants paid is established",
  evaluateGrantmaking(org({ filings: [filing(2023, 7549735)] }), { now: NOW }).state,
  "established"
);

// The finding that reshaped this predicate. A 990 filer's extract has no
// grants-paid field, so the registry cannot answer -- and that is NOT the same
// as looking and finding nothing.
check(
  "a 990 filer's grantmaking is not_applicable at this source",
  evaluateGrantmaking(org({ pfFilingRequirementCode: 0, filings: [filing(2023, null, 0)] }), { now: NOW }).state,
  "not_applicable"
);
check(
  "...and says why, so nobody re-runs looking for it",
  evaluateGrantmaking(org({ pfFilingRequirementCode: 0, filings: [filing(2023, null, 0)] }), { now: NOW }).reason.includes("not published"),
  true
);

check(
  "a 990-PF with no filings is insufficient",
  evaluateGrantmaking(org({ filings: [] }), { now: NOW }).state,
  "insufficient_evidence"
);
check(
  "filings that exist but carry no data say so",
  evaluateGrantmaking(org({ filings: [], filingsWithoutDataCount: 13 }), { now: NOW }).reason,
  "filings exist but none carry structured data"
);
check(
  "every filing reporting zero is insufficient, never a dismissal",
  evaluateGrantmaking(org({ filings: [filing(2023, 0), filing(2022, 0)] }), { now: NOW }).state,
  "insufficient_evidence"
);
check(
  "an older paying filing still establishes grantmaking",
  evaluateGrantmaking(org({ filings: [filing(2023, 0), filing(2022, 5000000)] }), { now: NOW }).state,
  "established"
);

// Age never dismisses. Stewardship's newest filing is tax year 2023 against a
// 2026 clock -- three years, because filings lag and aggregators lag again.
// Dismissing a $97M foundation for that would be a wrong dismissal.
const aged = evaluateGrantmaking(org({ filings: [filing(2023, 7549735)] }), { now: NOW });
check("a three-year-old filing still establishes grantmaking", aged.state, "established");
check("...and the age is recorded", aged.yearsSinceFiling, 3);
check("...and three years is not yet stale", aged.stale, false);
const veryAged = evaluateGrantmaking(org({ filings: [filing(2019, 7549735)] }), { now: NOW });
check("seven years is stale", veryAged.stale, true);
check("...but stale still does not change the verdict", veryAged.state, "established");

// ---------------------------------------------------------------------------
section("Combining into the four-valued predicate");
// ---------------------------------------------------------------------------

const established = resolveRegistryIdentity({ candidates: STEWARDSHIP_CANDIDATES, hints: { legalName: "The Stewardship Foundation", location: "Tacoma, WA" } });
const conflicting = resolveRegistryIdentity({ candidates: NCF_CANDIDATES, searchComplete: true, hints: { legalName: "National Christian Foundation" } });
const paying = evaluateGrantmaking(org({ filings: [filing(2023, 7549735)] }), { now: NOW });
const unanswerable: GrantmakingOutcome = evaluateGrantmaking(org({ pfFilingRequirementCode: 0, filings: [filing(2023, null, 0)] }), { now: NOW });

check(
  "identified and paying: established",
  evaluateLegitimacy({ identity: established, grantmaking: paying, regimePublishesFilings: true }).state,
  "established"
);
check(
  "conflicting identity dominates everything downstream",
  evaluateLegitimacy({ identity: conflicting, grantmaking: paying, regimePublishesFilings: true }).state,
  "conflicting"
);

// The subtle one. The FACT is not_applicable at this source; the PREDICATE is
// still open, because Tier 2 can answer it. Reporting not_applicable here
// would tell the user nothing more could be learned, which is false.
const openAtTier1 = evaluateLegitimacy({ identity: established, grantmaking: unanswerable, regimePublishesFilings: true });
check("identified, grantmaking unanswerable here: predicate stays open", openAtTier1.state, "insufficient_evidence");
check("...and the underlying fact keeps its own status", openAtTier1.grantmaking?.state, "not_applicable");
check("...and it points at where the answer lives", openAtTier1.reason.includes("own material"), true);

// An individual has no filings to be missing.
check(
  "a subject with no filing regime is not_applicable, not a failure",
  evaluateLegitimacy({ identity: established, grantmaking: null, regimePublishesFilings: false }).state,
  "not_applicable"
);

// ---------------------------------------------------------------------------
section("Every prospect-scoped run query names its pipeline");
// ---------------------------------------------------------------------------

// The countermeasure, not just the rule.
//
// Two pipelines share research_runs so they can be compared per prospect. The
// cost is that every query asking for "the latest run for this prospect" must
// say WHICH pipeline, and this was got wrong immediately: publishing one
// qualification tier made it the newest run, so the Research tab reported it as
// research in flight and the orphan sweep would have marked it errored for
// never finishing. Four readers had to be corrected by hand.
//
// This test is what stops the fifth. Any research_runs query filtering by
// prospect_id AND ordering (i.e. asking for "the latest one") must also filter
// by pipeline. Version allocation is exempt and says why at its call site:
// versions are unique per prospect ACROSS pipelines, so it must see all of them.
const runQueryFiles = SRC_DIRS.flatMap((d) => walk(d));
const unscoped: string[] = [];
for (const file of runQueryFiles) {
  const src = readFileSync(file, "utf8");
  let from = src.indexOf('.from("research_runs")');
  while (from !== -1) {
    // The statement runs to the first semicolon that ends the chain.
    const end = src.indexOf(";", from);
    const stmt = src.slice(from, end === -1 ? src.length : end);
    const scopedToProspect = stmt.includes('.eq("prospect_id"');
    const asksForLatest = stmt.includes(".order(");
    const namesPipeline = stmt.includes('.eq("pipeline"');
    // allocateResearchRunVersion: exempt by design, see lib/research.ts.
    const isAllocator = stmt.includes('.select("version")');
    if (scopedToProspect && asksForLatest && !namesPipeline && !isAllocator) {
      unscoped.push(`${file.replace(/\\/g, "/")}:${src.slice(0, from).split("\n").length}`);
    }
    from = src.indexOf('.from("research_runs")', from + 1);
  }
}
check("no prospect-scoped 'latest run' query omits the pipeline filter", unscoped, []);

// ---------------------------------------------------------------------------
section("One answer to 'are these the same funder?'");
// ---------------------------------------------------------------------------

// The reporting bug this fixes: three National Christian Foundation rows keyed
// on their display names produced three keys, and a report claiming 32 distinct
// funders from 32 rows containing a known triplicate.
const NCF_ROWS = [
  { id: "a", name: "National Christian Foundation (NCF) — Donor Advised Fund / Regranting", website: "https://www.ncfgiving.com/" },
  { id: "b", name: "National Christian Foundation", website: "https://ncfgiving.com" },
  { id: "c", name: "National Christian Foundation (NCF)", website: "ncfgiving.com" },
];
check(
  "three NCF rows collapse to one funder",
  new Set(NCF_ROWS.map((r) => funderIdentityKey(r).key)).size,
  1
);
check("...keyed on the domain, not the display name", funderIdentityKey(NCF_ROWS[0]).basis, "domain");

// Authority order: EIN beats domain beats name.
check("a confirmed EIN wins", funderIdentityKey({ ein: "91-6020515", website: "x.org", name: "Whatever" }), { key: "ein:916020515", basis: "ein" });
check("a domain beats a name", funderIdentityKey({ website: "https://maclellan.net/grants", name: "Maclellan Foundation" }).basis, "domain");
check(
  "without either, the ORGANIZATION name is used, not the opportunity",
  funderIdentityKey({ name: "Missio Nexus — Ministry Innovation Fund" }).key,
  funderIdentityKey({ name: "Missio Nexus" }).key
);
check("two genuinely different funders do not collapse", funderIdentityKey({ name: "Maclellan Foundation" }).key === funderIdentityKey({ name: "Mary McClellan Foundation" }).key, false);
check("a row with nothing usable falls back to its own id", funderIdentityKey({ id: "row-1" }), { key: "row:row-1", basis: "row" });

// ---------------------------------------------------------------------------
section("Site evidence narrows; it never decides");
// ---------------------------------------------------------------------------

// A site-derived EIN is a lead, not an identity. If the website is wrongly
// attributed to this prospect, taking its EIN as given resolves us confidently
// to an unrelated organization -- the worst failure available.
check(
  "a site-derived EIN does not resolve on its own",
  resolveRegistryIdentity({
    candidates: NCF_CANDIDATES, searchComplete: true,
    hints: { ein: "30-0209280", einSource: "site_evidence", legalName: "National Christian Foundation" },
  }).state,
  "conflicting"
);
check(
  "...while a prospect-confirmed EIN still does",
  resolveRegistryIdentity({
    candidates: NCF_CANDIDATES, searchComplete: true,
    hints: { ein: "30-0209280", einSource: "prospect", legalName: "National Christian Foundation" },
  }).state,
  "established"
);

// Corroboration is what makes a site-derived EIN usable.
check(
  "a record sharing our name tokens corroborates",
  corroborateRegistryRecord({ name: "Maclellan Foundation Inc", state: "TN" }, { names: ["Maclellan Foundation"], location: "Chattanooga, TN" }).by,
  "name+state"
);
check(
  "state alone is enough when the legal name diverges",
  corroborateRegistryRecord({ name: "Weyerhaeuser Family Trust", state: "WA" }, { names: ["The Stewardship Foundation"], location: "Tacoma, WA" }).by,
  "state"
);
check(
  "name alone is enough when we know no state",
  corroborateRegistryRecord({ name: "Maclellan Foundation Inc", state: "TN" }, { names: ["Maclellan Foundation"] }).by,
  "name"
);
// The case this exists for: a footer EIN belonging to somebody else entirely.
check(
  "a record matching on neither is rejected",
  corroborateRegistryRecord({ name: "Acme Widgets Charitable Trust", state: "DE" }, { names: ["Maclellan Foundation"], location: "Chattanooga, TN" }).corroborated,
  false
);
check(
  "...and says why",
  corroborateRegistryRecord({ name: "Acme Widgets Charitable Trust", state: "DE" }, { names: ["Maclellan Foundation"], location: "Chattanooga, TN" }).reason.includes("neither"),
  true
);

// Site evidence may break a tie that our stored data could not...
const ncfWithSite = resolveRegistryIdentity({
  candidates: NCF_CANDIDATES, searchComplete: true,
  hints: { legalName: "National Christian Foundation", siteEvidence: { states: ["GA"] } },
});
check("site-derived state breaks a tie our own data could not", ncfWithSite.ein, "300209280");
check("...and says the site narrowed it", ncfWithSite.reason.includes("own site"), true);

// ...but must never EXCLUDE. A wrongly attributed site pointing at a state
// where none of the real candidates sit has to leave the tie standing, not
// empty the pool.
check(
  "site evidence matching nothing leaves the verdict unchanged",
  resolveRegistryIdentity({
    candidates: NCF_CANDIDATES, searchComplete: true,
    hints: { legalName: "National Christian Foundation", siteEvidence: { states: ["ZZ"] } },
  }).state,
  "conflicting"
);
check(
  "...and still lists every candidate it could not choose between",
  resolveRegistryIdentity({
    candidates: NCF_CANDIDATES, searchComplete: true,
    hints: { legalName: "National Christian Foundation", siteEvidence: { states: ["ZZ"] } },
  }).alternatives.length,
  4
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
