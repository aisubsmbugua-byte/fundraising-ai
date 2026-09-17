// Step 4 acceptance tests: the availability ledger.
//
// Pure logic. The property under test is not the labels -- it is OBTAINABILITY.
// A gap that cannot close must never be offered to a user as more work, because
// that is the measured failure this whole step exists to remove: one prospect
// absorbed five paid runs chasing a document that is not published at all.
//
// Run: npx tsx scripts/test-availability.ts

import {
  deriveAvailability,
  obtainableGaps,
  availabilitySummary,
  isObtainable,
  factSource,
  AVAILABILITY_STATES,
  type AvailabilityInput,
} from "../lib/availability";
import type { PurposeCoverage } from "../lib/tier2/fetch";
import type { SelectionPurpose } from "../lib/tier2/select";

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function section(t: string) {
  console.log(`\n${t}`);
}

const cov = (over: Partial<Record<SelectionPurpose, PurposeCoverage>> = {}): Record<SelectionPurpose, PurposeCoverage> => ({
  priorities: "not_checked", eligibility: "not_checked", process: "not_checked",
  grants: "not_checked", identity: "not_checked", ...over,
});

const input = (over: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  regime: "us_990pf",
  subjectType: "private_foundation",
  registry: { retrieved: true, publishesGrantsPaid: true },
  coverage: cov(),
  siteReachable: true,
  claimKeys: [],
  ...over,
});

const stateOf = (ledger: ReturnType<typeof deriveAvailability>, key: string) => ledger.find((f) => f.key === key)?.state;

// ---------------------------------------------------------------------------
section("Obtainability is the property that matters");
// ---------------------------------------------------------------------------

check("a gap we never looked at can be closed", isObtainable("not_checked"), true);
check("a failed retrieval can be retried", isObtainable("retrieval_failed"), true);
// The two that ended the treadmill.
check("a source that does not state it CANNOT be closed", isObtainable("checked_not_stated"), false);
check("a disclosure that does not exist CANNOT be closed", isObtainable("not_applicable"), false);
check("something already found is not a gap", isObtainable("found"), false);
check("five states, no more", AVAILABILITY_STATES.length, 5);

// ---------------------------------------------------------------------------
section("Not applicable: the subject cannot produce it");
// ---------------------------------------------------------------------------

// Verified against the live registry: a 990 filer's extract carries grants
// RECEIVED and nothing about grants made. Asking forever would be asking the
// wrong source, not finding a gap.
check(
  "a 990 filer's charitable disbursements are not applicable",
  stateOf(deriveAvailability(input({ registry: { retrieved: true, publishesGrantsPaid: false } })), "funding.charitable_disbursements"),
  "not_applicable"
);
check(
  "...and a 990-PF filer's are not",
  stateOf(deriveAvailability(input()), "funding.charitable_disbursements"),
  "checked_not_stated"
);
check(
  "an individual files nothing, so registry facts are not applicable",
  stateOf(deriveAvailability(input({ regime: "none_public", subjectType: "individual" })), "funding.total_annual_giving"),
  "not_applicable"
);
// And none of those may be offered as work.
check(
  "not_applicable never appears in obtainable gaps",
  obtainableGaps(deriveAvailability(input({ regime: "none_public", subjectType: "individual" }))).some((f) => f.state === "not_applicable"),
  false
);

// ---------------------------------------------------------------------------
section("Checked and silent is not the same as never checked");
// ---------------------------------------------------------------------------

// We read the pages that cover eligibility, and they say nothing about
// denominational restrictions. That is the FUNDER's answer, and re-running will
// return the same silence.
check(
  "pages read but silent is checked_not_stated",
  stateOf(deriveAvailability(input({ coverage: cov({ eligibility: "found" }) })), "application.denominational_restriction"),
  "checked_not_stated"
);
check(
  "no page on the site could answer it is also checked_not_stated",
  stateOf(deriveAvailability(input({ coverage: cov({ eligibility: "not_offered" }) })), "application.excluded_recipients"),
  "checked_not_stated"
);
check(
  "never looking is not_checked",
  stateOf(deriveAvailability(input({ coverage: cov() })), "application.excluded_recipients"),
  "not_checked"
);
// The distinction, stated as the rule it enforces.
check(
  "only the second of those is offered as more work",
  [
    obtainableGaps(deriveAvailability(input({ coverage: cov({ eligibility: "found" }) }))).some((f) => f.key === "application.excluded_recipients"),
    obtainableGaps(deriveAvailability(input({ coverage: cov() }))).some((f) => f.key === "application.excluded_recipients"),
  ],
  [false, true]
);

// A page that loaded and said almost nothing has answered nothing. Counting it
// as checked would claim we read their priorities when we read their nav.
check(
  "a thin page leaves the fact not_checked, not checked_not_stated",
  stateOf(deriveAvailability(input({ coverage: cov({ priorities: "found_thin" }) })), "funding.focus_areas"),
  "not_checked"
);

// ---------------------------------------------------------------------------
section("Retrieval failure is retryable and must not read as absence");
// ---------------------------------------------------------------------------

check(
  "an unreachable site fails retrieval rather than reporting nothing published",
  stateOf(deriveAvailability(input({ siteReachable: false })), "funding.focus_areas"),
  "retrieval_failed"
);
check(
  "a single failed page fails only its own purpose",
  deriveAvailability(input({ coverage: cov({ eligibility: "retrieval_failed", priorities: "found" }) })).filter((f) => f.state === "retrieval_failed").length > 0,
  true
);
check(
  "...and it IS offered as more work, because it can succeed later",
  obtainableGaps(deriveAvailability(input({ siteReachable: false }))).length > 0,
  true
);
check(
  "no registry record retrieved is not_checked, not a funder fact",
  stateOf(deriveAvailability(input({ registry: null })), "funding.total_annual_giving"),
  "not_checked"
);

// ---------------------------------------------------------------------------
section("Found, and what the ledger covers");
// ---------------------------------------------------------------------------

check(
  "a claim makes the fact found",
  stateOf(deriveAvailability(input({ claimKeys: ["funding.focus_areas"] })), "funding.focus_areas"),
  "found"
);
check("found is never an obtainable gap", obtainableGaps(deriveAvailability(input({ claimKeys: ["funding.focus_areas"] }))).some((f) => f.key === "funding.focus_areas"), false);

// The ledger defaults to the SCREENING consumer -- the facts that gate pursue
// or dismiss, not all 43.
const ledger = deriveAvailability(input());
check("the ledger covers the screening required set", ledger.length > 10 && ledger.length < 25, true);
check("every entry has a state", ledger.every((f) => AVAILABILITY_STATES.includes(f.state)), true);
check("every entry says where the fact should come from", ledger.every((f) => ["registry", "official_site", "either"].includes(f.source)), true);
check("financial facts are registry facts", factSource("funding.total_assets"), "registry");
check("stated rules are site facts", factSource("application.denominational_restriction"), "official_site");

const summary = availabilitySummary(ledger);
check("the summary totals the ledger", Object.values(summary).reduce((a, b) => a + b, 0), ledger.length);

// The end-to-end property: a funder we could not reach at all offers retries,
// and a funder whose site we read completely offers nothing.
const unreachable = deriveAvailability(input({ siteReachable: false, registry: null }));
const fullyRead = deriveAvailability(
  input({ coverage: cov({ priorities: "found", eligibility: "found", process: "found", grants: "found" }) })
);
check("an unreachable funder has work worth doing", obtainableGaps(unreachable).length > 0, true);
check("a fully-read funder has none", obtainableGaps(fullyRead).length, 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
