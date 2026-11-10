// Item 110 (ruling 0045): read one IRS Form 990-PF e-file return into plain data.
//
// INVARIANT. Whatever the return states is carried through with the words the
// return used; whatever it does not state stays null. Nothing is defaulted to 0
// or "", nothing is merged with another filing, and a value that cannot be read
// as what it should be (a figure that is not a whole number, an unexpected
// return type, a missing tax period) REJECTS the whole filing with a reason, so
// the loader records it as unread rather than loading a guess (clause 6).
//
// WHAT IS NEVER READ. The signing officer's SSN field is not parsed or stored
// (the IRS publishes it masked; it is still not ours to keep). Preparer details
// are not stored: they describe the accountant, not the funder.

import { XmlNode, XmlError, parseXml, child, childrenNamed, at, textAt, descendants, leaves } from "./xml";

export class FilingRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FilingRejected";
  }
}

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null; // US state or, for a foreign address, province/state as written
  zip: string | null;
  country: string | null; // null for a US address; ISO-style code as written for a foreign one
}

export interface ParsedPerson {
  ordinal: number;
  listedIn: "part_viii_officers_directors_trustees" | "signer_on_return_header";
  nameAsNamed: string | null;
  titleAsStated: string | null;
  hoursPerWeekAsStated: string | null; // the text the return gave ("22.00"); not interpreted
  compensationAmt: number | null;
  employeeBenefitAmt: number | null;
  expenseAccountAmt: number | null;
  address: Address | null;
}

export interface ParsedGrant {
  kind: "paid_during_year" | "approved_for_future_payment";
  ordinal: number; // position within its kind, in document order, 1-based
  listedInElement: string; // the element that held the row (so a list kept elsewhere is visible)
  recipientNameLine1: string | null;
  recipientNameLine2: string | null;
  recipientPersonName: string | null;
  address: Address | null;
  relationshipAsStated: string | null;
  recipientStatusAsStated: string | null;
  purposeAsStated: string | null;
  amountAmt: number | null;
  /** Any leaf under the row that no column above reads: kept, never dropped. */
  unmappedFields: Record<string, string>;
}

export interface ParsedApplicationGroup {
  ordinal: number;
  rawFields: Record<string, string>; // every leaf of the group, path -> text
}

export interface ParsedFiling {
  returnVersion: string | null;
  returnTs: string | null;
  returnTypeCd: string;
  taxYr: string | null;
  taxPeriodBegin: string | null;
  taxPeriodEnd: string; // YYYY-MM-DD
  ein: string; // 9 digits

  filer: {
    nameLine1: string | null;
    nameLine2: string | null;
    careOfName: string | null;
    address: Address | null;
    phone: string | null;
  };

  isPrivateOperatingFoundation: boolean | null;
  websiteAsStated: string | null;
  booksContactName: string | null;
  booksContactPhone: string | null;
  booksContactAddress: Address | null;

  /** Named columns, each from one element the form defines. Absent element -> null. */
  figures: Record<FigureColumn, number | null>;
  /** Flattened leaves (element path -> text) of the financial-statement groups, as filed. */
  financialStatementValues: Record<string, string>;

  people: ParsedPerson[];
  grantsPaid: ParsedGrant[];
  grantsApproved: ParsedGrant[];
  /** The "preselected charities only" box exactly as the return carries it. */
  onlyPreselectedRaw: string | null;
  applicationGroups: ParsedApplicationGroup[];
}

