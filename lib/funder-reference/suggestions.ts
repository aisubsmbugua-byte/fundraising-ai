// STATE item 117 (ruling 0049): funders from the national database, suggested first in the Donor Finder.
//
// Everything here is either a pure rule (the size band, the reason sentence, the channel a funder maps to, the state of a
// location) or a read through the signed-in user's own session. There is no model call, no service key and no outside
// request: a reason is made of numbers the database computed from filed grants, and says so.
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatAmount, formatCount, formatPeriodEnd } from "./browse";

export const SUGGESTION_PAGE_SIZE = 25;

/** The size band is this share of the organization's yearly budget, up to the whole of it (ruling 0049 clause 5). */
export const BAND_LOW_SHARE = 0.02;

export interface SizeBand {
  lo: number;
  hi: number;
}

/** From the organization's own profile. No budget on the profile means no band, and the screen says so. */
export function bandFromBudget(budget: number | string | null | undefined): SizeBand | null {
  const n = typeof budget === "string" ? Number(budget) : budget;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  return { lo: Math.round(n * BAND_LOW_SHARE), hi: Math.round(n) };
}

export function describeBand(band: SizeBand | null, budget: number | string | null | undefined): string {
  if (!band) return "Your profile has no yearly budget, so no size band is applied: every grant to a faith-named recipient counts, whatever its size.";
  return `Grants of ${formatAmount(band.lo)} to ${formatAmount(band.hi)} count as in your band (${Math.round(BAND_LOW_SHARE * 100)}% to 100% of your yearly budget of ${formatAmount(budget)}).`;
}

export const ORDERING_RULE =
  "Ordered by: the number of grants to faith-named recipients that fall in your size band, over the years held; then the share of the funder's listed grants that went to faith-named recipients; then the most recent year with one. Where a band is set, a funder with none in it is left out.";

export const FAITH_NAMED_NOTE =
  "Faith-named means the recipient's name or stated purpose contains a word such as church, ministry, missions, worship or gospel (rule faith-name-v1). It is approximate: it misses some ministries and includes some that are not. Open the grants behind a funder to judge for yourself.";

export const NO_UNSOLICITED_NOTE =
  "These funders' filings say they give only to pre-selected charities. They are not shown as open to requests.";

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(STATES));

/** "Indio, California" or "Indio, CA" gives CA; anything else gives null (the state fact is then simply not shown). */
export function stateFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of [...parts].reverse()) {
    const lower = p.toLowerCase().replace(/\./g, "");
    if (STATES[lower]) return STATES[lower];
    const upper = p.toUpperCase().replace(/\./g, "");
    if (STATE_CODES.has(upper)) return upper;
    const tail = /\b([A-Z]{2})\b(?:\s+\d{5})?$/.exec(p.replace(/\./g, ""));
    if (tail && STATE_CODES.has(tail[1])) return tail[1];
  }
  return null;
}

export type SuggestionGroup = "main" | "daf" | "held_out";

export const DAF_GROUP_NOTE =
  "Donor-advised fund sponsors give on their donors' advice, so a sponsor is not approached the way a foundation is: its donors decide. They give to many recipients, which is why their counts are large. They are listed apart so they do not crowd out funders you can approach directly.";

export type SuggestionSource = "private_foundation" | "public_charity";

export interface SampleGrant {
  recipient: string | null;
  amount_amt: number | null;
  tax_period_end: string;
  filing_object_id: string;
  kind: string;
  ordinal: number;
}

export interface Suggestion {
  ein: string;
  source: SuggestionSource;
  name: string | null;
  city: string | null;
  state: string | null;
  is_daf_sponsor: boolean;
  grants_counted: number;
  periods_counted: number;
  faith_count: number;
  faith_in_band_count: number;
  faith_share: number | null;
  faith_last_period_end: string | null;
  faith_in_state_count: number | null;
  giving_amt: number | null;
  giving_period_end: string | null;
  takes_no_unsolicited: boolean | null;
  faith_amounts_capped: boolean;
  faith_sample: SampleGrant[];
  rule_version: string;
  total_matches: number;
}

interface RawSuggestion extends Omit<Suggestion, "grants_counted" | "faith_count" | "faith_in_band_count" | "faith_share" | "faith_in_state_count" | "giving_amt" | "total_matches"> {
  grants_counted: number | string;
  faith_count: number | string;
  faith_in_band_count: number | string;
  faith_share: number | string | null;
  faith_in_state_count: number | string | null;
  giving_amt: number | string | null;
  total_matches: number | string;
}

const num = (v: number | string | null): number | null => (v === null || v === undefined ? null : Number(v));

export function normalizeSuggestion(r: RawSuggestion): Suggestion {
  return {
    ...r,
    grants_counted: Number(r.grants_counted),
    faith_count: Number(r.faith_count),
    faith_in_band_count: Number(r.faith_in_band_count),
    faith_share: num(r.faith_share),
    faith_in_state_count: num(r.faith_in_state_count),
    giving_amt: num(r.giving_amt),
    total_matches: Number(r.total_matches),
    faith_sample: (r.faith_sample ?? []).map((g) => ({ ...g, amount_amt: num(g.amount_amt as number | string | null) })),
  };
}

export type KindLabel = "Private foundation" | "Donor-advised fund sponsor" | "Grantmaking public charity";

export function kindLabel(s: Pick<Suggestion, "source" | "is_daf_sponsor">): KindLabel {
  if (s.source === "private_foundation") return "Private foundation";
  return s.is_daf_sponsor ? "Donor-advised fund sponsor" : "Grantmaking public charity";
}

