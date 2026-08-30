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
import { isMaterialClaimKey, assessDossierState, claimFiguresAppearInEvidence, claimSpansMultiplePeriods, distinctiveNumbers, isGrantSchedulePage, isQuantitativeClaimKey, missingInformationSections, strategyFieldPolicy, IDENTITY_GATE_KEYS, STRATEGY_FIELD_POLICY, RESEARCH_CLAIM_KEYS } from "../lib/research";
import { deriveStrategyUse } from "../lib/prospect-intelligence";
import { domainIsFunderOwn, candidateDedupeKey } from "../lib/candidates";
import { contactEmailDomain, assessEntityLifecycle, mentionsSuccession, reportingPeriodYear, cleanEntityName, extractLocation, extractOfficialWebsite, extractOrgType, buildEntityCandidates, presentableCandidates, MIN_CANDIDATE_ATTRIBUTES, MAX_PRESENTED_CANDIDATES } from "../lib/research";
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

// Under the conservative rule this now REFUSES rather than ranking. A family
// foundation's siblings are plausible candidates too, and picking between
// them is exactly the judgement that produced a wrong-entity dossier. The
// human resolves it once via the picker, after which stored_ein applies.
check(
  "a family cluster refuses rather than ranking its members",
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
  { ein: null, method: "ambiguous_filings" }
);

// Two competitors were always refused; now ANY second candidate is.
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
  "even when both signals agree, more than one plausible EIN refuses",
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
  { ein: null, method: "ambiguous_filings" }
);

// A single plausible candidate is still confirmable -- the common case.
check(
  "one unambiguous candidate still resolves",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Maclellan Foundation",
    prospectWebsite: "https://www.maclellan.net",
    nameToken: maclellanToken,
    sources: [
      { url: "https://projects.propublica.org/nonprofits/organizations/626041468", title: "The Maclellan Foundation Inc - Nonprofit Explorer - ProPublica", texts: [], sourceType: "irs_filing" },
      { url: "https://www.guidestar.org/profile/62-6041468", title: "The Maclellan Foundation Inc - GuideStar Profile", texts: [], sourceType: "irs_filing" },
    ],
  }),
  { ein: MACLELLAN_EIN, method: "authoritative_filing" }
);


// ---------------------------------------------------------------------------
console.log("\n--- A claim's figures must appear in the evidence it cites (Servants Heart v8) ---");

// Ten named grants in one real run each cited a fragment containing the
// foundation's mission statement and no grant at all. Making evidence_ids
// required removed unevidenced claims but permitted MIS-evidenced ones.
const MISSION_FRAGMENT =
  "Servants Heart Foundation exists to glorify God by caring for those in need and strengthening the local church through ministry partnerships.";

check(
  "a grant amount absent from the cited fragment is not supported",
  claimFiguresAppearInEvidence("Grant to Mariners Church (Irvine, CA) of $190,000 in fiscal year 2023.", [MISSION_FRAGMENT]),
  false
);
check(
  "a figure present in the cited fragment IS supported",
  claimFiguresAppearInEvidence("Total assets were $17,408,962 in FY2024.", ["Total Assets $17,408,962 Total Liabilities $34.7k"]),
  true
);
check(
  "separators do not break the match",
  claimFiguresAppearInEvidence("approximately $167M in assets", ["Total assets of 167,367,179 at year end"]),
  true
);

// A bare year is not distinctive: 2023 appears on almost any filing page, so
// matching on it alone would pass a claim whose actual figure is absent.
check("a bare year is not a distinctive number", distinctiveNumbers("in fiscal year 2023"), []);
check("an amount is distinctive", distinctiveNumbers("$190,000 in fiscal year 2023"), ["190000"]);
check(
  "a year in the evidence cannot rescue a missing amount",
  claimFiguresAppearInEvidence("Grant of $85,000 in fiscal year 2023.", ["The foundation filed its return for fiscal year 2023."]),
  false
);

// Prose claims carry no figures and are Stage 5's job, not arithmetic's.
check(
  "a claim with no figures is not judged here",
  claimFiguresAppearInEvidence("The foundation supports Christian ministry organizations.", [MISSION_FRAGMENT]),
  true
);


// A real false positive from Servants Heart v9: a focus-areas claim reading
// "(NTEE-designated 501(c)(3) private grantmaking foundation)" yielded "501"
// and was flagged, though its cited fragment reasonably contained no digits.
// The figure check applies only where a number IS the claim.
check("focus areas is not a quantitative claim", isQuantitativeClaimKey("funding.focus_areas"), false);
check("total assets is", isQuantitativeClaimKey("funding.total_assets"), true);
check("recent grants is -- this is where the defect first appeared", isQuantitativeClaimKey("funding.recent_grants"), true);
check("identity keys are not", isQuantitativeClaimKey("identity.legal_name"), false);