// Each named figure, and the element on the form that supplies it. These are the
// definitions ruling 0045 clause 3 asks for: one column per thing the form calls
// something, no merged "giving".
export const FIGURE_PATHS = {
  fmv_assets_eoy_amt: "FMVAssetsEOYAmt",
  total_assets_boy_amt: "Form990PFBalanceSheetsGrp/TotalAssetsBOYAmt",
  total_assets_eoy_book_amt: "Form990PFBalanceSheetsGrp/TotalAssetsEOYAmt",
  total_assets_eoy_fmv_amt: "Form990PFBalanceSheetsGrp/TotalAssetsEOYFMVAmt",
  total_liabilities_eoy_amt: "Form990PFBalanceSheetsGrp/TotalLiabilitiesEOYAmt",
  net_assets_eoy_amt: "Form990PFBalanceSheetsGrp/TotNetAstOrFundBalancesEOYAmt",
  contributions_received_per_books_amt: "AnalysisOfRevenueAndExpenses/ContriRcvdRevAndExpnssAmt",
  total_revenue_per_books_amt: "AnalysisOfRevenueAndExpenses/TotalRevAndExpnssAmt",
  total_expenses_per_books_amt: "AnalysisOfRevenueAndExpenses/TotalExpensesRevAndExpnssAmt",
  contributions_paid_per_books_amt: "AnalysisOfRevenueAndExpenses/ContriPaidRevAndExpnssAmt",
  contributions_paid_disbursements_amt: "AnalysisOfRevenueAndExpenses/ContriPaidDsbrsChrtblAmt",
  total_expenses_charitable_disbursements_amt: "AnalysisOfRevenueAndExpenses/TotalExpensesDsbrsChrtblAmt",
  net_value_noncharitable_assets_amt: "MinimumInvestmentReturnGrp/NetVlNoncharitableAssetsAmt",
  minimum_investment_return_amt: "MinimumInvestmentReturnGrp/MinimumInvestmentReturnAmt",
  distributable_amount_amt: "DistributableAmountGrp/DistributableAsAdjustedAmt",
  qualifying_distributions_amt: "PFQualifyingDistributionsGrp/QualifyingDistributionsAmt",
  undistributed_income_current_year_amt: "UndistributedIncomeGrp/UndistributedIncomeCYAmt",
  grants_paid_stated_total_amt: "SupplementaryInformationGrp/TotalGrantOrContriPdDurYrAmt",
  grants_approved_future_stated_total_amt: "SupplementaryInformationGrp/TotalGrantOrContriApprvFutAmt",
} as const;
export type FigureColumn = keyof typeof FIGURE_PATHS;

// Groups whose every leaf is kept as filed (element path -> text). Version drift
// adds and drops elements inside these; keeping them whole means a new element
// is stored under its own name instead of being missed.
export const FINANCIAL_STATEMENT_GROUPS = [
  "AnalysisOfRevenueAndExpenses",
  "Form990PFBalanceSheetsGrp",
  "MinimumInvestmentReturnGrp",
  "DistributableAmountGrp",
  "PFQualifyingDistributionsGrp",
] as const;

const WHOLE_NUMBER = /^-?\d+$/;

function amount(node: XmlNode | null, path: string): number | null {
  const t = textAt(node, path);
  if (t === null) return null;
  if (!WHOLE_NUMBER.test(t)) throw new FilingRejected(`${path} is "${t}", not a whole number`);
  const v = Number(t);
  if (!Number.isSafeInteger(v)) throw new FilingRejected(`${path} is outside the safe integer range`);
  return v;
}

function amountOf(node: XmlNode | null): number | null {
  if (!node || node.text === "") return null;
  if (!WHOLE_NUMBER.test(node.text)) throw new FilingRejected(`${node.name} is "${node.text}", not a whole number`);
  const v = Number(node.text);
  if (!Number.isSafeInteger(v)) throw new FilingRejected(`${node.name} is outside the safe integer range`);
  return v;
}

export function addressOf(node: XmlNode | null): Address | null {
  if (!node) return null;
  const us = child(node, "USAddress") ?? child(node, "RecipientUSAddress") ?? child(node, "LocationOfBooksUSAddress");
  const fg = child(node, "ForeignAddress") ?? child(node, "RecipientForeignAddress");
  const a = us ?? fg ?? (child(node, "AddressLine1Txt") || child(node, "CityNm") ? node : null);
  if (!a) return null;
  const isUs = a === us || (a === node && !!child(a, "StateAbbreviationCd"));
  return {
    line1: textAt(a, "AddressLine1Txt"),
    line2: textAt(a, "AddressLine2Txt"),
    city: textAt(a, "CityNm"),
    state: isUs ? textAt(a, "StateAbbreviationCd") : textAt(a, "ProvinceOrStateNm"),
    zip: isUs ? textAt(a, "ZIPCd") : textAt(a, "ForeignPostalCd"),
    country: isUs ? null : textAt(a, "CountryCd"),
  };
}

export function isTrue(t: string | null): boolean | null {
  if (t === null) return null;
  const v = t.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "x") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

