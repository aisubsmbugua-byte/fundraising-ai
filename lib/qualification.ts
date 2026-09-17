// The pursue/dismiss decision, and the contract a research run is planned
// from.
//
// Research used to plan itself from the organization type and a broadly fixed
// dossier: every funder got the same treatment, and the run measured itself
// against a checklist rather than against the decision anyone was making. The
// contract below inverts that. Planning starts from the DECISION being
// supported -- what we must establish, about which subject, from which
// sources, how fresh, and how deep we are permitted to go. Organization type
// informs the contract; it does not control it.
//
// Nothing here performs retrieval or calls a model. This file is the
// vocabulary and the rules that can be decided in code, so that both are
// testable without a network -- see scripts/test-decision-contract.ts.

import { createHash } from "crypto";

import { requiredClaimKeysFor } from "./research";

export const QUALIFICATION_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

// Four, not three.
//
//   pursue                worth the executive's time; a next action follows
//   dismiss               positively disqualified, or established as a poor fit
//   insufficient_evidence we could not establish enough to say. NEVER silently
//                         converted to dismiss -- absence is not disconfirmation
//   intermediary_only     legitimate, and demonstrably not an opportunity
//
// intermediary_only exists because donor-advised-fund sponsors broke the other
// three. A DAF sponsor is unambiguously legitimate and unambiguously
// grantmaking, so it cannot be dismissed; but its "priorities" are the
// aggregate of thousands of unrelated donor-advisors, so no priority-fit
// verdict about IT is meaningful. It establishes that a giving channel exists,
// which is a real and useful finding -- and a different one from "we could not
// tell", which is what insufficient_evidence means.
export const QUALIFICATION_OUTCOMES = ["pursue", "dismiss", "insufficient_evidence", "intermediary_only"] as const;
export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number];

// Predicate 1. Deliberately NOT a boolean.
//
// Structured retrieval is deterministic; the identity underneath it may still
// be ambiguous. A registry name search for "stewardship foundation" returns 80
// organizations, several sharing that exact name in different states -- the
// lookup is repeatable and the answer is not settled. Collapsing that to
// true/false would force a wrong answer in the one place this build ranks as
// its worst possible failure.
export const LEGITIMACY_STATES = ["established", "conflicting", "insufficient_evidence", "not_applicable"] as const;
export type LegitimacyState = (typeof LEGITIMACY_STATES)[number];

// Predicate 2. Graded rather than binary: where the pursue threshold sits is a
// product setting that can move without redesign.
export const FIT_GRADES = ["strong", "plausible", "weak"] as const;
export type FitGrade = (typeof FIT_GRADES)[number];

// What the fit judgement rests on. Recorded because it changes the outreach --
// on stated priorities you can quote a funder's guidelines back to them; on
// revealed behaviour you cite a grant they actually made -- and because
// revealed evidence always describes the past, filings lagging one to two
// years.
export const FIT_BASES = ["stated", "revealed", "both"] as const;
export type FitBasis = (typeof FIT_BASES)[number];

// ---------------------------------------------------------------------------
// Subject and disclosure
// ---------------------------------------------------------------------------

