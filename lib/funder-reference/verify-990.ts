// Item 116 (ruling 0047 clause 6): compare what the Form 990 loader STORED for a public charity or a
// donor-advised fund sponsor with the IRS return itself. The sibling of
// scripts/verify-funder-reference-example.ts for Form 990-PF, and built the same way. Pure: no database,
// no network, no file reads; the script (scripts/verify-public-charities.ts) feeds it rows and bytes.
//
// WHAT IS INDEPENDENT OF THE LOADER, and what is not -- stated plainly because "the loader marking its
// own homework" is the failure this file exists to prevent.
//
// INDEPENDENT (typed out again here, not imported from the loader):
//   * the XML reader: a regular-expression scanner (tokenize), not lib/funder-reference/xml.ts;
//   * the table of which element feeds which stored column (FIGURE_PATHS, BOX_PATHS, DAF_PATHS,
//     ROW_COLUMN_PATHS, MAPPED_ROW_LEAVES, the filer and organization paths), not parse-990.ts;
//   * how an address is read, how a yes/no is read (X, 1, true / 0, false), how a whole-number amount
//     is read, which leaves of a Schedule I row are "unmapped";
//   * every derived figure (rows listed, sum of cash grants), the supersession winner, the kind labels
//     (public charity: the largest stated Part IX line 1 figure is at least the threshold; donor-advised
//     fund sponsor: any return states at least one fund) and the kind_basis, all recomputed from the
//     returns re-read here, never from the loader's own row builder or its pass-A cache;
//   * the structural checks for ruling 0047 (no grants to individuals, no donor, no person) which look
//     at the return's own element names and at the stored column names and values.
//
// NOT INDEPENDENT (shared on purpose, and why that is acceptable):
//   * the ZIP reader (lib/funder-reference/zip.ts) and the archive locator the script uses to find a
//     member when the stored location does not hold it. Whatever bytes come back are checked against
//     the stored SHA-256 and length, so a ZIP fault that returned different bytes shows up as a
//     mismatch here rather than as agreement;
//   * the written ruling and migration: the list of stored columns is typed out here from migration
//     0089, and a stored row with a column this file does not know is itself a mismatch.
//
// WHAT A "MISMATCH LINE" LOOKS LIKE. The same shape the Form 990-PF checker prints, so the same
// exception list mechanism can explain a line:
//   [ein] [object_id period_end] label: stored "X" but the filing gives "Y"
// A number the return states as zero and a number the return does not state are different facts; a
// stored zero where the return is silent is reported as an invented zero.

import { createHash } from "node:crypto";

export const VERIFIER_VERSION = "verify-public-charities/1.0.0";

// ---------------------------------------------------------------------------
// the verifier's own XML reader
// ---------------------------------------------------------------------------
export interface VNode {
  name: string;
  attrs: Record<string, string>;
  kids: VNode[];
  text: string;
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, b: string) => {
    if (b[0] === "#") return String.fromCodePoint(b[1] === "x" ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[b]!;
  });
}

/** Reads a well-formed document or throws. Refuses anything the scanner cannot place (a DOCTYPE, a stray `<`). */
export function tokenize(xml: string): VNode {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root: VNode = { name: "#root", attrs: {}, kids: [], text: "" };
  const stack: VNode[] = [root];
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) throw new Error(`verifier XML reader: cannot read markup at offset ${pos}`);
    pos = re.lastIndex;
    if (m[1] !== undefined) {
      stack[stack.length - 1].text += m[1];
    } else if (m[2] !== undefined) {
      const top = stack.pop()!;
      if (stack.length === 0 || top.name !== m[2].replace(/^.*:/, "")) throw new Error(`verifier XML reader: </${m[2]}> closes <${top.name}>`);
      top.text = top.text.trim();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (!/^xmlns(:|$)/.test(a[1])) attrs[a[1].replace(/^.*:/, "")] = decode(a[2] ?? a[3]);
      const n: VNode = { name: m[3].replace(/^.*:/, ""), attrs, kids: [], text: "" };
      stack[stack.length - 1].kids.push(n);
      if (m[5] !== "/") stack.push(n);
    } else if (m[6] !== undefined) {
      if (stack.length === 1 && m[6].trim() !== "") throw new Error("verifier XML reader: text outside the root element");
      stack[stack.length - 1].text += decode(m[6]);
    }
  }
  if (stack.length !== 1 || root.kids.length !== 1) throw new Error("verifier XML reader: unbalanced document");
  return root.kids[0];
}