const GRANT_MAPPED_PREFIXES = [
  "RecipientBusinessName/BusinessNameLine1Txt",
  "RecipientBusinessName/BusinessNameLine2Txt",
  "RecipientPersonNm",
  "RecipientUSAddress/AddressLine1Txt",
  "RecipientUSAddress/AddressLine2Txt",
  "RecipientUSAddress/CityNm",
  "RecipientUSAddress/StateAbbreviationCd",
  "RecipientUSAddress/ZIPCd",
  "RecipientForeignAddress/AddressLine1Txt",
  "RecipientForeignAddress/AddressLine2Txt",
  "RecipientForeignAddress/CityNm",
  "RecipientForeignAddress/ProvinceOrStateNm",
  "RecipientForeignAddress/CountryCd",
  "RecipientForeignAddress/ForeignPostalCd",
  "RecipientRelationshipTxt",
  "RecipientFoundationStatusTxt",
  "GrantOrContributionPurposeTxt",
  "Amt",
];

function parseGrant(node: XmlNode, kind: ParsedGrant["kind"], ordinal: number, parentName: string): ParsedGrant {
  const unmapped: Record<string, string> = {};
  for (const [p, v] of leaves(node)) if (!GRANT_MAPPED_PREFIXES.includes(p)) unmapped[p] = v;
  const addr = addressOf(node);
  return {
    kind,
    ordinal,
    listedInElement: parentName,
    recipientNameLine1: textAt(node, "RecipientBusinessName/BusinessNameLine1Txt"),
    recipientNameLine2: textAt(node, "RecipientBusinessName/BusinessNameLine2Txt"),
    recipientPersonName: textAt(node, "RecipientPersonNm"),
    address: addr,
    relationshipAsStated: textAt(node, "RecipientRelationshipTxt"),
    recipientStatusAsStated: textAt(node, "RecipientFoundationStatusTxt"),
    purposeAsStated: textAt(node, "GrantOrContributionPurposeTxt"),
    amountAmt: amount(node, "Amt"),
    unmappedFields: unmapped,
  };
}

/** Parent-aware descendant walk, so each grant row records where it was found. */
function collectWithParent(root: XmlNode, name: string): Array<{ node: XmlNode; parent: string }> {
  const out: Array<{ node: XmlNode; parent: string }> = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push({ node: c, parent: n.name });
      walk(c);
    }
  };
  walk(root);
  return out;
}

