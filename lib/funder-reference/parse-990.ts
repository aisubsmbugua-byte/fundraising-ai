// Item 116 (ruling 0047): read one IRS Form 990 e-file return into plain data, for the two kinds
// of funder ruling 0047 adds -- the grantmaking public charity and the donor-advised fund sponsor.
//
// Same invariant as parse-990pf.ts. Whatever the return states is carried through in the words the
// return used; whatever it does not state stays null. Nothing is defaulted to 0 or "". A value that
// cannot be read as what it should be (a figure that is not a whole number, a return type that is not
// 990, a missing tax period) REJECTS the whole filing with a reason, so the loader records it as
// unread rather than loading a guess (ruling 0045 clause 6).
//
// WHAT IS NEVER READ OR STORED (ruling 0047):
//   * Grants to individuals: Part IX line 2, Schedule I Part III. Out of scope, never stored.
//   * Anything that could name the person behind a donor-advised fund. Schedule D Part I states
//     counts and totals only; this reader reads those and nothing about donors. Part VII, Schedule B
//     (contributors) and the other schedules are not parsed.
//   * The signing officer, the preparer, and the principal officer: not the funder's grantmaking.
//
// WHAT A FIGURE MEANS. Every figure is stored under a name that carries the form and the line it comes
// from (CHARITY_FIGURES and DAF_FIGURES below), and never in a column whose name or meaning belongs
// to Form 990-PF (ruling 0047 clause 2). Part IX line 1 is "grants and other assistance to domestic
// organizations and domestic governments"; Part IX line 3 is "outside the United States" and mixes
// organizations and individuals, so it is stored (as its own column) but is NOT used for the grants
// to organizations test. Part I line 13 also includes grants to individuals and is not used for it.

import { XmlError, parseXml, child, descendants, leaves, textAt, type XmlNode } from "./xml";
import { FilingRejected, addressOf, isTrue, type Address } from "./parse-990pf";

export { FilingRejected };

/** Where a stored value sits on the form, in words, and the element that carries it. */
export interface FormPlace {
  element: string; // path from the schedule or the main form's element
  place: string; // schedule, part, line (and column where the form has columns)
}

// ---------------------------------------------------------------------------
// the main form (IRS990)
// ---------------------------------------------------------------------------
export const CHARITY_FIGURES = {
  part_i_line_8_cy_contributions_grants_amt: { element: "CYContributionsGrantsAmt", place: "Form 990, Part I, line 8, current year: contributions and grants" },
  part_i_line_12_cy_total_revenue_amt: { element: "CYTotalRevenueAmt", place: "Form 990, Part I, line 12, current year: total revenue" },
  part_i_line_13_cy_grants_and_similar_paid_amt: { element: "CYGrantsAndSimilarPaidAmt", place: "Form 990, Part I, line 13, current year: grants and similar amounts paid (includes grants to individuals)" },
  part_i_line_18_cy_total_expenses_amt: { element: "CYTotalExpensesAmt", place: "Form 990, Part I, line 18, current year: total expenses" },
  part_i_line_20_total_assets_eoy_amt: { element: "TotalAssetsEOYAmt", place: "Form 990, Part I, line 20, end of year: total assets" },
  part_i_line_22_net_assets_eoy_amt: { element: "NetAssetsOrFundBalancesEOYAmt", place: "Form 990, Part I, line 22, end of year: net assets or fund balances" },
  part_ix_line_1_grants_domestic_orgs_total_amt: { element: "GrantsToDomesticOrgsGrp/TotalAmt", place: "Form 990, Part IX, line 1, column (A): grants and other assistance to domestic organizations and domestic governments" },
  part_ix_line_3_grants_outside_us_total_amt: { element: "ForeignGrantsGrp/TotalAmt", place: "Form 990, Part IX, line 3, column (A): grants and other assistance outside the United States (organizations, governments and individuals together)" },
} as const;
export type CharityFigureColumn = keyof typeof CHARITY_FIGURES;