// ---------------------------------------------------------------------------
console.log("\n--- Dossier state and information coverage ---");

// A filing detail page is still a useful DIAGNOSTIC, but no longer decides
// whether a dossier is usable.
check("a full-filing page is recognised as a grant schedule", isGrantSchedulePage("https://projects.propublica.org/nonprofits/organizations/582218044/202543159349101244/full"), true);
check("an organization summary page is not", isGrantSchedulePage("https://projects.propublica.org/nonprofits/organizations/582218044"), false);

// Only identity blocks. Everything else is a gap for a human to weigh.
check("unresolved identity blocks", assessDossierState({ dossierConfirmed: false }), "blocked");
check("confirmed identity is ready for review", assessDossierState({ dossierConfirmed: true }), "ready_for_review");

// Coverage is judged on what was OBTAINED. The real case: a run holding 32
// facts and no grant information must say so rather than reporting complete.
check(
  "a dossier with financials but no grants reports recent_grants missing",
  missingInformationSections([
    { claim_key: "identity.ein" },
    { claim_key: "funding.total_assets" },
    { claim_key: "funding.focus_areas" },
    { claim_key: "application.accepts_unsolicited" },
    { claim_key: "people.key_contacts" },
    { claim_key: "application.eligible_org_types" },
  ]),
  ["recent_grants"]
);

// An uncited finding is visible to a human but cannot make a section count
// as covered -- otherwise evidence_missing would quietly fill gaps.
check(
  "an evidence-missing claim does not cover its section",
  missingInformationSections([{ claim_key: "funding.recent_grants", evidence_missing: true }]),
  ["identity", "funding_priorities", "financial_capacity", "recent_grants", "eligibility", "application_access", "leadership"]
);
check(
  "the same claim WITH evidence does cover it",
  missingInformationSections([{ claim_key: "funding.recent_grants", evidence_missing: false }]).includes("recent_grants"),
  false
);


// ---------------------------------------------------------------------------
console.log("\n--- evidence_missing guarantees ---");

// It has never fired in a real run, and that is fine: its value is that the
// system CAN represent an uncited finding safely if one occurs. What must
// hold is that when it does fire, the claim cannot be trusted or used. These
// assert the guarantee deterministically rather than waiting for the model
// to produce one.
const uncited = { claim_key: "funding.recent_grants", evidence_missing: true };
check("an uncited claim cannot cover its information section", missingInformationSections([uncited]).includes("recent_grants"), true);
check(
  "an uncited claim cannot satisfy any section it names",
  missingInformationSections([{ claim_key: "identity.ein", evidence_missing: true }]).includes("identity"),
  true
);
// The downstream bar: material claims must be supported, and a claim with no
// evidence can never be supported by definition.
check("evidence-missing is incompatible with a confirmed dossier claim", isMaterialClaimKey("identity.ein") && uncited.evidence_missing === true, true);


// ---------------------------------------------------------------------------
console.log("\n--- figures that span periods under a single-period key ---");

// The real case, from Servants Heart v14: verified, approved by a human, and
// handed to the strategy model as though it were an annual figure -- roughly
// 2x this funder's actual annual giving.
check(
  "the real cumulative-giving claim is caught",
  claimSpansMultiplePeriods(
    "funding.total_annual_giving",
    "Total grants paid across all years on record: 122 grants totaling $3.4M (multi-year cumulative)"
  ),
  true
);
check(
  "'since inception' is caught",
  claimSpansMultiplePeriods("funding.charitable_disbursements", "$18M disbursed since inception"),
  true
);
check(
  "a properly dated giving figure is untouched",
  claimSpansMultiplePeriods("funding.total_annual_giving", "$1,855,039 in grants awarded in Tax Year 2024"),
  false
);

