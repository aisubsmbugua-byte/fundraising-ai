// STATE items 113 + 116 (ruling 0048 clause 4, ruling 0047): the pure logic behind the charities half of the
// funder database screen -- reading the search form, saying which states are loaded and checked, and naming
// the two kinds. No database or network calls here; the pages and the tests both use it.
//
// The kinds stay separate (ruling 0047 clause 2): a funder is a grantmaking public charity, a donor-advised
// fund sponsor, or both, and a count of one kind is never added to a count of the other.

import { PAGE_SIZE, US_STATES } from "./browse";

export type CharityKind = "any" | "charity" | "daf" | "both";
export type CharitySortKey = "name" | "grants" | "daf_funds" | "daf_value";

export interface CharitySearchInput {
  q: string;
  state: string; // "" = any
  kind: CharityKind;
  minGrants: number | null;
  maxGrants: number | null;
  sort: CharitySortKey;
  descending: boolean;
  page: number; // 1-based
}

export const KIND_LABELS: Record<CharityKind, string> = {
  any: "Any kind",
  charity: "Grantmaking public charity",
  daf: "Donor-advised fund sponsor",
  both: "Both kinds",
};

export const CHARITY_SORT_LABELS: Record<CharitySortKey, string> = {
  name: "Name",
  grants: "Largest grants to organizations in a year held",
  daf_funds: "Most donor-advised funds held (count as filed)",
  daf_value: "Largest value of donor-advised funds, end of year",
};

/** Bands of the largest Part IX line 1 figure (grants to domestic organizations) over the periods held, in dollars. */
export const GRANT_BANDS: { value: string; label: string; min: number | null; max: number | null }[] = [
  { value: "", label: "Any size", min: null, max: null },
  { value: "100k-500k", label: "$100,000 to $500,000", min: 100_000, max: 499_999 },
  { value: "500k-1m", label: "$500,000 to $1 million", min: 500_000, max: 999_999 },
  { value: "1m-10m", label: "$1 million to $10 million", min: 1_000_000, max: 9_999_999 },
  { value: "10m-plus", label: "$10 million or more", min: 10_000_000, max: null },
];

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");

/** Reads the query string the form submits. Anything unrecognised falls back to the default, never to an error page. */
export function parseCharitySearch(raw: Raw): CharitySearchInput {
  const state = one(raw.state).trim().toUpperCase();
  const band = GRANT_BANDS.find((b) => b.value === one(raw.size)) ?? GRANT_BANDS[0];
  const sortRaw = one(raw.sort);
  const sort: CharitySortKey = sortRaw === "grants" || sortRaw === "daf_funds" || sortRaw === "daf_value" ? sortRaw : "name";
  const kindRaw = one(raw.kind);
  const kind: CharityKind = kindRaw === "charity" || kindRaw === "daf" || kindRaw === "both" ? kindRaw : "any";
  const pageNum = Number.parseInt(one(raw.page), 10);
  return {
    q: one(raw.q).trim().slice(0, 120),
    state: state in US_STATES ? state : "",
    kind,
    minGrants: band.min,
    maxGrants: band.max,
    sort,
    descending: one(raw.dir) ? one(raw.dir) === "desc" : sort !== "name",
    page: Number.isFinite(pageNum) && pageNum >= 1 ? Math.min(pageNum, 100_000) : 1,
  };
}

export function grantBandValue(input: Pick<CharitySearchInput, "minGrants" | "maxGrants">): string {
  return GRANT_BANDS.find((b) => b.min === input.minGrants && b.max === input.maxGrants)?.value ?? "";
}

/** The query string for a search, leaving out values that are the default. */
export function charitySearchHref(base: string, input: CharitySearchInput, overrides: Partial<CharitySearchInput> = {}): string {
  const s = { ...input, ...overrides };
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.state) p.set("state", s.state);
  if (s.kind !== "any") p.set("kind", s.kind);
  const band = grantBandValue(s);
  if (band) p.set("size", band);
  if (s.sort !== "name") p.set("sort", s.sort);
  const defaultDesc = s.sort !== "name";
  if (s.descending !== defaultDesc) p.set("dir", s.descending ? "desc" : "asc");
  if (s.page > 1) p.set("page", String(s.page));
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

