// STATE item 119 (rulings 0051 and 0052): funders that file no return, in the Donor Finder.
//
// Reads only, through the signed-in user's own session. No model, no service key, no outside request. Every fact is shown as the
// database holds it: the counts come from the grant rows, each grant links to its filing, and a curated record shows the sources
// a person read. Nothing here ranks a lead by a figure it does not have.
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadFilingLinks, readableName, type FilingLink } from "./suggestions";

export const LEAD_PAGE_SIZE = 25;
/** The mark on every lead (ruling 0052 clause 4). */
export const NO_RETURN_MARK = "No return in the database, so no giving figures";
export const CURATED_MARK = "Recorded from its own website; no filing figures";
export const LEADS_INTRO =
  "Some funders file no return, so the filings-based database cannot hold them: religious organizations are not required to file, and church extension funds and church-connected donor-advised fund sponsors are often among them. These were found another way. Nothing is added until you add it.";
export const LEADS_RULE =
  "A funder recorded here from its own website comes first. The rest were found in other funders' filings: a recipient that no funder or charity in the database matches, whose own name says it is a church extension fund, loan fund, gift fund or donor advised fund, or whose name is a foundation's and a giver's stated purpose says the gift went into a donor advised or gift fund (rule no-filing-lead-v2). They are shown only when a funder that named them has at least five faith-named grants, ordered by how many different funders named them. None of them has a share or a count in your size band, because there is no filing of its own to count.";
export const LEADS_LIMIT_NOTE =
  "A funder that files, written under a different name than its filing's, can appear here until the national list of exempt organizations is loaded to match names to EINs. Open the grants behind it to check.";

export type LeadOrigin = "curated" | "filings";
export type CuratedKind = "donor_advised_fund_sponsor" | "church_extension_fund" | "religious_funder" | "other_funder";

export interface LeadSampleGrant {
  funder_ein: string;
  funder_name: string | null;
  source: "private_foundation" | "public_charity";
  recipient: string | null;
  amount_amt: number | null;
  tax_period_end: string | null;
  filing_object_id: string;
  kind: string;
  ordinal: number;
  purpose: string | null;
}

export interface CuratedSource {
  url: string;
  title?: string | null;
  read_on?: string | null;
}

export interface CuratedDetail {
  id: string;
  kind: CuratedKind;
  address: string | null;
  website: string | null;
  contact: string | null;
  offers: string | null;
  ein_note: string | null;
  no_filing_note: string | null;
  sources: CuratedSource[];
  recorded_on: string | null;
}

export interface NoFilingLead {
  lead_key: string;
  display_name: string;
  city: string | null;
  state: string | null;
  stated_ein: string | null;
  funders_count: number;
  faith_funders_count: number;
  grants_count: number;
  periods_count: number;
  last_period_end: string | null;
  signal: string;
  daf_signal: boolean;
  sample: LeadSampleGrant[];
  rule_version: string;
  origin: LeadOrigin;
  curated: CuratedDetail | null;
  total_matches: number;
}

export type RawLead = Record<string, unknown>;

export function normalizeLead(r: RawLead): NoFilingLead {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    lead_key: String(r.lead_key),
    display_name: String(r.display_name ?? ""),
    city: (r.city as string) ?? null,
    state: (r.state as string) ?? null,
    stated_ein: (r.stated_ein as string) ?? null,
    funders_count: n(r.funders_count),
    faith_funders_count: n(r.faith_funders_count),
    grants_count: n(r.grants_count),
    periods_count: n(r.periods_count),
    last_period_end: (r.last_period_end as string) ?? null,
    signal: String(r.signal ?? ""),
    daf_signal: Boolean(r.daf_signal),
    sample: Array.isArray(r.sample) ? (r.sample as LeadSampleGrant[]) : [],
    rule_version: String(r.rule_version ?? ""),
    origin: r.origin === "curated" ? "curated" : "filings",
    curated: r.origin === "curated" && r.curated ? (r.curated as CuratedDetail) : null,
    total_matches: n(r.total_matches),
  };
}

