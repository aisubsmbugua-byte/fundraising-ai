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

import { EXCLUDED_ENTITY_STATUSES } from "../lib/ai/research-extract";
import {
  classifyRunSources,
  entityStatusMeaning,
  isConfirmedDossier,
  deriveEntityNameToken,
  locationConflicts,
  primarySourceEin,
  resolveRunEntity,
  nameMatchDistance,
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
    prospectName: "Servants Heart Foundation",
    prospectWebsite: null,
    nameToken: servantsToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/582218044", title: "Servants Heart Foundation Inc", texts: ["Servants Heart Foundation Inc"], sourceType: "irs_filing" },
      { url: "https://getholdings.com/nonprofits/ein/882110698", title: "Servants Heart Family Foundation", texts: ["Servants Heart Family Foundation"], sourceType: "irs_filing" },
    ],
  }),
  { ein: null, method: "ambiguous_filings" }
);

check(
  "a human-confirmed EIN on the prospect wins outright",
  resolveRunEntity({
    storedEin: "58-2218044",
    prospectName: "Servants Heart Foundation",
    prospectWebsite: null,
    nameToken: servantsToken,
    sources: [
      { url: "https://getholdings.com/nonprofits/ein/882110698", title: "Servants Heart Family Foundation", texts: ["Servants Heart Family Foundation"], sourceType: "irs_filing" },
    ],
  }),
  { ein: "58-2218044", method: "stored_ein" }
);

check(
  "a single authoritative filing resolves identity",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Maclellan Foundation",
    prospectWebsite: "https://www.maclellan.net",
    nameToken: maclellanToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/626041468", title: "Maclellan Foundation Inc", texts: ["Maclellan Foundation Inc"], sourceType: "irs_filing" },
      { url: "https://example.org/blog", title: "A post", texts: ["A post about the Maclellan Foundation"], sourceType: "secondary_source" },
    ],
  }),
  { ein: MACLELLAN_EIN, method: "authoritative_filing" }
);

check(
  "a non-matching name may not vote at all",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Maclellan Foundation",
    prospectWebsite: null,
    nameToken: maclellanToken,
    sources: [{ url: "https://projects.propublica.org/nonprofits/organizations/166032078", title: "Mclain Foundation", texts: ["Mclain Foundation"], sourceType: "irs_filing" }],
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
  ["different_entity_unverified_relation", "different_entity_unverified_relation", "different_entity_unverified_relation"]
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


// ---------------------------------------------------------------------------
console.log("\n--- Affiliate clusters must still resolve (Maclellan v22 regression) ---");

// v22 regressed to 50 facts (from 80) because the sibling foundations are
// themselves IRS filings carrying the family name, so "any matching filing
// may vote" made a family-foundation cluster permanently ambiguous. The
// researched entity's own filing names it almost exactly; its affiliates
// carry extra words naming different people.
check("prospect's own filing is the closest name match", nameMatchDistance("Maclellan Foundation", "The Maclellan Foundation Inc - Nonprofit Explorer - ProPublica"), 2);
check("an affiliate's filing is much further away", nameMatchDistance("Maclellan Foundation", "Robert L And Kathrina H Maclellan Foundation - Full Filing - Nonprofit Explorer - ProPublica"), 5);

check(
  "a family cluster still resolves to the researched entity",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Maclellan Foundation",
    prospectWebsite: "https://www.maclellan.net",
    nameToken: maclellanToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/626041468", title: "The Maclellan Foundation Inc - Nonprofit Explorer - ProPublica", texts: [], sourceType: "irs_filing" },
      { url: "https://projects.propublica.org/nonprofits/organizations/237159802", title: "Robert L And Kathrina H Maclellan Foundation - Full Filing - Nonprofit Explorer - ProPublica", texts: [], sourceType: "irs_filing" },
    ],
  }),
  { ein: MACLELLAN_EIN, method: "authoritative_filing" }
);

// ...but two EQUALLY close competitors are genuinely ambiguous and must not
// be guessed between. This is the real Servants Heart case.
check(
  "two equally-close competitors stay ambiguous",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Servants Heart Foundation",
    prospectWebsite: null,
    nameToken: servantsToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/582218044", title: "Servants Heart Foundation Inc - Nonprofit Explorer - ProPublica", texts: [], sourceType: "irs_filing" },
      { url: "https://getholdings.com/nonprofits/ein/882110698", title: "Servants Heart Family Foundation - Carlisle, PA", texts: [], sourceType: "irs_filing" },
    ],
  }),
  { ein: null, method: "ambiguous_filings" }
);