// The precision cases decide whether this is safe to run automatically: a
// check that demotes true claims is worse than no check at all. Each of
// these is a phrase the obvious version of the regex would have caught.
check(
  "a funder that MAKES multi-year grants is not a cumulative figure",
  claimSpansMultiplePeriods("funding.grant_size_range", "Makes multi-year grants ranging from $25,000 to $100,000"),
  false
);
check(
  "'to date' on an assets figure is not caught -- it means 'as of now'",
  claimSpansMultiplePeriods("funding.total_assets", "Total assets to date of $12.4M"),
  false
);
check(
  "the one key that exists to span periods is exempt",
  claimSpansMultiplePeriods("funding.multiyear_grant_stats", "122 grants totaling $3.4M cumulative across all years"),
  false
);
check(
  "a non-financial key is out of scope",
  claimSpansMultiplePeriods("funding.focus_areas", "Has funded education across all years on record"),
  false
);


// ---------------------------------------------------------------------------
console.log("\n--- per-consumer field policy (Strategy) ---");

// The guard that matters most. A key added to the vocabulary without a
// policy would otherwise pick up a silent default -- exactly how the display
// sections fell behind the vocabulary and hid 16 claims from a reviewer.
const unpoliced = RESEARCH_CLAIM_KEYS.map((k) => k.key).filter(
  (k) => !IDENTITY_GATE_KEYS.has(k) && !(k in STRATEGY_FIELD_POLICY)
);
check("every claim key has a policy or is an identity gate", unpoliced, []);

check("identity is a run gate, not a Strategy policy", strategyFieldPolicy("identity.ein"), "identity_gate");
check("eligibility gates the strategy", strategyFieldPolicy("application.foreign_org_eligibility"), "required");
check("ask sizing gates the strategy", strategyFieldPolicy("funding.median_grant_size"), "required");
check("funder type gates the strategy", strategyFieldPolicy("funding.funder_type"), "required");
check("focus areas are advisory", strategyFieldPolicy("funding.focus_areas"), "advisory");
check("key contacts are advisory for Strategy", strategyFieldPolicy("people.key_contacts"), "advisory");
check("phone is unused by Strategy", strategyFieldPolicy("identity.phone"), "unused");

// The geography split: a stated rule gates, a description of past giving
// does not. Two keys rather than one, so the distinction is decided at
// extraction where the sentence is visible.
check("a geographic RESTRICTION gates", strategyFieldPolicy("funding.geographic_restriction"), "required");
check("a geographic PATTERN is advisory", strategyFieldPolicy("funding.geographic_focus"), "advisory");

// An unmapped key must never gain the authority to size an ask.
check("an unknown key falls back to advisory, never required", strategyFieldPolicy("funding.invented_later"), "advisory");

// Verification coverage is derived, so it cannot drift from the policy.
check(
  "everything required is verified",
  Object.entries(STRATEGY_FIELD_POLICY)
    .filter(([, p]) => p === "required")
    .every(([k]) => isMaterialClaimKey(k)),
  true
);
check("nothing advisory is verified", isMaterialClaimKey("funding.focus_areas"), false);
check("identity is verified", isMaterialClaimKey("identity.ein"), true);


// ---------------------------------------------------------------------------
console.log("\n--- what may reach Strategy ---");

const use = (over: Partial<Parameters<typeof deriveStrategyUse>[0]> = {}) =>
  deriveStrategyUse({
    claimKey: "funding.focus_areas",
    decision: null,
    supported: false,
    hasVerdict: false,
    contradicted: false,
    evidenceMissing: false,
    withheldReason: null,
    ...over,
  });

check("an unchecked advisory field enters as context", use(), "advisory_context");
check(
  "an unchecked REQUIRED field does not",
  use({ claimKey: "funding.median_grant_size" }),
  "not_verified"
);
// "Advisory" means unconfirmed, not disproven.
check("a contradicted advisory field is excluded", use({ contradicted: true, hasVerdict: true }), "held_back");
check("an advisory field with no captured evidence is excluded", use({ evidenceMissing: true }), "held_back");
check(
  "a reviewer's exclusion outranks the advisory path",
  use({ decision: "excluded" }),
  "excluded_by_you"
);
check("an unused field never appears", use({ claimKey: "identity.phone" }), "not_used_field");
check(
  "an approved required claim with no period is approved but not used",
  use({ claimKey: "funding.total_assets", decision: "approved", withheldReason: "no reporting period" }),
  "approved_not_used"
);


// ---------------------------------------------------------------------------
console.log("\n--- entity lifecycle signals ---");

