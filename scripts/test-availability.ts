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
  availabilityForResearchRun,
  offerableGaps,
  factLabel,
  AVAILABILITY_STATES,
  AVAILABILITY_WORDING,
  type AvailabilityInput,
} from "../lib/availability";
import { requiredClaimKeysFor, focusKeysFor, outstandingIntelligence } from "../lib/research";
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

// Every input names its consumer. There is no ledger for a prospect, only a
// ledger for a decision (ruling 0011), so the helper cannot leave it implicit
// either -- that default is what let call sites skip the question.
const input = (over: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  keys: requiredClaimKeysFor("screening"),
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

// The pages the model selected for eligibility were read and are silent. That
// closes those PAGES, not the site: a purpose tag is a prediction, and pages
// selection skipped could still state the fact (ruling 0024 -- an absence
// names the set it was checked over). So the fact stays open.
check(
  "selected pages read but silent stays not_checked -- other pages unread",
  stateOf(deriveAvailability(input({ coverage: cov({ eligibility: "read_substantive" }) })), "application.denominational_restriction"),
  "not_checked"
);
check(
  "...and the reason names the pages read, never the site",
  deriveAvailability(input({ coverage: cov({ eligibility: "read_substantive" }) })).find((f) => f.key === "application.denominational_restriction")?.reason,
  "the pages selected for eligibility were read and do not state it; other pages were not read"
);
// The one site-scope absence selection can produce: the model recorded that no
// candidate page exists. A declaration about the site, and it closes.
check(
  "a declared no-candidate purpose is checked_not_stated",
  stateOf(deriveAvailability(input({ coverage: cov({ eligibility: "not_offered" }) })), "application.excluded_recipients"),
  "checked_not_stated"
);
check(
  "...with a reason naming the declaration as its basis, not a site fact",
  deriveAvailability(input({ coverage: cov({ eligibility: "not_offered" }) })).find((f) => f.key === "application.excluded_recipients")?.reason,
  "the page-selection model declared no candidate page for eligibility on this site"
);
check(
  "never looking is not_checked",
  stateOf(deriveAvailability(input({ coverage: cov() })), "application.excluded_recipients"),
  "not_checked"
);
// The distinction, stated as the rule it enforces: only the model's recorded
// declaration closes a site fact; reading the selected pages does not.
check(
  "a declared absence is settled, an unlooked-at fact is offered",
  [
    obtainableGaps(deriveAvailability(input({ coverage: cov({ eligibility: "not_offered" }) }))).some((f) => f.key === "application.excluded_recipients"),
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
  deriveAvailability(input({ coverage: cov({ eligibility: "retrieval_failed", priorities: "read_substantive" }) })).filter((f) => f.state === "retrieval_failed").length > 0,
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
section("A fact with two sources takes the state of the FACT (ruling 0008)");
// ---------------------------------------------------------------------------

// The defect this section exists for: `either` facts fell through the registry
// branch entirely and adopted the site's verdict. A prospect whose registry
// record was never retrieved, and whose site was read for grants and said
// nothing, reported funding.recent_grants as checked_not_stated -- declaring
// the 990 grant schedule a closed question because a DIFFERENT source was
// silent. Ruling 0008's test of compliance requires exactly this shape: a
// source never consulted alongside one read and silent.
const eitherMixed = deriveAvailability(input({ registry: null, coverage: cov({ grants: "read_substantive" }) }));
check(
  "registry never retrieved + site read and silent => still obtainable",
  stateOf(eitherMixed, "funding.recent_grants"),
  "not_checked"
);
check(
  "...and the reason names the unread source, not the silent one",
  eitherMixed.find((f) => f.key === "funding.recent_grants")?.reason,
  "no registry record was retrieved"
);
check(
  "...so it is offered as work",
  obtainableGaps(eitherMixed).some((f) => f.key === "funding.recent_grants"),
  true
);
// The same ledger must not contradict itself about that registry record.
check(
  "the ledger cannot say 'no registry record' and 'nothing more to get' at once",
  [stateOf(eitherMixed, "funding.total_annual_giving"), stateOf(eitherMixed, "funding.recent_grants")],
  ["not_checked", "not_checked"]
);

// Reading the selected grants pages no longer closes the fact: that is
// page-scope evidence, and other site pages remain unread (ruling 0024).
check(
  "registry silent + selected pages silent is still open",
  stateOf(deriveAvailability(input({ coverage: cov({ grants: "read_substantive" }) })), "funding.recent_grants"),
  "not_checked"
);
// The site half closes only on the model's declared abstention.
check(
  "registry silent + declared no grants page => checked_not_stated",
  stateOf(deriveAvailability(input({ coverage: cov({ grants: "not_offered" }) })), "funding.recent_grants"),
  "checked_not_stated"
);
// A failure on one source with the other unread stays obtainable, and reports
// the unread one -- there is more work available than a retry.
check(
  "unread beats failed when both are open",
  stateOf(deriveAvailability(input({ registry: null, siteReachable: false })), "funding.recent_grants"),
  "not_checked"
);
check(
  "failed on one, silent on the other => retryable",
  stateOf(deriveAvailability(input({ siteReachable: false })), "funding.recent_grants"),
  "retrieval_failed"
);
// not_applicable on one source never closes a fact the other could still carry.
check(
  "an individual files nothing, but their site could still list grants",
  stateOf(deriveAvailability(input({ regime: "none_public", subjectType: "individual", coverage: cov() })), "funding.recent_grants"),
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

// This ledger is derived for the SCREENING consumer -- the facts that gate
// pursue or dismiss, not all 43. There is no default (ruling 0011); the helper
// above names it, the same way every call site must.
const ledger = deriveAvailability(input());
check("the ledger covers the screening required set", ledger.length > 10 && ledger.length < 25, true);
check("every entry has a state", ledger.every((f) => AVAILABILITY_STATES.includes(f.state)), true);
check("every entry says where the fact should come from", ledger.every((f) => ["registry", "official_site", "either"].includes(f.source)), true);
check("financial facts are registry facts", factSource("funding.total_assets"), "registry");
check("stated rules are site facts", factSource("application.denominational_restriction"), "official_site");

const summary = availabilitySummary(ledger);
check("the summary totals the ledger", Object.values(summary).reduce((a, b) => a + b, 0), ledger.length);

// The end-to-end property: a funder we could not reach at all offers retries;
// reading every SELECTED page still leaves site work open, because selection
// is a prediction and the rest of the site is unread (ruling 0024); only the
// model's declared abstention on every purpose closes the site side.
const unreachable = deriveAvailability(input({ siteReachable: false, registry: null }));
const fullyRead = deriveAvailability(
  input({ coverage: cov({ priorities: "read_substantive", eligibility: "read_substantive", process: "read_substantive", grants: "read_substantive" }) })
);
const declaredBarren = deriveAvailability(
  input({ coverage: cov({ priorities: "not_offered", eligibility: "not_offered", process: "not_offered", grants: "not_offered" }) })
);
check("an unreachable funder has work worth doing", obtainableGaps(unreachable).length > 0, true);
check("reading every selected page still leaves site work open", obtainableGaps(fullyRead).length > 0, true);
check("a site the model declared barren offers none", obtainableGaps(declaredBarren).length, 0);

// ---------------------------------------------------------------------------
section("The live path's actual input: a partial close, labelled partial (ruling 0013)");
// ---------------------------------------------------------------------------
//
// availabilityForResearchRun is the ONE place the live run's stored columns are
// mapped onto an AvailabilityInput. Everything below is a property of that
// mapping, not of deriveAvailability -- which is the point: the mapping is
// where a guess would hide.

const runLedger = (over: { filingFetched?: boolean | null; evidencedClaimKeys?: string[] } = {}) =>
  availabilityForResearchRun({
    keys: requiredClaimKeysFor("screening"),
    filingFetched: over.filingFetched ?? null,
    evidencedClaimKeys: over.evidencedClaimKeys ?? [],
  });

const noFiling = runLedger();
const filingRead = runLedger({ filingFetched: true });

check(
  "with no filing read, a registry fact is open",
  stateOf(noFiling, "funding.total_annual_giving"),
  "not_checked"
);
// The half ruling 0013 says to ship: once the filing has actually been read,
// the registry facts it does not carry stop being offered as more work. This is
// the measured failure -- five paid runs chasing figures from a source already
// read -- and this assertion is the thing that closes it.
check(
  "once the filing has been read, a registry fact is settled",
  stateOf(filingRead, "funding.total_annual_giving"),
  "checked_not_stated"
);
check(
  "and is no longer offered",
  obtainableGaps(filingRead).some((f) => f.key === "funding.total_annual_giving"),
  false
);
check(
  "grants paid out, likewise",
  obtainableGaps(filingRead).some((f) => f.key === "funding.charitable_disbursements"),
  false
);
// Without a recorded form type, not_applicable would be asserting one. The
// reason shown is the one we can evidence: we read it and it did not say.
check(
  "and the reason names the filing rather than a form type nobody recorded",
  stateOf(filingRead, "funding.charitable_disbursements"),
  "checked_not_stated"
);

// The other half, unchanged on purpose. coverage is null because only Tier 2
// produces per-purpose coverage and Tier 2 is not in the live path, so no site
// fact may be declared settled -- site work is offered exactly as it is today.
const siteKeys = requiredClaimKeysFor("screening").filter((k) => factSource(k) === "official_site");
check("every site fact is still obtainable, filing or no filing", siteKeys.every((k) => filingRead.find((f) => f.key === k)?.obtainable === true), true);
check("no site fact is ever declared settled", filingRead.filter((f) => factSource(f.key) === "official_site").some((f) => f.state === "checked_not_stated"), false);
// Ruling 0008 through the live mapping: an `either` fact whose site half was
// never checked stays open even though the registry half was read and silent.
// This is the 990 grant schedule, and it is exactly the fact the old code
// declared closed.
check("an either-sourced fact survives a read registry", stateOf(filingRead, "funding.recent_grants"), "not_checked");
check("and is still offered", obtainableGaps(filingRead).some((f) => f.key === "funding.recent_grants"), true);

// Evidence still beats every source question, and only EVIDENCED claims count.
check(
  "an evidenced claim makes the fact found",
  stateOf(runLedger({ evidencedClaimKeys: ["funding.focus_areas"] }), "funding.focus_areas"),
  "found"
);

// ---------------------------------------------------------------------------
section("Nothing is offered that the ledger says cannot close (ruling 0009)");
// ---------------------------------------------------------------------------
//
// offerableGaps is the single filter between the ledger and the rerun
// treadmill. Its output is the ONLY input the gap vocabulary is given --
// outstandingIntelligence for the user, focusKeysFor for the next run's
// directives -- so these assertions cover both surfaces at once.

const ALL_MISSING = ["identity", "funding_priorities", "financial_capacity", "recent_grants", "eligibility", "application_access", "leadership"];

const offerNoFiling = offerableGaps({ ledger: noFiling, missingSections: ALL_MISSING, missingSourceClasses: ["grant_schedule"] });
const offerFilingRead = offerableGaps({ ledger: filingRead, missingSections: ALL_MISSING, missingSourceClasses: ["grant_schedule"] });

check("before the filing is read, financial capacity is worth going after", offerNoFiling.sections.includes("financial_capacity"), true);
check("after it is read, it is not", offerFilingRead.sections.includes("financial_capacity"), false);
// Where the ledger has nothing to say, the guard does not reach past its
// evidence -- ruling 0013's general invariant, stated as a test.
check("a section holding no fact screening requires is left alone", offerFilingRead.sections.includes("leadership"), true);
check("eligibility is all site facts, so it stays offered", offerFilingRead.sections.includes("eligibility"), true);
check("recent grants stays offered even with the filing read", offerFilingRead.sections.includes("recent_grants"), true);
check("and so does the grant schedule that would supply it", offerFilingRead.sourceClasses, ["grant_schedule"]);

// The negative test ruling 0009 calls the one that matters: everything the
// document could supply has been found, so the document is not offered.
const grantsFound = runLedger({ filingFetched: true, evidencedClaimKeys: ["funding.recent_grants"] });
check(
  "a document whose facts are all in hand is not offered",
  offerableGaps({ ledger: grantsFound, missingSections: [], missingSourceClasses: ["grant_schedule"] }).sourceClasses,
  []
);

// Both consumers of the filtered output agree, because they are given the same
// list. A gap shown to a user with no matching directive would be an offer the
// search cannot act on; a directive with no shown gap would be spending the
// user never saw.
check(
  "what the user is shown and what the next run searches for are the same set",
  focusKeysFor({ missingInformation: offerFilingRead.sections, missingSourceClasses: offerFilingRead.sourceClasses }).length,
  outstandingIntelligence({ missingInformation: offerFilingRead.sections, missingSourceClasses: offerFilingRead.sourceClasses }).length
);
check(
  "and a settled fact reaches neither",
  outstandingIntelligence({ missingInformation: offerFilingRead.sections, missingSourceClasses: offerFilingRead.sourceClasses }).some((g) =>
    /financial capacity/i.test(g.label)
  ),
  false
);

// ---------------------------------------------------------------------------
section("A fact that cannot be obtained is still shown, with its reason (ruling 0017)");
// ---------------------------------------------------------------------------

check("every state has wording", AVAILABILITY_STATES.every((s) => AVAILABILITY_WORDING[s]?.label.length > 0), true);
// The distinction the whole build exists to preserve, at the last place it can
// be lost: the screen. A reader who has never seen this vocabulary must be able
// to tell "we read where it would be" from "nobody looked".
check(
  "no two states read the same",
  new Set(AVAILABILITY_STATES.map((s) => AVAILABILITY_WORDING[s].label)).size,
  AVAILABILITY_STATES.length
);
check("checked and silent is not phrased as unchecked", AVAILABILITY_WORDING.checked_not_stated.label === AVAILABILITY_WORDING.not_checked.label, false);
check("no internal vocabulary leaks into the wording", AVAILABILITY_STATES.every((s) => !/_/.test(AVAILABILITY_WORDING[s].label)), true);
// Every fact is displayable: a key with no hand-written label still renders as
// words rather than as an identifier.
check("every required fact has a readable label", requiredClaimKeysFor("screening").every((k) => !factLabel(k).includes(".") && !factLabel(k).includes("_")), true);
check("an unmapped key still renders as words", factLabel("funding.some_new_fact"), "Some new fact");
// Count the actions: exactly the obtainable facts have one. The render keys the
// action off f.obtainable, so this asserts the two agree by construction.
check(
  "exactly the obtainable facts carry an action",
  filingRead.filter((f) => f.obtainable).length,
  obtainableGaps(filingRead).length
);
check("and the settled ones are still on the list", filingRead.length, requiredClaimKeysFor("screening").length);
check("each carrying a reason", filingRead.every((f) => f.reason.length > 0), true);

// ---------------------------------------------------------------------------
section("A screen serving two decisions carries two ledgers (ruling 0030)");
// ---------------------------------------------------------------------------
//
// The Research tab serves screening AND planning the approach, so it derives
// two ledgers -- one call per consumer (ruling 0011), neither keys set widened
// to cover the other. These assertions are ruling 0030's test of compliance:
// two distinct sets at the call sites, and the 8 strategy-only facts each
// present with a reason.

// The 8 keys ruling 0030 names, verbatim from the ruling text.
const STRATEGY_ONLY_KEYS = [
  "application.accepts_unsolicited",
  "application.deadline",
  "application.fiscal_sponsorship_rules",
  "application.invitation_mechanism",
  "funding.grant_size_range",
  "funding.international_reach",
  "funding.median_grant_size",
  "funding.total_assets",
];

const screeningKeys = requiredClaimKeysFor("screening");
const strategyKeys = requiredClaimKeysFor("strategy");

// Two distinct sets, and the difference is exactly the 8 the ruling names --
// derived from the policy maps, never restated by a display.
check("the two consumers' required sets are distinct", JSON.stringify(screeningKeys) === JSON.stringify(strategyKeys), false);
check(
  "strategy requires exactly the 8 facts ruling 0030 names beyond screening",
  strategyKeys.filter((k) => !screeningKeys.includes(k)),
  STRATEGY_ONLY_KEYS
);
// Neither set was widened to serve the other: screening still requires facts
// strategy does not, so neither is a superset of the other.
check("screening's set carries none of the 8", screeningKeys.some((k) => STRATEGY_ONLY_KEYS.includes(k)), false);
check("screening still requires facts strategy does not", screeningKeys.filter((k) => !strategyKeys.includes(k)).length > 0, true);

// The strategy ledger through the live mapping, on a run that found nothing:
// every one of the 8 is present, carries a reason, and is honestly open.
const strategyNoFiling = availabilityForResearchRun({ keys: strategyKeys, filingFetched: null, evidencedClaimKeys: [] });
check("the strategy ledger covers strategy's whole required set", strategyNoFiling.length, strategyKeys.length);
check("each of the 8 strategy-only facts is on the ledger", STRATEGY_ONLY_KEYS.every((k) => strategyNoFiling.some((f) => f.key === k)), true);
check("each of the 8 carries a reason", STRATEGY_ONLY_KEYS.every((k) => (strategyNoFiling.find((f) => f.key === k)?.reason.length ?? 0) > 0), true);
check("with nothing read, each of the 8 is open, not settled", STRATEGY_ONLY_KEYS.every((k) => strategyNoFiling.find((f) => f.key === k)?.obtainable === true), true);
check("and each renders as words, not an identifier", STRATEGY_ONLY_KEYS.every((k) => !factLabel(k).includes(".") && !factLabel(k).includes("_")), true);

// Once the filing is read, the one registry fact among the 8 settles and the
// site-sourced ones stay open -- the same partial close as screening's ledger.
const strategyFilingRead = availabilityForResearchRun({ keys: strategyKeys, filingFetched: true, evidencedClaimKeys: [] });
check("total assets settles once the filing is read", stateOf(strategyFilingRead, "funding.total_assets"), "checked_not_stated");
check(
  "the site-sourced strategy facts stay open",
  STRATEGY_ONLY_KEYS.filter((k) => factSource(k) === "official_site").every((k) => strategyFilingRead.find((f) => f.key === k)?.obtainable === true),
  true
);

// The call sites themselves: one call per consumer, sets passed by consumer
// name rather than by list, so neither can silently grow to cover the other.
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const intelSrc = fs.readFileSync(path.join(__dirname, "../lib/prospect-intelligence.ts"), "utf8");
const tabSrc = fs.readFileSync(path.join(__dirname, "../app/(dashboard)/prospects/[id]/research-tab.tsx"), "utf8");
check(
  "the loader derives exactly one ledger per consumer, each named",
  [intelSrc.split('requiredClaimKeysFor("screening")').length - 1, intelSrc.split('requiredClaimKeysFor("strategy")').length - 1],
  [1, 1]
);
check("no call site in the loader passes an unnamed keys set", intelSrc.split("availabilityForResearchRun(").length - 1, 2);
check(
  "the tab renders both ledgers, each labelled with its decision",
  ["What screening needs", "What strategy needs"].every((h) => tabSrc.includes(h)),
  true
);
check(
  "and reads them from two fields, never one merged list",
  ["intelligence.availability", "intelligence.strategyAvailability"].every((f) => tabSrc.includes(f)),
  true
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
