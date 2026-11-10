// Item 116 (ruling 0047 clauses 2, 3 and 4): turn one Form 990 return into the rows the database
// function takes, attaching to EVERY row the filing it came from, where the document can be read, when
// it was loaded and by which loader version -- and, to every value, the place on the form it is read
// from. Mirrors document.ts for Form 990-PF and shares none of its column meanings.

import { createHash } from "node:crypto";
import type { IndexRow, Provenance } from "./document";
import {
  CHARITY_BOXES,
  CHARITY_FIGURES,
  DAF_FIGURES,
  SCHEDULE_I_ROW_PLACE,
  type CharityBoxColumn,
  type CharityFigureColumn,
  type DafFigureColumn,
  type ParsedReturn990,
} from "./parse-990";
import { CHARITY_RULE_TEXT, type CharityThreshold, type FunderKinds } from "./charity-scope";

/** Bump when parsing or storage semantics change; a return read by an older version is re-read. */
export const CHARITY_LOADER_VERSION = "funder-reference-loader/990-1.0.0";

export interface CharityFilingDoc {
  filing: Record<string, unknown>;
  charity: Record<string, unknown> | null;
  figures: Record<string, unknown> | null;
  daf: Record<string, unknown> | null;
  grants: Array<Record<string, unknown>>;
}

export type { IndexRow, Provenance };

function filingRow(p: Provenance, base: Record<string, unknown>) {
  return {
    object_id: p.index.objectId,
    ein: p.index.ein,
    return_type: "990",
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

/** A return that could not be read. Only what the index and the failure can say is stored. */
export function unreadCharityDoc(p: Provenance, reason: string, xml?: { sha256: string; bytes: number }): CharityFilingDoc {
  return {
    filing: filingRow(p, { status: "unread", status_note: reason, xml_sha256: xml?.sha256 ?? null, xml_bytes: xml?.bytes ?? null }),
    charity: null,
    figures: null,
    daf: null,
    grants: [],
  };
}

/** Each stored figure column named for the schedule, part and line it is read from. */
const figurePlaces = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(CHARITY_FIGURES).map(([k, v]) => [k, v.place])),
  ...Object.fromEntries(Object.entries(CHARITY_BOXES).flatMap(([k, v]) => [[k, v.place], [`${k}_as_written`, `${v.place} (as the return wrote it)`]])),
  schedule_i_rows_listed_count: "Derived from the Schedule I (Form 990), Part II recipient rows stored for this filing",
  schedule_i_cash_grants_listed_sum_amt: "Derived: sum of the cash grant column (Schedule I, Part II, column (d)) over those rows",
  schedule_i_grant_records_maintained_ind: "Schedule I (Form 990), Part I, line 1",
  schedule_i_total_501c3_org_cnt: "Schedule I (Form 990), Part II, line 2: number of section 501(c)(3) and government organizations listed in the line 1 table",
  schedule_i_total_other_org_cnt: "Schedule I (Form 990), Part II, line 3: number of other organizations listed in the line 1 table",
});
const dafPlaces = (): Record<string, string> => Object.fromEntries(Object.entries(DAF_FIGURES).map(([k, v]) => [k, v.place]));

