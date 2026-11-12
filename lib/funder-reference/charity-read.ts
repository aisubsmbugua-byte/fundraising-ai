// STATE items 113 + 116 (ruling 0048): the reads behind the charities half of the funder database screen.
//
// READ-ONLY, with the signed-in user's own session (lib/supabase/server.ts), never the service key: the
// read-only policies of ruling 0045 clause 1 (carried to the charity tables by migration 0089) are what keep this
// from writing. The only call that is not a plain select is the search function, which is itself `stable`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { GRANTS_PAGE_SIZE } from "./browse";
import { CHARITY_RUN_KIND, PAGE_SIZE, charityStateStatuses, type CharityRunRow, type CharitySearchInput, type CharityStateStatus } from "./charity-browse";

export interface CharityDirectoryRow {
  ein: string;
  name: string | null;
  city: string | null;
  state: string | null;
  is_grantmaking_public_charity: boolean;
  is_daf_sponsor: boolean;
  figures_period_end: string | null;
  figures_filing_object_id: string | null;
  grants_domestic_orgs_amt: number | null;
  grants_domestic_orgs_max_amt: number | null;
  total_assets_eoy_amt: number | null;
  daf_held_max_cnt: number | null;
  daf_value_eoy_amt: number | null;
  daf_period_end: string | null;
  periods_held: number;
  total_matches: number;
}

export async function searchCharities(
  supabase: SupabaseClient,
  input: CharitySearchInput
): Promise<{ rows: CharityDirectoryRow[]; total: number; error: string | null }> {
  const { data, error } = await supabase.rpc("charity_reference_search", {
    p_query: input.q || null,
    p_state: input.state || null,
    p_kind: input.kind,
    p_min_grants: input.minGrants,
    p_max_grants: input.maxGrants,
    p_sort: input.sort,
    p_descending: input.descending,
    p_limit: PAGE_SIZE,
    p_offset: (input.page - 1) * PAGE_SIZE,
  });
  if (error) return { rows: [], total: 0, error: error.message };
  const rows = (data ?? []) as CharityDirectoryRow[];
  const total = rows.length ? Number(rows[0].total_matches) : 0;
  return { rows, total, error: null };
}

/** When the charity search list was last refreshed from the loader's tables (it can lag the loader), or null if never. */
export async function loadCharityDirectoryRefreshedAt(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc("charity_reference_directory_refreshed_at");
  return error || !data ? null : String(data);
}

/** The status of every state, from the charity load's own run records (only the check verdict is read from each run). */
export async function loadCharityStateStatuses(supabase: SupabaseClient): Promise<Record<string, CharityStateStatus>> {
  const { data } = await supabase
    .from("funder_reference_runs")
    .select("status, started_at, parameters, v:counts->verification->>verification_status")
    .eq("parameters->>kind", CHARITY_RUN_KIND)
    .order("started_at", { ascending: false })
    .limit(1000);
  return charityStateStatuses((data ?? []) as unknown as CharityRunRow[]);
}

export interface CharityOrgRow {
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
  website_as_stated: string | null;
  mission_as_stated: string | null;
  is_grantmaking_public_charity: boolean;
  is_daf_sponsor: boolean;
  kind_rule: string;
  kind_threshold_org_grants_amt: number;
  kind_basis: Array<{ tax_period_end: string; grants_to_domestic_orgs_amt: number | null; donor_advised_funds_held_cnt: number | null; donor_advised_fund_box: boolean | null }>;
  loaded_at: string;
  loader_version: string;
}