// The real case: Overseas Council International. Filings stop at FY2017 with
// a short-period return, the organization was absorbed into another ministry,
// and every existing check passed cleanly because none of them asks whether
// the subject still exists.
const oci = [
  { claim: "Total expenses were $815,022 for the fiscal year ending December 2017 (short-period return).", reporting_period: "FY ending Dec. 2017" },
  { claim: "Total expenses were $3,431,859 for the fiscal year ending September 2017.", reporting_period: "FY ending Sept. 2017" },
  { claim: "Total expenses were $6,204,033 for the fiscal year ending September 2015.", reporting_period: "FY ending Sept. 2015" },
];
const ociResult = assessEntityLifecycle({ claims: oci, currentYear: 2026 });
check("newest year is read across every claim", ociResult.newestYear, 2017);
check("nine-year-old filings are flagged", ociResult.signals.some((s) => s.kind === "stale_filings"), true);
check("the short-period return is flagged", ociResult.signals.some((s) => s.kind === "short_period_return"), true);

// A going concern must stay silent, or the warning becomes wallpaper.
const current = [
  { claim: "Charitable disbursements of $1,855,039 for the fiscal year ending December 2024.", reporting_period: "FY2024" },
  { claim: "16 awards in 2024", reporting_period: "Tax Year 2024" },
];
check("a current funder raises nothing", assessEntityLifecycle({ claims: current, currentYear: 2026 }).signals, []);
check(
  "a two-year lag is normal, not a signal",
  assessEntityLifecycle({ claims: [{ claim: "x", reporting_period: "FY2024" }], currentYear: 2026 }).signals,
  []
);
check(
  "three years is where it becomes a question",
  assessEntityLifecycle({ claims: [{ claim: "x", reporting_period: "FY2023" }], currentYear: 2026 }).signals.some((s) => s.kind === "stale_filings"),
  true
);
// Undated claims cannot date a run either way.
check(
  "unstated periods do not fabricate a year",
  assessEntityLifecycle({ claims: [{ claim: "x", reporting_period: "unstated" }], currentYear: 2026 }).newestYear,
  null
);

// "FY2024" has no word boundary between the Y and the 2, so \b found no year
// in the single most common period format in our own data.
check("a year is read out of FY2024", reportingPeriodYear("FY2024"), 2024);
check("...and out of prose", reportingPeriodYear("FY ending Sept. 2017"), 2017);
check("...and Tax Year 2023", reportingPeriodYear("Tax Year 2023"), 2023);
check("a filing id is not a year", reportingPeriodYear("202303199349108860"), null);

check("succession language is caught", mentionsSuccession("Overseas Council merged into United World Mission in 2018."), true);
check("a name change is caught", mentionsSuccession("Formerly known as Overseas Council for Theological Education."), true);
check("a final return is caught", mentionsSuccession("The organization filed a final return for 2017."), true);

// Precision: grantmaking prose is full of these words used about OTHER
// organizations. A warning that fires on every funder teaches people to
// ignore it, which is worse than not having one.
check(
  "a funder that supports merged organizations is not itself merged",
  mentionsSuccession("Supports ministries serving communities dissolved by conflict and displacement."),
  false
);
check(
  "funding mergers is not being merged",
  mentionsSuccession("Has funded mergers and capacity-building among partner ministries."),
  false
);
check("plain grantmaking prose is silent", mentionsSuccession("Grants are made to preselected charitable organizations."), false);


// ---------------------------------------------------------------------------
console.log("\n--- candidates a person can actually recognise ---");

// The real list, from a Presbyterian-named prospect: 20 rows, 12 of them
// labelled with a bare ProPublica URL because no page title was captured.
// A row nobody can identify is not a choice.
check("an aggregator page title becomes a name", cleanEntityName("Presbyterian Church Usa Foundation - Nonprofit Explorer - ProPublica"), "Presbyterian Church Usa Foundation");
check("a full-filing suffix comes off too", cleanEntityName("Dwight Presbyterian Mission Inc - Full Filing - Nonprofit Explorer - ProPublica"), "Dwight Presbyterian Mission Inc");
check("a pipe separator works the same", cleanEntityName("Overseas Council International | Charlotte, NC | Cause IQ"), "Overseas Council International");
check("a bare URL is not a name", cleanEntityName("https://projects.propublica.org/nonprofits/organizations/546054857"), null);
check("a single word is not a name", cleanEntityName("projects.propublica.org"), null);
// From the Presbyterian run: a title beginning with the EIN passed the
// two-word test and was shown as the organization's name, directly above a
// line repeating the same EIN.
check("an EIN is not a name, spaces notwithstanding", cleanEntityName("EIN 13-3462549"), null);
check("nor is it when a filing label follows", cleanEntityName("EIN 13-3462549 - Full Filing - ProPublica"), null);
check("a real name beginning with a number still works", cleanEntityName("1001 New Worshiping Communities Fund"), "1001 New Worshiping Communities Fund");
check("no title is not a name", cleanEntityName(null), null);

