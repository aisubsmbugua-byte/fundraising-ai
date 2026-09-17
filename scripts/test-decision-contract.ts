// Step 1 acceptance tests: the decision contract, screening materiality, the
// four qualification outcomes, and the faith-affiliation model.
//
// Pure logic. No network, no database, no model. Everything here is a rule we
// chose to decide in code precisely so it could be tested this way.
//
// Three of these tests exist because of a specific defect this build has
// already produced at least four times -- a concept wired into some of its
// call sites but not all:
//
//   * completeness of BOTH policy maps, so a claim key added later cannot
//     silently acquire or lose materiality for one consumer
//   * that no caller reaches into a policy map directly
//   * that the contract's required-facts list is derived, never restated
//
// Run: npx tsx scripts/test-decision-contract.ts

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  RESEARCH_CLAIM_KEYS,
  IDENTITY_GATE_KEYS,
  SCREENING_FIELD_POLICY,
  STRATEGY_FIELD_POLICY,
  RESEARCH_CONSUMERS,
  fieldPolicyFor,
  requiredClaimKeysFor,
} from "../lib/research";
import {
  QUALIFICATION_OUTCOMES,
  LEGITIMACY_STATES,
  AFFILIATION_STATES,
  UNKNOWN_AFFILIATION,
  readFaithAffiliation,
  denominationalCompatibility,
  normalizeAffiliationId,
  resolvesToIntermediary,
  buildQualificationContract,
  profileFingerprint,
  impliedRegime,
  EMPTY_DENOMINATION_REGISTRY,
  type ProfileSnapshot,
  type FaithAffiliation,
  type CanonicalDenomination,
  type DenominationRegistry,
} from "../lib/qualification";

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section("Outcome vocabulary");
// ---------------------------------------------------------------------------

// Four outcomes, not three. intermediary_only is the one a DAF sponsor needs
// and none of the other three can express.
check("four qualification outcomes", QUALIFICATION_OUTCOMES.length, 4);
check("intermediary_only is one of them", QUALIFICATION_OUTCOMES.includes("intermediary_only"), true);
check("insufficient_evidence is distinct from dismiss", QUALIFICATION_OUTCOMES.includes("insufficient_evidence") && QUALIFICATION_OUTCOMES.includes("dismiss"), true);

// Predicate 1 is four-valued. A boolean here would force a wrong answer on the
// registry name collision -- 80 organizations match "stewardship foundation".
check("legitimacy is four-valued, not boolean", [...LEGITIMACY_STATES].sort(), ["conflicting", "established", "insufficient_evidence", "not_applicable"]);

// ---------------------------------------------------------------------------
section("Policy map completeness -- both consumers");
// ---------------------------------------------------------------------------

// THE test. Every claim key must be graded by every consumer, or gated as
// identity. A key added without a policy would fall back to advisory and
// quietly stop being able to decide anything -- the exact class of defect that
// left screening measuring itself against Strategy's grading.
for (const consumer of RESEARCH_CONSUMERS) {
  const ungraded = RESEARCH_CLAIM_KEYS.map((k) => k.key)
    .filter((key) => !IDENTITY_GATE_KEYS.has(key))
    .filter((key) => fieldPolicyFor(consumer, key) === "advisory")
    .filter((key) => {
      const map = consumer === "screening" ? SCREENING_FIELD_POLICY : STRATEGY_FIELD_POLICY;
      return !(key in map); // advisory BY FALLBACK, not by decision
    });
  check(`${consumer}: every claim key has an explicit policy`, ungraded, []);
}

// And nothing graded that is not a real key -- a typo'd entry would grade a
// key that never arrives, and look like coverage.
for (const consumer of RESEARCH_CONSUMERS) {
  const known = new Set<string>(RESEARCH_CLAIM_KEYS.map((k) => k.key));
  const map = consumer === "screening" ? SCREENING_FIELD_POLICY : STRATEGY_FIELD_POLICY;
  check(`${consumer}: no policy for an unknown key`, Object.keys(map).filter((k) => !known.has(k)), []);
}