/** Yes/no boxes on the main form, each with its place. */
export const CHARITY_BOXES = {
  part_iv_line_6_donor_advised_fund_box: { element: "DonorAdvisedFundInd", place: "Form 990, Part IV, line 6: did the organization maintain donor advised funds" },
  part_iv_line_21_grants_to_domestic_orgs_box: { element: "GrantsToOrganizationsInd", place: "Form 990, Part IV, line 21: grants to domestic organizations or governments over $5,000" },
} as const;
export type CharityBoxColumn = keyof typeof CHARITY_BOXES;

// ---------------------------------------------------------------------------
// Schedule D, Part I (donor-advised funds). Column (a) is donor advised funds; column (b) is "funds
// and other accounts", a different thing, so it has its own columns and is never added to column (a).
// ---------------------------------------------------------------------------
export const DAF_FIGURES = {
  daf_held_cnt: { element: "DonorAdvisedFundsHeldCnt", place: "Schedule D, Part I, line 1, column (a): total number of donor advised funds at end of year" },
  daf_contributions_amt: { element: "DonorAdvisedFundsContriAmt", place: "Schedule D, Part I, line 2, column (a): aggregate value of contributions to donor advised funds during the year" },
  daf_grants_amt: { element: "DonorAdvisedFundsGrantsAmt", place: "Schedule D, Part I, line 3, column (a): aggregate value of grants from donor advised funds during the year" },
  daf_value_eoy_amt: { element: "DonorAdvisedFundsVlEOYAmt", place: "Schedule D, Part I, line 4, column (a): aggregate value of donor advised funds at end of year" },
  other_funds_held_cnt: { element: "FundsAndOtherAccountsHeldCnt", place: "Schedule D, Part I, line 1, column (b): total number of funds and other accounts at end of year (not donor advised funds)" },
  other_funds_contributions_amt: { element: "FundsAndOtherAccountsContriAmt", place: "Schedule D, Part I, line 2, column (b): contributions to funds and other accounts (not donor advised funds)" },
  other_funds_grants_amt: { element: "FundsAndOtherAccountsGrantsAmt", place: "Schedule D, Part I, line 3, column (b): grants from funds and other accounts (not donor advised funds)" },
  other_funds_value_eoy_amt: { element: "FundsAndOtherAccountsVlEOYAmt", place: "Schedule D, Part I, line 4, column (b): value of funds and other accounts at end of year (not donor advised funds)" },
} as const;
export type DafFigureColumn = keyof typeof DAF_FIGURES;

/** Where every Schedule I recipient row sits. */
export const SCHEDULE_I_ROW_PLACE = "Schedule I (Form 990), Part II: grants and other assistance to domestic organizations and domestic governments, one recipient per row";

// ---------------------------------------------------------------------------
// what the reader returns
// ---------------------------------------------------------------------------
export interface ParsedScheduleIRow {
  ordinal: number; // 1-based, document order
  recipientNameLine1: string | null;
  recipientNameLine2: string | null;
  recipientEinAsStated: string | null;
  address: Address | null;
  ircSectionAsStated: string | null;
  cashGrantAmt: number | null;
  nonCashAssistanceAmt: number | null;
  nonCashAssistanceDesc: string | null;
  valuationMethodDesc: string | null;
  purposeAsStated: string | null;
  /** Any leaf under the row that no column above reads: kept, never dropped. */
  unmappedFields: Record<string, string>;
}

export interface ParsedReturn990 {
  returnVersion: string | null;
  returnTs: string | null;
  returnTypeCd: string;
  taxYr: string | null;
  taxPeriodBegin: string | null;
  taxPeriodEnd: string; // YYYY-MM-DD
  ein: string; // 9 digits
  filer: { nameLine1: string | null; nameLine2: string | null; careOfName: string | null; address: Address | null; phone: string | null };
  websiteAsStated: string | null;
  missionAsStated: string | null;
  legalDomicileStateAsStated: string | null;
  figures: Record<CharityFigureColumn, number | null>;
  boxes: Record<CharityBoxColumn, boolean | null>;
  /** The yes/no boxes exactly as written ('1', 'true', 'X', ...), so a reader can see what the return said. */
  boxesRaw: Record<CharityBoxColumn, string | null>;
  hasScheduleI: boolean;
  hasScheduleD: boolean;
  scheduleI: { grantRecordsMaintainedInd: boolean | null; total501c3OrgCnt: number | null; totalOtherOrgCnt: number | null } | null;
  rows: ParsedScheduleIRow[];
  /** Schedule D Part I figures, or null when the return has no Schedule D (a return with the schedule and no such element has nulls, not zeros). */
  daf: Record<DafFigureColumn, number | null> | null;
}

