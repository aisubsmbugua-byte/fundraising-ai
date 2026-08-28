// Demonstrates the Stage 1 entity-resolution rules (see
// docs/decisions/0002-research-agent.md). All of this is pure, deterministic
// string logic -- no Anthropic call, no DB -- so it runs without an
// ANTHROPIC_API_KEY, unlike the other scripts.
//
// Every case below is built from data captured in a REAL run, named in the
// comment above it. That matters: each of these rules exists because the
// previous version of the code got that specific case wrong in production.
//
// Usage: npx tsx scripts/test-entity-validation.ts

import {
  classifyRunSources,
  deriveEntityNameToken,
  locationConflicts,
  primarySourceEin,
  resolveRunEntity,
  type ResearchEntityValidationStatus,
} from "../lib/research";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}\n      got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}

const MACLELLAN_EIN = "62-6041468";
const SIBLING_EIN = "23-7159802"; // Robert L. & Kathrina H. Maclellan Foundation
const maclellanToken = deriveEntityNameToken("Maclellan Foundation");
const servantsToken = deriveEntityNameToken("Servants Heart Foundation");

console.log(`Name tokens: "${maclellanToken}" / "${servantsToken}"\n`);

// ---------------------------------------------------------------------------
console.log("--- EIN detection ---");

// ProPublica full-filing URLs carry BOTH the EIN (9 digits) and a filing id
// (18 digits). Only the EIN may be picked up, or every filing page would
// register a nonsense entity.
check(
  "18-digit filing id is not mistaken for an EIN",
  primarySourceEin("https://projects.propublica.org/nonprofits/organizations/237159802/202303199349108860/full", []),
  SIBLING_EIN
);
check(
  "a source naming two EINs has no single primary entity",
  primarySourceEin("https://example.org/list", ["Includes 62-6041468 and 23-7159802"]),
  null
);

// ---------------------------------------------------------------------------
console.log("\n--- Identity resolution: priority, not popularity ---");

// Servants Heart v1: the WRONG entity (Carlisle PA) won a majority vote
// because it happened to state its EIN in more page titles. Two competing
// authoritative filings must now resolve to nothing at all.
check(
  "two competing authoritative filings -> ambiguous, no EIN chosen",
  resolveRunEntity({
    storedEin: null,
    prospectWebsite: null,
    nameToken: servantsToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/582218044", texts: ["Servants Heart Foundation Inc"], sourceType: "irs_filing" },
      { url: "https://getholdings.com/nonprofits/ein/882110698", texts: ["Servants Heart Family Foundation"], sourceType: "irs_filing" },
    ],
  }),
  { ein: null, method: "ambiguous_filings" }
);

check(
  "a human-confirmed EIN on the prospect wins outright",
  resolveRunEntity({
    storedEin: "58-2218044",
    prospectWebsite: null,
    nameToken: servantsToken,
    sources: [
      { url: "https://getholdings.com/nonprofits/ein/882110698", texts: ["Servants Heart Family Foundation"], sourceType: "irs_filing" },
    ],
  }),
  { ein: "58-2218044", method: "stored_ein" }
);

check(
  "a single authoritative filing resolves identity",
  resolveRunEntity({
    storedEin: null,
    prospectWebsite: "https://www.maclellan.net",
    nameToken: maclellanToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/626041468", texts: ["Maclellan Foundation Inc"], sourceType: "irs_filing" },
      { url: "https://example.org/blog", texts: ["A post about the Maclellan Foundation"], sourceType: "secondary_source" },
    ],
  }),
  { ein: MACLELLAN_EIN, method: "authoritative_filing" }
);

check(
  "a non-matching name may not vote at all",
  resolveRunEntity({
    storedEin: null,
    prospectWebsite: null,
    nameToken: maclellanToken,
    sources: [{ url: "https://projects.propublica.org/nonprofits/organizations/166032078", texts: ["Mclain Foundation"], sourceType: "irs_filing" }],
  }),
  { ein: null, method: "unresolved" }
);

// ---------------------------------------------------------------------------
console.log("\n--- Entity-level classification (Maclellan v21 defect) ---");