// Identity answers a different question for every consumer.
check("identity is gated, not graded", fieldPolicyFor("screening", "identity.legal_name"), "identity_gate");
check("...for strategy too", fieldPolicyFor("strategy", "identity.ein"), "identity_gate");

// ---------------------------------------------------------------------------
section("Screening grades differently from strategy -- the inversion");
// ---------------------------------------------------------------------------

// The defect that motivated this whole step: "what they fund and where" was
// advisory, while fiscal sponsorship rules and grant size ranges were
// required. Correct for Strategy; backwards for the decision that gates it.
check("focus_areas: required to screen", fieldPolicyFor("screening", "funding.focus_areas"), "required");
check("focus_areas: advisory to strategy", fieldPolicyFor("strategy", "funding.focus_areas"), "advisory");
check("geographic_focus: required to screen", fieldPolicyFor("screening", "funding.geographic_focus"), "required");
check("geographic_focus: advisory to strategy", fieldPolicyFor("strategy", "funding.geographic_focus"), "advisory");

// And symmetrically, application mechanics matter to Strategy and not to us.
check("grant_size_range: advisory to screen", fieldPolicyFor("screening", "funding.grant_size_range"), "advisory");
check("grant_size_range: required to strategy", fieldPolicyFor("strategy", "funding.grant_size_range"), "required");
check("submission_method: unused when screening", fieldPolicyFor("screening", "application.submission_method"), "unused");

// funder_type decides the KIND of verdict, so it cannot be advisory anywhere.
check("funder_type: required to screen", fieldPolicyFor("screening", "funding.funder_type"), "required");

// Revealed giving carries fit for the 22% of prospects with no reachable site.
check("recent_grants: required to screen", fieldPolicyFor("screening", "funding.recent_grants"), "required");
check("recent_grants: advisory to strategy", fieldPolicyFor("strategy", "funding.recent_grants"), "advisory");

// The new key must be a disqualifier for both consumers.
check("denominational_restriction: required to screen", fieldPolicyFor("screening", "application.denominational_restriction"), "required");
check("denominational_restriction: required to strategy", fieldPolicyFor("strategy", "application.denominational_restriction"), "required");

// ---------------------------------------------------------------------------
section("No caller decides materiality for itself");
// ---------------------------------------------------------------------------

