// STATE item 113, ruling 0048: the pure logic behind the funder database screen --
// reading the search form, saying which states are loaded and which are verified,
// and formatting values so that "absent", "not held" and zero are never confused.
// No database or network calls here; the pages and the tests both use it.

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export const PAGE_SIZE = 25;
export const GRANTS_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// the search form
// ---------------------------------------------------------------------------

export type SortKey = "name" | "assets" | "grants_paid";
export type PreselectedFilter = "any" | "marked" | "not_marked";

export interface SearchInput {
  q: string;
  state: string; // "" = any
  minAssets: number | null;
  maxAssets: number | null;
  preselected: PreselectedFilter;
  sort: SortKey;
  descending: boolean;
  page: number; // 1-based
}

export const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  assets: "Assets, end of year",
  grants_paid: "Grants paid in the year",
};

/** The size bands offered, in dollars. A band is a minimum and an optional maximum. */
export const SIZE_BANDS: { value: string; label: string; min: number | null; max: number | null }[] = [
  { value: "", label: "Any size", min: null, max: null },
  { value: "under-1m", label: "Under $1 million", min: null, max: 999_999 },
  { value: "1m-10m", label: "$1 million to $10 million", min: 1_000_000, max: 9_999_999 },
  { value: "10m-100m", label: "$10 million to $100 million", min: 10_000_000, max: 99_999_999 },
  { value: "100m-plus", label: "$100 million or more", min: 100_000_000, max: null },
];

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");

/** Reads the query string the form submits. Anything unrecognised falls back to the default, never to an error page. */
export function parseSearch(raw: Raw): SearchInput {
  const state = one(raw.state).trim().toUpperCase();
  const size = SIZE_BANDS.find((b) => b.value === one(raw.size)) ?? SIZE_BANDS[0];
  const sortRaw = one(raw.sort);
  const sort: SortKey = sortRaw === "assets" || sortRaw === "grants_paid" ? sortRaw : "name";
  const preRaw = one(raw.preselected);
  const preselected: PreselectedFilter = preRaw === "marked" || preRaw === "not_marked" ? preRaw : "any";
  const pageNum = Number.parseInt(one(raw.page), 10);
  return {
    q: one(raw.q).trim().slice(0, 120),
    state: state in US_STATES ? state : "",
    minAssets: size.min,
    maxAssets: size.max,
    preselected,
    sort,
    // sorting by a dollar figure starts with the largest; by name, A to Z -- unless the form says otherwise
    descending: one(raw.dir) ? one(raw.dir) === "desc" : sort !== "name",
    page: Number.isFinite(pageNum) && pageNum >= 1 ? Math.min(pageNum, 100_000) : 1,
  };
}

export function sizeBandValue(input: Pick<SearchInput, "minAssets" | "maxAssets">): string {
  return SIZE_BANDS.find((b) => b.min === input.minAssets && b.max === input.maxAssets)?.value ?? "";
}

/** The query string for a search, leaving out values that are the default. */
export function searchHref(base: string, input: SearchInput, overrides: Partial<SearchInput> = {}): string {
  const s = { ...input, ...overrides };
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.state) p.set("state", s.state);
  const band = sizeBandValue(s);
  if (band) p.set("size", band);
  if (s.preselected !== "any") p.set("preselected", s.preselected);
  if (s.sort !== "name") p.set("sort", s.sort);
  const defaultDesc = s.sort !== "name";
  if (s.descending !== defaultDesc) p.set("dir", s.descending ? "desc" : "asc");
  if (s.page > 1) p.set("page", String(s.page));
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