export function parseFiling990PF(xml: string): ParsedFiling {
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
  if (returnTypeCd !== "990PF") throw new FilingRejected(`ReturnTypeCd is ${returnTypeCd === null ? "absent" : `"${returnTypeCd}"`}, not 990PF`);

  const taxPeriodEnd = textAt(header, "TaxPeriodEndDt");
  if (!taxPeriodEnd || !/^\d{4}-\d{2}-\d{2}$/.test(taxPeriodEnd)) throw new FilingRejected(`TaxPeriodEndDt is ${taxPeriodEnd === null ? "absent" : `"${taxPeriodEnd}"`}`);
  const ein = textAt(header, "Filer/EIN");
  if (!ein || !/^\d{9}$/.test(ein)) throw new FilingRejected(`Filer/EIN is ${ein === null ? "absent" : `"${ein}"`}, not nine digits`);

  const data = child(root, "ReturnData");
  const pf = child(data, "IRS990PF");
  if (!data || !pf) throw new FilingRejected("no IRS990PF in ReturnData");

  const filerNode = child(header, "Filer");
  const careOf = filerNode ? descendants(filerNode, "InCareOfNm")[0]?.text || null : null;

  // --- figures ---
  const figures = {} as Record<FigureColumn, number | null>;
  for (const [col, path] of Object.entries(FIGURE_PATHS) as Array<[FigureColumn, string]>) figures[col] = amount(pf, path);

  const fsv: Record<string, string> = {};
  for (const g of FINANCIAL_STATEMENT_GROUPS) {
    const gn = child(pf, g);
    if (gn) for (const [p, v] of leaves(gn, g)) fsv[p] = v;
  }

  // --- people ---
  const people: ParsedPerson[] = [];
  const officers = at(pf, "OfficerDirTrstKeyEmplInfoGrp");
  let ord = 0;
  for (const o of childrenNamed(officers, "OfficerDirTrstKeyEmplGrp")) {
    ord++;
    people.push({
      ordinal: ord,
      listedIn: "part_viii_officers_directors_trustees",
      nameAsNamed: textAt(o, "PersonNm") ?? textAt(o, "BusinessName/BusinessNameLine1Txt"),
      titleAsStated: textAt(o, "TitleTxt"),
      hoursPerWeekAsStated: textAt(o, "AverageHrsPerWkDevotedToPosRt"),
      compensationAmt: amount(o, "CompensationAmt"),
      employeeBenefitAmt: amount(o, "EmployeeBenefitProgramAmt"),
      expenseAccountAmt: amount(o, "ExpenseAccountOtherAllwncAmt"),
      address: addressOf(o),
    });
  }
  const signer = child(header, "BusinessOfficerGrp");
  if (signer && (textAt(signer, "PersonNm") || textAt(signer, "PersonTitleTxt"))) {
    people.push({
      ordinal: 1,
      listedIn: "signer_on_return_header",
      nameAsNamed: textAt(signer, "PersonNm"),
      titleAsStated: textAt(signer, "PersonTitleTxt"),
      hoursPerWeekAsStated: null,
      compensationAmt: null,
      employeeBenefitAmt: null,
      expenseAccountAmt: null,
      address: null,
    });
  }

  // --- grants: found wherever the return keeps them, with the element recorded ---
  const grantsPaid = collectWithParent(data, "GrantOrContributionPdDurYrGrp").map((g, i) => parseGrant(g.node, "paid_during_year", i + 1, g.parent));
  const grantsApproved = collectWithParent(data, "GrantOrContriApprvForFutGrp").map((g, i) =>
    parseGrant(g.node, "approved_for_future_payment", i + 1, g.parent)
  );

  // --- how to apply ---
  const sup = child(pf, "SupplementaryInformationGrp");
  const applicationGroups: ParsedApplicationGroup[] = descendants(pf, "ApplicationSubmissionInfoGrp").map((g, i) => ({
    ordinal: i + 1,
    rawFields: Object.fromEntries(leaves(g)),
  }));

  const stmt = child(pf, "StatementsRegardingActyGrp");
  const booksName = textAt(stmt, "IndividualWithBooksNm") ?? textAt(stmt, "PersonsWithBooksName/BusinessNameLine1Txt");
  const privateOperating =
    isTrue(textAt(stmt, "PrivateOperatingFoundationInd")) ?? isTrue(textAt(pf, "PrivateOperatingFoundationsGrp/PrivateOperatingFoundationInd"));

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
    isPrivateOperatingFoundation: privateOperating,
    websiteAsStated: textAt(stmt, "WebsiteAddressTxt"),
    booksContactName: booksName,
    booksContactPhone: textAt(stmt, "PhoneNum"),
    booksContactAddress: addressOf(child(stmt, "LocationOfBooksUSAddress") ? stmt : null),
    figures,
    financialStatementValues: fsv,
    people,
    grantsPaid,
    grantsApproved,
    onlyPreselectedRaw: textAt(sup, "OnlyContriToPreselectedInd"),
    applicationGroups,
  };
}

/**
 * Cheap look at the start of a return, for deciding whether a filing is in scope
 * before reading all of it. Works on a truncated document. Returns null when the
 * start does not contain what is needed (the caller then reads more or the whole).
 */
export interface HeaderPeek {
  ein: string | null;
  returnType: string | null;
  taxPeriodEnd: string | null;
  state: string | null; // US state of the filer's address; null if foreign or absent
  foreign: boolean;
}
export function peekHeader(prefix: string): HeaderPeek | null {
  const filerStart = prefix.indexOf("<Filer>");
  const filerEnd = prefix.indexOf("</Filer>");
  if (filerStart < 0 || filerEnd < 0) return null;
  const grab = (re: RegExp, s: string) => re.exec(s)?.[1]?.trim() ?? null;
  const filer = prefix.slice(filerStart, filerEnd);
  const us = /<USAddress>([\s\S]*?)<\/USAddress>/.exec(filer);
  return {
    ein: grab(/<EIN>(\d+)<\/EIN>/, filer),
    returnType: grab(/<ReturnTypeCd>([^<]*)<\/ReturnTypeCd>/, prefix),
    taxPeriodEnd: grab(/<TaxPeriodEndDt>([^<]*)<\/TaxPeriodEndDt>/, prefix),
    state: us ? grab(/<StateAbbreviationCd>([^<]*)<\/StateAbbreviationCd>/, us[1]) : null,
    foreign: /<ForeignAddress>/.test(filer),
  };
}