// The countermeasure, not just the rule. A consumer that reads a policy map
// directly can answer "how material is this" differently from every other
// consumer, which is how the single collapsed MATERIAL_CLAIM_KEYS set went
// wrong in the first place.
const SRC_DIRS = ["lib", "app", "scripts"];
const ALLOWED = new Set(["lib/research.ts", "scripts/test-decision-contract.ts"]);
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
const offenders = SRC_DIRS.flatMap((d) => walk(d))
  .filter((f) => !ALLOWED.has(f.replace(/\\/g, "/")))
  .filter((f) => /\b(SCREENING_FIELD_POLICY|STRATEGY_FIELD_POLICY)\s*\[/.test(readFileSync(f, "utf8")));
check("no file indexes a policy map directly", offenders, []);

// ---------------------------------------------------------------------------
section("Faith affiliation: unknown, none and declared are three facts");
// ---------------------------------------------------------------------------

check("three states", [...AFFILIATION_STATES].sort(), ["declared", "none", "unknown"]);
check("a missing profile row is unknown", readFaithAffiliation(null), UNKNOWN_AFFILIATION);
check("an unset state is unknown", readFaithAffiliation({}), UNKNOWN_AFFILIATION);

// The distinction decision 1 exists to preserve.
check(
  "confirmed 'none' is not the same value as unknown",
  readFaithAffiliation({ faith_affiliation_state: "none", faith_affiliations: [] }).state,
  "none"
);
check(
  "multiple affiliations are permitted",
  readFaithAffiliation({
    faith_affiliation_state: "declared",
    faith_affiliations: ["Presbyterian Church (U.S.A.)", "Evangelical Covenant Church"],
  }).affiliations.length,
  2
);

// Invariants enforced, not trusted.
check(
  "'declared' with nothing declared reads as unknown, never as a disqualifier",
  readFaithAffiliation({ faith_affiliation_state: "declared", faith_affiliations: [] }),
  UNKNOWN_AFFILIATION
);
check(
  "a stray array under 'none' does not contradict the confirmed state",
  readFaithAffiliation({ faith_affiliation_state: "none", faith_affiliations: ["Anglican"] }).affiliations,
  []
);
check(
  "an unrecognised state falls back to unknown",
  readFaithAffiliation({ faith_affiliation_state: "sort-of", faith_affiliations: ["Anglican"] }).state,
  "unknown"
);

// Normalization must not conflate distinct denominations. PC(USA) and PCA are
// different bodies; a normalizer that strips "church", "in" and "of" merges
// them and would wrongly disqualify half of American Presbyterianism.
check(
  "PC(USA) and PCA do not normalize to the same identifier",
  normalizeAffiliationId("Presbyterian Church (U.S.A.)") === normalizeAffiliationId("Presbyterian Church in America"),
  false
);
check("punctuation and case are normalized", normalizeAffiliationId("Presbyterian Church (U.S.A.)"), "presbyterian church u s a");

// ---------------------------------------------------------------------------
section("Denominational rule: all three conditions, or it does not fire");
// ---------------------------------------------------------------------------

const declared = (...names: string[]): FaithAffiliation => ({
  state: "declared", affiliations: names, confirmedAt: "2026-01-01T00:00:00Z", confirmedBy: "user-1",
});
const noneConfirmed: FaithAffiliation = { state: "none", affiliations: [], confirmedAt: "2026-01-01T00:00:00Z", confirmedBy: "user-1" };

check(
  "no stated restriction: rule does not fire",
  denominationalCompatibility({ acceptedBodies: [], profile: declared("Anglican Church in North America") }),
  "undetermined"
);
check(
  "restriction stated but affiliation unknown: never disqualifies",
  denominationalCompatibility({ acceptedBodies: ["Presbyterian Church (U.S.A.)"], profile: UNKNOWN_AFFILIATION }),
  "undetermined"
);
check(
  "match on one of several affiliations is enough",
  denominationalCompatibility({
    acceptedBodies: ["Presbyterian Church (U.S.A.)"],
    profile: declared("Evangelical Covenant Church", "Presbyterian Church (U.S.A.)"),
  }),
  "satisfied"
);
check(
  "funder accepting several bodies: any overlap satisfies",
  denominationalCompatibility({
    acceptedBodies: ["Anglican Church in North America", "Presbyterian Church (U.S.A.)"],
    profile: declared("Presbyterian Church (U.S.A.)"),
  }),
  "satisfied"
);
check(
  "affiliation alone, with no restriction, is never a disqualifier",
  denominationalCompatibility({ acceptedBodies: [], profile: noneConfirmed }),
  "undetermined"
);

// -- Auto-dismissal is disabled by construction, not by intention ----------
//
// Two different denominations no longer disqualify anyone, because "these
// names differ" is not evidence of incompatibility. PC(USA) and PCA are the
// worked example: a hastily authored list treating them as opposed would
// produce a wrong automatic dismissal, among the most damaging outcomes here.
check(
  "declared, stated, and different: review required, NOT dismissal",
  denominationalCompatibility({
    acceptedBodies: ["Presbyterian Church in America"],
    profile: declared("Presbyterian Church (U.S.A.)"),
  }),
  "review_required"
);
check(
  "confirmed 'none' with no vocabulary entry: review required",
  denominationalCompatibility({ acceptedBodies: ["Assemblies of God"], profile: noneConfirmed }),
  "review_required"
);

// The safe shortcut survives: an exact match still satisfies with no
// vocabulary at all, because satisfying can only REMOVE a disqualification.
check(
  "an exact match satisfies without any registry",
  denominationalCompatibility({
    acceptedBodies: ["Presbyterian Church (U.S.A.)"],
    profile: declared("presbyterian church (u.s.a.)"),
  }),
  "satisfied"
);

// But only an EXACT one. "U.S.A." and "USA" are obviously the same body to a
// reader and are not the same string after normalization, and the fix for that
// is a registry entry carrying the abbreviation -- not a cleverer normalizer.
// Solving abbreviation variance with string munging is the same instinct that
// would treat PC(USA) and PCA as interchangeable.
check(
  "an abbreviation variant does not auto-satisfy; it goes to review",
  denominationalCompatibility({
    acceptedBodies: ["Presbyterian Church (U.S.A.)"],
    profile: declared("Presbyterian Church USA"),
  }),
  "review_required"
);

// review_required and undetermined are different facts: one has something for
// a human to look at, the other has nothing.
check(
  "no restriction stated is undetermined, not review required",
  denominationalCompatibility({ acceptedBodies: [], profile: declared("Anglican Church in North America") }),
  "undetermined"
);
check(
  "unknown affiliation is undetermined, not review required",
  denominationalCompatibility({ acceptedBodies: ["Assemblies of God"], profile: UNKNOWN_AFFILIATION }),
  "undetermined"
);

// -- And what it takes to re-enable it, one confirmed entry at a time ------
const entry = (id: string, officialName: string, status: "confirmed" | "suggested" = "confirmed"): CanonicalDenomination => ({
  id, officialName, abbreviations: [], formerNames: [], parentBodyId: null,
  officialWebsite: null, relationshipSources: {}, reviewStatus: status, lastReviewedAt: "2026-09-02",
});

const PCUSA = entry("pcusa", "Presbyterian Church (U.S.A.)");
const PCA = entry("pca", "Presbyterian Church in America");

// A registry that resolves both bodies but documents no incompatibility
// between them. Non-overlap is not opposition -- still a human's call.
const resolvingOnly: DenominationRegistry = {
  resolve: (n) => (/u\.?s\.?a/i.test(n) ? PCUSA : /in America/i.test(n) ? PCA : null),
  explicitlyIncompatible: () => false,
};
check(
  "both sides canonical but no documented incompatibility: still review required",
  denominationalCompatibility({
    acceptedBodies: ["Presbyterian Church in America"],
    profile: declared("Presbyterian Church (U.S.A.)"),
    registry: resolvingOnly,
  }),
  "review_required"
);

// Only a DOCUMENTED incompatibility dismisses.
const documenting: DenominationRegistry = {
  ...resolvingOnly,
  explicitlyIncompatible: (a, b) => (a === "pcusa" && b === "pca") || (a === "pca" && b === "pcusa"),
};
check(
  "a documented incompatibility is the only path to dismissal",
  denominationalCompatibility({
    acceptedBodies: ["Presbyterian Church in America"],
    profile: declared("Presbyterian Church (U.S.A.)"),
    registry: documenting,
  }),
  "incompatible"
);
check(
  "one unresolved body is enough to send it to review",
  denominationalCompatibility({
    acceptedBodies: ["Presbyterian Church in America", "Evangelical Presbyterian Church"],
    profile: declared("Presbyterian Church (U.S.A.)"),
    registry: documenting,
  }),
  "review_required"
);
check(
  "with a confirmed restriction, 'none' is decisive without name-matching",
  denominationalCompatibility({ acceptedBodies: ["Presbyterian Church in America"], profile: noneConfirmed, registry: documenting }),
  "incompatible"
);

// The default registry is empty, so nothing in production can reach
// "incompatible" until entries are added deliberately.
check(
  "the default registry resolves nothing",
  EMPTY_DENOMINATION_REGISTRY.resolve("Presbyterian Church (U.S.A.)"),
  null
);
check(
  "and documents no incompatibility",
  EMPTY_DENOMINATION_REGISTRY.explicitlyIncompatible("pcusa", "pca"),
  false
);

// ---------------------------------------------------------------------------
section("Intermediaries");
// ---------------------------------------------------------------------------

check(
  "a bare DAF sponsor is an intermediary",
  resolvesToIntermediary({ subjectType: "daf_sponsor", namedOpportunity: null }),
  true
);
check(
  "a DAF sponsor with a named fund is a normal subject",
  resolvesToIntermediary({ subjectType: "daf_sponsor", namedOpportunity: "Ministry Innovation Fund" }),
  false
);
check(
  "whitespace is not a named opportunity",
  resolvesToIntermediary({ subjectType: "daf_sponsor", namedOpportunity: "   " }),
  true
);
check(
  "a private foundation is never an intermediary",
  resolvesToIntermediary({ subjectType: "private_foundation", namedOpportunity: null }),
  false
);

// ---------------------------------------------------------------------------
section("Contract");
// ---------------------------------------------------------------------------

const profile: ProfileSnapshot = {
  mission: "After-school literacy in Memphis churches",
  programs: "Tutoring, family literacy nights",
  whoWeServe: "K-8 students in under-resourced neighbourhoods",
  causeAreas: ["education", "christian ministry"],
  geographicArea: "Memphis, Tennessee",
  faithAffiliation: declared("Presbyterian Church (U.S.A.)"),
};

const contract = buildQualificationContract({
  opportunity: "Ministry Innovation Fund",
  operatingOrganization: "Missio Nexus",
  legalEntityName: "Missio Nexus Inc",
  ein: "62-1234567",
  officialSources: ["https://missionexus.org/", "https://missionexus.org/"],
  discoverySources: ["https://example-directory.org/listing"],
  subjectType: "private_foundation",
  profile,
});

check("the three subject layers are separate fields", [
  contract.subject.opportunity, contract.subject.operatingOrganization, contract.subject.legalEntityName,
], ["Ministry Innovation Fund", "Missio Nexus", "Missio Nexus Inc"]);
check("EIN is normalized to nine digits", contract.subject.ein, "621234567");
check("a malformed EIN is null, not a guess", buildQualificationContract({ ein: "62-123", profile }).subject.ein, null);
check("official sources are deduped", contract.knownSources.official.length, 1);
check("official and discovery sources stay separate", contract.knownSources.discovery.length, 1);
check("regime is implied from subject type", contract.disclosure.regime, "us_990pf");
check("an individual has no public filing regime", impliedRegime("individual"), "none_public");
check("unknown stays unknown rather than being guessed", impliedRegime("unknown"), "unknown");

// Derived, never restated -- the contract's required facts ARE the screening
// policy, so the two cannot drift.
check("required facts are derived from the screening policy", contract.requiredFacts, requiredClaimKeysFor("screening"));
check("required facts include what they fund", contract.requiredFacts.includes("funding.focus_areas"), true);
check("and exclude application mechanics", contract.requiredFacts.includes("application.submission_method"), false);

// Fingerprint covers exactly what was compared, and is stable across rebuilds.
check("fingerprint is stable for an identical profile", profileFingerprint(profile), profileFingerprint({ ...profile }));
check(
  "editing the mission changes the fingerprint",
  profileFingerprint(profile) === profileFingerprint({ ...profile, mission: "Something else" }),
  false
);
check(
  "changing a confirmed affiliation changes the fingerprint",
  profileFingerprint(profile) === profileFingerprint({ ...profile, faithAffiliation: noneConfirmed }),
  false
);
check(
  "key order does not change the fingerprint",
  profileFingerprint(profile) ===
    profileFingerprint({
      faithAffiliation: profile.faithAffiliation,
      geographicArea: profile.geographicArea,
      causeAreas: profile.causeAreas,
      whoWeServe: profile.whoWeServe,
      programs: profile.programs,
      mission: profile.mission,
    } as ProfileSnapshot),
  true
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
