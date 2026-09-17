// Predicate 1 -- "is this a legitimate organization" -- decided from registry
// data alone, with no model and no network.
//
// The predicate is two questions that resolve on different evidence and can
// disagree, so they are answered separately and combined explicitly:
//
//   identity     WHICH legal entity is this?
//   grantmaking  is it actually making grants?
//
// Neither is a boolean, for a reason that is easy to verify: a registry search
// for "stewardship foundation" returns 80 organizations, and one for "national
// christian foundation" returns six with near-identical names in six different
// states, the top-scored of which has no filings at all. Structured retrieval
// is perfectly repeatable and the answer underneath it is still ambiguous.
// Collapsing that to true/false would force a wrong answer in the one place
// this build ranks as its worst possible failure.

import {
  PF_FILING_REQUIRED,
  type RegistryCandidate,
  type RegistryOrganization,
} from "./registry/propublica";
import type { LegitimacyState } from "./qualification";
import { identityTokens, sameState, stateOf, ENTITY_LIFECYCLE_STALE_YEARS } from "./research";

// Tokens that carry no discriminating signal between two organization names.
// Note the plurals: a registry record reads "National Christian Foundations"
// where ours reads "Foundation", and a singular-only list silently makes those
// two names disagree.
const GENERIC_NAME_TOKENS = new Set([
  "the", "and", "for", "of",
  "foundation", "foundations", "fund", "funds", "trust", "trusts", "ttees", "trustees",
  "inc", "incorporated", "corp", "corporation", "company", "llc",
  "family", "charitable", "charity", "charities",
  "ministries", "ministry", "organization", "organisation",
]);

// The distinctive tokens of a name.
//
// NOT deriveEntityNameToken, which returns the single longest surviving word
// and is built for substring-matching a source page. Against a registry record
// it picks the wrong word outright: "Stewardship Foundation C D A B & W T
// Weyerhaeuser Ttees" yields "Weyerhaeuser", which shares nothing with "The
// Stewardship Foundation".
//
// Containment over this set is the same test attestation already uses --
// every distinctive token of OUR name must appear in theirs -- and it is
// deliberately not a similarity score, because a fuzzy measure rates
// "McClellan" close enough to "Maclellan" to pass.
export function distinctiveNameTokens(name: string | null | undefined): string[] {
  return identityTokens(name).filter((t) => !GENERIC_NAME_TOKENS.has(t));
}

// What to actually type into a registry name search.
//
// A prospect's display name routinely carries an opportunity qualifier that no
// registry has ever heard of, and the registry answers a query it cannot match
// with a 404. Measured: "The Signatry (Servant Foundation)" returns 404 while
// "The Signatry" returns 200; likewise "National Christian Foundation (NCF)".
// Searching the display name therefore looks like a retrieval failure when it
// is really a question nobody could answer.
//
// This strips the two shapes an opportunity qualifier reliably takes -- a
// parenthetical, and everything after a dash separator -- and stops there. It
// does NOT try to shorten a name that simply has too many words ("Mariners
// Church High-Capacity Giving Community"): guessing at a shorter query risks
// resolving to a different organization, and a wrong entity is the worst
// failure this build can commit. Those return no candidates, which is
// insufficient evidence and honest.
export function searchableOrganizationName(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+[—–-]\s+/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_ARTICLE = /^(the|a|an)\s+/i;

// Controlled variants of a name to search, ORIGINAL FIRST.
//
// A leading article is not noise to this endpoint. Measured: "The Stewardship
// Foundation" returns 6 organizations, "Stewardship Foundation" returns 80 --
// and the correct funder is only in the second. Stripping articles globally
// would simply move the blind spot, so both forms are asked and the results
// merged. Same for the opportunity qualifier: dropping it finds the parent
// organization, keeping it occasionally finds a separately-registered program.
export function nameQueryVariants(raw: string | null | undefined): string[] {
  const original = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!original) return [];
  const variants = [
    original,
    searchableOrganizationName(original),
    original.replace(LEADING_ARTICLE, ""),
    searchableOrganizationName(original).replace(LEADING_ARTICLE, ""),
  ];
  return [...new Set(variants.map((v) => v.trim()).filter(Boolean))];
}

// Normalized, with a leading article removed, for prefix comparison only.
function nameForPrefix(raw: string | null | undefined): string {
  return normalizeName((raw ?? "").replace(LEADING_ARTICLE, ""));
}