export { PAGE_SIZE };

/** The kinds a funder carries, as labels. Neither label is ever inferred here: they are the stored flags. */
export function kindLabels(isCharity: boolean | null | undefined, isDaf: boolean | null | undefined): string[] {
  return [isCharity ? "Grantmaking public charity" : null, isDaf ? "Donor-advised fund sponsor" : null].filter((x): x is string => !!x);
}

// ---------------------------------------------------------------------------
// which states are loaded, and what their sample check said (from the loader's own run records)
// ---------------------------------------------------------------------------

export interface CharityRunRow {
  status: string;
  started_at: string;
  parameters: { state?: string; kind?: string } | null;
  /** counts.verification.verification_status, as the check recorded it on the run */
  v: string | null;
}

export type CharityStateStatus = "verified" | "verified_within_tolerance" | "not_verified" | "check_not_recorded" | "not_loaded";
export const CHARITY_RUN_KIND = "public_charity_and_daf_sponsor";

/**
 * The status of every state, from the latest COMPLETED run of the charity load for it: what its sample check
 * recorded, "check_not_recorded" when the run finished but carries no check result (it is not guessed to have
 * passed), "not_loaded" when no run completed.
 */
export function charityStateStatuses(runs: CharityRunRow[]): Record<string, CharityStateStatus> {
  const latest = new Map<string, CharityRunRow>();
  for (const r of runs) {
    if (r.parameters?.kind !== CHARITY_RUN_KIND) continue;
    const st = r.parameters?.state?.toUpperCase();
    if (!st || r.status !== "completed") continue;
    const prev = latest.get(st);
    if (!prev || r.started_at > prev.started_at) latest.set(st, r);
  }
  const out: Record<string, CharityStateStatus> = {};
  for (const st of Object.keys(US_STATES)) {
    const r = latest.get(st);
    out[st] = !r ? "not_loaded" : r.v === "verified" ? "verified" : r.v === "verified_within_tolerance" ? "verified_within_tolerance" : r.v === "not_verified" ? "not_verified" : "check_not_recorded";
  }
  return out;
}

export function describeCharityStates(s: Record<string, CharityStateStatus>) {
  const keys = Object.keys(s).sort();
  const of = (...want: CharityStateStatus[]) => keys.filter((k) => want.includes(s[k]));
  return {
    loaded: keys.filter((k) => s[k] !== "not_loaded"),
    exact: of("verified"),
    withinTolerance: of("verified_within_tolerance"),
    notVerified: of("not_verified"),
    notRecorded: of("check_not_recorded"),
    notLoaded: of("not_loaded"),
  };
}

export function charityStateChip(status: CharityStateStatus | undefined): { tone: "teal" | "amber" | "neutral"; text: string } | null {
  if (status === "verified") return { tone: "teal", text: "sample check passed" };
  if (status === "verified_within_tolerance") return { tone: "teal", text: "sample check passed within the margin of error" };
  if (status === "not_verified") return { tone: "amber", text: "not yet verified" };
  if (status === "check_not_recorded") return { tone: "neutral", text: "check result not recorded on the load" };
  if (status === "not_loaded") return { tone: "neutral", text: "load not recorded" };
  return null;
}

/** The statement the screen must carry wherever a donor-advised fund sponsor's grants are shown (ruling 0047 clause 3). */
export const NO_DONOR_STATEMENT =
  "No donor, advisor or fund is named anywhere in this database. For a donor-advised fund sponsor, the grants shown are the sponsor's own as filed, and carry no donor.";

/**
 * Shown beside every donor-advised fund count. The count is exactly what Schedule D, Part I, line 1, column (a)
 * says, and the check proves it matches the return; but some filers type a dollar amount into that field, so a
 * very large count is not evidence of a large sponsor. The value of the funds is the better guide.
 */
export const DAF_COUNT_CAVEAT =
  "The number of funds is shown exactly as filed. Some filers enter a dollar amount in that field, so an unusually large count is not proof of a large sponsor; the value of the funds is the better guide.";