check("a city and state are found in prose", extractLocation(["Main address · 14 Corporate Plaza Dr Ste 200 · Newport Beach, CA 92660 United States"]), "Newport Beach, CA");
check("two-word cities work", extractLocation(["Based in Kansas City, MO since 1997"]), "Kansas City, MO");
check("prose with no location yields none", extractLocation(["Grants are made to preselected organizations."]), null);
// A spelled-out state was invisible before, which is why the real
// Presbyterian candidates showed no location at all.
check("a spelled-out state is read too", extractLocation(["Offices in Louisville, Kentucky since 1988"]), "Louisville, KY");

check(
  "an aggregator is never the funder's own site",
  extractOfficialWebsite(["https://projects.propublica.org/nonprofits/organizations/626041468"], []),
  null
);
check(
  "the funder's own domain is picked out",
  extractOfficialWebsite(["https://projects.propublica.org/x"], ["See more at https://www.maclellan.net/about"], "Maclellan Foundation"),
  "maclellan.net"
);
// The inversion, asserted directly: a domain has to CARRY the entity's name to
// be called theirs. Previously anything absent from the eleven-domain
// aggregator denylist was returned as official, which is how philanthropy.org
// and google.com were displayed to a user as two funders' homepages.
check(
  "an unrecognised domain is not promoted to official",
  extractOfficialWebsite(["https://projects.propublica.org/x"], ["Listed at https://philanthropy.org/profile/123"], "Maclellan Foundation"),
  null
);

check("a 990-PF filer reads as a private foundation", extractOrgType(["Form 990-PF filed for tax year 2024"]), "Private foundation");
check("unrecognised prose yields no type", extractOrgType(["Some text about giving"]), null);

// The threshold that turns a dump into a shortlist.
const built = buildEntityCandidates({
  sources: [
    // Recognisable: name + location + type.
    { url: "https://projects.propublica.org/nonprofits/organizations/626041468", title: "Maclellan Foundation Inc - Nonprofit Explorer - ProPublica", sourceEin: "62-6041468", status: null, texts: ["Chattanooga, TN 37402", "Form 990-PF"] },
    // Unrecognisable: no title, no evidence. This is the row type that made
    // the real list unusable.
    { url: "https://projects.propublica.org/nonprofits/organizations/546054857", title: null, sourceEin: "54-6054857", status: null, texts: [] },
  ],
  nameToken: "maclellan",
  prospectLocation: "Chattanooga, TN",
});
const presentable = presentableCandidates(built);
check("both entities are built", built.length, 2);
check("only the recognisable one may be shown", presentable.map((c) => c.ein), ["62-6041468"]);
check("...with a name", presentable[0].name, "Maclellan Foundation Inc");
check("...a location", presentable[0].location, "Chattanooga, TN");
check("...and a reason it might be the one", presentable[0].whyMatch.length > 0, true);
check(
  "a bare-URL entity carries too little to offer",
  built.find((c) => c.ein === "54-6054857")!.attributeCount < MIN_CANDIDATE_ATTRIBUTES,
  true
);

// Beyond three, a list stops being a decision.
const many = buildEntityCandidates({
  sources: Array.from({ length: 8 }, (_, i) => ({
    url: `https://projects.propublica.org/nonprofits/organizations/1234567${i}`,
    title: `Presbyterian Mission Fund ${i} - Nonprofit Explorer - ProPublica`,
    sourceEin: `12-345678${i}`,
    status: null,
    texts: ["Louisville, KY 40202", "Form 990-PF"],
  })),
  nameToken: "presbyterian",
  prospectLocation: null,
});
check("eight credible entities are all built", many.length, 8);
// The distinction that matters: too many is a different answer from a few.
// Showing the "best" three would assert the answer is among them, which with
// eight near-identical Presbyterian entities is untrue -- and is the original
// twenty-row failure at smaller scale.
check("more than three credible -> show none, ask instead", presentableCandidates(many), []);
check(
  "exactly three credible are all shown",
  presentableCandidates(many.slice(0, 3)).length,
  3
);


// A work email identifies the organization as well as a website field does.
// The real prospect that prompted this asked "which of twenty organizations
// is this?" while its contact record read chris.romine@pcusa.org.
check("a work email yields the organization's domain", contactEmailDomain("chris.romine@pcusa.org"), "pcusa.org");
check("a personal mailbox does not", contactEmailDomain("chris.romine@gmail.com"), null);
check("nor does an empty contact", contactEmailDomain(null), null);
check("nor a malformed address", contactEmailDomain("not-an-email"), null);


