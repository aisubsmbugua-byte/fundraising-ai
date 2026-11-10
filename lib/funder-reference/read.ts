// STATE item 113, ruling 0048: the reads behind the funder database screen.
//
// READ-ONLY, with the signed-in user's own session (lib/supabase/server.ts), never the
// service key: ruling 0045 clause 1's read-only policies are what keep this screen
// from writing, not this file's good behavior. The only call that is not a plain
// select is the search function, which is itself `stable` and read-only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { GRANTS_PAGE_SIZE, PAGE_SIZE, stateStatuses, type RunRow, type SearchInput, type StateStatus } from "./browse";

export interface DirectoryRow {
  ein: string;
  name: string | null;
  city: string | null;
  state: string | null;
  figures_period_end: string | null;
  figures_filing_object_id: string | null;
  fmv_assets_eoy_amt: number | null;
  contributions_paid_per_books_amt: number | null;
  grants_listed_count: number | null;
  only_preselected_charities_box_checked: boolean | null;
  periods_held: number;
  total_matches: number;
}

export async function searchFunders(
  supabase: SupabaseClient,
  input: SearchInput
): Promise<{ rows: DirectoryRow[]; total: number; error: string | null }> {
  const { data, error } = await supabase.rpc("funder_reference_search", {
    p_query: input.q || null,
    p_state: input.state || null,
    p_min_assets: input.minAssets,
    p_max_assets: input.maxAssets,
    p_preselected: input.preselected,
    p_sort: input.sort,
    p_descending: input.descending,
    p_limit: PAGE_SIZE,
    p_offset: (input.page - 1) * PAGE_SIZE,
  });
  if (error) return { rows: [], total: 0, error: error.message };
  const rows = (data ?? []) as DirectoryRow[];
  // total_matches is the same on every row; an empty page past the end has no row to read it from
  const total = rows.length ? Number(rows[0].total_matches) : 0;
  return { rows, total, error: null };
}

/** The status of every state, from the loader's own run records. */
export async function loadStateStatuses(supabase: SupabaseClient): Promise<Record<string, StateStatus>> {
  // Runs are a few hundred rows at most; one page of the API is enough, and a run
  // whose state parameter is missing (the supervisor's own bookkeeping row) is ignored.
  const { data } = await supabase
    .from("funder_reference_runs")
    .select("status, started_at, parameters, counts")
    .order("started_at", { ascending: false })
    .limit(1000);
  return stateStatuses((data ?? []) as RunRow[]);
}

export interface FoundationRow {
  ein: string;
  source_object_id: string;
  source_tax_period_end: string;
  legal_name_line1: string | null;
  legal_name_line2: string | null;
  care_of_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone_as_stated: string | null;
  fiscal_year_end_month: number | null;
  private_operating_foundation_ind: boolean | null;
  website_as_stated: string | null;
  loaded_at: string;
  loader_version: string;
}

export interface FilingRow {
  object_id: string;
  ein: string;
  return_type: string;
  tax_period_end: string | null;
  status: string;
  status_note: string | null;
  index_file: string;
  document_archive_url: string;
  document_member: string;
  loaded_at: string;
  loader_version: string;
}

export interface FigureRow {
  ein: string;
  tax_period_end: string;
  filing_object_id: string;
  fmv_assets_eoy_amt: number | null;
  net_assets_eoy_amt: number | null;
  contributions_received_per_books_amt: number | null;
  total_revenue_per_books_amt: number | null;
  total_expenses_per_books_amt: number | null;
  contributions_paid_per_books_amt: number | null;
  contributions_paid_disbursements_amt: number | null;
  total_expenses_charitable_disbursements_amt: number | null;
  qualifying_distributions_amt: number | null;
  grants_paid_stated_total_amt: number | null;
  grants_listed_count: number | null;
  grants_listed_sum_amt: number | null;
  grants_listed_avg_amt: number | null;
  grants_listed_median_amt: number | null;
  grants_listed_min_amt: number | null;
  grants_listed_max_amt: number | null;
  grants_listed_in_filer_state_count: number | null;
  grants_listed_in_filer_state_sum_amt: number | null;
  grants_listed_derivation: string | null;
  qualifying_to_minimum_investment_return_ratio: number | null;
  payout_ratio_derivation: string | null;
}

export interface CoverageRow {
  period_year: number;
  status: "loaded" | "unread" | "no_filing_in_index";
  filing_object_id: string | null;
  note: string;
}

export interface PersonRow {
  filing_object_id: string;
  listed_in: string;
  ordinal: number;
  tax_period_end: string;
  name_as_named: string | null;
  title_as_stated: string | null;
  hours_per_week_as_stated: string | null;
  compensation_amt: number | null;
  city: string | null;
  state: string | null;
}