const at = (n: VNode | null | undefined, path: string): VNode | null => {
  let c: VNode | null | undefined = n;
  for (const p of path.split("/")) c = c?.kids.find((k) => k.name === p);
  return c ?? null;
};
const txt = (n: VNode | null | undefined, path: string): string | null => {
  const t = at(n, path);
  return t && t.text !== "" ? t.text : null;
};
/** Every element named `name` anywhere under `n`, with the names from n down to it joined by "/". */
function findAll(n: VNode, name: string, prefix = "", out: Array<{ node: VNode; path: string }> = []): Array<{ node: VNode; path: string }> {
  for (const k of n.kids) {
    const p = prefix ? `${prefix}/${k.name}` : k.name;
    if (k.name === name) out.push({ node: k, path: p });
    findAll(k, name, p, out);
  }
  return out;
}
function leafPaths(n: VNode, prefix = "", out: Array<[string, string]> = []): Array<[string, string]> {
  for (const k of n.kids) {
    const p = prefix ? `${prefix}/${k.name}` : k.name;
    if (k.kids.length === 0) out.push([p, k.text]);
    else leafPaths(k, p, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the verifier's own column-to-element tables (typed out again, deliberately)
// ---------------------------------------------------------------------------
const MAIN = "ReturnData/IRS990";
const FIGURE_PATHS: Array<[string, string, string]> = [
  // [stored column, element under ReturnData/IRS990, text the stored place must contain]
  ["part_i_line_8_cy_contributions_grants_amt", "CYContributionsGrantsAmt", "Part I, line 8"],
  ["part_i_line_12_cy_total_revenue_amt", "CYTotalRevenueAmt", "Part I, line 12"],
  ["part_i_line_13_cy_grants_and_similar_paid_amt", "CYGrantsAndSimilarPaidAmt", "Part I, line 13"],
  ["part_i_line_18_cy_total_expenses_amt", "CYTotalExpensesAmt", "Part I, line 18"],
  ["part_i_line_20_total_assets_eoy_amt", "TotalAssetsEOYAmt", "Part I, line 20"],
  ["part_i_line_22_net_assets_eoy_amt", "NetAssetsOrFundBalancesEOYAmt", "Part I, line 22"],
  ["part_ix_line_1_grants_domestic_orgs_total_amt", "GrantsToDomesticOrgsGrp/TotalAmt", "Part IX, line 1"],
  ["part_ix_line_3_grants_outside_us_total_amt", "ForeignGrantsGrp/TotalAmt", "Part IX, line 3"],
];
const BOX_PATHS: Array<[string, string, string]> = [
  ["part_iv_line_6_donor_advised_fund_box", "DonorAdvisedFundInd", "Part IV, line 6"],
  ["part_iv_line_21_grants_to_domestic_orgs_box", "GrantsToOrganizationsInd", "Part IV, line 21"],
];
const DAF_PATHS: Array<[string, string, string]> = [
  ["daf_held_cnt", "DonorAdvisedFundsHeldCnt", "line 1, column (a)"],
  ["daf_contributions_amt", "DonorAdvisedFundsContriAmt", "line 2, column (a)"],
  ["daf_grants_amt", "DonorAdvisedFundsGrantsAmt", "line 3, column (a)"],
  ["daf_value_eoy_amt", "DonorAdvisedFundsVlEOYAmt", "line 4, column (a)"],
  ["other_funds_held_cnt", "FundsAndOtherAccountsHeldCnt", "line 1, column (b)"],
  ["other_funds_contributions_amt", "FundsAndOtherAccountsContriAmt", "line 2, column (b)"],
  ["other_funds_grants_amt", "FundsAndOtherAccountsGrantsAmt", "line 3, column (b)"],
  ["other_funds_value_eoy_amt", "FundsAndOtherAccountsVlEOYAmt", "line 4, column (b)"],
];
/** Schedule I row column -> element under the row (RecipientTable). */
const ROW_TEXT_COLUMNS: Array<[string, string]> = [
  ["recipient_name_line1", "RecipientBusinessName/BusinessNameLine1Txt"],
  ["recipient_name_line2", "RecipientBusinessName/BusinessNameLine2Txt"],
  ["recipient_ein_as_stated", "RecipientEIN"],
  ["irc_section_as_stated", "IRCSectionDesc"],
  ["noncash_assistance_desc", "NonCashAssistanceDesc"],
  ["valuation_method_desc", "ValuationMethodUsedDesc"],
  ["purpose_as_stated", "PurposeOfGrantTxt"],
];
const ROW_AMOUNT_COLUMNS: Array<[string, string]> = [
  ["cash_grant_amt", "CashGrantAmt"],
  ["noncash_assistance_amt", "NonCashAssistanceAmt"],
];
/** Every leaf of a recipient row that a stored column reads; any other leaf must be in unmapped_fields. */
const MAPPED_ROW_LEAVES = new Set([
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

/** The columns each stored table has (migration 0089). A stored row with any other column is a mismatch. */
const COLUMNS: Record<string, string[]> = {
  filings: ["object_id", "ein", "return_type", "index_tax_period", "tax_period_end", "tax_period_begin", "tax_year", "return_version", "return_ts", "status", "status_note", "superseded_by_object_id", "index_file", "index_return_id", "index_sub_year", "document_archive_url", "document_member", "xml_sha256", "xml_bytes", "run_id", "loaded_at", "loader_version"],
  organizations: ["ein", "source_object_id", "source_tax_period_end", "form_type", "legal_name_line1", "legal_name_line2", "care_of_name", "address_line1", "address_line2", "city", "state", "zip", "country", "phone_as_stated", "website_as_stated", "mission_as_stated", "legal_domicile_state_as_stated", "is_grantmaking_public_charity", "is_daf_sponsor", "kind_rule", "kind_threshold_org_grants_amt", "kind_basis", "loaded_at", "loader_version"],
  figures: ["ein", "tax_period_end", "filing_object_id", "form_type", ...FIGURE_PATHS.map((x) => x[0]), ...BOX_PATHS.flatMap((x) => [x[0], `${x[0]}_as_written`]), "has_schedule_i", "has_schedule_d", "schedule_i_grant_records_maintained_ind", "schedule_i_total_501c3_org_cnt", "schedule_i_total_other_org_cnt", "schedule_i_rows_listed_count", "schedule_i_cash_grants_listed_sum_amt", "schedule_i_listed_derivation", "form_places", "loaded_at", "loader_version"],
  daf: ["filing_object_id", "ein", "tax_period_end", "form_type", ...DAF_PATHS.map((x) => x[0]), "form_places", "loaded_at", "loader_version"],
  grants: ["filing_object_id", "ordinal", "ein", "tax_period_end", "form_type", "source_location", "recipient_name_line1", "recipient_name_line2", "recipient_ein_as_stated", "recipient_address_line1", "recipient_address_line2", "recipient_city", "recipient_state", "recipient_zip", "recipient_country", "irc_section_as_stated", "cash_grant_amt", "noncash_assistance_amt", "noncash_assistance_desc", "valuation_method_desc", "purpose_as_stated", "unmapped_fields", "loaded_at", "loader_version"],
  coverage: ["ein", "period_year", "status", "filing_object_id", "note", "run_id", "checked_at"],
};

// ---------------------------------------------------------------------------
// what the verifier is given and what it returns
// ---------------------------------------------------------------------------
export type Row = Record<string, unknown>;

export interface StoredFunder {
  ein: string;
  filings: Row[]; // every status
  organizations: Row[];
  figures: Row[];
  daf: Row[];
  grants: Row[];
  coverage: Row[];
}

export interface VerifyContext {
  /** The threshold the run was made under (the owner's $100,000); the stored threshold must equal it. */
  thresholdAmt: number;
  years: number[];
  /** The bytes of a stored filing's XML, or the reason they could not be had. */
  readXml(filing: Row): Promise<Uint8Array | { error: string }>;
  /** Years in which the IRS index lists a Form 990 for this EIN; null when the index was not given (coverage claims of absence are then not checked). */
  indexYears?(ein: string): Set<number> | null;
}

export class Checker {
  compared = 0;
  lines: string[] = [];
  ein = "";
  eq(label: string, actual: unknown, expected: unknown, kind: "text" | "int" | "bool" | "ts" | "json" = "text") {
    this.compared++;
    const a = norm(actual);
    const e = norm(expected);
    let same: boolean;
    if (a === null || e === null) same = a === e;
    else if (kind === "int") same = Number(a) === Number(e);
    else if (kind === "ts") same = Date.parse(a) === Date.parse(e);
    else same = a === e;
    if (same) return;
    const invented = kind === "int" && e === null && a !== null && Number(a) === 0;
    this.lines.push(`[${this.ein}] ${label}: stored ${a === null ? "NULL" : JSON.stringify(a)} but the filing gives ${e === null ? "nothing" : JSON.stringify(e)}${invented ? " (an invented zero: the return does not state this figure)" : ""}`);
  }
  check(label: string, cond: boolean, detail = "") {
    this.compared++;
    if (!cond) this.lines.push(`[${this.ein}] ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function norm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(sortKeys(v));
  return String(v);
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, sortKeys((v as Row)[k])]));
  return v;
}

// ---------------------------------------------------------------------------
// reading one return, the verifier's way
// ---------------------------------------------------------------------------
type Amount = { v: number | null; bad?: string };
function amount(n: VNode | null | undefined, path: string): Amount {
  const t = at(n, path);
  if (!t || t.text === "") return { v: null };
  if (!/^-?\d+$/.test(t.text)) return { v: null, bad: `${path} is "${t.text}", not a whole number` };
  const v = Number(t.text);
  return Number.isSafeInteger(v) ? { v } : { v: null, bad: `${path} is outside the safe integer range` };
}
/** One reading for every yes/no the IRS writes: 1, true, X are yes; 0, false are no; anything else, or nothing, is not stated. */
function yesNo(text: string | null): boolean | null {
  if (text === null) return null;
  const t = text.trim().toLowerCase();
  if (t === "1" || t === "true" || t === "x") return true;
  if (t === "0" || t === "false") return false;
  return null;
}
interface Addr {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}
const NO_ADDR: Addr = { line1: null, line2: null, city: null, state: null, zip: null, country: null };
/** A United States address (state, zip, no country) or a foreign one (province, postal code, country); the lines themselves when the element is the address. */
function addressUnder(n: VNode | null): Addr {
  if (!n) return NO_ADDR;
  const us = at(n, "USAddress");
  const fg = at(n, "ForeignAddress");
  const a = us ?? fg ?? (at(n, "AddressLine1Txt") || at(n, "CityNm") ? n : null);
  if (!a) return NO_ADDR;
  const isUs = a === us || (a === n && !!at(a, "StateAbbreviationCd"));
  return {
    line1: txt(a, "AddressLine1Txt"),
    line2: txt(a, "AddressLine2Txt"),
    city: txt(a, "CityNm"),
    state: isUs ? txt(a, "StateAbbreviationCd") : txt(a, "ProvinceOrStateNm"),
    zip: isUs ? txt(a, "ZIPCd") : txt(a, "ForeignPostalCd"),
    country: isUs ? null : txt(a, "CountryCd"),
  };
}

export interface ReadReturn {
  root: VNode;
  header: VNode;
  main: VNode;
  si: VNode | null;
  sd: VNode | null;
  periodEnd: string;
  ein: string;
  returnTs: string | null;
  /** Part IX line 1 column (A), null when the return does not state it. */
  orgGrants: number | null;
  /** Schedule D Part I line 1 column (a), null when not stated or no Schedule D. */
  dafHeld: number | null;
  dafBox: boolean | null;
  /** The reasons this return would not be a clean Form 990 (the same tests the loader makes, written again). */
  rejectReasons: string[];
}

export function readReturn(bytes: Uint8Array): ReadReturn | { error: string } {
  let root: VNode;
  try {
    root = tokenize(Buffer.from(bytes).toString("utf8"));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const header = at(root, "ReturnHeader");
  const main = at(root, MAIN);
  if (root.name !== "Return" || !header) return { error: `not a Return with a ReturnHeader (root is <${root.name}>)` };
  const reasons: string[] = [];
  const type = txt(header, "ReturnTypeCd");
  if (type !== "990") reasons.push(`ReturnTypeCd is ${type ?? "absent"}, not 990`);
  const periodEnd = txt(header, "TaxPeriodEndDt");
  if (!periodEnd || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) reasons.push(`TaxPeriodEndDt is ${periodEnd ?? "absent"}`);
  const ein = txt(header, "Filer/EIN");
  if (!ein || !/^\d{9}$/.test(ein)) reasons.push(`Filer EIN is ${ein ?? "absent"}, not nine digits`);
  if (!main) reasons.push("no IRS990 in ReturnData");
  const si = at(root, "ReturnData/IRS990ScheduleI");
  const sd = at(root, "ReturnData/IRS990ScheduleD");
  if (main) {
    for (const [, el] of FIGURE_PATHS) {
      const a = amount(main, el);
      if (a.bad) reasons.push(a.bad);
    }
  }
  if (sd) for (const [, el] of DAF_PATHS) {
    const a = amount(sd, el);
    if (a.bad) reasons.push(`Schedule D ${a.bad}`);
  }
  if (si) for (const el of ["Total501c3OrgCnt", "TotalOtherOrgCnt"]) {
    const a = amount(si, el);
    if (a.bad) reasons.push(`Schedule I ${a.bad}`);
  }
  if (si) for (const { node } of findAll(si, "RecipientTable")) for (const [, el] of ROW_AMOUNT_COLUMNS) {
    const a = amount(node, el);
    if (a.bad) reasons.push(`Schedule I row ${a.bad}`);
  }
  return {
    root,
    header,
    main: main ?? root,
    si,
    sd,
    periodEnd: periodEnd ?? "",
    ein: ein ?? "",
    returnTs: txt(header, "ReturnTs"),
    orgGrants: main ? amount(main, "GrantsToDomesticOrgsGrp/TotalAmt").v : null,
    dafHeld: sd ? amount(sd, "DonorAdvisedFundsHeldCnt").v : null,
    dafBox: main ? yesNo(txt(main, "DonorAdvisedFundInd")) : null,
    rejectReasons: reasons,
  };
}

/** The United States state on the return's own filer address, or null (a foreign address, or none). */
export function stateOfReturn(r: ReadReturn): string | null {
  return txt(r.header, "Filer/USAddress/StateAbbreviationCd");
}

/** Why a return the loader recorded as unread really is one, by the verifier's own reading; null when this reading finds nothing wrong with it. */
export function independentRejectReason(bytes: Uint8Array): string | null {
  const r = readReturn(bytes);
  if ("error" in r) return r.error;
  return r.rejectReasons.length ? r.rejectReasons.join("; ") : null;
}

// ---------------------------------------------------------------------------
// the kind rule, written again from ruling 0047 clause 8
// ---------------------------------------------------------------------------
export function expectedKinds(returns: ReadReturn[], thresholdAmt: number) {
  const stated = returns.map((r) => r.orgGrants).filter((v): v is number => v !== null);
  const max = stated.length ? Math.max(...stated) : null;
  return {
    charity: max !== null && max >= thresholdAmt,
    daf: returns.some((r) => r.dafHeld !== null && r.dafHeld > 0),
    basis: returns.map((r) => ({ tax_period_end: r.periodEnd, grants_to_domestic_orgs_amt: r.orgGrants, donor_advised_funds_held_cnt: r.dafHeld, donor_advised_fund_box: r.dafBox })),
  };
}

// ---------------------------------------------------------------------------
// comparing one funder
// ---------------------------------------------------------------------------
const PROVENANCE_URL = /^https:\/\/apps\.irs\.gov\/pub\/epostcard\/990\/xml\/\d{4}\/[\w]+\.zip$/;

function checkColumns(ck: Checker, table: string, tag: string, row: Row) {
  const known = new Set(COLUMNS[table]);
  const extra = Object.keys(row).filter((k) => !known.has(k));
  const missing = COLUMNS[table].filter((k) => !(k in row));
  ck.check(`${tag} ${table} row has exactly the columns migration 0089 defines`, extra.length === 0 && missing.length === 0, `unknown columns: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
}

const hasProvenance = (r: Row) => !!r.loaded_at && !!r.loader_version;

export async function verifyFunder(stored: StoredFunder, ctx: VerifyContext, ck: Checker): Promise<{ filingsChecked: number }> {
  const ein = stored.ein;
  ck.ein = ein;
  const filings = [...stored.filings].sort((a, b) => String(a.tax_period_end ?? "").localeCompare(String(b.tax_period_end ?? "")) || String(a.object_id).localeCompare(String(b.object_id)));
  const standing = filings.filter((f) => f.status === "loaded");
  const superseded = filings.filter((f) => f.status === "superseded");
  const unread = filings.filter((f) => f.status === "unread");
  const idsHoldingRows = new Set(standing.map((f) => String(f.object_id)));
  ck.check("the database holds at least one filing for this EIN", filings.length > 0);
  ck.check("every filing of this EIN has an allowed status (loaded, superseded or unread)", filings.every((f) => ["loaded", "superseded", "unread"].includes(String(f.status))));

  // rows hang only off standing filings: nothing double-counted, nothing orphaned
  for (const [name, rows] of [["figures", stored.figures], ["daf figures", stored.daf], ["grants", stored.grants]] as Array<[string, Row[]]>) {
    const stray = rows.filter((r) => !idsHoldingRows.has(String(r.filing_object_id)));
    ck.check(`every stored ${name} row of this EIN belongs to a standing (loaded) filing`, stray.length === 0, stray.slice(0, 3).map((r) => String(r.filing_object_id)).join(", "));
  }
  for (const u of unread) {
    ck.check(`unread filing ${u.object_id} records a reason and holds no figures, daf figures or grants`, typeof u.status_note === "string" && String(u.status_note).length > 10 && ![...stored.figures, ...stored.daf, ...stored.grants].some((r) => r.filing_object_id === u.object_id));
  }
  ck.check("exactly one standing filing per tax period end", new Set(standing.map((f) => f.tax_period_end)).size === standing.length);
  ck.check("one figures row per standing filing", stored.figures.length === standing.length);

  // ---- re-read every stored (loaded and superseded) filing ----
  const reads = new Map<string, ReadReturn>();
  const bytesOf = new Map<string, Uint8Array>();
  let filingsChecked = 0;
  for (const f of [...standing, ...superseded]) {
    const id = String(f.object_id);
    const got = await ctx.readXml(f);
    if ("error" in got) {
      ck.check(`[${id}] the filing can be re-read from the IRS archive`, false, got.error);
      continue;
    }
    bytesOf.set(id, got);
    const r = readReturn(got);
    if ("error" in r) {
      ck.check(`[${id} ${String(f.tax_period_end)}] the stored filing is a well-formed return`, false, r.error);
      continue;
    }
    reads.set(id, r);
    filingsChecked++;
  }

  // ---- supersession: the winner is the latest submitted return for the EIN and period ----
  const byPeriod = new Map<string, Array<{ id: string; ts: string; row: Row }>>();
  for (const f of [...standing, ...superseded]) {
    const r = reads.get(String(f.object_id));
    if (!r) continue;
    const a = byPeriod.get(r.periodEnd) ?? [];
    a.push({ id: String(f.object_id), ts: r.returnTs ?? "", row: f });
    byPeriod.set(r.periodEnd, a);
  }
  for (const [period, list] of byPeriod) {
    list.sort((x, y) => Date.parse(y.ts || "1970-01-01") - Date.parse(x.ts || "1970-01-01") || y.id.localeCompare(x.id));
    ck.check(`[${period}] the standing return for the period is the latest submitted one (${list[0].id})`, list[0].row.status === "loaded", `stored status of ${list[0].id} is ${String(list[0].row.status)}`);
    for (const lose of list.slice(1)) {
      ck.check(`[${lose.id} ${period}] an earlier return for the period is recorded as superseded by ${list[0].id}`, lose.row.status === "superseded" && lose.row.superseded_by_object_id === list[0].id, `status ${String(lose.row.status)}, superseded_by ${String(lose.row.superseded_by_object_id)}`);
    }
  }
  for (const s of superseded) {
    const succ = standing.find((x) => x.object_id === s.superseded_by_object_id);
    ck.check(`superseded filing ${s.object_id} names a standing successor for the same EIN and tax period end`, !!succ && succ.tax_period_end === s.tax_period_end && succ.ein === s.ein);
  }

  // ---- each standing filing, value by value ----
  for (const f of standing) {
    const id = String(f.object_id);
    const r = reads.get(id);
    if (!r) continue;
    const bytes = bytesOf.get(id)!;
    const tag = `[${id} ${r.periodEnd}]`;
    checkFiling(ck, tag, f, r, bytes);
    checkFigures(ck, tag, f, r, stored.figures.find((x) => x.filing_object_id === id));
    checkDaf(ck, tag, f, r, stored.daf.filter((x) => x.filing_object_id === id));
    checkGrants(ck, tag, f, r, stored.grants.filter((x) => x.filing_object_id === id));
    checkRuling0047(ck, tag, id, r, stored);
  }
  for (const f of superseded) {
    const id = String(f.object_id);
    const r = reads.get(id);
    if (!r) continue;
    checkFiling(ck, `[${id} ${r.periodEnd}]`, f, r, bytesOf.get(id)!, true);
  }

  // ---- the funder row: identity from the latest standing return, and the kind labels ----
  const org = stored.organizations;
  ck.check("exactly one funder row for the EIN", org.length === 1, `${org.length} rows`);
  const allReads = [...standing, ...superseded].map((f) => reads.get(String(f.object_id))).filter((x): x is ReadReturn => !!x);
  if (org.length === 1 && standing.length) {
    const o = org[0];
    checkColumns(ck, "organizations", `[${ein}]`, o);
    const latest = [...standing].sort((a, b) => String(b.tax_period_end).localeCompare(String(a.tax_period_end)))[0];
    const lr = reads.get(String(latest.object_id));
    const tag = `[${latest.object_id} ${lr?.periodEnd ?? ""}]`;
    ck.eq(`${tag} funder.ein`, o.ein, ein);
    ck.eq(`${tag} funder.source_object_id (the latest standing return)`, o.source_object_id, latest.object_id);
    ck.eq(`${tag} funder.source_tax_period_end`, o.source_tax_period_end, latest.tax_period_end);
    ck.eq(`${tag} funder.form_type`, o.form_type, "990");
    if (lr) {
      const filer = at(lr.header, "Filer");
      const a = addressUnder(filer);
      ck.eq(`${tag} funder.legal_name_line1`, o.legal_name_line1, txt(filer, "BusinessName/BusinessNameLine1Txt"));
      ck.eq(`${tag} funder.legal_name_line2`, o.legal_name_line2, txt(filer, "BusinessName/BusinessNameLine2Txt"));
      const care = filer ? findAll(filer, "InCareOfNm")[0]?.node.text : "";
      ck.eq(`${tag} funder.care_of_name`, o.care_of_name, care || null);
      ck.eq(`${tag} funder.address_line1`, o.address_line1, a.line1);
      ck.eq(`${tag} funder.address_line2`, o.address_line2, a.line2);
      ck.eq(`${tag} funder.city`, o.city, a.city);
      ck.eq(`${tag} funder.state`, o.state, a.state);
      ck.eq(`${tag} funder.zip`, o.zip, a.zip);
      ck.eq(`${tag} funder.country`, o.country, a.country);
      ck.eq(`${tag} funder.phone_as_stated`, o.phone_as_stated, txt(filer, "PhoneNum"));
      ck.eq(`${tag} funder.website_as_stated`, o.website_as_stated, txt(lr.main, "WebsiteAddressTxt"));
      ck.eq(`${tag} funder.mission_as_stated`, o.mission_as_stated, txt(lr.main, "MissionDesc") ?? txt(lr.main, "ActivityOrMissionDesc"));
      ck.eq(`${tag} funder.legal_domicile_state_as_stated`, o.legal_domicile_state_as_stated, txt(lr.main, "LegalDomicileStateCd"));
    }
    const k = expectedKinds(allReads, ctx.thresholdAmt);
    ck.eq(`${tag} funder.is_grantmaking_public_charity (the largest stated Part IX line 1 figure is at least ${ctx.thresholdAmt})`, o.is_grantmaking_public_charity, k.charity, "bool");
    ck.eq(`${tag} funder.is_daf_sponsor (some return states at least one donor advised fund on Schedule D)`, o.is_daf_sponsor, k.daf, "bool");
    ck.check(`${tag} the stored funder is in scope under at least one kind, by the verifier's own reading`, k.charity || k.daf, "a funder with neither kind should not be stored");
    ck.eq(`${tag} funder.kind_threshold_org_grants_amt`, o.kind_threshold_org_grants_amt, ctx.thresholdAmt, "int");
    ck.check(`${tag} funder.kind_rule states the rule (Part IX line 1, Schedule D) and that an unstated figure is not zero`, typeof o.kind_rule === "string" && /Part IX, line 1/.test(String(o.kind_rule)) && /Schedule D/.test(String(o.kind_rule)) && /never zero/.test(String(o.kind_rule)));
    const canon = (x: unknown) => (Array.isArray(x) ? x.map((e) => JSON.stringify(sortKeys(e))).sort() : x);
    ck.eq(`${tag} funder.kind_basis (every return read for the funder, with the two figures the rule used)`, canon(o.kind_basis), canon(k.basis), "json");
    ck.check(`${tag} funder row provenance`, hasProvenance(o));
  }

  // ---- coverage ----
  const indexYears = ctx.indexYears?.(ein) ?? null;
  const cov = stored.coverage;
  checkColumnsAll(ck, "coverage", `[${ein}]`, cov);
  for (const year of ctx.years) {
    const row = cov.find((c) => Number(c.period_year) === year);
    const standingInYear = standing.filter((f) => String(f.tax_period_end).startsWith(String(year)));
    const unreadInYear = unread.filter((f) => String(f.index_tax_period).startsWith(String(year)));
    if (!row) {
      // a year this EIN's run did not decide (another state's run holds it) has no row: acceptable only when something else holds that year
      ck.check(`coverage for ${year}: no row is acceptable only where the year is decided by another state's run`, standingInYear.length === 0 && unreadInYear.length === 0, "a stored filing exists for the year but there is no coverage row");
      continue;
    }
    if (standingInYear.length) {
      ck.eq(`coverage ${year} status`, row.status, "loaded");
      ck.check(`coverage ${year} names a standing filing of that year`, standingInYear.some((f) => f.object_id === row.filing_object_id), String(row.filing_object_id));
    } else if (unreadInYear.length) {
      ck.eq(`coverage ${year} status`, row.status, "unread");
    } else {
      ck.eq(`coverage ${year} status`, row.status, "no_filing_in_index");
      ck.check(`coverage ${year} names no filing`, row.filing_object_id === null);
      if (indexYears) ck.check(`coverage ${year} claims the IRS index lists no Form 990 for this EIN in that year`, !indexYears.has(year), "the index does list one");
    }
    ck.check(`coverage ${year} note is not empty and does not say nothing was given`, typeof row.note === "string" && String(row.note).length > 10);
  }
  ck.check("no coverage row for a year outside the run's years", cov.every((c) => ctx.years.includes(Number(c.period_year))));
  return { filingsChecked };
}

function checkColumnsAll(ck: Checker, table: string, tag: string, rows: Row[]) {
  for (const r of rows) checkColumns(ck, table, tag, r);
}
function checkFiling(ck: Checker, tag: string, f: Row, r: ReadReturn, bytes: Uint8Array, superseded = false) {
  checkColumns(ck, "filings", tag, f);
  ck.eq(`${tag} xml_sha256 (the bytes compared are the bytes loaded)`, f.xml_sha256, createHash("sha256").update(bytes).digest("hex"));
  ck.eq(`${tag} xml_bytes`, f.xml_bytes, bytes.length, "int");
  ck.eq(`${tag} ein`, f.ein, txt(r.header, "Filer/EIN"));
  ck.eq(`${tag} return_type`, f.return_type, txt(r.header, "ReturnTypeCd"));
  ck.eq(`${tag} tax_period_end`, f.tax_period_end, r.periodEnd);
  ck.eq(`${tag} tax_period_begin`, f.tax_period_begin, txt(r.header, "TaxPeriodBeginDt"));
  ck.eq(`${tag} tax_year`, f.tax_year, txt(r.header, "TaxYr"));
  ck.eq(`${tag} return_version`, f.return_version, r.root.attrs["returnVersion"] ?? null);
  ck.eq(`${tag} return_ts`, f.return_ts, r.returnTs, "ts");
  ck.eq(`${tag} index_tax_period is the period end as yyyymm`, f.index_tax_period, r.periodEnd.slice(0, 4) + r.periodEnd.slice(5, 7));
  ck.check(`${tag} the return is a clean Form 990 by the verifier's reading (the loader would have recorded it as unread otherwise): ${r.rejectReasons.join("; ")}`, r.rejectReasons.length === 0);
  ck.check(`${tag} document location recorded (IRS archive URL and the member name)`, PROVENANCE_URL.test(String(f.document_archive_url)) && String(f.document_member).endsWith(`${String(f.object_id)}_public.xml`), `${String(f.document_archive_url)} | ${String(f.document_member)}`);
  ck.check(`${tag} object id is eighteen digits and the index file is named`, /^\d{18}$/.test(String(f.object_id)) && /^index_\d{4}\.csv$/.test(String(f.index_file)));
  ck.check(`${tag} loaded_at and loader_version recorded`, hasProvenance(f));
  if (!superseded) ck.check(`${tag} status_note is null for a standing filing`, f.status_note === null);
  else ck.check(`${tag} a superseded filing says why`, typeof f.status_note === "string" && String(f.status_note).length > 10);
}

function checkFigures(ck: Checker, tag: string, f: Row, r: ReadReturn, fig: Row | undefined) {
  ck.check(`${tag} a figures row exists`, !!fig);
  if (!fig) return;
  checkColumns(ck, "figures", tag, fig);
  ck.eq(`${tag} figures.ein`, fig.ein, f.ein);
  ck.eq(`${tag} figures.tax_period_end`, fig.tax_period_end, r.periodEnd);
  ck.eq(`${tag} figures.filing_object_id`, fig.filing_object_id, f.object_id);
  ck.eq(`${tag} figures.form_type`, fig.form_type, "990");
  const places = (fig.form_places ?? {}) as Record<string, unknown>;
  for (const [col, el, place] of FIGURE_PATHS) {
    ck.eq(`${tag} ${col}`, fig[col], amount(r.main, el).v, "int");
    ck.check(`${tag} form_places.${col} names ${place}`, typeof places[col] === "string" && String(places[col]).includes(place), String(places[col]));
  }
  for (const [col, el, place] of BOX_PATHS) {
    const raw = txt(r.main, el);
    ck.eq(`${tag} ${col}`, fig[col], yesNo(raw), "bool");
    ck.eq(`${tag} ${col}_as_written (the box exactly as the return wrote it)`, fig[`${col}_as_written`], raw);
    ck.check(`${tag} form_places.${col} names ${place}`, typeof places[col] === "string" && String(places[col]).includes(place), String(places[col]));
  }
  ck.eq(`${tag} has_schedule_i`, fig.has_schedule_i, !!r.si, "bool");
  ck.eq(`${tag} has_schedule_d`, fig.has_schedule_d, !!r.sd, "bool");
  ck.eq(`${tag} schedule_i_grant_records_maintained_ind`, fig.schedule_i_grant_records_maintained_ind, r.si ? yesNo(txt(r.si, "GrantRecordsMaintainedInd")) : null, "bool");
  ck.eq(`${tag} schedule_i_total_501c3_org_cnt`, fig.schedule_i_total_501c3_org_cnt, r.si ? amount(r.si, "Total501c3OrgCnt").v : null, "int");
  ck.eq(`${tag} schedule_i_total_other_org_cnt`, fig.schedule_i_total_other_org_cnt, r.si ? amount(r.si, "TotalOtherOrgCnt").v : null, "int");
  // derived here, from the return's own recipient rows
  const rows = r.si ? findAll(r.si, "RecipientTable") : [];
  const cash = rows.map((x) => amount(x.node, "CashGrantAmt").v).filter((v): v is number => v !== null);
  ck.eq(`${tag} schedule_i_rows_listed_count`, fig.schedule_i_rows_listed_count, rows.length, "int");
  ck.eq(`${tag} schedule_i_cash_grants_listed_sum_amt (null when no row states a cash grant)`, fig.schedule_i_cash_grants_listed_sum_amt, cash.length ? cash.reduce((a, b) => a + b, 0) : null, "int");
  ck.check(`${tag} schedule_i_listed_derivation names the set it ranged over`, typeof fig.schedule_i_listed_derivation === "string" && (r.si ? new RegExp(`${rows.length} recipient row`).test(String(fig.schedule_i_listed_derivation)) : /no Schedule I/.test(String(fig.schedule_i_listed_derivation))), String(fig.schedule_i_listed_derivation));
  ck.check(`${tag} figures provenance`, hasProvenance(fig));
}

function checkDaf(ck: Checker, tag: string, f: Row, r: ReadReturn, daf: Row[]) {
  ck.eq(`${tag} number of donor advised fund figure rows (one when the return has a Schedule D, none otherwise)`, daf.length, r.sd ? 1 : 0, "int");
  const d = daf[0];
  if (!d || !r.sd) return;
  checkColumns(ck, "daf", tag, d);
  ck.eq(`${tag} daf.ein`, d.ein, f.ein);
  ck.eq(`${tag} daf.tax_period_end`, d.tax_period_end, r.periodEnd);
  ck.eq(`${tag} daf.form_type`, d.form_type, "990");
  const places = (d.form_places ?? {}) as Record<string, unknown>;
  for (const [col, el, place] of DAF_PATHS) {
    ck.eq(`${tag} ${col}`, d[col], amount(r.sd, el).v, "int");
    ck.check(`${tag} form_places.${col} names Schedule D and ${place}`, typeof places[col] === "string" && String(places[col]).includes("Schedule D") && String(places[col]).includes(place), String(places[col]));
  }
  ck.check(`${tag} daf provenance`, hasProvenance(d));
}

function checkGrants(ck: Checker, tag: string, f: Row, r: ReadReturn, stored: Row[]) {
  const rows = r.si ? findAll(r.si, "RecipientTable") : [];
  ck.eq(`${tag} number of stored grant rows (the recipient rows on Schedule I)`, stored.length, rows.length, "int");
  ck.check(`${tag} grant ordinals are 1 to ${rows.length} with none repeated`, new Set(stored.map((g) => Number(g.ordinal))).size === stored.length && stored.every((g) => Number(g.ordinal) >= 1 && Number(g.ordinal) <= Math.max(rows.length, 1)));
  rows.forEach(({ node: n }, i) => {
    const g = stored.find((x) => Number(x.ordinal) === i + 1);
    ck.check(`${tag} grant ${i + 1} row exists`, !!g);
    if (!g) return;
    const t = `${tag} grant ${i + 1}`;
    checkColumns(ck, "grants", t, g);
    ck.eq(`${t} ein`, g.ein, f.ein);
    ck.eq(`${t} tax_period_end`, g.tax_period_end, r.periodEnd);
    ck.eq(`${t} form_type`, g.form_type, "990");
    ck.check(`${t} source_location names Schedule I`, /Schedule I/.test(String(g.source_location)), String(g.source_location));
    for (const [col, el] of ROW_TEXT_COLUMNS) ck.eq(`${t} ${col}`, g[col], txt(n, el));
    for (const [col, el] of ROW_AMOUNT_COLUMNS) ck.eq(`${t} ${col}`, g[col], amount(n, el).v, "int");
    const us = at(n, "USAddress");
    const fg = at(n, "ForeignAddress");
    const a = us || fg ? addressUnder(n) : NO_ADDR;
    ck.eq(`${t} recipient_address_line1`, g.recipient_address_line1, a.line1);
    ck.eq(`${t} recipient_address_line2`, g.recipient_address_line2, a.line2);
    ck.eq(`${t} recipient_city`, g.recipient_city, a.city);
    ck.eq(`${t} recipient_state`, g.recipient_state, a.state);
    ck.eq(`${t} recipient_zip`, g.recipient_zip, a.zip);
    ck.eq(`${t} recipient_country`, g.recipient_country, a.country);
    const unmapped: Record<string, string> = {};
    for (const [p, v] of leafPaths(n)) if (!MAPPED_ROW_LEAVES.has(p)) unmapped[p] = v;
    ck.eq(`${t} unmapped_fields (every leaf of the row that no column reads, kept not dropped)`, g.unmapped_fields ?? {}, unmapped, "json");
    ck.check(`${t} provenance`, hasProvenance(g));
  });
}

/**
 * The names of people on a return that must never be a stored string: officers, the signer, the preparer.
 * A PersonNm directly under ContractorName (Part VII's highest-paid independent contractors) is skipped:
 * the form puts a business name in that element as often as a person's (found on the first California
 * charity check: a hospital system's contractor "DONOR NETWORK WEST" was also, correctly, a Schedule I
 * recipient organization). The loader stores no contractor, and the officers, signer and preparer are
 * still checked.
 */
export function peopleOnReturn(root: VNode): Set<string> {
  const people = new Set<string>();
  const businessNames = new Set<string>();
  const walk = (n: VNode, parent = "") => {
    if (/^(PersonNm|OfficerNm|PreparerPersonNm|SigningOfficerNm)$/.test(n.name) && n.text.length >= 4 && parent !== "ContractorName") people.add(n.text.toLowerCase());
    if (/^BusinessNameLine[12]Txt$/.test(n.name) && n.text) businessNames.add(n.text.toLowerCase());
    n.kids.forEach((k) => walk(k, n.name));
  };
  walk(root);
  // A string the return also gives as a business name is an organization's name, not a person's, however a
  // contact box on the return tags it (found on an Arizona return whose "books in care of" PersonNm holds the
  // name of a Schedule I recipient, an organization).
  for (const b of businessNames) people.delete(b);
  return people;
}

/**
 * Ruling 0047 clause 3 and the stage-one limits, by structure: no grants to individuals read, no donor
 * or person related to a recipient. Looks at the return's element names and at the stored values.
 */
function checkRuling0047(ck: Checker, tag: string, id: string, r: ReadReturn, stored: StoredFunder) {
  // every RecipientTable must sit directly under the Schedule I root: one nested under a group of grants to individuals would be read as an organization's row
  if (r.si) {
    const stray = findAll(r.si, "RecipientTable").filter((x) => x.path !== "RecipientTable");
    ck.check(`${tag} every recipient row is a direct part of Schedule I (none nested under another group, e.g. grants to individuals)`, stray.length === 0, stray.slice(0, 3).map((x) => x.path).join(", "));
  }
  const mine = [...stored.grants, ...stored.figures, ...stored.daf].filter((x) => String(x.filing_object_id) === id);
  const keys = new Set<string>();
  for (const row of mine) {
    for (const k of Object.keys(row)) keys.add(k);
    for (const k of Object.keys((row.unmapped_fields as Row | undefined) ?? {})) keys.add(`unmapped:${k}`);
  }
  const bad = [...keys].filter((k) => /individual|donor_name|contributor|advisor|grantee_person|person/i.test(k));
  ck.check(`${tag} no stored column or unmapped element names a person, an individual recipient, a contributor or a donor advisor`, bad.length === 0, bad.join(", "));
  // no person's name from the return (officers, the signer, the preparer) is a stored string
  const people = peopleOnReturn(r.root);
  if (people.size) {
    const strings: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v === "string") strings.push(v.toLowerCase());
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v as Row).forEach(collect);
    };
    mine.forEach(collect);
    const hit = strings.find((s) => people.has(s));
    ck.check(`${tag} no stored string equals the name of a person on the return (people are not stored in this stage)`, !hit, hit ?? "");
  }
}

// ---------------------------------------------------------------------------
// the run-level checks
// ---------------------------------------------------------------------------
/** Ruling 0047 clause 6: the run finished and its outcome counts add up to the rows it considered. */
export function outcomeCountProblems(run: { status?: unknown; counts?: unknown } | null): string[] {
  if (!run) return ["no completed charity run is recorded for this state"];
  const c = (run.counts ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (run.status !== "completed") out.push(`the run's status is ${String(run.status)}, not completed`);
  const n = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : NaN);
  const parts = ["out_of_scope_state", "status_unread", "status_not_in_scope", "status_loaded", "status_superseded"];
  const sum = parts.reduce((a, k) => a + n(k), 0);
  if (!Number.isFinite(sum) || !Number.isFinite(n("index_rows_considered"))) out.push("the run record lacks the outcome counts");
  else if (sum !== n("index_rows_considered")) out.push(`the outcomes (loaded + superseded + unread + not in scope + out of state = ${sum}) do not add up to the ${n("index_rows_considered")} index rows considered`);
  if (c.outcomes_sum_check !== true) out.push("the run itself did not record outcomes_sum_check as true");
  return out;
}

// The charity tables hold every state loaded so far, so the stored filing totals must equal the sum, over every
// state, of that state's latest completed run's own outcome counts (a state re-run later carries its full end
// state). Item 116: the first national state (AE, after California) exposed a check that assumed one state.
export function storedTotalsProblems(
  stored: Record<string, number>,
  runs: Array<{ status?: unknown; parameters?: unknown; counts?: unknown }>,
): string[] {
  const latest = new Map<string, Record<string, unknown>>();
  for (const r of runs) { // runs arrive newest first
    const st = (r.parameters as { state?: string } | null)?.state;
    if (st && r.status === "completed" && !latest.has(st)) latest.set(st, (r.counts ?? {}) as Record<string, unknown>);
  }
  const out: string[] = [];
  for (const [kind, key] of [["loaded", "status_loaded"], ["superseded", "status_superseded"], ["unread", "status_unread"]] as const) {
    const want = [...latest.values()].reduce((a, c) => a + (Number(c[key]) || 0), 0);
    if ((stored[kind] ?? 0) !== want) out.push(`the database holds ${stored[kind] ?? 0} ${kind} filing(s); the runs say ${want} across ${latest.size} state(s)' latest runs`);
  }
  return out;
}
