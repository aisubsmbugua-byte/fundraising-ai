// Attestation and dedupe, checked against the real overnight run of
// 2026-08-30 -- the one that first proved the capture contract and, in the
// same nine rows, exposed both defects this covers.
//
// Pure logic, no API call and no database. Run: npx tsx scripts/test-candidate-attestation.ts

import {
  attestationCorpus,
  candidateDedupeKey,
  candidateDisplayName,
  distinctiveTokens,
  isAttested,
  normalizeOpportunityForDedupe,
} from "../lib/candidates";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

// The live failure: not a program Mariners Church publishes, but our own
// suggested approach to them, typed into a field that reads as fact.
const mariners = attestationCorpus({
  url: "https://marinerschurch.org/giving/",
  title: "Giving | Mariners Church",
});
check("invented strategy phrase is unattested", isAttested("Sister Campus Sibling Outreach Strategy", mariners), false);
check("the funder's own name is attested", isAttested("Mariners Church", mariners), true);

// The real programs from the same run must survive -- a check that rejects
// genuine program names is worse than no check.
const calvin = attestationCorpus({
  url: "https://worship.calvin.edu/grants/",
  title: "Vital Worship, Vital Preaching Grants Program | Calvin Institute of Christian Worship",
});
check("real program name is attested", isAttested("Vital Worship, Vital Preaching Grants", calvin), true);
check("same program, trailing 'Program'", isAttested("Vital Worship, Vital Preaching Grants Program", calvin), true);

// Ampersand vs. "and" must not decide the outcome -- the model wrote
// "GrantsPlus and Emerging Leader Grant Programs" where the source used "&".
const weRaise = attestationCorpus({
  url: "https://weraise.org/grants/",
  title: "GrantsPlus & Emerging Leader Grant Programs - We Raise Foundation",
});
check("ampersand normalizes to 'and'", isAttested("GrantsPlus and Emerging Leader Grant Programs", weRaise), true);

// A third-party source that names the program is still valid attestation --
// provenance and attestation are separate questions.
const ncc = attestationCorpus({
  url: "https://nccumc.org/racial-ethnic-local-church-grants/",
  title: "Racial Ethnic Local Church Grants",
});
check("directory source can attest a program", isAttested("Racial Ethnic Local Church Grants", ncc), true);

// Nothing distinctive to check must not manufacture a failure.
check("empty value attests", isAttested(null, mariners), true);
check("value of only filler words attests", isAttested("The Grant Program", mariners), true);

// Tokens under three characters are too promiscuous to carry a check.
check("distinctive tokens drop filler and short words", distinctiveTokens("The 1001 New Worshiping Communities Fund"), [
  "1001",
  "new",
  "worshiping",
  "communities",
]);

// A single missing distinctive token is enough to withhold attestation --
// "every token" is the contract, not "most".
check("one absent token fails the whole value", isAttested("Vital Worship, Vital Preaching Fellowship", calvin), false);

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

// The live duplicate: same funder, same domain, same page, found under two
// channels on the same night. Byte-identical funder_name; one trailing word
// split the key and both rows were written.
const calvinA = candidateDedupeKey({
  sourceDomain: "worship.calvin.edu",
  funderName: "Calvin Institute of Christian Worship",
  opportunityName: "Vital Worship, Vital Preaching Grants",
  opportunityAttested: true,
});
const calvinB = candidateDedupeKey({
  sourceDomain: "worship.calvin.edu",
  funderName: "Calvin Institute of Christian Worship",
  opportunityName: "Vital Worship, Vital Preaching Grants Program",
  opportunityAttested: true,
});
check("trailing 'Program' no longer splits one opportunity in two", calvinA === calvinB, true);

// ...while genuinely distinct programs from one funder must stay distinct.
// This is why the key was never domain-alone.
const pcusaA = candidateDedupeKey({
  sourceDomain: "pcusa.org",
  funderName: "Presbyterian Mission Agency",
  opportunityName: "1001 New Worshiping Communities",
  opportunityAttested: true,
});
const pcusaB = candidateDedupeKey({
  sourceDomain: "pcusa.org",
  funderName: "Presbyterian Mission Agency",
  opportunityName: "Mission Program Grants",
  opportunityAttested: true,
});
check("two real programs from one funder stay separate", pcusaA === pcusaB, false);

// An unattested phrase must not be allowed to manufacture a distinction.
const marinersInvented = candidateDedupeKey({
  sourceDomain: "marinerschurch.org",
  funderName: "Mariners Church",
  opportunityName: "Sister Campus Sibling Outreach Strategy",
  opportunityAttested: false,
});
const marinersPlain = candidateDedupeKey({
  sourceDomain: "marinerschurch.org",
  funderName: "Mariners Church",
  opportunityName: null,
});
check("an unattested opportunity cannot create a duplicate", marinersInvented === marinersPlain, true);

check("opportunity normalization strips filler", normalizeOpportunityForDedupe("Vital Worship, Vital Preaching Grants Program"), "vital worship vital preaching");

// ---------------------------------------------------------------------------
// Derived display name
// ---------------------------------------------------------------------------

check(
  "name is built from its parts",
  candidateDisplayName({ funderName: "Second Presbyterian Church Foundation", opportunityName: "World Outreach Grants", opportunityAttested: true, fallback: "x" }),
  "Second Presbyterian Church Foundation — World Outreach Grants"
);

// The live inconsistency: the display name asserted a program the structured
// field had correctly declined.
check(
  "no opportunity means no suffix",
  candidateDisplayName({ funderName: "Mustard Seed Foundation", opportunityName: null, fallback: "Mustard Seed Foundation — General Grants" }),
  "Mustard Seed Foundation"
);

check(
  "an unattested opportunity does not reach the name",
  candidateDisplayName({ funderName: "Mariners Church", opportunityName: "Sister Campus Sibling Outreach Strategy", opportunityAttested: false, fallback: "x" }),
  "Mariners Church"
);

check(
  "a program already inside the funder name is not repeated",
  candidateDisplayName({ funderName: "We Raise Foundation GrantsPlus", opportunityName: "GrantsPlus", opportunityAttested: true, fallback: "x" }),
  "We Raise Foundation GrantsPlus"
);

check(
  "falls back to the model's name when no funder name was given",
  candidateDisplayName({ funderName: null, opportunityName: null, fallback: "Festus & Helen Stacy Foundation" }),
  "Festus & Helen Stacy Foundation"
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