/** A return read, whose funder is in scope: everything under it, each row carrying its provenance. */
export function loadedCharityDoc(
  p: Provenance,
  parsed: ParsedReturn990,
  xml: { sha256: string; bytes: number },
  kinds: FunderKinds,
  threshold: CharityThreshold
): CharityFilingDoc {
  const key = {
    filing_object_id: p.index.objectId,
    ein: parsed.ein,
    tax_period_end: parsed.taxPeriodEnd,
    loaded_at: p.loadedAt,
    loader_version: p.loaderVersion,
  };
  const addr = parsed.filer.address;

  const cash = parsed.rows.map((r) => r.cashGrantAmt).filter((v): v is number => v !== null);
  const figures: Record<string, unknown> = { ...key, form_type: "990" };
  for (const col of Object.keys(CHARITY_FIGURES) as CharityFigureColumn[]) figures[col] = parsed.figures[col];
  for (const col of Object.keys(CHARITY_BOXES) as CharityBoxColumn[]) {
    figures[col] = parsed.boxes[col];
    figures[`${col}_as_written`] = parsed.boxesRaw[col];
  }
  Object.assign(figures, {
    has_schedule_i: parsed.hasScheduleI,
    has_schedule_d: parsed.hasScheduleD,
    schedule_i_grant_records_maintained_ind: parsed.scheduleI?.grantRecordsMaintainedInd ?? null,
    schedule_i_total_501c3_org_cnt: parsed.scheduleI?.total501c3OrgCnt ?? null,
    schedule_i_total_other_org_cnt: parsed.scheduleI?.totalOtherOrgCnt ?? null,
    schedule_i_rows_listed_count: parsed.rows.length,
    schedule_i_cash_grants_listed_sum_amt: cash.length ? cash.reduce((a, b) => a + b, 0) : null,
    schedule_i_listed_derivation: parsed.hasScheduleI
      ? `${parsed.rows.length} recipient row(s) listed on Schedule I, Part II of this return (Schedule I lists only recipients that received more than $5,000); the sum is over the ${cash.length} row(s) that state a cash grant, and is null when none does`
      : "this return has no Schedule I, so no recipient rows are listed; a return with no Schedule I is not one that gave nothing",
    form_places: figurePlaces(),
  });

  const daf = parsed.daf
    ? { ...key, form_type: "990", ...Object.fromEntries((Object.keys(DAF_FIGURES) as DafFigureColumn[]).map((c) => [c, parsed.daf![c]])), form_places: dafPlaces() }
    : null;

  return {
    filing: filingRow(p, {
      tax_period_end: parsed.taxPeriodEnd,
      tax_period_begin: parsed.taxPeriodBegin,
      tax_year: parsed.taxYr,
      return_version: parsed.returnVersion,
      return_ts: parsed.returnTs,
      xml_sha256: xml.sha256,
      xml_bytes: xml.bytes,
      status: "loaded",
      status_note: null,
    }),
    charity: {
      ein: parsed.ein,
      source_object_id: p.index.objectId,
      source_tax_period_end: parsed.taxPeriodEnd,
      form_type: "990",
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
      website_as_stated: parsed.websiteAsStated,
      mission_as_stated: parsed.missionAsStated,
      legal_domicile_state_as_stated: parsed.legalDomicileStateAsStated,
      is_grantmaking_public_charity: kinds.isGrantmakingPublicCharity,
      is_daf_sponsor: kinds.isDafSponsor,
      kind_rule: CHARITY_RULE_TEXT,
      kind_threshold_org_grants_amt: threshold.minOrgGrantsAmt,
      kind_basis: kinds.basis,
      loaded_at: p.loadedAt,
      loader_version: p.loaderVersion,
    },
    figures,
    daf,
    grants: parsed.rows.map((r) => ({
      ...key,
      ordinal: r.ordinal,
      form_type: "990",
      source_location: SCHEDULE_I_ROW_PLACE,
      recipient_name_line1: r.recipientNameLine1,
      recipient_name_line2: r.recipientNameLine2,
      recipient_ein_as_stated: r.recipientEinAsStated,
      recipient_address_line1: r.address?.line1 ?? null,
      recipient_address_line2: r.address?.line2 ?? null,
      recipient_city: r.address?.city ?? null,
      recipient_state: r.address?.state ?? null,
      recipient_zip: r.address?.zip ?? null,
      recipient_country: r.address?.country ?? null,
      irc_section_as_stated: r.ircSectionAsStated,
      cash_grant_amt: r.cashGrantAmt,
      noncash_assistance_amt: r.nonCashAssistanceAmt,
      noncash_assistance_desc: r.nonCashAssistanceDesc,
      valuation_method_desc: r.valuationMethodDesc,
      purpose_as_stated: r.purposeAsStated,
      unmapped_fields: r.unmappedFields,
    })),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