export interface CharityFilingRow {
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

export interface CharityFigureRow {
  ein: string;
  tax_period_end: string;
  filing_object_id: string;
  part_i_line_8_cy_contributions_grants_amt: number | null;
  part_i_line_12_cy_total_revenue_amt: number | null;
  part_i_line_13_cy_grants_and_similar_paid_amt: number | null;
  part_i_line_18_cy_total_expenses_amt: number | null;
  part_i_line_20_total_assets_eoy_amt: number | null;
  part_i_line_22_net_assets_eoy_amt: number | null;
  part_ix_line_1_grants_domestic_orgs_total_amt: number | null;
  part_ix_line_3_grants_outside_us_total_amt: number | null;
  part_iv_line_6_donor_advised_fund_box: boolean | null;
  has_schedule_i: boolean;
  has_schedule_d: boolean;
  schedule_i_rows_listed_count: number;
  schedule_i_cash_grants_listed_sum_amt: number | null;
  schedule_i_listed_derivation: string;
}

export interface CharityDafRow {
  filing_object_id: string;
  tax_period_end: string;
  daf_held_cnt: number | null;
  daf_contributions_amt: number | null;
  daf_grants_amt: number | null;
  daf_value_eoy_amt: number | null;
  other_funds_held_cnt: number | null;
  other_funds_contributions_amt: number | null;
  other_funds_grants_amt: number | null;
  other_funds_value_eoy_amt: number | null;
}

export interface CharityCoverageRow {
  period_year: number;
  status: "loaded" | "unread" | "no_filing_in_index";
  filing_object_id: string | null;
  note: string;
}

export interface CharityGrantRow {
  filing_object_id: string;
  ordinal: number;
  recipient_name_line1: string | null;
  recipient_name_line2: string | null;
  recipient_ein_as_stated: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_country: string | null;
  irc_section_as_stated: string | null;
  cash_grant_amt: number | null;
  noncash_assistance_amt: number | null;
  noncash_assistance_desc: string | null;
  purpose_as_stated: string | null;
}

export interface CharityPage {
  org: CharityOrgRow;
  filings: CharityFilingRow[];
  figures: CharityFigureRow[];
  daf: CharityDafRow[];
  coverage: CharityCoverageRow[];
  grants: { rows: CharityGrantRow[]; total: number; period: string | null };
}

const FIGURE_COLUMNS =
  "ein, tax_period_end, filing_object_id, part_i_line_8_cy_contributions_grants_amt, part_i_line_12_cy_total_revenue_amt, part_i_line_13_cy_grants_and_similar_paid_amt, part_i_line_18_cy_total_expenses_amt, part_i_line_20_total_assets_eoy_amt, part_i_line_22_net_assets_eoy_amt, part_ix_line_1_grants_domestic_orgs_total_amt, part_ix_line_3_grants_outside_us_total_amt, part_iv_line_6_donor_advised_fund_box, has_schedule_i, has_schedule_d, schedule_i_rows_listed_count, schedule_i_cash_grants_listed_sum_amt, schedule_i_listed_derivation";
const DAF_COLUMNS =
  "filing_object_id, tax_period_end, daf_held_cnt, daf_contributions_amt, daf_grants_amt, daf_value_eoy_amt, other_funds_held_cnt, other_funds_contributions_amt, other_funds_grants_amt, other_funds_value_eoy_amt";
const GRANT_COLUMNS =
  "filing_object_id, ordinal, recipient_name_line1, recipient_name_line2, recipient_ein_as_stated, recipient_city, recipient_state, recipient_country, irc_section_as_stated, cash_grant_amt, noncash_assistance_amt, noncash_assistance_desc, purpose_as_stated";

/** null when no charity or sponsor has this EIN. `grantsPeriod` is a tax period end (yyyy-mm-dd); default is the latest held. */
export async function loadCharityPage(supabase: SupabaseClient, ein: string, grantsPeriod: string | null, grantsPage: number): Promise<CharityPage | null> {
  const { data: org } = await supabase.from("charity_reference_organizations").select("*").eq("ein", ein).maybeSingle();
  if (!org) return null;

  const [filings, figures, daf, coverage] = await Promise.all([
    supabase
      .from("charity_reference_filings")
      .select("object_id, ein, return_type, tax_period_end, status, status_note, index_file, document_archive_url, document_member, loaded_at, loader_version")
      .eq("ein", ein)
      .order("tax_period_end", { ascending: false, nullsFirst: false }),
    supabase.from("charity_reference_figures").select(FIGURE_COLUMNS).eq("ein", ein).order("tax_period_end", { ascending: false }),
    supabase.from("charity_reference_daf_figures").select(DAF_COLUMNS).eq("ein", ein).order("tax_period_end", { ascending: false }),
    supabase.from("charity_reference_period_coverage").select("period_year, status, filing_object_id, note").eq("ein", ein).order("period_year", { ascending: false }),
  ]);

  const figureRows = (figures.data ?? []) as CharityFigureRow[];
  const period = grantsPeriod && figureRows.some((f) => f.tax_period_end === grantsPeriod) ? grantsPeriod : figureRows[0]?.tax_period_end ?? null;

  let grants: CharityPage["grants"] = { rows: [], total: 0, period };
  if (period) {
    const from = (Math.max(1, grantsPage) - 1) * GRANTS_PAGE_SIZE;
    const g = await supabase
      .from("charity_reference_grants")
      .select(GRANT_COLUMNS, { count: "exact" })
      .eq("ein", ein)
      .eq("tax_period_end", period)
      .order("cash_grant_amt", { ascending: false, nullsFirst: false })
      .order("ordinal")
      .range(from, from + GRANTS_PAGE_SIZE - 1);
    grants = { rows: (g.data ?? []) as CharityGrantRow[], total: g.count ?? 0, period };
  }

  return {
    org: org as CharityOrgRow,
    filings: (filings.data ?? []) as CharityFilingRow[],
    figures: figureRows,
    daf: (daf.data ?? []) as CharityDafRow[],
    coverage: (coverage.data ?? []) as CharityCoverageRow[],
    grants,
  };
}