// ---------------------------------------------------------------------------
console.log("\n--- Different-entity evidence is withheld by CODE, not by prompt ---");

// A differing EIN means a different legal entity. Whether it is an affiliate
// is NOT established -- a family foundation's sibling and an unrelated
// organization that shares a name look identical on the evidence we hold. The
// old label asserted the relationship and let that evidence into extraction
// "as context", which left the guarantee resting on the model obeying.
check("different-entity evidence cannot be cited", EXCLUDED_ENTITY_STATUSES.has("different_entity_unverified_relation"), true);
check("v1 rows carrying the old label are withheld too", EXCLUDED_ENTITY_STATUSES.has("affiliate_related_entity"), true);
check(
  "the old label is re-read without asserting a relationship",
  entityStatusMeaning("affiliate_related_entity", 1).assertedRelationship,
  true
);
check(
  "the current label asserts no relationship",
  entityStatusMeaning("different_entity_unverified_relation", 2).assertedRelationship,
  false
);

console.log("\n--- Unresolved identity cannot become a confirmed dossier ---");
check("stored EIN -> confirmed dossier", isConfirmedDossier({ entity_resolution_method: "stored_ein" }), true);
check("authoritative filing -> confirmed dossier", isConfirmedDossier({ entity_resolution_method: "authoritative_filing" }), true);
check("ambiguous filings -> NOT a confirmed dossier", isConfirmedDossier({ entity_resolution_method: "ambiguous_filings" }), false);
check("unresolved -> NOT a confirmed dossier", isConfirmedDossier({ entity_resolution_method: "unresolved" }), false);
check("a pre-Stage-1 run -> NOT a confirmed dossier", isConfirmedDossier({ entity_resolution_method: null }), false);


// ---------------------------------------------------------------------------
console.log("\n--- Name and corroboration must converge (Servants Heart v6) ---");

// The worst failure this rule has produced. The prospect is "Servants Heart
// Foundation Inc"; a DIFFERENT charity is named exactly "Servants Heart
// Foundation", so it scored a perfect name match, won outright, was confirmed
// with dossier_confirmed true, and the real entity's own sources were then
// discarded as belonging to someone else. 56 evidence fragments were thrown
// away and the dossier described the wrong organization.
check(
  "closest name match with LEAST corroboration must not win",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Servants Heart Foundation",
    prospectWebsite: null,
    nameToken: servantsToken,
    sources: [
      // Perfect name match, but only one source vouches for it.
      { url: "https://projects.propublica.org/nonprofits/organizations/200526547", title: "Servants Heart Foundation - Nonprofit Explorer - ProPublica", texts: [], sourceType: "irs_filing" },
      // One extra word, but corroborated twice -- this is the real prospect.
      { url: "https://www.guidestar.org/profile/58-2218044", title: "Servants Heart Foundation Inc - GuideStar Profile", texts: [], sourceType: "irs_filing" },
      { url: "https://projects.propublica.org/nonprofits/organizations/582218044", title: "Servants Heart Foundation Inc - Nonprofit Explorer - ProPublica", texts: [], sourceType: "irs_filing" },
    ],
  }),
  { ein: null, method: "ambiguous_filings" }
);

// Convergence: the closest name is ALSO the best corroborated, so it stands.
// This is the Maclellan family cluster, which must keep resolving.
check(
  "when both signals agree, identity still resolves",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Maclellan Foundation",
    prospectWebsite: "https://www.maclellan.net",
    nameToken: maclellanToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/626041468", title: "The Maclellan Foundation Inc - Nonprofit Explorer - ProPublica", texts: [], sourceType: "irs_filing" },
      { url: "https://www.guidestar.org/profile/62-6041468", title: "The Maclellan Foundation Inc - GuideStar Profile", texts: [], sourceType: "irs_filing" },
      { url: "https://projects.propublica.org/nonprofits/organizations/237159802", title: "Robert L And Kathrina H Maclellan Foundation - Full Filing - Nonprofit Explorer", texts: [], sourceType: "irs_filing" },
    ],
  }),
  { ein: MACLELLAN_EIN, method: "authoritative_filing" }
);

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