// The real defect: ONE affiliated foundation appeared at three URLs and got
// two different verdicts, because its summary page returned a bare-domain
// title while its two filing pages carried the full name.
const siblingSources = [
  {
    url: "https://projects.propublica.org/nonprofits/organizations/237159802/202303199349108860/full",
    texts: ["Robert L And Kathrina H Maclellan Foundation - Full Filing - Nonprofit Explorer - ProPublica"],
  },
  {
    url: "https://projects.propublica.org/nonprofits/organizations/237159802",
    texts: ["projects.propublica.org", "Summary charts: organization finances over time\n\nRevenue\n$2.7M (2024)"],
  },
  {
    url: "https://projects.propublica.org/nonprofits/organizations/237159802/202033219349101313/full",
    texts: ["Robert L And Kathrina H Maclellan Foundation - Full Filing - Nonprofit Explorer - ProPublica"],
  },
];
const siblingResult = classifyRunSources({
  sources: siblingSources,
  prospectWebsite: "https://www.maclellan.net",
  prospectLocation: "Chattanooga, TN",
  nameToken: maclellanToken,
  confirmedEin: MACLELLAN_EIN,
});
check(
  "same entity at 3 URLs -> ONE shared verdict (bare-domain page inherits identity)",
  siblingResult.map((r) => r.status),
  ["affiliate_related_entity", "affiliate_related_entity", "affiliate_related_entity"]
);
check("...and every URL is attributed to the same entity", Array.from(new Set(siblingResult.map((r) => r.sourceEin))), [SIBLING_EIN]);

// Genuinely different organizations whose names are near-misses. These are
// real sources from the Maclellan v21 run.
const nearMisses = classifyRunSources({
  sources: [
    { url: "https://projects.propublica.org/nonprofits/organizations/166032078", texts: ["Mclain Foundation - Nonprofit Explorer - ProPublica"] },
    { url: "https://projects.propublica.org/nonprofits/organizations/364055957", texts: ["Maclean Foundation - Nonprofit Explorer - ProPublica"] },
    { url: "https://projects.propublica.org/nonprofits/organizations/650820881", texts: ["Mccall Foundation - Nonprofit Explorer - ProPublica"] },
  ],
  prospectWebsite: "https://www.maclellan.net",
  prospectLocation: "Chattanooga, TN",
  nameToken: maclellanToken,
  confirmedEin: MACLELLAN_EIN,
});
const EXCLUDED: ResearchEntityValidationStatus[] = ["entity_mismatch", "unrelated_excluded"];
check(
  "Mclain / Maclean / Mccall are all excluded, not admitted as affiliates",
  nearMisses.every((r) => EXCLUDED.includes(r.status)),
  true
);

// The researched entity itself.
check(
  "the confirmed entity's own filing page -> ein_confirmed",
  classifyRunSources({
    sources: [{ url: "https://projects.propublica.org/nonprofits/organizations/626041468", texts: ["projects.propublica.org"] }],
    prospectWebsite: "https://www.maclellan.net",
    prospectLocation: "Chattanooga, TN",
    nameToken: maclellanToken,
    confirmedEin: MACLELLAN_EIN,
  })[0].status,
  "ein_confirmed"
);

// ---------------------------------------------------------------------------
console.log("\n--- Location: a tolerant signal, never an exclusion ---");

// THE regression guard. The real prospect record says "Irvine, CA" while the
// organization's own filings say "Newport Beach, CA" -- adjacent cities in
// one metro. A city-level match would have rejected the correct organization.
check("Irvine, CA vs Newport Beach, CA -> no conflict (same state)", locationConflicts("Irvine, CA", "Newport Beach, California 92660"), false);
check("Irvine, CA vs Carlisle, PA -> conflict", locationConflicts("Irvine, CA", "Servants Heart Family Foundation — Carlisle, PA"), true);
check("no location on the prospect -> never conflicts", locationConflicts(null, "Carlisle, PA"), false);
check("no location in the evidence -> never conflicts", locationConflicts("Irvine, CA", "A page with no location at all"), false);

check(
  "a conflicting state DOWNGRADES to unresolved -- it does not exclude",
  classifyRunSources({
    sources: [{ url: "https://www.instrumentl.com/990-report/servants-heart-family-foundation", texts: ["Servants Heart Family Foundation | Carlisle, PA | 990 Report"] }],
    prospectWebsite: null,
    prospectLocation: "Irvine, CA",
    nameToken: servantsToken,
    confirmedEin: null,
  })[0].status,
  "identity_unresolved"
);

check(
  "the correct entity survives an imprecise stored city",
  classifyRunSources({
    sources: [{ url: "https://www.taxexemptworld.com/organization.asp?tn=1319509", texts: ["Servants Heart Foundation Inc - 501C3 Nonprofit - Newport Beach, CA - 582218044"] }],
    prospectWebsite: null,
    prospectLocation: "Irvine, CA",
    nameToken: servantsToken,
    confirmedEin: null,
  })[0].status,
  "legal_name_confirmed"
);

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