export function pageCount(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

// ---------------------------------------------------------------------------
// which states are loaded, and which have passed their sample check
// ---------------------------------------------------------------------------

export interface RunRow {
  status: string;
  started_at: string;
  parameters: { state?: string } | null;
  counts: { supervisor?: { complete?: boolean } } | null;
}

export type StateStatus = "verified" | "not_verified" | "not_loaded";

/**
 * The status of every state, from the runs the loader recorded (ruling 0046 clause 3):
 * "verified" only when the state's latest COMPLETED run says its sample check passed;
 * "not_verified" when a run completed but did not say so (still being checked, or run
 * before the check existed); "not_loaded" when no run completed.
 */
export function stateStatuses(runs: RunRow[]): Record<string, StateStatus> {
  const latest = new Map<string, RunRow>();
  for (const r of runs) {
    const st = r.parameters?.state?.toUpperCase();
    if (!st || r.status !== "completed") continue;
    const prev = latest.get(st);
    if (!prev || r.started_at > prev.started_at) latest.set(st, r);
  }
  const out: Record<string, StateStatus> = {};
  for (const st of Object.keys(US_STATES)) {
    const r = latest.get(st);
    out[st] = !r ? "not_loaded" : r.counts?.supervisor?.complete === true ? "verified" : "not_verified";
  }
  return out;
}

export function describeStates(statuses: Record<string, StateStatus>): {
  loaded: string[];
  verified: string[];
  notVerified: string[];
  notLoaded: string[];
} {
  const keys = Object.keys(statuses).sort();
  return {
    loaded: keys.filter((k) => statuses[k] !== "not_loaded"),
    verified: keys.filter((k) => statuses[k] === "verified"),
    notVerified: keys.filter((k) => statuses[k] === "not_verified"),
    notLoaded: keys.filter((k) => statuses[k] === "not_loaded"),
  };
}

// ---------------------------------------------------------------------------
// values: absent is not zero, and a period not held is not "gave nothing"
// ---------------------------------------------------------------------------

export const NOT_STATED = "Not stated on the return";
export const NOT_HELD = "Not held in this database";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Dollars from a stored amount; null (the return does not carry it) is NOT_STATED, never $0. */
export function formatAmount(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return NOT_STATED;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? money.format(n) : NOT_STATED;
}

export function formatCount(v: number | null | undefined): string {
  return v === null || v === undefined ? NOT_STATED : v.toLocaleString("en-US");
}

/** A date as stored (yyyy-mm-dd) in words, with no time-zone shift. */
export function formatPeriodEnd(iso: string | null | undefined): string {
  if (!iso) return NOT_STATED;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** A timestamp as "November 10, 2026, 22:00 UTC"; the search list says when it was last refreshed in this form. */
export function formatRefreshed(iso: string | null | undefined): string {
  if (!iso) return "not yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not yet";
  const day = formatPeriodEnd(d.toISOString().slice(0, 10));
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`;
}

export function formatEin(ein: string): string {
  return /^\d{9}$/.test(ein) ? `${ein.slice(0, 2)}-${ein.slice(2)}` : ein;
}

export function funderName(name: string | null | undefined): string {
  return name && name.trim() ? name : "Name not stated on the return";
}

export function placeLine(city: string | null | undefined, state: string | null | undefined): string {
  return [city, state].filter((x) => x && x.trim()).join(", ") || "Address not stated on the return";
}

/** What the "gives only to pre-selected charities" box says -- and no more than it says. */
export function preselectedText(checked: boolean | null | undefined, held: boolean): { label: string; note: string | null } {
  if (!held) return { label: NOT_HELD, note: null };
  if (checked === true) {
    return { label: "The return says it gives only to pre-selected charities.", note: "It does not accept unsolicited requests, as the return states." };
  }
  return {
    label: "The return does not say it gives only to pre-selected charities.",
    note: "An unmarked box is not a statement that the funder accepts requests; check the funder's own guidelines.",
  };
}

/** The coverage of one calendar year of tax periods, in words that do not read as "gave nothing". */
export function coverageText(status: "loaded" | "unread" | "no_filing_in_index" | undefined, note?: string | null): string {
  if (status === "loaded") return "Held";
  if (status === "unread") return `A filing exists but could not be read${note ? `: ${note}` : ""}`;
  if (status === "no_filing_in_index") return "Not held: the IRS index lists no return for this year";
  return NOT_HELD;
}

/** Anchor for a filing's source block on a funder page. */
export const filingAnchor = (objectId: string): string => `filing-${objectId}`;

export function figureLabelTone(v: unknown): "present" | "absent" {
  return v === null || v === undefined ? "absent" : "present";
}