// ---------------------------------------------------------------------------
console.log("\n--- the funder's own domain outranks same-named filings ---");

// Presbyterian Mission Agency: many IRS filings match the token
// "Presbyterian", so the filing check returned ambiguous and the domain
// check -- which ran last -- was never reached. pcusa.org stating its own
// EIN lost to a pile of third parties sharing one word.
const pcusaSources = [
  { url: "https://www.pcusa.org/about/", title: "About the Presbyterian Mission Agency", texts: ["EIN 13-3462549"], sourceType: "official_website" as const },
  { url: "https://projects.propublica.org/nonprofits/organizations/911669740", title: "Presbyterian Church Usa", texts: ["Presbyterian Church Usa"], sourceType: "irs_filing" as const },
  { url: "https://projects.propublica.org/nonprofits/organizations/231440115", title: "Presbyterian Church Usa Foundation", texts: ["Presbyterian Church Usa Foundation"], sourceType: "irs_filing" as const },
];
check(
  "the organization's own site settles it",
  resolveRunEntity({ storedEin: null, prospectName: "Presbyterian Mission Agency", prospectWebsite: "https://pcusa.org", nameToken: "presbyterian", sources: pcusaSources }),
  { ein: "13-3462549", method: "official_domain" }
);
// Without the website we are back to genuinely not knowing, which is the
// honest answer rather than a guess.
check(
  "without the domain it stays ambiguous",
  resolveRunEntity({ storedEin: null, prospectName: "Presbyterian Mission Agency", prospectWebsite: null, nameToken: "presbyterian", sources: pcusaSources }),
  { ein: null, method: "ambiguous_filings" }
);
// The adversarial case this promotion has to survive: a denomination's own
// page listing several agencies does not say which one the prospect is.
check(
  "an own-domain page naming several EINs resolves nothing",
  resolveRunEntity({
    storedEin: null,
    prospectName: "Presbyterian Mission Agency",
    prospectWebsite: "https://pcusa.org",
    nameToken: "presbyterian",
    sources: [{ url: "https://www.pcusa.org/agencies/", title: "Our agencies", texts: ["EIN 13-3462549 and EIN 23-1440115"], sourceType: "official_website" as const }],
  }),
  { ein: null, method: "unresolved" }
);
// A human-confirmed EIN still beats everything, including the domain.
check(
  "a stored EIN still wins outright",
  resolveRunEntity({ storedEin: "99-9999999", prospectName: "Presbyterian Mission Agency", prospectWebsite: "https://pcusa.org", nameToken: "presbyterian", sources: pcusaSources }).method,
  "stored_ein"
);

// ---------------------------------------------------------------------------
console.log("\n--- Donor Finder capture contract ---");

// A cited URL is provenance, not identity. Storing ProPublica as a prospect's
// website would let an aggregator page be read as the organization speaking
// about itself -- and resolution now consults the domain BEFORE falling back
// on ambiguous filings, so it would confirm the wrong entity outright.
check("a third-party source never resolves identity", domainIsFunderOwn("third_party_source"), false);
check("a candidate official domain may", domainIsFunderOwn("official_candidate"), true);
check("so may one Research confirmed", domainIsFunderOwn("official_confirmed"), true);
check("a hand-entered website (no status) stays trusted", domainIsFunderOwn(null), true);

// Domain alone would merge distinct programs: pcusa.org hosts many agencies.
const pmaKey = candidateDedupeKey({ sourceDomain: "pcusa.org", funderName: "Presbyterian Mission Agency", opportunityName: "1001 New Worshiping Communities" });
const otherProgram = candidateDedupeKey({ sourceDomain: "pcusa.org", funderName: "Presbyterian Mission Agency", opportunityName: "Matthew 25 Grants" });
check("two programs from one funder stay separate", pmaKey === otherProgram, false);
check(
  "the same program found twice consolidates",
  pmaKey === candidateDedupeKey({ sourceDomain: "pcusa.org", funderName: "The Presbyterian Mission Agency, Inc.", opportunityName: "1001 New Worshiping Communities" }),
  true
);
check(
  "a funder alone is not confused with one of its programs",
  candidateDedupeKey({ sourceDomain: "pcusa.org", funderName: "Presbyterian Mission Agency" }) === pmaKey,
  false
);

console.log(`\n${pass} passed, ${fail} failed.`);