const WHOLE_NUMBER = /^-?\d+$/;
function amountOf(node: XmlNode | null, label: string): number | null {
  if (!node || node.text === "") return null;
  if (!WHOLE_NUMBER.test(node.text)) throw new FilingRejected(`${label} is "${node.text}", not a whole number`);
  const v = Number(node.text);
  if (!Number.isSafeInteger(v)) throw new FilingRejected(`${label} is outside the safe integer range`);
  return v;
}
function amountAtPath(node: XmlNode | null, path: string): number | null {
  let cur: XmlNode | null = node;
  for (const part of path.split("/")) {
    cur = child(cur, part);
    if (!cur) return null;
  }
  return amountOf(cur, path);
}

/** A yes/no written as true/false, 1/0 or an X: ONE reading for all (the IRS writes both ways). Anything else is null (not stated), not false. */
function boxOf(node: XmlNode | null): boolean | null {
  return node ? isTrue(node.text === "" ? null : node.text) : null;
}

const ROW_MAPPED_LEAVES = new Set([
  "RecipientBusinessName/BusinessNameLine1Txt",
  "RecipientBusinessName/BusinessNameLine2Txt",
  "USAddress/AddressLine1Txt",
  "USAddress/AddressLine2Txt",
  "USAddress/CityNm",
  "USAddress/StateAbbreviationCd",
  "USAddress/ZIPCd",
  "ForeignAddress/AddressLine1Txt",
  "ForeignAddress/AddressLine2Txt",
  "ForeignAddress/CityNm",
  "ForeignAddress/ProvinceOrStateNm",
  "ForeignAddress/CountryCd",
  "ForeignAddress/ForeignPostalCd",
  "RecipientEIN",
  "IRCSectionDesc",
  "CashGrantAmt",
  "NonCashAssistanceAmt",
  "NonCashAssistanceDesc",
  "ValuationMethodUsedDesc",
  "PurposeOfGrantTxt",
]);

function parseRow(node: XmlNode, ordinal: number): ParsedScheduleIRow {
  const unmapped: Record<string, string> = {};
  for (const [p, v] of leaves(node)) if (!ROW_MAPPED_LEAVES.has(p)) unmapped[p] = v;
  const us = child(node, "USAddress");
  const fg = child(node, "ForeignAddress");
  const address = addressOf(us || fg ? node : null);
  return {
    ordinal,
    recipientNameLine1: textAt(node, "RecipientBusinessName/BusinessNameLine1Txt"),
    recipientNameLine2: textAt(node, "RecipientBusinessName/BusinessNameLine2Txt"),
    recipientEinAsStated: textAt(node, "RecipientEIN"),
    address,
    ircSectionAsStated: textAt(node, "IRCSectionDesc"),
    cashGrantAmt: amountAtPath(node, "CashGrantAmt"),
    nonCashAssistanceAmt: amountAtPath(node, "NonCashAssistanceAmt"),
    nonCashAssistanceDesc: textAt(node, "NonCashAssistanceDesc"),
    valuationMethodDesc: textAt(node, "ValuationMethodUsedDesc"),
    purposeAsStated: textAt(node, "PurposeOfGrantTxt"),
    unmappedFields: unmapped,
  };
}