// Are two prospect rows the same funder?
//
// One function, because there is only one question and two answers to it will
// drift. It was answered twice: scripts/entity-collisions.ts keyed on
// EIN-then-domain-then-name, while a report keyed on the display name's
// distinctive tokens -- and the display name carries opportunity qualifiers, so
// the three National Christian Foundation rows produced three different keys
// and a report claiming 32 distinct funders from 32 rows containing a known
// triplicate.
//
// Ordered by authority: a confirmed EIN is the legal entity, an operating
// domain is the organization in practice, a normalized name is a guess and is
// labelled as one.
export function funderIdentityKey(row: {
  ein?: string | null;
  website?: string | null;
  operating_identity_domain?: string | null;
  legal_name?: string | null;
  name?: string | null;
  id?: string | null;
}): { key: string; basis: "ein" | "domain" | "name" | "row" } {
  const ein = (row.ein ?? "").replace(/\D/g, "");
  if (ein.length === 9) return { key: `ein:${ein}`, basis: "ein" };

  const raw = row.operating_identity_domain ?? row.website ?? "";
  if (raw) {
    try {
      const host = new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname.replace(/^www\./, "").toLowerCase();
      if (host) return { key: `domain:${host}`, basis: "domain" };
    } catch {
      // Not a parseable URL; fall through to the name.
    }
  }

  // The ORGANIZATION's name, with any opportunity qualifier removed -- keying
  // on the display name is what produced the three-NCF failure.
  const tokens = distinctiveNameTokens(searchableOrganizationName(row.legal_name ?? row.name)).join(" ");
  if (tokens) return { key: `name:${tokens}`, basis: "name" };

  return { key: `row:${row.id ?? "unknown"}`, basis: "row" };
}

export const IDENTITY_RESOLUTIONS = ["established", "conflicting", "incomplete_search", "insufficient_evidence"] as const;
export type IdentityResolution = (typeof IDENTITY_RESOLUTIONS)[number];

export type IdentityOutcome = {
  state: IdentityResolution;
  ein: string | null;
  matched: RegistryCandidate | null;
  // Everything that survived filtering but was not chosen. A conflicting
  // verdict is only useful if it can say what it is conflicting between.
  alternatives: RegistryCandidate[];
  reason: string;
};