export const SUBJECT_TYPES = [
  "private_foundation",
  "community_foundation",
  "corporate_program",
  "denominational_fund",
  "daf_sponsor",
  "family_office",
  "individual",
  "unknown",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

// What SHOULD exist for a subject of this type. This is what lets the system
// tell a gap from an absence: an individual has no 990 to be missing, so the
// right status for its filing facts is not_applicable, not not_checked.
export const DISCLOSURE_REGIMES = ["us_990pf", "us_990", "none_public", "unknown"] as const;
export type DisclosureRegime = (typeof DISCLOSURE_REGIMES)[number];

// How far a run may go. The contract carries this so retrieval depth is a
// decision recorded up front rather than something a model discovers it has
// run out of.
export const RETRIEVAL_DEPTHS = ["tier1_only", "tier1_tier2", "tier1_tier2_tier3"] as const;
export type RetrievalDepth = (typeof RETRIEVAL_DEPTHS)[number];

// ---------------------------------------------------------------------------
// Faith affiliation
// ---------------------------------------------------------------------------

// Three states, because two cannot carry the distinction that matters.
//
//   unknown   nobody has told us. Must never disqualify.
//   none      a human confirmed this nonprofit has no denominational affiliation.
//   declared  a human confirmed one or more affiliations.
//
// An empty array cannot distinguish "no affiliation" from "never asked", and
// this codebase already has a rule about exactly that: "not evaluated" and
// "evaluated and clean" are different facts and must not collapse into one
// value. So the state is stored explicitly and the array only ever elaborates
// it.
export const AFFILIATION_STATES = ["unknown", "none", "declared"] as const;
export type AffiliationState = (typeof AFFILIATION_STATES)[number];

export type FaithAffiliation = {
  state: AffiliationState;
  // Vocabulary identifiers, not free text. Non-empty only when declared.
  affiliations: string[];
  confirmedAt: string | null;
  confirmedBy: string | null;
};

export const UNKNOWN_AFFILIATION: FaithAffiliation = {
  state: "unknown",
  affiliations: [],
  confirmedAt: null,
  confirmedBy: null,
};

// Comparison key. Case and punctuation are normalized; NOTHING is dropped.
//
// The temptation is to strip generic tokens the way the entity core-token
// check does -- but "Presbyterian Church (U.S.A.)" and "Presbyterian Church in
// America" are different denominations, and dropping "church", "in" and "of"
// collapses them into each other. Under-matching here costs a missed
// opportunity; over-matching costs a wrong disqualification, and this build
// ranks a missed opportunity as the worse of the two only AFTER a wrong
// material fact. Exact-after-normalization keeps both risks in code we can see.
export function normalizeAffiliationId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

// Reads a stored profile row into the model above, enforcing its invariants
// rather than trusting them. A row claiming "declared" with nothing declared
// is a contradiction, and the safe reading of a contradiction is "we do not
// know" -- never a state that could disqualify someone.
export function readFaithAffiliation(row: {
  faith_affiliation_state?: string | null;
  faith_affiliations?: string[] | null;
  faith_affiliation_confirmed_at?: string | null;
  faith_affiliation_confirmed_by?: string | null;
} | null | undefined): FaithAffiliation {
  if (!row) return UNKNOWN_AFFILIATION;

  const declared = (row.faith_affiliations ?? []).map((a) => a.trim()).filter(Boolean);
  const state = (AFFILIATION_STATES as readonly string[]).includes(row.faith_affiliation_state ?? "")
    ? (row.faith_affiliation_state as AffiliationState)
    : "unknown";

  if (state === "declared" && declared.length === 0) return UNKNOWN_AFFILIATION;

  return {
    state,
    // Only "declared" carries affiliations; a stray array under any other
    // state is ignored rather than allowed to contradict the confirmed state.
    affiliations: state === "declared" ? declared : [],
    confirmedAt: row.faith_affiliation_confirmed_at ?? null,
    confirmedBy: row.faith_affiliation_confirmed_by ?? null,
  };
}

// A denomination the vocabulary can actually vouch for. Nothing enters this
// by inference: a model may SUGGEST a mapping, but only an exact match or a
// human confirmation makes an entry usable, and `reviewStatus` is what
// separates the two.
export type CanonicalDenomination = {
  id: string;
  officialName: string;
  abbreviations: string[];
  formerNames: string[];
  parentBodyId: string | null;
  officialWebsite: string | null;
  // Every claimed relationship carries the source that supports it. A parent
  // body asserted without one is not a relationship, it is a guess.
  relationshipSources: Record<string, string>;
  reviewStatus: "confirmed" | "suggested";
  lastReviewedAt: string | null;
};

// The vocabulary, behind an interface so the rule cannot be made to fire by
// anything less than a confirmed entry.
//
//   resolve                 returns an entry ONLY when it is human-confirmed.
//   explicitlyIncompatible  a DOCUMENTED incompatibility between two canonical
//                           bodies -- never "these two names are different".
export type DenominationRegistry = {
  resolve(name: string): CanonicalDenomination | null;
  explicitlyIncompatible(aId: string, bId: string): boolean;
};

// The registry is empty, deliberately, and this is the default everywhere.
//
// A quickly authored denomination list is the failure mode to avoid: treating
// PC(USA), PCA and EPC as interchangeable -- or as automatically incompatible
// -- would cause a wrong automatic dismissal, among the most damaging outcomes
// this system can produce. The vocabulary grows from real opportunities, one
// evidence-backed and human-confirmed entry at a time.
//
// While it is empty, no input can reach the `incompatible` branch below.
// Denominational auto-dismissal is therefore disabled by construction rather
// than by intention.
export const EMPTY_DENOMINATION_REGISTRY: DenominationRegistry = {
  resolve: () => null,
  explicitlyIncompatible: () => false,
};

// Four verdicts. review_required is the one the ruling turns on, and it is
// genuinely distinct from undetermined:
//
//   undetermined     the rule never fired -- no restriction stated, or no
//                    affiliation known. There is nothing for a human to look at.
//   review_required  a restriction WAS found and an affiliation IS known, and
//                    compatibility could not be established automatically.
//                    A person should decide.
//
// Collapsing them would either hide real work or manufacture it.
export const DENOMINATIONAL_VERDICTS = ["satisfied", "incompatible", "review_required", "undetermined"] as const;
export type DenominationalVerdict = (typeof DENOMINATIONAL_VERDICTS)[number];

export const DENOMINATIONAL_REVIEW_MESSAGE =
  "A denominational restriction was found, but compatibility could not be determined automatically.";

// The denominational rule, and the only place it is decided.
//
// It fires only when all three of the reviewer's conditions hold: the funder
// STATES a restriction, the profile SUPPLIES a confirmed affiliation, and the
// two are DETERMINISTICALLY incompatible. Affiliation alone is never a
// disqualifier, and neither is the absence of one.
//
// `acceptedBodies` must be vocabulary identifiers. Extraction emits none when
// it cannot map a stated restriction onto the vocabulary, and the rule simply
// does not fire -- which is why a non-empty list can be compared exactly
// without risking a wrong dismissal on a wording variant.
export function denominationalCompatibility(input: {
  acceptedBodies: string[];
  profile: FaithAffiliation;
  registry?: DenominationRegistry;
}): DenominationalVerdict {
  const registry = input.registry ?? EMPTY_DENOMINATION_REGISTRY;
  const accepted = input.acceptedBodies.map((b) => b.trim()).filter(Boolean);

  // No stated restriction: the rule has nothing to act on. Not "satisfied" --
  // we have not checked anything, and saying otherwise would let an unstated
  // rule read as an affirmatively cleared one.
  if (accepted.length === 0) return "undetermined";

  // Absence of profile data never disqualifies anyone.
  if (input.profile.state === "unknown") return "undetermined";

  // An exact match needs no vocabulary. It is also the one shortcut that is
  // safe to take without one, because satisfying a restriction can only ever
  // REMOVE a disqualification -- the direction in which being wrong costs
  // nothing worse than a funder we look at more closely than we needed to.
  const acceptedNorm = new Set(accepted.map(normalizeAffiliationId));
  const oursNorm = input.profile.affiliations.map(normalizeAffiliationId);
  if (oursNorm.some((ours) => acceptedNorm.has(ours))) return "satisfied";

  // Everything past here could end in a dismissal, so it requires the
  // vocabulary. Each of the three conditions must hold; any one failing sends
  // the decision to a human instead.

  // 1. The funder's restriction maps confidently to canonical denominations.
  const acceptedCanonical = accepted.map((name) => registry.resolve(name));
  if (acceptedCanonical.some((entry) => entry === null)) return "review_required";

  // 2. Our own affiliation is canonically established too. A confirmed "none"
  //    satisfies this: it is a human-confirmed fact that needs no vocabulary
  //    entry, and comparing it to a named-body requirement involves no
  //    name-matching at all.
  if (input.profile.state === "none") return "incompatible";

  const oursCanonical = input.profile.affiliations.map((name) => registry.resolve(name));
  if (oursCanonical.some((entry) => entry === null)) return "review_required";

  // 3. The incompatibility is DOCUMENTED, not inferred from the fact that two
  //    canonical ids differ. A body can be a member of, or in communion with,
  //    another; non-overlap is not opposition.
  const documented = oursCanonical.every((ours) =>
    acceptedCanonical.every((theirs) => registry.explicitlyIncompatible(ours!.id, theirs!.id))
  );
  return documented ? "incompatible" : "review_required";
}

// ---------------------------------------------------------------------------
// Intermediaries
// ---------------------------------------------------------------------------

// A DAF sponsor is not ordinarily the funding opportunity -- unless a named
// advised fund, specific program or identifiable donor opportunity has been
// identified, in which case THAT is the subject and a normal verdict applies.
//
// Deliberately keyed on whether a named opportunity exists rather than on the
// sponsor's own attributes: National Christian Foundation is the same
// organization whether or not we have identified a specific fund inside it,
// and only the second case is something a nonprofit can pursue.
export function resolvesToIntermediary(input: {
  subjectType: SubjectType;
  namedOpportunity: string | null;
}): boolean {
  if (input.subjectType !== "daf_sponsor") return false;
  return !(input.namedOpportunity ?? "").trim();
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

// The half of the tenant's own profile the fit judgement compares against.
// Held separately from the full row so the fingerprint covers exactly what was
// compared -- editing a phone number must not invalidate a past decision, and
// editing the mission must.
export type ProfileSnapshot = {
  mission: string | null;
  programs: string | null;
  whoWeServe: string | null;
  causeAreas: string[];
  geographicArea: string | null;
  faithAffiliation: FaithAffiliation;
};

export type QualificationContract = {
  contractVersion: number;

  // The three layers, named separately because they resolve on different
  // evidence and one legal entity may carry several opportunities.
  subject: {
    opportunity: string | null;
    operatingOrganization: string | null;
    legalEntityName: string | null;
    ein: string | null;
  };

  knownSources: {
    official: string[];   // the funder speaking about itself
    discovery: string[];  // where we first found them; never conflated with official
  };

  disclosure: {
    subjectType: SubjectType;
    regime: DisclosureRegime;
  };

  tenantProfile: {
    snapshot: ProfileSnapshot;
    // Content hash, not an update timestamp: the point is to reconstruct the
    // exact comparison a past decision rested on.
    fingerprint: string;
  };

  // Derived from SCREENING_FIELD_POLICY, never restated -- a second hand-kept
  // list would be free to drift from the policy it claims to reflect.
  requiredFacts: string[];

  retrievalDepth: RetrievalDepth;

  freshness: {
    // Two filing years. Filings lag one to two years structurally, so
    // demanding anything tighter would fail every filer.
    filingsMaxAgeYears: number;
    officialPagesMaxAgeDays: number;
  };
};

export const DEFAULT_FILINGS_MAX_AGE_YEARS = 2;
export const DEFAULT_OFFICIAL_PAGES_MAX_AGE_DAYS = 30;

// Stable JSON: key order must not change a fingerprint, or the same profile
// would appear to have changed every time an object was rebuilt.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function profileFingerprint(snapshot: ProfileSnapshot): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

export function buildQualificationContract(input: {
  opportunity?: string | null;
  operatingOrganization?: string | null;
  legalEntityName?: string | null;
  ein?: string | null;
  officialSources?: string[];
  discoverySources?: string[];
  subjectType?: SubjectType;
  regime?: DisclosureRegime;
  profile: ProfileSnapshot;
  retrievalDepth?: RetrievalDepth;
  filingsMaxAgeYears?: number;
  officialPagesMaxAgeDays?: number;
}): QualificationContract {
  const subjectType = input.subjectType ?? "unknown";
  return {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    subject: {
      opportunity: input.opportunity?.trim() || null,
      operatingOrganization: input.operatingOrganization?.trim() || null,
      legalEntityName: input.legalEntityName?.trim() || null,
      ein: (input.ein ?? "").replace(/\D/g, "").length === 9 ? (input.ein ?? "").replace(/\D/g, "") : null,
    },
    knownSources: {
      official: dedupe(input.officialSources ?? []),
      discovery: dedupe(input.discoverySources ?? []),
    },
    disclosure: {
      subjectType,
      // An explicit regime always wins; otherwise it is implied by the subject
      // type, and "unknown" stays unknown rather than being guessed into a
      // regime that would make missing filings look like a retrieval failure.
      regime: input.regime ?? impliedRegime(subjectType),
    },
    tenantProfile: {
      snapshot: input.profile,
      fingerprint: profileFingerprint(input.profile),
    },
    requiredFacts: requiredClaimKeysFor("screening"),
    retrievalDepth: input.retrievalDepth ?? "tier1_tier2",
    freshness: {
      filingsMaxAgeYears: input.filingsMaxAgeYears ?? DEFAULT_FILINGS_MAX_AGE_YEARS,
      officialPagesMaxAgeDays: input.officialPagesMaxAgeDays ?? DEFAULT_OFFICIAL_PAGES_MAX_AGE_DAYS,
    },
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function impliedRegime(subjectType: SubjectType): DisclosureRegime {
  switch (subjectType) {
    case "private_foundation":
    case "family_office":
      return "us_990pf";
    case "community_foundation":
    case "denominational_fund":
    case "daf_sponsor":
      return "us_990";
    case "individual":
      return "none_public";
    case "corporate_program":
    case "unknown":
    default:
      return "unknown";
  }
}