export function parseReturn990(xml: string): ParsedReturn990 {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new FilingRejected(`not well-formed XML: ${e.message}`);
    throw e;
  }
  if (root.name !== "Return") throw new FilingRejected(`root element is <${root.name}>, not <Return>`);
  const header = child(root, "ReturnHeader");
  if (!header) throw new FilingRejected("no ReturnHeader");
  const returnTypeCd = textAt(header, "ReturnTypeCd");
  if (returnTypeCd !== "990") throw new FilingRejected(`ReturnTypeCd is ${returnTypeCd === null ? "absent" : `"${returnTypeCd}"`}, not 990`);
  const taxPeriodEnd = textAt(header, "TaxPeriodEndDt");
  if (!taxPeriodEnd || !/^\d{4}-\d{2}-\d{2}$/.test(taxPeriodEnd)) throw new FilingRejected(`TaxPeriodEndDt is ${taxPeriodEnd === null ? "absent" : `"${taxPeriodEnd}"`}`);
  const ein = textAt(header, "Filer/EIN");
  if (!ein || !/^\d{9}$/.test(ein)) throw new FilingRejected(`Filer EIN is ${ein === null ? "absent" : `"${ein}"`}, not nine digits`);

  const data = child(root, "ReturnData");
  const f990 = child(data, "IRS990");
  if (!data || !f990) throw new FilingRejected("no IRS990 in ReturnData");
  const si = child(data, "IRS990ScheduleI");
  const sd = child(data, "IRS990ScheduleD");

  const filerNode = child(header, "Filer");
  const careOf = filerNode ? descendants(filerNode, "InCareOfNm")[0]?.text || null : null;

  const figures = {} as Record<CharityFigureColumn, number | null>;
  for (const [col, def] of Object.entries(CHARITY_FIGURES) as Array<[CharityFigureColumn, FormPlace]>) figures[col] = amountAtPath(f990, def.element);
  const boxes = {} as Record<CharityBoxColumn, boolean | null>;
  const boxesRaw = {} as Record<CharityBoxColumn, string | null>;
  for (const [col, def] of Object.entries(CHARITY_BOXES) as Array<[CharityBoxColumn, FormPlace]>) {
    const n = child(f990, def.element);
    boxes[col] = boxOf(n);
    boxesRaw[col] = n && n.text !== "" ? n.text : null;
  }

  const rows = si ? descendants(si, "RecipientTable").map((n, i) => parseRow(n, i + 1)) : [];
  let daf: ParsedReturn990["daf"] = null;
  if (sd) {
    daf = {} as Record<DafFigureColumn, number | null>;
    for (const [col, def] of Object.entries(DAF_FIGURES) as Array<[DafFigureColumn, FormPlace]>) daf[col] = amountOf(child(sd, def.element), `Schedule D ${def.element}`);
  }

  return {
    returnVersion: root.attrs["returnVersion"] ?? null,
    returnTs: textAt(header, "ReturnTs"),
    returnTypeCd,
    taxYr: textAt(header, "TaxYr"),
    taxPeriodBegin: textAt(header, "TaxPeriodBeginDt"),
    taxPeriodEnd,
    ein,
    filer: {
      nameLine1: textAt(filerNode, "BusinessName/BusinessNameLine1Txt"),
      nameLine2: textAt(filerNode, "BusinessName/BusinessNameLine2Txt"),
      careOfName: careOf,
      address: addressOf(filerNode),
      phone: textAt(filerNode, "PhoneNum"),
    },
    websiteAsStated: textAt(f990, "WebsiteAddressTxt"),
    missionAsStated: textAt(f990, "MissionDesc") ?? textAt(f990, "ActivityOrMissionDesc"),
    legalDomicileStateAsStated: textAt(f990, "LegalDomicileStateCd"),
    figures,
    boxes,
    boxesRaw,
    hasScheduleI: !!si,
    hasScheduleD: !!sd,
    scheduleI: si
      ? {
          grantRecordsMaintainedInd: boxOf(child(si, "GrantRecordsMaintainedInd")),
          total501c3OrgCnt: amountOf(child(si, "Total501c3OrgCnt"), "Schedule I Total501c3OrgCnt"),
          totalOtherOrgCnt: amountOf(child(si, "TotalOtherOrgCnt"), "Schedule I TotalOtherOrgCnt"),
        }
      : null,
    rows,
    daf,
  };
}