const KIND_LABELS: Record<CuratedKind, string> = {
  donor_advised_fund_sponsor: "Donor-advised fund sponsor",
  church_extension_fund: "Church extension fund",
  religious_funder: "Religious funder",
  other_funder: "Funder",
};

/** The label shown on a lead: what a record says it is, or, for one found in filings, what its name and the givers' purposes point to. */
export function leadKindLabel(l: Pick<NoFilingLead, "origin" | "curated" | "daf_signal" | "display_name">): string {
  if (l.curated) return KIND_LABELS[l.curated.kind] ?? "Funder";
  if (l.daf_signal) return "Possible donor-advised fund";
  if (/church extension/i.test(l.display_name)) return "Possible church extension fund";
  if (/loan fund/i.test(l.display_name)) return "Possible loan fund";
  return "Possible funder";
}

export function channelForLead(l: Pick<NoFilingLead, "daf_signal" | "curated">): "daf" | "regranting" {
  if (l.curated?.kind === "donor_advised_fund_sponsor") return "daf";
  return l.daf_signal ? "daf" : "regranting";
}

/** Plain lines about how the filings name it. Counts only; nothing a model wrote. */
export function describeLead(l: NoFilingLead): string[] {
  const lines: string[] = [];
  if (l.funders_count === 0) {
    lines.push("No grant in the loaded filings names it.");
  } else {
    lines.push(
      `Named as a recipient by ${l.funders_count} different ${l.funders_count === 1 ? "funder" : "funders"} in ${l.periods_count} tax ${l.periods_count === 1 ? "year" : "years"}, ${l.grants_count} ${l.grants_count === 1 ? "grant" : "grants"} in all.`
    );
    lines.push(
      l.faith_funders_count > 0
        ? `${l.faith_funders_count} of those ${l.funders_count === 1 ? "funder has" : "funders have"} at least five faith-named grants of ${l.funders_count === 1 ? "its" : "their"} own.`
        : "None of those funders has five faith-named grants of its own."
    );
  }
  if (l.stated_ein) lines.push(l.curated ? "EIN: see the note below." : "A filing states its EIN as " + l.stated_ein.slice(0, 2) + "-" + l.stated_ein.slice(2) + ".");
  return lines;
}

export interface LeadPage {
  rows: NoFilingLead[];
  total: number;
  links: Record<string, FilingLink>;
  error: string | null;
}

export async function loadNoFilingLeads(supabase: SupabaseClient, page: number): Promise<LeadPage> {
  const { data, error } = await supabase.rpc("reference_nofiling_leads", {
    p_limit: LEAD_PAGE_SIZE,
    p_offset: Math.max(0, page - 1) * LEAD_PAGE_SIZE,
  });
  if (error) return { rows: [], total: 0, links: {}, error: error.message };
  const rows = ((data ?? []) as RawLead[]).map(normalizeLead);
  const links = await loadFilingLinks(supabase, rows.flatMap((r) => r.sample.map((g) => g.filing_object_id)));
  return { rows, total: rows[0]?.total_matches ?? 0, links, error: null };
}

/** The record kept on a candidate: what the lead rested on at the moment a person added it. A snapshot, not live. */
export function buildLeadBasis(l: NoFilingLead, addedAt: string) {
  return {
    basis_kind: "no_filing_lead",
    origin: l.origin,
    rule_version: l.rule_version,
    lead_key: l.lead_key,
    funders_count: l.funders_count,
    faith_funders_count: l.faith_funders_count,
    grants_count: l.grants_count,
    periods_count: l.periods_count,
    last_period_end: l.last_period_end,
    signal: l.signal,
    daf_signal: l.daf_signal,
    stated_ein: l.stated_ein,
    sample: l.sample,
    curated: l.curated,
    added_at: addedAt,
  };
}

export const displayLeadName = (l: Pick<NoFilingLead, "display_name" | "curated">): string => l.curated ? l.display_name : readableName(l.display_name);