export interface GrantRow {
  filing_object_id: string;
  kind: "paid_during_year" | "approved_for_future_payment";
  ordinal: number;
  recipient_name_line1: string | null;
  recipient_name_line2: string | null;
  recipient_person_name: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_country: string | null;
  relationship_as_stated: string | null;
  recipient_status_as_stated: string | null;
  purpose_as_stated: string | null;
  amount_amt: number | null;
}

export interface TermsRow {
  filing_object_id: string;
  tax_period_end: string;
  only_preselected_charities_raw: string | null;
  only_preselected_charities_box_checked: boolean | null;
  application_groups: Array<{ ordinal: number; fields: Record<string, string> }>;
}

export interface FunderPage {
  foundation: FoundationRow;
  filings: FilingRow[];
  figures: FigureRow[];
  coverage: CoverageRow[];
  people: PersonRow[];
  terms: TermsRow[];
  grants: { rows: GrantRow[]; total: number; period: string | null };
}

const FIGURE_COLUMNS =
  "ein, tax_period_end, filing_object_id, fmv_assets_eoy_amt, net_assets_eoy_amt, contributions_received_per_books_amt, total_revenue_per_books_amt, total_expenses_per_books_amt, contributions_paid_per_books_amt, contributions_paid_disbursements_amt, total_expenses_charitable_disbursements_amt, qualifying_distributions_amt, grants_paid_stated_total_amt, grants_listed_count, grants_listed_sum_amt, grants_listed_avg_amt, grants_listed_median_amt, grants_listed_min_amt, grants_listed_max_amt, grants_listed_in_filer_state_count, grants_listed_in_filer_state_sum_amt, grants_listed_derivation, qualifying_to_minimum_investment_return_ratio, payout_ratio_derivation";

/** null when no funder has this EIN. `grantsPeriod` is a tax period end (yyyy-mm-dd); default is the latest held. */
export async function loadFunderPage(
  supabase: SupabaseClient,
  ein: string,
  grantsPeriod: string | null,
  grantsPage: number
): Promise<FunderPage | null> {
  const { data: foundation } = await supabase.from("funder_reference_foundations").select("*").eq("ein", ein).maybeSingle();
  if (!foundation) return null;

  const [filings, figures, coverage, people, terms] = await Promise.all([
    supabase
      .from("funder_reference_filings")
      .select("object_id, ein, return_type, tax_period_end, status, status_note, index_file, document_archive_url, document_member, loaded_at, loader_version")
      .eq("ein", ein)
      .order("tax_period_end", { ascending: false, nullsFirst: false }),
    supabase.from("funder_reference_figures").select(FIGURE_COLUMNS).eq("ein", ein).order("tax_period_end", { ascending: false }),
    supabase
      .from("funder_reference_period_coverage")
      .select("period_year, status, filing_object_id, note")
      .eq("ein", ein)
      .order("period_year", { ascending: false }),
    supabase
      .from("funder_reference_people")
      .select("filing_object_id, listed_in, ordinal, tax_period_end, name_as_named, title_as_stated, hours_per_week_as_stated, compensation_amt, city, state")
      .eq("ein", ein)
      .order("tax_period_end", { ascending: false })
      .order("listed_in")
      .order("ordinal"),
    supabase
      .from("funder_reference_application_terms")
      .select("filing_object_id, tax_period_end, only_preselected_charities_raw, only_preselected_charities_box_checked, application_groups")
      .eq("ein", ein)
      .order("tax_period_end", { ascending: false }),
  ]);

  const figureRows = (figures.data ?? []) as FigureRow[];
  const period = grantsPeriod && figureRows.some((f) => f.tax_period_end === grantsPeriod) ? grantsPeriod : figureRows[0]?.tax_period_end ?? null;

  let grants: FunderPage["grants"] = { rows: [], total: 0, period };
  if (period) {
    const from = (Math.max(1, grantsPage) - 1) * GRANTS_PAGE_SIZE;
    const g = await supabase
      .from("funder_reference_grants")
      .select(
        "filing_object_id, kind, ordinal, recipient_name_line1, recipient_name_line2, recipient_person_name, recipient_city, recipient_state, recipient_country, relationship_as_stated, recipient_status_as_stated, purpose_as_stated, amount_amt",
        { count: "exact" }
      )
      .eq("ein", ein)
      .eq("tax_period_end", period)
      .order("amount_amt", { ascending: false, nullsFirst: false })
      .order("kind")
      .order("ordinal")
      .range(from, from + GRANTS_PAGE_SIZE - 1);
    grants = { rows: (g.data ?? []) as GrantRow[], total: g.count ?? 0, period };
  }

  return {
    foundation: foundation as FoundationRow,
    filings: (filings.data ?? []) as FilingRow[],
    figures: figureRows,
    coverage: (coverage.data ?? []) as CoverageRow[],
    people: (people.data ?? []) as PersonRow[],
    terms: (terms.data ?? []) as TermsRow[],
    grants,
  };
}