function normalizeName(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

// Resolve a name search down to one legal entity, or refuse.
//
// Deliberately conservative at every branch: this returns "conflicting" rather
// than picking the best-scoring candidate, because the registry's own score
// ranked a Houston affiliate with zero filings above the national body it
// belongs to. A relevance score answers "which string is most similar", which
// is not the question.
export function resolveRegistryIdentity(input: {
  candidates: RegistryCandidate[];
  // False when the sweep was truncated -- pagination capped, or a variant
  // query failed. An unresolved identity over a partial candidate set is
  // incomplete_search, never conflicting: reporting a truncation as a settled
  // ambiguity tells the user a question was answered when it was not asked.
  searchComplete?: boolean;
  hints: {
    ein?: string | null;
    // Where the EIN came from. Only "prospect" -- a human-confirmed value on
    // the prospect row -- is authoritative on its own.
    einSource?: "prospect" | "site_evidence";
    legalName?: string | null;
    operatingName?: string | null;
    aliases?: string[] | null;
    location?: string | null;
    // Names and states read off the funder's own site. These NARROW; they never
    // decide. An unconfirmed domain may influence which of several candidates
    // wins a tie, but must never remove a candidate from consideration -- a
    // wrongly attributed website would otherwise exclude the right answer.
    siteEvidence?: { legalNames?: string[]; states?: string[]; domainConfirmed?: boolean } | null;
  };
}): IdentityOutcome {
  const { candidates, hints } = input;

  // A confirmed EIN outranks every heuristic below it -- but only a CONFIRMED
  // one. An EIN scraped from a website is a lead, not an identity: if that
  // website is wrongly attributed to this prospect, taking its EIN as given
  // resolves us confidently to an entirely unrelated organization, which is the
  // worst failure this build can commit. Site-derived EINs go through
  // corroborateRegistryRecord() against the fetched record instead.
  const hintEin = (hints.ein ?? "").replace(/\D/g, "");
  if (hintEin.length === 9 && (hints.einSource ?? "prospect") === "prospect") {
    const exact = candidates.find((c) => c.ein === hintEin) ?? null;
    return {
      state: "established",
      ein: hintEin,
      matched: exact,
      alternatives: [],
      reason: exact ? "confirmed EIN matched a registry record" : "confirmed EIN taken as given",
    };
  }

  const complete = input.searchComplete !== false;
  const unresolved = (reason: string, alternatives: RegistryCandidate[] = []): IdentityOutcome =>
    complete
      ? { state: "insufficient_evidence", ein: null, matched: null, alternatives, reason }
      : { state: "incomplete_search", ein: null, matched: null, alternatives, reason: `${reason} (search was truncated, so this is not a settled ambiguity)` };

  if (candidates.length === 0) return unresolved("no registry candidates");

  const names = [hints.legalName, hints.operatingName, ...(hints.aliases ?? [])].filter(Boolean) as string[];
  if (names.length === 0) {
    return { state: "insufficient_evidence", ein: null, matched: null, alternatives: [], reason: "no name to search on" };
  }

  const ourNames = new Set(names.map(normalizeName).filter(Boolean));
  const ourTokenSets = names.map(distinctiveNameTokens).filter((set) => set.length > 0);
  if (ourTokenSets.length === 0) {
    return { state: "insufficient_evidence", ein: null, matched: null, alternatives: [], reason: "our own name has no distinctive tokens to match on" };
  }

  // 1. STATE FIRST. Location is the one hint that is universally populated,
  //    and applying it before name matching is what turns 80 candidates into
  //    a handful. Only narrows: if we know a state and no candidate is in it,
  //    the registry's state can legitimately differ from ours (a trust
  //    administered elsewhere), so fall back rather than reject.
  const ourState = stateOf(hints.location);
  const inState = ourState ? candidates.filter((c) => sameState(c.state, ourState)) : [];
  const stateScoped = inState.length > 0;
  const pool0 = stateScoped ? inState : candidates;
  const where = stateScoped ? ` in ${ourState}` : "";

  // 2. Then containment: every distinctive token of one of our names must
  //    appear in theirs. Not similarity -- "Mary McClellan Foundation" does
  //    not contain "maclellan", which is the real contamination this guards.
  const byToken = pool0.filter((c) => {
    const theirs = new Set(distinctiveNameTokens(c.name));
    return ourTokenSets.some((ours) => ours.every((t) => theirs.has(t)));
  });
  if (byToken.length === 0) return unresolved("no candidate contains our distinctive name tokens");

  if (byToken.length === 1) {
    return { state: "established", ein: byToken[0].ein, matched: byToken[0], alternatives: [], reason: `unique name-token match${where}` };
  }

  // 3. An exact full-name match breaks the tie outright.
  const exact = byToken.filter((c) => ourNames.has(normalizeName(c.name)));
  if (exact.length === 1) {
    return { state: "established", ein: exact[0].ein, matched: exact[0], alternatives: byToken.filter((c) => c.ein !== exact[0].ein), reason: `exact name match among ${byToken.length} token matches${where}` };
  }

  // 4. Legal-name ranking. A registry legal name routinely appends trustee and
  //    registration designations to the operating name -- "Stewardship
  //    Foundation C D A B & W T Weyerhaeuser Ttees" IS the Stewardship
  //    Foundation, while "Asset Stewardship Foundation" and "Johnson Family
  //    Stewardship Foundation" are different organizations that merely contain
  //    the same word.
  //
  //    The asymmetry is the signal: our name appearing as a PREFIX means the
  //    extra tokens are trailing legal apparatus; our name appearing in the
  //    middle means someone qualified it into a different entity. Anchored at
  //    a token boundary so "stewardshipfoundation..." cannot match.
  //    NARROW BY DESIGN: trailing words are not universally legal boilerplate.
  //    "Redwood Trust Foundation of Oregon" extends "Redwood Trust" and is a
  //    different organization. The rule therefore only decides when something
  //    else already corroborates the candidate -- currently that the candidate
  //    sits in the state we independently know the funder to be in. Without
  //    corroboration the tie stands and a human sees the alternatives.
  //    Site evidence ranks, never excludes. A state read off the funder's own
  //    site can break a tie that our stored location could not -- but if the
  //    website is wrongly attributed, excluding on it would remove the right
  //    answer entirely. So it only ever reorders what containment already kept.
  const siteStates = (input.hints.siteEvidence?.states ?? []).map((s) => s.toUpperCase());
  const siteNames = new Set((input.hints.siteEvidence?.legalNames ?? []).map(normalizeName).filter(Boolean));
  if (siteStates.length || siteNames.size) {
    const bySite = byToken.filter((c) => (c.state && siteStates.includes(c.state.toUpperCase())) || siteNames.has(normalizeName(c.name)));
    if (bySite.length === 1) {
      return {
        state: "established",
        ein: bySite[0].ein,
        matched: bySite[0],
        alternatives: byToken.filter((c) => c.ein !== bySite[0].ein),
        reason: `unique match once the funder's own site narrowed it${where}`,
      };
    }
  }

  const ourPrefixes = [...new Set(names.map(nameForPrefix).filter(Boolean))];
  const prefixMatches = stateScoped
    ? byToken.filter((c) => {
        const theirs = nameForPrefix(c.name);
        return ourPrefixes.some((ours) => theirs === ours || theirs.startsWith(`${ours} `));
      })
    : [];
  if (prefixMatches.length === 1) {
    return {
      state: "established",
      ein: prefixMatches[0].ein,
      matched: prefixMatches[0],
      alternatives: byToken.filter((c) => c.ein !== prefixMatches[0].ein),
      reason: `legal name extends our name${where}; ${byToken.length - 1} other token matches qualify it differently`,
    };
  }

  // 5. Genuinely several, or none distinguishable. Only call it a conflict if
  //    we actually saw everything -- otherwise the answer may be on a page we
  //    never fetched, which is exactly how this funder was misreported.
  if (!complete) {
    return { state: "incomplete_search", ein: null, matched: null, alternatives: byToken, reason: `${byToken.length} candidates${where} and the search was truncated` };
  }
  return {
    state: "conflicting",
    ein: null,
    matched: null,
    alternatives: byToken,
    reason: ourState
      ? `${byToken.length} organizations share this name token${where}`
      : `${byToken.length} organizations share this name token and no location is known`,
  };
}

// Does a registry record fetched by a SITE-DERIVED EIN actually describe the
// organization we are researching?
//
// This is the safeguard that keeps a wrongly attributed website from forcing a
// wrong legal identity. An EIN on a page is a lead: it may belong to the
// funder, to a fiscal sponsor, to a partner named in a footer, or to whoever
// really owns a domain we mis-assigned. Fetching the record and checking that
// its name or state corroborates ours is the difference between using site
// evidence and being led by it.
//
// Either signal suffices. Requiring both would reject correct EINs whenever a
// registry legal name diverges from the operating name -- common for trusts --
// and the risk being guarded against is a record that matches on NEITHER.
export function corroborateRegistryRecord(
  org: { name: string; state: string | null },
  hints: { names: (string | null | undefined)[]; location?: string | null }
): { corroborated: boolean; by: "name" | "state" | "name+state" | null; reason: string } {
  const ourTokenSets = hints.names.filter(Boolean).map((n) => distinctiveNameTokens(n)).filter((s) => s.length > 0);
  const theirs = new Set(distinctiveNameTokens(org.name));
  const nameOk = ourTokenSets.some((ours) => ours.every((t) => theirs.has(t)));

  const ourState = stateOf(hints.location);
  const stateOk = Boolean(ourState) && sameState(org.state, ourState);

  const by = nameOk && stateOk ? "name+state" : nameOk ? "name" : stateOk ? "state" : null;
  return {
    corroborated: by !== null,
    by,
    reason: by
      ? `site-derived EIN corroborated by ${by}: registry record "${org.name}"${org.state ? ` (${org.state})` : ""}`
      : `site-derived EIN rejected: registry record "${org.name}"${org.state ? ` (${org.state})` : ""} shares neither our name tokens nor our state`,
  };
}

export const GRANTMAKING_STATES = ["established", "insufficient_evidence", "not_applicable"] as const;
export type GrantmakingState = (typeof GRANTMAKING_STATES)[number];

export type GrantmakingOutcome = {
  state: GrantmakingState;
  mostRecentFilingYear: number | null;
  mostRecentGrantsPaid: number | null;
  yearsSinceFiling: number | null;
  stale: boolean;
  reason: string;
};

// Is this entity actually making grants, according to its filings?
//
// The hard constraint, verified against the live API rather than assumed: only
// a 990-PF extract carries grants PAID (contrpdpbks). A 990 filer's extract
// exposes grants RECEIVED and nothing about grants made -- so for public
// charities, denominational funds and DAF sponsors this question is
// not_applicable AT THIS SOURCE, and must be answered from the funder's own
// material instead. That is a different fact from "we looked and found
// nothing", and collapsing them would send the user chasing a number the
// registry never publishes.
//
// Age never dismisses. Filings lag one to two years structurally and an
// aggregator can be a year behind that again; a $97M foundation whose newest
// filing is three years old is stale data, not a dormant funder. Staleness is
// recorded for the availability ledger and does not change the verdict.
export function evaluateGrantmaking(
  org: RegistryOrganization,
  opts: { now?: Date } = {}
): GrantmakingOutcome {
  const currentYear = (opts.now ?? new Date()).getUTCFullYear();
  const mostRecent = org.filings[0] ?? null;
  const year = mostRecent?.taxYear ?? null;
  const yearsSince = year === null ? null : currentYear - year;
  const stale = yearsSince !== null && yearsSince > ENTITY_LIFECYCLE_STALE_YEARS;

  if (org.pfFilingRequirementCode !== PF_FILING_REQUIRED) {
    return {
      state: "not_applicable",
      mostRecentFilingYear: year,
      mostRecentGrantsPaid: null,
      yearsSinceFiling: yearsSince,
      stale,
      reason: "not a 990-PF filer; grants paid are not published in this registry's extract for this form type",
    };
  }

  if (org.filings.length === 0) {
    return {
      state: "insufficient_evidence",
      mostRecentFilingYear: null,
      mostRecentGrantsPaid: null,
      yearsSinceFiling: null,
      stale: false,
      reason: org.filingsWithoutDataCount > 0 ? "filings exist but none carry structured data" : "no filings on record",
    };
  }

  const paying = org.filings.find((f) => (f.grantsPaid ?? 0) > 0) ?? null;
  if (paying) {
    return {
      state: "established",
      mostRecentFilingYear: year,
      mostRecentGrantsPaid: mostRecent?.grantsPaid ?? null,
      yearsSinceFiling: yearsSince,
      stale,
      reason: `grants paid in tax year ${paying.taxYear}`,
    };
  }

  // Every filing reports zero. That is positive evidence and belongs in the
  // record -- but Tier 1 does not dismiss on it, because a foundation can
  // legitimately grant through a related entity. Step 5's disqualification
  // rules decide what to do with it.
  return {
    state: "insufficient_evidence",
    mostRecentFilingYear: year,
    mostRecentGrantsPaid: mostRecent?.grantsPaid ?? null,
    yearsSinceFiling: yearsSince,
    stale,
    reason: "no filing on record reports grants paid",
  };
}

export type LegitimacyOutcome = {
  state: LegitimacyState;
  identity: IdentityOutcome;
  grantmaking: GrantmakingOutcome | null;
  reason: string;
};

// Combine the two halves into the four-valued predicate.
//
// The subtle case is an established identity whose grantmaking the registry
// cannot report. The FACT is not_applicable at this source; the PREDICATE is
// insufficient_evidence, because the question is still open and Tier 2 can
// answer it. Reporting the predicate as not_applicable would tell the user
// nothing more could be learned, which is false.
export function evaluateLegitimacy(input: {
  identity: IdentityOutcome;
  grantmaking: GrantmakingOutcome | null;
  regimePublishesFilings: boolean;
}): LegitimacyOutcome {
  const { identity, grantmaking } = input;

  if (!input.regimePublishesFilings) {
    return {
      state: "not_applicable",
      identity,
      grantmaking,
      reason: "this subject's disclosure regime publishes no filings; legitimacy cannot be settled from a registry",
    };
  }
  if (identity.state === "conflicting") {
    return { state: "conflicting", identity, grantmaking, reason: identity.reason };
  }
  // A truncated search is an open question, not a settled ambiguity, so the
  // predicate is insufficient_evidence rather than conflicting -- and the
  // identity keeps its own incomplete_search status underneath, so nobody
  // reads "we could not decide" as "there are several and we must choose".
  if (identity.state === "incomplete_search" || identity.state === "insufficient_evidence" || !grantmaking) {
    return { state: "insufficient_evidence", identity, grantmaking, reason: identity.reason };
  }
  if (grantmaking.state === "established") {
    return { state: "established", identity, grantmaking, reason: `${identity.reason}; ${grantmaking.reason}` };
  }
  return {
    state: "insufficient_evidence",
    identity,
    grantmaking,
    reason:
      grantmaking.state === "not_applicable"
        ? "entity identified; grantmaking must be established from the funder's own material"
        : `entity identified; ${grantmaking.reason}`,
  };
}
