// Item 110 (ruling 0045 clause 2): turn what was read into the rows the database
// function takes, attaching to EVERY row the filing it came from, where the
// document can be read, when it was loaded and by which loader version.

import { createHash } from "node:crypto";
import type { FigureColumn, ParsedFiling } from "./parse-990pf";
import { FIGURE_PATHS } from "./parse-990pf";
import { deriveGrantStats, derivePayoutRatio } from "./derive";

/** Bump when parsing or storage semantics change; a filing read by an older version is re-read. */
export const LOADER_VERSION = "funder-reference-loader/1.0.0";

export interface IndexRow {
  returnId: string | null;
  ein: string;
  taxPeriod: string; // yyyymm
  subYear: number | null;
  taxpayerName: string;
  returnType: string;
  objectId: string;
  batchId: string | null;
  indexFile: string;
}

export interface Provenance {
  runId: string;
  loadedAt: string; // ISO
  loaderVersion: string;
  index: IndexRow;
  archiveUrl: string;
  member: string;
}

export interface FilingDoc {
  filing: Record<string, unknown>;
  foundation: Record<string, unknown> | null;
  figures: Record<string, unknown> | null;
  people: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
  application: Record<string, unknown> | null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filingRow(p: Provenance, base: Record<string, unknown>) {
  return {
    object_id: p.index.objectId,
    ein: p.index.ein,
    return_type: p.index.returnType,
    index_tax_period: p.index.taxPeriod,
    tax_period_end: null,
    tax_period_begin: null,
    tax_year: null,
    return_version: null,
    return_ts: null,
    status: "loaded",
    status_note: null,
    superseded_by_object_id: null,
    index_file: p.index.indexFile,
    index_return_id: p.index.returnId,
    index_sub_year: p.index.subYear,
    document_archive_url: p.archiveUrl,
    document_member: p.member,
    xml_sha256: null,
    xml_bytes: null,
    run_id: p.runId,
    loaded_at: p.loadedAt,
    loader_version: p.loaderVersion,
    ...base,
  };
}

type FilingHead = Pick<ParsedFiling, "taxPeriodEnd" | "taxPeriodBegin" | "taxYr" | "returnVersion" | "returnTs">;

function fromParsed(parsed: FilingHead, xml: { sha256: string; bytes: number }) {
  return {
    tax_period_end: parsed.taxPeriodEnd,
    tax_period_begin: parsed.taxPeriodBegin,
    tax_year: parsed.taxYr,
    return_version: parsed.returnVersion,
    return_ts: parsed.returnTs,
    xml_sha256: xml.sha256,
    xml_bytes: xml.bytes,
  };
}

/** A filing that could not be read. Only what the index and the failure can say is stored. */
export function unreadDoc(p: Provenance, reason: string, xml?: { sha256: string; bytes: number }): FilingDoc {
  return {
    filing: filingRow(p, { status: "unread", status_note: reason, xml_sha256: xml?.sha256 ?? null, xml_bytes: xml?.bytes ?? null }),
    foundation: null,
    figures: null,
    people: [],
    grants: [],
    application: null,
  };
}

/** A filing read and understood, but whose funder is outside the size threshold. */
export function skippedDoc(p: Provenance, parsed: FilingHead, xml: { sha256: string; bytes: number }, reason: string): FilingDoc {
  return {
    filing: filingRow(p, { ...fromParsed(parsed, xml), status: "skipped_below_threshold", status_note: reason }),
    foundation: null,
    figures: null,
    people: [],
    grants: [],
    application: null,
  };
}

/** A filing read, in scope: everything under it, each row carrying its provenance. */
export function loadedDoc(p: Provenance, parsed: ParsedFiling, xml: { sha256: string; bytes: number }): FilingDoc {
  const key = {
    filing_object_id: p.index.objectId,
    ein: parsed.ein,
    tax_period_end: parsed.taxPeriodEnd,
    loaded_at: p.loadedAt,
    loader_version: p.loaderVersion,
  };
  const addr = parsed.filer.address;
  const stats = deriveGrantStats(parsed.grantsPaid, addr?.country === null ? (addr?.state ?? null) : null, parsed.figures.grants_paid_stated_total_amt);
  const payout = derivePayoutRatio(parsed.figures.qualifying_distributions_amt, parsed.figures.minimum_investment_return_amt);

  const figures: Record<string, unknown> = { ...key };
  for (const col of Object.keys(FIGURE_PATHS) as FigureColumn[]) figures[col] = parsed.figures[col];
  Object.assign(figures, {
    financial_statement_values: parsed.financialStatementValues,
    grants_listed_count: stats.count,
    grants_listed_sum_amt: stats.sum,
    grants_listed_avg_amt: stats.avg,
    grants_listed_median_amt: stats.median,
    grants_listed_min_amt: stats.min,
    grants_listed_max_amt: stats.max,
    grants_listed_in_filer_state_count: stats.inFilerStateCount,
    grants_listed_in_filer_state_sum_amt: stats.inFilerStateSum,
    grants_listed_minus_stated_amt: stats.minusStated,
    grants_listed_derivation: stats.derivation,
    qualifying_to_minimum_investment_return_ratio: payout.ratio,
    payout_ratio_derivation: payout.derivation,
  });

  const endMonth = Number(parsed.taxPeriodEnd.slice(5, 7));
  return {
    filing: filingRow(p, { ...fromParsed(parsed, xml), status: "loaded", status_note: null }),
    foundation: {
      ein: parsed.ein,
      source_object_id: p.index.objectId,
      source_tax_period_end: parsed.taxPeriodEnd,
      legal_name_line1: parsed.filer.nameLine1,
      legal_name_line2: parsed.filer.nameLine2,
      care_of_name: parsed.filer.careOfName,
      address_line1: addr?.line1 ?? null,
      address_line2: addr?.line2 ?? null,
      city: addr?.city ?? null,
      state: addr?.state ?? null,
      zip: addr?.zip ?? null,
      country: addr?.country ?? null,
      phone_as_stated: parsed.filer.phone,
      fiscal_year_end_month: endMonth,
      private_operating_foundation_ind: parsed.isPrivateOperatingFoundation,
      website_as_stated: parsed.websiteAsStated,
      books_contact_name: parsed.booksContactName,
      books_contact_phone: parsed.booksContactPhone,
      loaded_at: p.loadedAt,
      loader_version: p.loaderVersion,
    },
    figures,
    people: parsed.people.map((x) => ({
      ...key,
      listed_in: x.listedIn,
      ordinal: x.ordinal,
      name_as_named: x.nameAsNamed,
      title_as_stated: x.titleAsStated,
      hours_per_week_as_stated: x.hoursPerWeekAsStated,
      compensation_amt: x.compensationAmt,
      employee_benefit_amt: x.employeeBenefitAmt,
      expense_account_amt: x.expenseAccountAmt,
      address_line1: x.address?.line1 ?? null,
      address_line2: x.address?.line2 ?? null,
      city: x.address?.city ?? null,
      state: x.address?.state ?? null,
      zip: x.address?.zip ?? null,
      country: x.address?.country ?? null,
    })),
    grants: [...parsed.grantsPaid, ...parsed.grantsApproved].map((g) => ({
      ...key,
      kind: g.kind,
      ordinal: g.ordinal,
      listed_in_element: g.listedInElement,
      recipient_name_line1: g.recipientNameLine1,
      recipient_name_line2: g.recipientNameLine2,
      recipient_person_name: g.recipientPersonName,
      recipient_address_line1: g.address?.line1 ?? null,
      recipient_address_line2: g.address?.line2 ?? null,
      recipient_city: g.address?.city ?? null,
      recipient_state: g.address?.state ?? null,
      recipient_zip: g.address?.zip ?? null,
      recipient_country: g.address?.country ?? null,
      relationship_as_stated: g.relationshipAsStated,
      recipient_status_as_stated: g.recipientStatusAsStated,
      purpose_as_stated: g.purposeAsStated,
      amount_amt: g.amountAmt,
      unmapped_fields: g.unmappedFields,
    })),
    application: {
      filing_object_id: key.filing_object_id,
      ein: key.ein,
      tax_period_end: key.tax_period_end,
      only_preselected_charities_raw: parsed.onlyPreselectedRaw,
      // ticked -> true; anything else stays null (an unmarked box is not a statement)
      only_preselected_charities_box_checked: parsed.onlyPreselectedRaw === null ? null : /^(x|1|true)$/i.test(parsed.onlyPreselectedRaw) ? true : null,
      application_groups: parsed.applicationGroups.map((g) => ({ ordinal: g.ordinal, fields: g.rawFields })),
      loaded_at: key.loaded_at,
      loader_version: key.loader_version,
    },
  };
}
