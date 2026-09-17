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
import { requiredClaimKeysFor } from "./research";
import type { SelectionPurpose } from "./tier2/select";
import type { PurposeCoverage } from "./tier2/fetch";

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
  // Defaults to the screening consumer's required set -- the facts that gate
  // pursue or dismiss, not all 43.
  keys?: string[];
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

export function deriveAvailability(input: AvailabilityInput): FactAvailability[] {
  const keys = input.keys ?? requiredClaimKeysFor("screening");
  const found = new Set(input.claimKeys);

  return keys.map((key) => {
    const source = factSource(key);
    const make = (state: AvailabilityState, reason: string): FactAvailability => ({
      key, state, source, obtainable: isObtainable(state), reason,
    });

    // 1. Could this subject ever produce it? An individual files no return; a
    //    990 filer publishes no grants-paid figure. Neither is a gap.
    if (source === "registry" || source === "either") {
      if (input.regime === "none_public" && source === "registry") {
        return make("not_applicable", "this subject's disclosure regime publishes no filings");
      }
      if (key === "funding.charitable_disbursements" && input.registry && !input.registry.publishesGrantsPaid) {
        return make("not_applicable", "this form type's registry extract does not carry grants paid");
      }
    }

    // 2. Extraction produced it.
    if (found.has(key)) return make("found", "stated in captured evidence");

    // 3. Registry facts: retrieved but silent, or never retrieved.
    if (source === "registry") {
      if (!input.registry?.retrieved) return make("not_checked", "no registry record was retrieved");
      return make("checked_not_stated", "the registry record was read and does not carry this field");
    }

    // 4. Site facts, decided by what happened to the purpose that covers them.
    const purpose = KEY_PURPOSE[key];
    const cov = purpose && input.coverage ? input.coverage[purpose] : undefined;

    if (!input.siteReachable) {
      return make("retrieval_failed", "the funder's own site could not be reached");
    }
    if (cov === "retrieval_failed") return make("retrieval_failed", `the page selected for ${purpose} could not be read`);
    if (cov === "not_offered") return make("checked_not_stated", `no page on this site could answer ${purpose}`);
    if (cov === "found") return make("checked_not_stated", `pages covering ${purpose} were read and do not state it`);
    // A page that loaded but said almost nothing has not answered anything.
    // Treating it as checked would claim we read their priorities when we read
    // their navigation.
    if (cov === "found_thin") return make("not_checked", `the page covering ${purpose} carried too little text to have stated it`);

    return make("not_checked", purpose ? `no page was read for ${purpose}` : "not retrieved");
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
