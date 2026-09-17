// For every fact the screening decision needs: did we find it, did we look, or
// could we never have found it?
//
// This is the fix for the largest measured user pain. The old system reported
// coverage gaps without distinguishing obtainable from unobtainable, so a user
// was invited to spend again on gaps that could never close -- one prospect
// absorbed five paid runs chasing a document that direct probing later showed
// is not published at that source at all.
//
// Five states, and the one that matters most is the difference between the
// middle two:
//
//   found              we have evidence stating it
//   checked_not_stated we read where it would be, and it is not there
//   not_checked        we never looked
//   retrieval_failed   we tried and could not reach it
//   not_applicable     this subject does not produce this disclosure at all
//
// "They do not publish it" is a fact about the funder. "We did not look" is a
// fact about us. Collapsing them is what produced the treadmill, and the
// codebase already had the rule -- never let "not evaluated" and "evaluated and
// clean" become one value -- applied to claim verification and nowhere else.

import type { DisclosureRegime, SubjectType } from "./qualification";
import type { SelectionPurpose } from "./tier2/select";
import type { PurposeCoverage } from "./tier2/fetch";
import { RESEARCH_INFORMATION_SECTIONS } from "./research";

export const AVAILABILITY_STATES = [
  "found",
  "checked_not_stated",
  "not_checked",
  "retrieval_failed",
  "not_applicable",
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

// The whole point of the ledger. Only these two can be closed by doing more
// work, so only these two may ever be offered to a user as a reason to spend.
export const OBTAINABLE: ReadonlySet<AvailabilityState> = new Set(["not_checked", "retrieval_failed"]);

export function isObtainable(state: AvailabilityState): boolean {
  return OBTAINABLE.has(state);
}

// Where a fact is expected to come from. This is what lets the ledger say
// "not_applicable" honestly rather than reporting a permanent gap: a 990 filer
// publishes no grants-paid figure in the registry extract, so asking the
// registry for one forever would be asking the wrong source.
export const FACT_SOURCES = ["registry", "official_site", "either"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

const KEY_SOURCE: Record<string, FactSource> = {
  "funding.total_assets": "registry",
  "funding.total_annual_giving": "registry",
  "funding.charitable_disbursements": "registry",
  "funding.total_revenue": "registry",
  "funding.total_expenses": "registry",
  "funding.funder_type": "registry",
  "funding.recent_grants": "either",
  "funding.focus_areas": "official_site",
  "funding.geographic_focus": "either",
  "funding.geographic_restriction": "official_site",
  "funding.international_reach": "official_site",
  "application.eligible_org_types": "official_site",
  "application.foreign_org_eligibility": "official_site",
  "application.excluded_recipients": "official_site",
  "application.prohibited_activities": "official_site",
  "application.mission_alignment_requirement": "official_site",
  "application.denominational_restriction": "official_site",
  "application.accepts_unsolicited": "official_site",
  "application.invitation_mechanism": "official_site",
  "application.deadline": "official_site",
  "application.fiscal_sponsorship_rules": "official_site",
};

export function factSource(key: string): FactSource {
  return KEY_SOURCE[key] ?? "official_site";
}

// Which retrieval purpose was supposed to surface this fact.
const KEY_PURPOSE: Record<string, SelectionPurpose> = {
  "funding.focus_areas": "priorities",
  "funding.geographic_focus": "priorities",
  "funding.international_reach": "priorities",
  "funding.geographic_restriction": "eligibility",
  "application.eligible_org_types": "eligibility",
  "application.foreign_org_eligibility": "eligibility",
  "application.excluded_recipients": "eligibility",
  "application.prohibited_activities": "eligibility",
  "application.mission_alignment_requirement": "eligibility",
  "application.denominational_restriction": "eligibility",
  "application.fiscal_sponsorship_rules": "eligibility",
  "application.accepts_unsolicited": "process",
  "application.invitation_mechanism": "process",
  "application.deadline": "process",
  "funding.recent_grants": "grants",
};

export type FactAvailability = {
  key: string;
  state: AvailabilityState;
  source: FactSource;
  obtainable: boolean;
  reason: string;
};

export type AvailabilityInput = {
  // Required, with no default. There is no ledger for a prospect, only a ledger
  // for a DECISION -- screening needs different facts than strategy, and a
  // default silently answered that question for call sites that never asked it
  // (ruling 0011). Callers pass requiredClaimKeysFor(consumer).
  keys: string[];
  regime: DisclosureRegime;
  subjectType: SubjectType;
  // Was a registry record actually retrieved, and does this filer's form type
  // publish grants paid? Both matter: a 990 filer's extract carries grants
  // RECEIVED and nothing about grants made, verified against the live API.
  registry: { retrieved: boolean; publishesGrantsPaid: boolean } | null;
  // Per-purpose outcome from Tier 2.
  coverage: Record<SelectionPurpose, PurposeCoverage> | null;
  // Whether the funder's own site could be reached at all.
  siteReachable: boolean;
  // Claim keys extraction actually produced.
  claimKeys: string[];
};

// What ONE source has to say about a fact. Recorded per source and never
// adopted as the fact's own state -- see combine() below.
type SourceOutcome = { state: AvailabilityState; reason: string };

function registryOutcome(key: string, input: AvailabilityInput): SourceOutcome {
  // Could this subject ever file? An individual files no return.
  if (input.regime === "none_public") {
    return { state: "not_applicable", reason: "this subject's disclosure regime publishes no filings" };
  }
  // A 990 filer's extract carries grants RECEIVED and nothing about grants
  // made, verified against the live API. Asking forever would be asking the
  // wrong source.
  if (key === "funding.charitable_disbursements" && input.registry && !input.registry.publishesGrantsPaid) {
    return { state: "not_applicable", reason: "this form type's registry extract does not carry grants paid" };
  }
  if (!input.registry?.retrieved) {
    return { state: "not_checked", reason: "no registry record was retrieved" };
  }
  return { state: "checked_not_stated", reason: "the registry record was read and does not carry this field" };
}

function siteOutcome(key: string, input: AvailabilityInput): SourceOutcome {
  if (!input.siteReachable) {
    return { state: "retrieval_failed", reason: "the funder's own site could not be reached" };
  }
  const purpose = KEY_PURPOSE[key];
  const cov = purpose && input.coverage ? input.coverage[purpose] : undefined;

  if (cov === "retrieval_failed") return { state: "retrieval_failed", reason: `the page selected for ${purpose} could not be read` };
  if (cov === "not_offered") return { state: "checked_not_stated", reason: `no page on this site could answer ${purpose}` };
  if (cov === "found") return { state: "checked_not_stated", reason: `pages covering ${purpose} were read and do not state it` };
  // A page that loaded but said almost nothing has not answered anything.
  // Treating it as checked would claim we read their priorities when we read
  // their navigation.
  if (cov === "found_thin") return { state: "not_checked", reason: `the page covering ${purpose} carried too little text to have stated it` };

  return { state: "not_checked", reason: purpose ? `no page was read for ${purpose}` : "not retrieved" };
}

// Ruling 0008: a fact is unobtainable only when EVERY source that could carry
// it has been checked. The fact takes the state of the fact, never the state of
// whichever source happened to be consulted first.
//
// Order matters and is not arbitrary -- it is "most work still available"
// first. An unread source outranks a read-and-silent one, because the unread
// one can still change the answer.
function combine(outcomes: SourceOutcome[]): SourceOutcome {
  const pick = (s: AvailabilityState) => outcomes.find((o) => o.state === s);

  // Any source we never consulted leaves the fact open, whatever the others said.
  const unchecked = pick("not_checked");
  if (unchecked) return unchecked;

  // Tried and failed: still retryable, so still obtainable.
  const failed = pick("retrieval_failed");
  if (failed) return failed;

  // Every source has now been checked. If they ALL structurally cannot carry
  // it, the fact is not applicable; if any could have and did not, the funder
  // has answered and the answer is silence.
  const silent = pick("checked_not_stated");
  if (silent) return silent;

  return outcomes[0] ?? { state: "not_checked", reason: "no source was consulted" };
}

export function deriveAvailability(input: AvailabilityInput): FactAvailability[] {
  const found = new Set(input.claimKeys);

  return input.keys.map((key) => {
    const source = factSource(key);
    const make = (state: AvailabilityState, reason: string): FactAvailability => ({
      key, state, source, obtainable: isObtainable(state), reason,
    });

    // Evidence beats every source-level question.
    if (found.has(key)) return make("found", "stated in captured evidence");

    const outcomes: SourceOutcome[] = [];
    if (source === "registry" || source === "either") outcomes.push(registryOutcome(key, input));
    if (source === "official_site" || source === "either") outcomes.push(siteOutcome(key, input));

    const { state, reason } = combine(outcomes);
    return make(state, reason);
  });
}

// What may honestly be offered to a user as more work.
//
// A gap that cannot close must never appear here. This is the single guard
// between the ledger and the rerun treadmill.
export function obtainableGaps(ledger: FactAvailability[]): FactAvailability[] {
  return ledger.filter((f) => f.obtainable);
}

export function availabilitySummary(ledger: FactAvailability[]): Record<AvailabilityState, number> {
  const out = Object.fromEntries(AVAILABILITY_STATES.map((s) => [s, 0])) as Record<AvailabilityState, number>;
  for (const f of ledger) out[f.state]++;
  return out;
}

// ---------------------------------------------------------------------------
// The live path's input to the ledger (ruling 0013)
// ---------------------------------------------------------------------------
//
// One function maps a stored research run onto AvailabilityInput, so the
// judgement calls below are made once and are reviewable in one place rather
// than being re-invented at each call site.
//
// Ruling 0013 authorizes a PARTIAL close: obtainability is decided where the
// live path has evidence for it, and nowhere else. Concretely:
//
//   coverage: null      Per-purpose coverage is produced by Tier 2 only, and
//                       Tier 2 is not in the live path. Inferring it from
//                       official_site_fetched was considered and rejected --
//                       it has no measurement behind it. Under ruling 0008
//                       this leaves every site-sourced fact obtainable, so
//                       site work is still offered exactly as it is today.
//
//   registry.retrieved  research_runs.filing_fetched: whether a page this run
//                       actually fetched classified as an IRS filing. This is
//                       a record of retrieval, not an inference from one, so
//                       it is the half ruling 0013 says to ship.
//
//   publishesGrantsPaid The live path does not record a form type. Only FALSE
//                       produces a verdict (not_applicable on
//                       charitable_disbursements), so passing false would be
//                       asserting a form type nobody established. Passing true
//                       asserts nothing: the fact lands on
//                       checked_not_stated instead, which is obtainable=false
//                       either way. The choice changes the REASON shown, never
//                       the offer, and "we read the filing and it did not
//                       carry this" is the reason that is true.
//
//   subjectType/regime  Neither is recorded against a prospect -- searched for
//                       with `grep -rn "subject_type\|disclosure_regime"
//                       supabase/migrations/`, which returns nothing. "unknown"
//                       is therefore the honest value; impliedRegime would be
//                       guessing a filer out of a funder_type string.
//
//   siteReachable       true, which under coverage: null selects "no page was
//                       read for X" over "the site could not be reached".
//                       Both are obtainable, so nothing about the offer turns
//                       on it -- but the live path cannot evidence a FAILED
//                       attempt at a purpose, and claiming one would be the
//                       display telling a user we tried when we did not.
export function availabilityForResearchRun(input: {
  // Required, no default -- ruling 0011. Callers pass
  // requiredClaimKeysFor(consumer) and the call site names its decision.
  keys: string[];
  // research_runs.filing_fetched. Null on runs predating migration 0044.
  filingFetched: boolean | null;
  // Claim keys this run produced WITH evidence. An uncited finding cannot make
  // a fact count as found, the same rule missingInformationSections applies.
  evidencedClaimKeys: string[];
}): FactAvailability[] {
  return deriveAvailability({
    keys: input.keys,
    regime: "unknown",
    subjectType: "unknown",
    registry: input.filingFetched === true ? { retrieved: true, publishesGrantsPaid: true } : null,
    coverage: null,
    siteReachable: true,
    claimKeys: input.evidencedClaimKeys,
  });
}

// ---------------------------------------------------------------------------
// The single filter between the ledger and the rerun treadmill (ruling 0009)
// ---------------------------------------------------------------------------
//
// Ruling 0009 does not move the gap vocabulary: outstandingIntelligence and
// FOCUS_SEARCH_DIRECTIVES still translate a gap into what it is worth and what
// to search for. What changes is their INPUT -- the sections and source classes
// they receive are filtered here, once, upstream, instead of being every
// category that happens to lack a claim.
//
// Two rules, and the second is ruling 0013's general invariant:
//
//   Where the ledger has graded a fact, the ledger decides. A section whose
//   graded facts are all unobtainable is not offered, in any wording.
//
//   Where the ledger has nothing to say -- a section holding no fact this
//   consumer requires -- the facts are still not_checked, so the section
//   continues to be offered. Suppressing it would be the guard reaching past
//   the evidence it has, which is the failure ruling 0013 names.

// Which required facts a given source class would actually supply. Derived from
// the FactSource map rather than listed twice, except for the grant schedule,
// which is a specific document inside a filing rather than a source class of
// its own.
const GRANT_SCHEDULE_KEYS = new Set([
  "funding.recent_grants",
  "funding.median_grant_size",
  "funding.grant_size_range",
  "funding.grant_count_annual",
]);

function sourceClassServes(cls: string, key: string): boolean {
  if (cls === "grant_schedule") return GRANT_SCHEDULE_KEYS.has(key);
  if (cls === "authoritative_filing") return factSource(key) !== "official_site";
  if (cls === "official_site") return factSource(key) !== "registry";
  // An unrecognised class is not claimed to serve anything, so it falls through
  // to "the ledger says nothing" and is left alone.
  return false;
}

export type OfferableGaps = { sections: string[]; sourceClasses: string[] };

export function offerableGaps(input: {
  ledger: FactAvailability[];
  // What this run obtained nothing for, from missingInformationSections.
  missingSections: string[];
  // What it recorded as present-but-unread, from the retrieval diagnostics.
  missingSourceClasses: string[];
}): OfferableGaps {
  const obtainable = new Set(obtainableGaps(input.ledger).map((f) => f.key));
  const graded = input.ledger.map((f) => f.key);
  const gradedSet = new Set(graded);

  const decide = (keys: string[]): boolean => {
    const gradedKeys = keys.filter((k) => gradedSet.has(k));
    if (gradedKeys.length === 0) return true;
    return gradedKeys.some((k) => obtainable.has(k));
  };

  return {
    sections: input.missingSections.filter((section) =>
      decide([...(RESEARCH_INFORMATION_SECTIONS.find((s) => s.section === section)?.keys ?? [])])
    ),
    sourceClasses: input.missingSourceClasses.filter((cls) => decide(graded.filter((k) => sourceClassServes(cls, k)))),
  };
}

// ---------------------------------------------------------------------------
// Showing a fact that cannot be obtained (ruling 0017)
// ---------------------------------------------------------------------------
//
// A fact removed from the offer must NOT be removed from the screen. The
// wording below has one job: let a reader tell "we read where it would be and
// they are silent" from "nobody has looked", without knowing any of this
// module's vocabulary. That distinction is the whole point -- a blank cannot
// carry it, and this build exists to stop exactly that collapse.
export const AVAILABILITY_WORDING: Record<AvailabilityState, { label: string; tone: "teal" | "amber" | "red" | "neutral" }> = {
  found: { label: "Found", tone: "teal" },
  checked_not_stated: { label: "Checked — they do not state it", tone: "neutral" },
  not_checked: { label: "Nobody has looked yet", tone: "amber" },
  retrieval_failed: { label: "Tried, could not be read", tone: "amber" },
  not_applicable: { label: "Not something they publish at all", tone: "neutral" },
};

// A fact key in words. Explicit where the phrasing matters, derived otherwise,
// so a key added to the vocabulary renders as readable text rather than as
// nothing at all.
const FACT_LABELS: Record<string, string> = {
  "funding.total_assets": "Total assets",
  "funding.total_annual_giving": "Total annual giving",
  "funding.charitable_disbursements": "Grants paid out",
  "funding.total_revenue": "Total revenue",
  "funding.total_expenses": "Total expenses",
  "funding.funder_type": "What kind of funder this is",
  "funding.recent_grants": "Grants they have actually made",
  "funding.focus_areas": "What they fund",
  "funding.geographic_focus": "Where they fund",
  "funding.geographic_restriction": "Geographic limits on who may apply",
  "funding.international_reach": "Whether they fund internationally",
  "funding.grant_size_range": "Range of grant sizes",
  "funding.median_grant_size": "Typical grant size",
  "funding.grant_count_annual": "Grants made per year",
  "application.eligible_org_types": "Which organization types may apply",
  "application.foreign_org_eligibility": "Whether non-US organizations may apply",
  "application.excluded_recipients": "Who they explicitly exclude",
  "application.prohibited_activities": "What they will not fund",
  "application.mission_alignment_requirement": "Any mission-alignment requirement",
  "application.denominational_restriction": "Any denominational restriction",
  "application.accepts_unsolicited": "Whether they accept unsolicited requests",
  "application.invitation_mechanism": "How an invitation is obtained",
  "application.deadline": "Application deadline",
  "application.fiscal_sponsorship_rules": "Fiscal sponsorship rules",
};

export function factLabel(key: string): string {
  const known = FACT_LABELS[key];
  if (known) return known;
  const tail = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const words = tail.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