/** The pipeline channel a funder is added under. A person can change it later; it is never a model's choice. */
export function channelFor(s: Pick<Suggestion, "source" | "is_daf_sponsor">): "foundation" | "daf" | "regranting" {
  if (s.source === "private_foundation") return "foundation";
  return s.is_daf_sponsor ? "daf" : "regranting";
}

/** The reason a funder is on the list, as numbers and nothing else. Every figure here is a stored count (clause 3). */
export function describeReason(s: Suggestion, band: SizeBand | null, organizationState: string | null): string[] {
  const lines: string[] = [];
  const inBand = band
    ? `${formatCount(s.faith_in_band_count)} of its ${formatCount(s.faith_count)} grants to faith-named recipients were between ${formatAmount(band.lo)} and ${formatAmount(band.hi)}`
    : `${formatCount(s.faith_count)} of its listed grants went to faith-named recipients`;
  lines.push(`${inBand}, over the ${s.periods_counted} tax ${s.periods_counted === 1 ? "year" : "years"} held.`);
  if (s.faith_share !== null) {
    lines.push(`That is ${Math.round(s.faith_share * 100)}% of the ${formatCount(s.grants_counted)} grants it listed in those years.`);
  }
  if (s.faith_last_period_end) lines.push(`Most recent: tax year ended ${formatPeriodEnd(s.faith_last_period_end)}.`);
  if (organizationState && s.faith_in_state_count !== null) {
    lines.push(
      s.faith_in_state_count > 0
        ? `${formatCount(s.faith_in_state_count)} of those went to recipients in ${organizationState}.`
        : `None of those went to recipients in ${organizationState}.`
    );
  }
  if (s.faith_amounts_capped) lines.push("This funder has more such grants than the database counts by size, so the figure in your band is a minimum.");
  return lines;
}

export interface FilingLink {
  url: string;
  member: string | null;
}

export interface SuggestionPage {
  rows: Suggestion[];
  total: number;
  computed: boolean;
  links: Record<string, FilingLink>;
  error: string | null;
}

/** Whether the derived counts have been computed at all: an empty list before that is "not computed", not "nothing fits". */
export async function derivedCountsExist(supabase: SupabaseClient): Promise<boolean> {
  const { count } = await supabase.from("funder_reference_faith_giving").select("ein", { count: "exact", head: true }).limit(1);
  return (count ?? 0) > 0;
}

export async function loadSuggestions(
  supabase: SupabaseClient,
  args: { band: SizeBand | null; state: string | null; group: SuggestionGroup; page: number }
): Promise<SuggestionPage> {
  const { data, error } = await supabase.rpc("reference_funder_suggestions", {
    p_band_lo: args.band?.lo ?? null,
    p_band_hi: args.band?.hi ?? null,
    p_state: args.state,
    p_group: args.group,
    p_limit: SUGGESTION_PAGE_SIZE,
    p_offset: Math.max(0, args.page - 1) * SUGGESTION_PAGE_SIZE,
  });
  if (error) return { rows: [], total: 0, computed: true, links: {}, error: error.message };
  const rows = ((data ?? []) as RawSuggestion[]).map(normalizeSuggestion);
  const computed = rows.length > 0 ? true : await derivedCountsExist(supabase);
  const ids = [...new Set(rows.flatMap((r) => r.faith_sample.map((g) => g.filing_object_id)))];
  const links: Record<string, FilingLink> = {};
  if (ids.length > 0) {
    const [f, c] = await Promise.all([
      supabase.from("funder_reference_filings").select("object_id, document_archive_url, document_member").in("object_id", ids),
      supabase.from("charity_reference_filings").select("object_id, document_archive_url, document_member").in("object_id", ids),
    ]);
    for (const x of [...(f.data ?? []), ...(c.data ?? [])] as Array<{ object_id: string; document_archive_url: string; document_member: string | null }>) {
      if (/^https:\/\//.test(x.document_archive_url)) links[x.object_id] = { url: x.document_archive_url, member: x.document_member };
    }
  }
  return { rows, total: rows[0]?.total_matches ?? 0, computed, links, error: null };
}

/** The record kept on a candidate: what the suggestion rested on at the moment a person added it. A snapshot, not live. */
export function buildBasis(s: Suggestion, band: SizeBand | null, organizationState: string | null, addedAt: string) {
  return {
    rule_version: s.rule_version,
    band,
    organization_state: organizationState,
    source: s.source,
    kind: kindLabel(s),
    grants_counted: s.grants_counted,
    periods_counted: s.periods_counted,
    faith_count: s.faith_count,
    faith_in_band_count: s.faith_in_band_count,
    faith_share: s.faith_share,
    faith_last_period_end: s.faith_last_period_end,
    faith_in_state_count: s.faith_in_state_count,
    giving_amt: s.giving_amt,
    giving_period_end: s.giving_period_end,
    sample: s.faith_sample,
    added_at: addedAt,
  };
}

const SMALL_WORDS = new Set(["of", "the", "and", "for", "in", "on", "at", "to", "a", "an"]);
/** Filings are upper-case; the candidate shows a readable name without changing a letter of it. */
export function readableName(name: string | null | undefined): string {
  if (!name) return "";
  if (name !== name.toUpperCase()) return name.trim();
  return name
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => (/^\s+$/.test(w) ? w : i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("")
    .replace(/\b(Llc|Pc|Usa|Ymca|Ywca|Dba)\b/g, (m) => m.toUpperCase())
    .trim();
}
