// Item 110 (ruling 0045): compare EVERY stored value for one funder with the
// IRS filing itself. Permanent; run it again whenever the schema, the parser or
// the loader changes, and for any other funder by changing --ein.
//
// WHY THIS IS NOT THE LOADER MARKING ITS OWN HOMEWORK. It deliberately shares no
// parsing code with the loader: its own XML tokenizer (a regular-expression
// scanner, not lib/funder-reference/xml.ts), its own table of which element feeds
// which column (typed out again here, not imported), and its own arithmetic for
// every derived figure. A mistake common to the loader's parser and its column
// mapping therefore shows up as a mismatch here instead of cancelling out.
//
// WHAT IT COMPARES, per filing found in the database for the EIN:
//   * the bytes: the SHA-256 and length of the XML (fetched again from the
//     document location stored in the database when no local copy is given)
//     equal the stored xml_sha256 / xml_bytes -- so what is compared is what was
//     loaded;
//   * every column of funder_reference_filings, _foundations, _figures,
//     _application_terms, every row of _people and _grants, every key and value
//     of the financial_statement_values and unmapped_fields documents;
//   * every derived figure, recomputed here from the filing's own grant rows;
//   * row counts (no missing rows, no extra rows), provenance on every row, and
//     that the signing officer's SSN appears nowhere in what was stored;
//   * what the filing carries that is NOT stored, listed by element name (a gap
//     is reported, not hidden).
// Optionally (--propublica <saved API response>) it compares the figures
// ProPublica's API reports with the filing and prints each agreement and
// disagreement.
//
// Usage: npx tsx scripts/verify-funder-reference-example.ts \
//          --db pglite:<dir> --ein 582218044 [--xml-dir <dir>] [--archives-dir <dir>] [--propublica <json>]
//        (--xml-dir holds <object_id>_public.xml; --archives-dir holds the IRS zips
//         by their IRS names; without either, each return is fetched from the IRS
//         archive location the database recorded)

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// the verifier's own XML reader (no shared code with the loader)
// ---------------------------------------------------------------------------
interface VNode {
  name: string;
  attrs: Record<string, string>;
  kids: VNode[];
  text: string;
}
function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
}
function tokenize(xml: string): VNode {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root: VNode = { name: "#root", attrs: {}, kids: [], text: "" };
  const stack: VNode[] = [root];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml.replace(/^﻿/, "")))) {
    if (m[1] !== undefined) {
      const top = stack.pop()!;
      if (top.name !== m[1].replace(/^.*:/, "")) throw new Error(`verifier XML reader: </${m[1]}> closes <${top.name}>`);
      top.text = top.text.trim();
    } else if (m[2] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, "")] = decode(a[2] ?? a[3]);
      const n: VNode = { name: m[2].replace(/^.*:/, ""), attrs, kids: [], text: "" };
      stack[stack.length - 1].kids.push(n);
      if (m[4] !== "/") stack.push(n);
    } else if (m[5] !== undefined) {
      stack[stack.length - 1].text += decode(m[5]);
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
const all = (n: VNode | null | undefined, path: string): VNode[] => {
  const parts = path.split("/");
  let cur: VNode[] = n ? [n] : [];
  for (const p of parts) cur = cur.flatMap((c) => c.kids.filter((k) => k.name === p));
  return cur;
};
const txt = (n: VNode | null | undefined, path: string): string | null => {
  const t = at(n, path);
  return t && t.text !== "" ? t.text : null;
};
function leafPaths(n: VNode, prefix: string, out: Array<[string, string]> = []): Array<[string, string]> {
  for (const k of n.kids) {
    const p = prefix ? `${prefix}/${k.name}` : k.name;
    if (k.kids.length === 0) out.push([p, k.text]);
    else leafPaths(k, p, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// reading the database
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
// Each table's primary key, in order: the stable order a paged read of a live database needs.
const PRIMARY_KEY_ORDER: Record<string, string[]> = {
  funder_reference_filings: ["object_id"],
  funder_reference_foundations: ["ein"],
  funder_reference_figures: ["ein", "tax_period_end"],
  funder_reference_people: ["filing_object_id", "listed_in", "ordinal"],
  funder_reference_grants: ["filing_object_id", "kind", "ordinal"],
  funder_reference_application_terms: ["filing_object_id"],
  funder_reference_period_coverage: ["ein", "period_year"],
};
interface ReadDb {
  label: string;
  rows(table: string, ein: string): Promise<Row[]>;
  /** Raw SQL, available on a local database only; used to choose a varied sample. */
  query?(sql: string): Promise<Row[]>;
  /** Every funder's EIN, in order (paged). Available on both kinds of database. */
  listEins(): Promise<string[]>;
  close(): Promise<void>;
}
async function openDb(spec: string): Promise<ReadDb> {
  if (spec.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(resolve(spec.slice(7)));
    await db.waitReady;
    return {
      label: spec,
      // to_jsonb so bigint, date, numeric and timestamptz arrive as plain JSON values
      rows: async (table, ein) => (await db.query(`select to_jsonb(t) as r from ${table} t where ein = $1 order by 1`, [ein])).rows.map((x) => (x as { r: Row }).r),
      query: async (sql) => (await db.query(sql)).rows as Row[],
      listEins: async () => (await db.query(`select ein from funder_reference_foundations order by ein`)).rows.map((r) => String((r as { ein: string }).ein)),
      close: () => db.close(),
    };
  }
  if (spec === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    const { createClient } = await import("@supabase/supabase-js");
    const c = createClient(url, key, { auth: { persistSession: false } });
    return {
      label: "supabase",
      // A live Supabase project caps every response at its configured maximum (1000
      // rows by default) whatever .limit() says, so a funder with more than 1000
      // grants came back truncated and was reported as 7,895 false mismatches on
      // 2026-11-09. Page explicitly, in a stable order (the table's primary key), and
      // keep going until a page comes back short.
      rows: async (table, ein) => {
        const order = PRIMARY_KEY_ORDER[table];
        if (!order) throw new Error(`verifier: no stable order known for ${table}`);
        const out: Row[] = [];
        for (let from = 0; ; from += 1000) {
          let q = c.from(table).select("*").eq("ein", ein);
          for (const col of order) q = q.order(col, { ascending: true });
          const { data, error } = await q.range(from, from + 999);
          if (error) throw new Error(`${table}: ${error.message}`);
          out.push(...(data as Row[]));
          if (data.length < 1000) break;
        }
        return out;
      },
      listEins: async () => {
        const out: string[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await c.from("funder_reference_foundations").select("ein").order("ein").range(from, from + 999);
          if (error) throw new Error(`foundations: ${error.message}`);
          out.push(...(data as Array<{ ein: string }>).map((r) => r.ein));
          if (data.length < 1000) break;
        }
        return out;
      },
      close: async () => undefined,
    };
  }
  throw new Error(`unknown --db ${spec}`);
}

// ---------------------------------------------------------------------------
// comparison bookkeeping
// ---------------------------------------------------------------------------
let compared = 0;
let mismatches = 0;
const failures: string[] = [];
let currentEin = "";
// what the returns carry that is not stored, accumulated over every funder verified
const uncovered = new Map<string, number>();
let leafTotal = 0;
let leafStored = 0;
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
/** expected may be a string (from the filing), a number, boolean, or null. Numerics compare as numbers. */
function eq(label: string, actual: unknown, expected: unknown, kind: "text" | "int" | "num" | "ts" | "bool" | "json" = "text") {
  compared++;
  const a = norm(actual);
  const e = norm(expected);
  let same: boolean;
  if (a === null || e === null) same = a === e;
  else if (kind === "int" || kind === "num") same = Number(a) === Number(e);
  else if (kind === "ts") same = Date.parse(a) === Date.parse(e);
  else same = a === e;
  if (!same) {
    mismatches++;
    failures.push(`[${currentEin}] ${label}: stored ${a === null ? "NULL" : JSON.stringify(a)} but the filing gives ${e === null ? "nothing" : JSON.stringify(e)}`);
  }
}
function check(label: string, cond: boolean, detail = "") {
  compared++;
  if (!cond) {
    mismatches++;
    failures.push(`[${currentEin}] ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// the verifier's own column-to-element table (typed out again, deliberately)
// ---------------------------------------------------------------------------
const PF = "ReturnData/IRS990PF";
const FIGURES: Array<[string, string]> = [
  ["fmv_assets_eoy_amt", `${PF}/FMVAssetsEOYAmt`],
  ["total_assets_boy_amt", `${PF}/Form990PFBalanceSheetsGrp/TotalAssetsBOYAmt`],
  ["total_assets_eoy_book_amt", `${PF}/Form990PFBalanceSheetsGrp/TotalAssetsEOYAmt`],
  ["total_assets_eoy_fmv_amt", `${PF}/Form990PFBalanceSheetsGrp/TotalAssetsEOYFMVAmt`],
  ["total_liabilities_eoy_amt", `${PF}/Form990PFBalanceSheetsGrp/TotalLiabilitiesEOYAmt`],
  ["net_assets_eoy_amt", `${PF}/Form990PFBalanceSheetsGrp/TotNetAstOrFundBalancesEOYAmt`],
  ["contributions_received_per_books_amt", `${PF}/AnalysisOfRevenueAndExpenses/ContriRcvdRevAndExpnssAmt`],
  ["total_revenue_per_books_amt", `${PF}/AnalysisOfRevenueAndExpenses/TotalRevAndExpnssAmt`],
  ["total_expenses_per_books_amt", `${PF}/AnalysisOfRevenueAndExpenses/TotalExpensesRevAndExpnssAmt`],
  ["contributions_paid_per_books_amt", `${PF}/AnalysisOfRevenueAndExpenses/ContriPaidRevAndExpnssAmt`],
  ["contributions_paid_disbursements_amt", `${PF}/AnalysisOfRevenueAndExpenses/ContriPaidDsbrsChrtblAmt`],
  ["total_expenses_charitable_disbursements_amt", `${PF}/AnalysisOfRevenueAndExpenses/TotalExpensesDsbrsChrtblAmt`],
  ["net_value_noncharitable_assets_amt", `${PF}/MinimumInvestmentReturnGrp/NetVlNoncharitableAssetsAmt`],
  ["minimum_investment_return_amt", `${PF}/MinimumInvestmentReturnGrp/MinimumInvestmentReturnAmt`],
  ["distributable_amount_amt", `${PF}/DistributableAmountGrp/DistributableAsAdjustedAmt`],
  ["qualifying_distributions_amt", `${PF}/PFQualifyingDistributionsGrp/QualifyingDistributionsAmt`],
  ["undistributed_income_current_year_amt", `${PF}/UndistributedIncomeGrp/UndistributedIncomeCYAmt`],
  ["grants_paid_stated_total_amt", `${PF}/SupplementaryInformationGrp/TotalGrantOrContriPdDurYrAmt`],
  ["grants_approved_future_stated_total_amt", `${PF}/SupplementaryInformationGrp/TotalGrantOrContriApprvFutAmt`],
];
const STATEMENT_GROUPS = ["AnalysisOfRevenueAndExpenses", "Form990PFBalanceSheetsGrp", "MinimumInvestmentReturnGrp", "DistributableAmountGrp", "PFQualifyingDistributionsGrp"];

// Hand-read from the 2022 return's XML (the 30 listed grants sum to 911,322; the
// per-books figure is 911,323): a transcription made by reading the filing, kept
// as a check on the tokenizer too.
const GOLDEN_2022: Record<string, number> = {
  fmv_assets_eoy_amt: 17049161,
  total_revenue_per_books_amt: 539140,
  total_expenses_per_books_amt: 2054296,
  contributions_paid_per_books_amt: 911323,
  total_expenses_charitable_disbursements_amt: 1104388,
  qualifying_distributions_amt: 1104388,
  minimum_investment_return_amt: 841321,
  distributable_amount_amt: 841321,
  grants_paid_stated_total_amt: 911322,
};

function addr(n: VNode | null, usName: string, foreignName: string) {
  const us = at(n, usName);
  const fg = at(n, foreignName);
  const a = us ?? fg;
  return {
    line1: txt(a, "AddressLine1Txt"),
    line2: txt(a, "AddressLine2Txt"),
    city: txt(a, "CityNm"),
    state: us ? txt(a, "StateAbbreviationCd") : txt(a, "ProvinceOrStateNm"),
    zip: us ? txt(a, "ZIPCd") : txt(a, "ForeignPostalCd"),
    country: us ? null : txt(a, "CountryCd"),
  };
}

async function fetchMember(archiveUrl: string, member: string, archivesDir?: string): Promise<Uint8Array> {
  const { openZip, httpSource, fileSource } = await import("../lib/funder-reference/zip");
  const { existsSync } = await import("node:fs");
  const local = archivesDir ? join(archivesDir, archiveUrl.slice(archiveUrl.lastIndexOf("/") + 1)) : null;
  // The archive named by the recorded location: from disk when a copy is given, otherwise from the IRS.
  const zip = await openZip(local && existsSync(local) ? await fileSource(local) : await httpSource(archiveUrl, "FundraisingAI-funder-reference-verifier/1.0"));
  try {
    const entry = zip.find(member);
    if (!entry) throw new Error(`${member} is not in ${archiveUrl}`);
    return await zip.read(entry);
  } finally {
    await zip.close();
  }
}

// ---------------------------------------------------------------------------
async function verifyOne(db: ReadDb, ein: string, xmlDir: string | undefined, ppLines: string[]) {
  currentEin = ein;
  const filings = (await db.rows("funder_reference_filings", ein)).sort((x, y) => String(x.tax_period_end).localeCompare(String(y.tax_period_end)));
  if (!SAMPLE_MODE) console.log(`database: ${db.label}; EIN ${ein}; ${filings.length} filing row(s)`);
  check("the database holds at least one filing for this EIN", filings.length > 0);

  const foundations = await db.rows("funder_reference_foundations", ein);
  const figures = await db.rows("funder_reference_figures", ein);
  const people = await db.rows("funder_reference_people", ein);
  const grants = await db.rows("funder_reference_grants", ein);
  const apps = await db.rows("funder_reference_application_terms", ein);
  const coverage = await db.rows("funder_reference_period_coverage", ein);

  const standing = filings.filter((f) => f.status === "loaded");
  const superseded = filings.filter((f) => f.status === "superseded");
  check("no filing for this EIN is skipped below the threshold (a funder in scope has none)", filings.every((f) => f.status !== "skipped_below_threshold"), filings.map((f) => `${f.object_id}:${f.status}`).join(", "));
  for (const u of filings.filter((f) => f.status === "unread")) {
    check(`unread filing ${u.object_id} records a reason and holds no figures, people, grants or application terms`, typeof u.status_note === "string" && String(u.status_note).length > 10 && ![...figures, ...people, ...grants, ...apps].some((r) => r.filing_object_id === u.object_id));
  }
  for (const s of superseded) {
    const succ = standing.find((x) => x.object_id === s.superseded_by_object_id);
    check(`superseded filing ${s.object_id} names a standing successor for the same EIN and tax period end`, !!succ && succ.tax_period_end === s.tax_period_end && succ.ein === s.ein);
    check(`superseded filing ${s.object_id} holds no figures, people, grants or application terms (nothing double-counted)`, ![...figures, ...people, ...grants, ...apps].some((r) => r.filing_object_id === s.object_id));
  }
  check("exactly one standing filing per tax period end", new Set(standing.map((f) => f.tax_period_end)).size === standing.length);
  check("one figures row per standing filing", figures.length === standing.length);
  check("one application-terms row per standing filing", apps.length === standing.length);
  check("exactly one foundation row for the EIN", foundations.length === 1);

  let expectedPeople = 0;
  let expectedGrants = 0;
  const everyText: string[] = [];
  let latest: { periodEnd: string; root: VNode } | null = null;

  for (const f of standing) {
    const id = String(f.object_id);
    const tag = `[${id} ${String(f.tax_period_end)}]`;
    // ---- the bytes ----
    let bytes: Uint8Array;
    const local = xmlDir ? join(xmlDir, `${id}_public.xml`) : null;
    if (local && existsSync(local)) bytes = readFileSync(local);
    else bytes = await fetchMember(String(f.document_archive_url), String(f.document_member), arg("archives-dir"));
    eq(`${tag} xml_sha256 (the bytes compared are the bytes loaded)`, f.xml_sha256, createHash("sha256").update(bytes).digest("hex"));
    eq(`${tag} xml_bytes`, f.xml_bytes, bytes.length, "int");
    const root = tokenize(Buffer.from(bytes).toString("utf8"));
    const header = at(root, "ReturnHeader")!;
    const pf = at(root, PF)!;
    const periodEnd = txt(header, "TaxPeriodEndDt")!;
    if (!latest || periodEnd > latest.periodEnd) latest = { periodEnd, root };

    // ---- filing row ----
    eq(`${tag} object_id equals the file name`, id, id);
    eq(`${tag} ein`, f.ein, txt(header, "Filer/EIN"));
    eq(`${tag} return_type`, f.return_type, txt(header, "ReturnTypeCd"));
    eq(`${tag} tax_period_end`, f.tax_period_end, periodEnd);
    eq(`${tag} tax_period_begin`, f.tax_period_begin, txt(header, "TaxPeriodBeginDt"));
    eq(`${tag} tax_year`, f.tax_year, txt(header, "TaxYr"));
    eq(`${tag} return_version`, f.return_version, root.attrs["returnVersion"] ?? null);
    eq(`${tag} return_ts`, f.return_ts, txt(header, "ReturnTs"), "ts");
    eq(`${tag} index_tax_period is the period end as yyyymm`, f.index_tax_period, periodEnd.slice(0, 4) + periodEnd.slice(5, 7));
    check(`${tag} document location recorded (archive URL and member name)`, /^https:\/\/apps\.irs\.gov\/pub\/epostcard\/990\/xml\/\d{4}\/[\w]+\.zip$/.test(String(f.document_archive_url)) && String(f.document_member).endsWith(`${id}_public.xml`), `${f.document_archive_url} | ${f.document_member}`);
    check(`${tag} loaded_at and loader_version recorded`, !!f.loaded_at && !!f.loader_version);
    check(`${tag} status_note is null for a standing filing`, f.status_note === null);

    // ---- figures ----
    const fig = figures.find((x) => x.filing_object_id === id);
    check(`${tag} a figures row exists`, !!fig);
    if (fig) {
      eq(`${tag} figures.ein`, fig.ein, f.ein);
      eq(`${tag} figures.tax_period_end`, fig.tax_period_end, periodEnd);
      for (const [col, path] of FIGURES) eq(`${tag} ${col}`, fig[col], txt(root, path), "int");
      // financial_statement_values: same keys, same values, nothing extra, nothing missing
      const expectedFsv: Record<string, string> = {};
      for (const g of STATEMENT_GROUPS) for (const [p, v] of leafPaths(at(pf, g) ?? { name: g, attrs: {}, kids: [], text: "" }, g)) expectedFsv[p] = v;
      const storedFsv = (fig.financial_statement_values ?? {}) as Record<string, string>;
      eq(`${tag} financial_statement_values (whole document, ${Object.keys(expectedFsv).length} elements)`, storedFsv, expectedFsv, "json");
      // derived figures, recomputed here
      const gl = all(pf, "SupplementaryInformationGrp/GrantOrContributionPdDurYrGrp");
      const amts = gl.map((g) => txt(g, "Amt")).filter((a): a is string => a !== null).map(Number);
      const sorted = [...amts].sort((a, b) => a - b);
      const sum = amts.reduce((a, b) => a + b, 0);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length === 0 ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const st = txt(header, "Filer/USAddress/StateAbbreviationCd");
      const inState = gl.filter((g) => at(g, "RecipientUSAddress") && txt(g, "RecipientUSAddress/StateAbbreviationCd") === st && txt(g, "Amt") !== null);
      eq(`${tag} grants_listed_count`, fig.grants_listed_count, amts.length || null, "int");
      eq(`${tag} grants_listed_sum_amt`, fig.grants_listed_sum_amt, amts.length ? sum : null, "int");
      eq(`${tag} grants_listed_avg_amt`, fig.grants_listed_avg_amt, amts.length ? Math.round((sum / amts.length) * 100) / 100 : null, "num");
      eq(`${tag} grants_listed_median_amt`, fig.grants_listed_median_amt, median, "num");
      eq(`${tag} grants_listed_min_amt`, fig.grants_listed_min_amt, amts.length ? sorted[0] : null, "int");
      eq(`${tag} grants_listed_max_amt`, fig.grants_listed_max_amt, amts.length ? sorted[sorted.length - 1] : null, "int");
      eq(`${tag} grants_listed_in_filer_state_count`, fig.grants_listed_in_filer_state_count, amts.length && st ? inState.length : null, "int");
      eq(`${tag} grants_listed_in_filer_state_sum_amt`, fig.grants_listed_in_filer_state_sum_amt, amts.length && st ? inState.reduce((a, g) => a + Number(txt(g, "Amt")), 0) : null, "int");
      const stated = txt(pf, "SupplementaryInformationGrp/TotalGrantOrContriPdDurYrAmt");
      eq(`${tag} grants_listed_minus_stated_amt`, fig.grants_listed_minus_stated_amt, amts.length && stated !== null ? sum - Number(stated) : null, "int");
      check(`${tag} grants_listed_derivation names the set`, typeof fig.grants_listed_derivation === "string" && /Part XV/.test(String(fig.grants_listed_derivation)) && /funder_reference_grants/.test(String(fig.grants_listed_derivation)));
      const q = txt(pf, "PFQualifyingDistributionsGrp/QualifyingDistributionsAmt");
      const m = txt(pf, "MinimumInvestmentReturnGrp/MinimumInvestmentReturnAmt");
      eq(`${tag} qualifying_to_minimum_investment_return_ratio`, fig.qualifying_to_minimum_investment_return_ratio, q !== null && m !== null && Number(m) !== 0 ? Math.round((Number(q) / Number(m)) * 10000) / 10000 : null, "num");
      check(`${tag} payout_ratio_derivation names the figures used`, fig.qualifying_to_minimum_investment_return_ratio === null || /qualifying_distributions_amt.*minimum_investment_return_amt/.test(String(fig.payout_ratio_derivation)));
      check(`${tag} provenance on figures row`, !!fig.loaded_at && !!fig.loader_version && fig.filing_object_id === id);
      if (ein === "582218044" && periodEnd === "2022-12-31") for (const [col, v] of Object.entries(GOLDEN_2022)) eq(`${tag} golden (hand-read) ${col}`, fig[col], v, "int");
    }

    // ---- application terms ----
    const app = apps.find((x) => x.filing_object_id === id);
    check(`${tag} an application-terms row exists`, !!app);
    if (app) {
      const raw = txt(pf, "SupplementaryInformationGrp/OnlyContriToPreselectedInd");
      eq(`${tag} only_preselected_charities_raw`, app.only_preselected_charities_raw, raw);
      eq(`${tag} only_preselected_charities_box_checked`, app.only_preselected_charities_box_checked, raw !== null && /^(x|1|true)$/i.test(raw) ? true : null, "bool");
      const groups = all(pf, "SupplementaryInformationGrp/ApplicationSubmissionInfoGrp");
      eq(`${tag} application_groups`, app.application_groups, groups.map((g, i) => ({ ordinal: i + 1, fields: Object.fromEntries(leafPaths(g, "")) })), "json");
    }

    // ---- people ----
    const mine = people.filter((x) => x.filing_object_id === id);
    const officers = all(pf, "OfficerDirTrstKeyEmplInfoGrp/OfficerDirTrstKeyEmplGrp");
    const signer = at(header, "BusinessOfficerGrp");
    const signerCount = signer && (txt(signer, "PersonNm") || txt(signer, "PersonTitleTxt")) ? 1 : 0;
    eq(`${tag} number of people rows (officers listed + signer)`, mine.length, officers.length + signerCount, "int");
    expectedPeople += officers.length + signerCount;
    officers.forEach((o, i) => {
      const row = mine.find((x) => x.listed_in === "part_viii_officers_directors_trustees" && Number(x.ordinal) === i + 1);
      check(`${tag} officer ${i + 1} row exists`, !!row);
      if (!row) return;
      const a = addr(o, "USAddress", "ForeignAddress");
      eq(`${tag} officer ${i + 1} name_as_named`, row.name_as_named, txt(o, "PersonNm") ?? txt(o, "BusinessName/BusinessNameLine1Txt"));
      eq(`${tag} officer ${i + 1} title_as_stated`, row.title_as_stated, txt(o, "TitleTxt"));
      eq(`${tag} officer ${i + 1} hours_per_week_as_stated`, row.hours_per_week_as_stated, txt(o, "AverageHrsPerWkDevotedToPosRt"));
      eq(`${tag} officer ${i + 1} compensation_amt`, row.compensation_amt, txt(o, "CompensationAmt"), "int");
      eq(`${tag} officer ${i + 1} employee_benefit_amt`, row.employee_benefit_amt, txt(o, "EmployeeBenefitProgramAmt"), "int");
      eq(`${tag} officer ${i + 1} expense_account_amt`, row.expense_account_amt, txt(o, "ExpenseAccountOtherAllwncAmt"), "int");
      for (const [k, col] of [["line1", "address_line1"], ["line2", "address_line2"], ["city", "city"], ["state", "state"], ["zip", "zip"], ["country", "country"]] as const)
        eq(`${tag} officer ${i + 1} ${col}`, row[col], a[k]);
      check(`${tag} officer ${i + 1} provenance`, row.ein === f.ein && String(row.tax_period_end) === periodEnd && !!row.loaded_at && !!row.loader_version);
    });
    if (signerCount) {
      const row = mine.find((x) => x.listed_in === "signer_on_return_header");
      check(`${tag} signer row exists`, !!row);
      if (row) {
        eq(`${tag} signer name_as_named`, row.name_as_named, txt(signer, "PersonNm"));
        eq(`${tag} signer title_as_stated`, row.title_as_stated, txt(signer, "PersonTitleTxt"));
        for (const col of ["hours_per_week_as_stated", "compensation_amt", "employee_benefit_amt", "expense_account_amt", "address_line1", "city", "state", "zip"]) eq(`${tag} signer ${col} is absent (the header states none)`, row[col], null);
      }
    }
    const ssn = txt(header, "SigningOfficerGrp/SSN");

    // ---- grants ----
    const mineG = grants.filter((x) => x.filing_object_id === id && x.kind === "paid_during_year");
    const gl = all(pf, "SupplementaryInformationGrp/GrantOrContributionPdDurYrGrp");
    eq(`${tag} number of paid-during-year grant rows`, mineG.length, gl.length, "int");
    eq(`${tag} number of approved-for-future grant rows`, grants.filter((x) => x.filing_object_id === id && x.kind === "approved_for_future_payment").length, all(pf, "SupplementaryInformationGrp/GrantOrContriApprvForFutGrp").length, "int");
    expectedGrants += gl.length + all(pf, "SupplementaryInformationGrp/GrantOrContriApprvForFutGrp").length;
    gl.forEach((g, i) => {
      const row = mineG.find((x) => Number(x.ordinal) === i + 1);
      check(`${tag} grant ${i + 1} row exists`, !!row);
      if (!row) return;
      const a = addr(g, "RecipientUSAddress", "RecipientForeignAddress");
      const t = `${tag} grant ${i + 1}`;
      eq(`${t} recipient_name_line1`, row.recipient_name_line1, txt(g, "RecipientBusinessName/BusinessNameLine1Txt"));
      eq(`${t} recipient_name_line2`, row.recipient_name_line2, txt(g, "RecipientBusinessName/BusinessNameLine2Txt"));
      eq(`${t} recipient_person_name`, row.recipient_person_name, txt(g, "RecipientPersonNm"));
      for (const [k, col] of [["line1", "recipient_address_line1"], ["line2", "recipient_address_line2"], ["city", "recipient_city"], ["state", "recipient_state"], ["zip", "recipient_zip"], ["country", "recipient_country"]] as const)
        eq(`${t} ${col}`, row[col], a[k]);
      eq(`${t} relationship_as_stated`, row.relationship_as_stated, txt(g, "RecipientRelationshipTxt"));
      eq(`${t} recipient_status_as_stated`, row.recipient_status_as_stated, txt(g, "RecipientFoundationStatusTxt"));
      eq(`${t} purpose_as_stated`, row.purpose_as_stated, txt(g, "GrantOrContributionPurposeTxt"));
      eq(`${t} amount_amt`, row.amount_amt, txt(g, "Amt"), "int");
      eq(`${t} listed_in_element`, row.listed_in_element, "SupplementaryInformationGrp");
      eq(`${t} unmapped_fields is empty (no element of the row was left unread)`, row.unmapped_fields, {}, "json");
      check(`${t} provenance`, row.ein === f.ein && String(row.tax_period_end) === periodEnd && !!row.loaded_at && !!row.loader_version);
    });

    // ---- coverage of the return: what is stored, what is not ----
    const stored = new Set<string>();
    for (const [, p] of FIGURES) stored.add(p);
    for (const g of STATEMENT_GROUPS) for (const [p] of leafPaths(at(pf, g) ?? { name: g, attrs: {}, kids: [], text: "" }, `${PF}/${g}`)) stored.add(p);
    const roots = [
      [`${PF}/SupplementaryInformationGrp/GrantOrContributionPdDurYrGrp`, "grant row"],
      [`${PF}/OfficerDirTrstKeyEmplInfoGrp/OfficerDirTrstKeyEmplGrp`, "officer row"],
    ] as const;
    const storedLeaf = (p: string) => {
      if (stored.has(p)) return true;
      for (const [r] of roots) if (p.startsWith(r + "/")) {
        const rel = p.slice(r.length + 1);
        // the child elements a row's columns read
        return /^(RecipientBusinessName\/BusinessNameLine[12]Txt|RecipientPersonNm|Recipient(US|Foreign)Address\/\w+|RecipientRelationshipTxt|RecipientFoundationStatusTxt|GrantOrContributionPurposeTxt|Amt|PersonNm|BusinessName\/BusinessNameLine1Txt|TitleTxt|AverageHrsPerWkDevotedToPosRt|CompensationAmt|EmployeeBenefitProgramAmt|ExpenseAccountOtherAllwncAmt|USAddress\/\w+|ForeignAddress\/\w+)$/.test(rel);
      }
      return /^ReturnData\/IRS990PF\/(SupplementaryInformationGrp\/(OnlyContriToPreselectedInd|ApplicationSubmissionInfoGrp\/.*)|StatementsRegardingActyGrp\/(WebsiteAddressTxt|PrivateOperatingFoundationInd|IndividualWithBooksNm|PersonsWithBooksName\/BusinessNameLine1Txt|PhoneNum|LocationOfBooksUSAddress\/.*))$/.test(p) ||
        /^ReturnHeader\/(TaxPeriodEndDt|TaxPeriodBeginDt|TaxYr|ReturnTs|ReturnTypeCd|Filer\/(EIN|PhoneNum|BusinessName\/BusinessNameLine[12]Txt|USAddress\/\w+|ForeignAddress\/\w+|InCareOfNm)|BusinessOfficerGrp\/(PersonNm|PersonTitleTxt))$/.test(p);
    };
    for (const [p] of [...leafPaths(header, "ReturnHeader"), ...leafPaths(at(root, "ReturnData")!, "ReturnData")]) {
      // skip the other attached documents (Schedule B, statements): not Part XV and not stored
      leafTotal++;
      if (storedLeaf(p)) leafStored++;
      else {
        const top = p.split("/").slice(0, p.startsWith("ReturnData/IRS990PF") ? 3 : 2).join("/");
        uncovered.set(top, (uncovered.get(top) ?? 0) + 1);
      }
    }

    // ---- stored text, for the SSN scan ----
    for (const t of [f, fig, app, ...mine, ...mineG].filter(Boolean)) everyText.push(JSON.stringify(t));
    // The IRS publishes the field masked; a value with no digits (a placeholder) is not an SSN,
    // and filers sometimes type the same placeholder into their own text.
    if (ssn && /\d{3}-?\d{2}-?\d{4}|\d{9}/.test(ssn)) check(`${tag} the signing officer's SSN field is not stored anywhere`, !everyText.join("\n").includes(ssn), `value ${ssn.replace(/\d/g, "#")} found`);
  }

  eq("total people rows for the EIN", people.length, expectedPeople, "int");
  eq("total grant rows for the EIN", grants.length, expectedGrants, "int");

  // ---- foundation row: the latest period's filer block ----
  if (latest && foundations[0]) {
    const f = foundations[0];
    const h = at(latest.root, "ReturnHeader")!;
    const pf = at(latest.root, PF)!;
    const a = addr(at(h, "Filer"), "USAddress", "ForeignAddress");
    const stmt = at(pf, "StatementsRegardingActyGrp");
    eq("foundation.ein", f.ein, txt(h, "Filer/EIN"));
    eq("foundation.source_tax_period_end is the latest period held", f.source_tax_period_end, latest.periodEnd);
    eq("foundation.legal_name_line1", f.legal_name_line1, txt(h, "Filer/BusinessName/BusinessNameLine1Txt"));
    eq("foundation.legal_name_line2", f.legal_name_line2, txt(h, "Filer/BusinessName/BusinessNameLine2Txt"));
    eq("foundation.care_of_name", f.care_of_name, txt(h, "Filer/InCareOfNm"));
    for (const [k, col] of [["line1", "address_line1"], ["line2", "address_line2"], ["city", "city"], ["state", "state"], ["zip", "zip"], ["country", "country"]] as const) eq(`foundation.${col}`, f[col], a[k]);
    eq("foundation.phone_as_stated", f.phone_as_stated, txt(h, "Filer/PhoneNum"));
    eq("foundation.fiscal_year_end_month", f.fiscal_year_end_month, Number(latest.periodEnd.slice(5, 7)), "int");
    const po = txt(stmt, "PrivateOperatingFoundationInd");
    eq("foundation.private_operating_foundation_ind", f.private_operating_foundation_ind, po === null ? null : po === "1" || po.toLowerCase() === "true", "bool");
    eq("foundation.website_as_stated (exactly the return's words; no URL derived)", f.website_as_stated, txt(stmt, "WebsiteAddressTxt"));
    eq("foundation.books_contact_name", f.books_contact_name, txt(stmt, "IndividualWithBooksNm") ?? txt(stmt, "PersonsWithBooksName/BusinessNameLine1Txt"));
    eq("foundation.books_contact_phone", f.books_contact_phone, txt(stmt, "PhoneNum"));
    check("foundation provenance", !!f.loaded_at && !!f.loader_version && !!f.source_object_id);
  }

  // ---- coverage rows ----
  for (const c of coverage) {
    const inYear = filings.filter((f) => String(f.index_tax_period).slice(0, 4) === String(c.period_year));
    if (c.status === "loaded") check(`coverage ${c.period_year} is 'loaded' and points at a standing filing`, standing.some((s) => s.object_id === c.filing_object_id));
    else if (c.status === "unread") check(`coverage ${c.period_year} is 'unread' and points at an unread filing`, filings.some((f) => f.object_id === c.filing_object_id && f.status === "unread") && !inYear.some((f) => f.status === "loaded"));
    else check(`coverage ${c.period_year} is 'no_filing_in_index': no filing row exists for that year and none is claimed`, c.filing_object_id === null && inYear.length === 0, `${inYear.length} filing row(s) for the year`);
  }
  check("coverage holds one row per period year in the run, none duplicated", new Set(coverage.map((c) => c.period_year)).size === coverage.length);

  // ---- ProPublica cross-check (optional) ----
  const pp = arg("propublica");
  if (pp) {
    const d = JSON.parse(readFileSync(pp, "utf8")) as { filings_with_data: Row[]; filings_without_data?: Row[] };
    for (const f of standing) {
      const fig = figures.find((x) => x.filing_object_id === f.object_id)!;
      const per = Number(String(f.tax_period_end).slice(0, 4) + String(f.tax_period_end).slice(5, 7));
      const w = d.filings_with_data.find((x) => Number(x.tax_prd) === per);
      if (!w) {
        const wo = (d.filings_without_data ?? []).find((x) => Number(x.tax_prd) === per);
        ppLines.push(`${f.tax_period_end}: ProPublica has ${wo ? "the filing listed WITHOUT structured data" : "no entry"}; the IRS return carries total assets ${fig.total_assets_eoy_fmv_amt}, revenue per books ${fig.total_revenue_per_books_amt}`);
        continue;
      }
      const pairs: Array<[string, unknown, string]> = [
        ["totassetsend", fig.total_assets_eoy_book_amt, "total_assets_eoy_book_amt"],
        ["totrevenue", fig.total_revenue_per_books_amt, "total_revenue_per_books_amt"],
        ["totfuncexpns", fig.total_expenses_per_books_amt, "total_expenses_per_books_amt"],
        ["contrpdpbks", fig.contributions_paid_per_books_amt, "contributions_paid_per_books_amt"],
        ["distribamt", fig.distributable_amount_amt, "distributable_amount_amt"],
        ["qlfydistriamt", fig.qualifying_distributions_amt, "qualifying_distributions_amt"],
        ["qlfydistribtot", fig.qualifying_distributions_amt, "qualifying_distributions_amt"],
        ["totexpnsexempt", fig.total_expenses_charitable_disbursements_amt, "total_expenses_charitable_disbursements_amt"],
      ];
      for (const [k, mine, col] of pairs) {
        const theirs = w[k];
        const status = theirs === null || theirs === undefined ? "ProPublica: empty" : Number(theirs) === Number(mine) ? "agrees" : "DISAGREES";
        ppLines.push(`${f.tax_period_end}  ProPublica ${k} = ${theirs ?? "null"}  vs filing/${col} = ${mine}  -> ${status}`);
      }
    }
  }

}

// A varied, repeatable sample of the funders in a database: one chosen to exercise each
// feature of the data, then pseudo-random ones (ordered by a hash of the EIN).
async function pickSample(db: ReadDb, n: number): Promise<Array<[string, string]>> {
  if (!db.query) throw new Error("--sample needs a local (pglite) database");
  const picks: Array<[string, string]> = [
    ["the largest grant list in one filing", `select ein from funder_reference_figures order by grants_listed_count desc nulls last, ein limit 1`],
    ["the most grants to foreign-address recipients", `select ein from funder_reference_grants where recipient_country is not null group by ein order by count(*) desc, ein limit 1`],
    ["grants approved for future payment", `select ein from funder_reference_grants where kind = 'approved_for_future_payment' group by ein order by count(*) desc, ein limit 1`],
    ["application details given", `select ein from funder_reference_application_terms where jsonb_array_length(application_groups) > 0 order by ein limit 1`],
    ["an amended (superseded) return", `select ein from funder_reference_filings where status = 'superseded' order by ein limit 1`],
    ["a fiscal year not ending in December", `select ein from funder_reference_foundations where fiscal_year_end_month <> 12 order by ein limit 1`],
    ["a private operating foundation", `select ein from funder_reference_foundations where private_operating_foundation_ind order by ein limit 1`],
    ["the most grants to named persons", `select ein from funder_reference_grants where recipient_person_name is not null group by ein order by count(*) desc, ein limit 1`],
    ["listed grants differ from the stated total", `select ein from funder_reference_figures where grants_listed_minus_stated_amt <> 0 order by ein limit 1`],
    ["money paid per books but no grant list", `select ein from funder_reference_figures where grants_listed_count is null and contributions_paid_per_books_amt > 0 order by contributions_paid_per_books_amt desc limit 1`],
    ["holds exactly one period", `select ein from funder_reference_period_coverage group by ein having count(*) filter (where status = 'loaded') = 1 order by ein limit 1`],
    ["holds exactly two periods", `select ein from funder_reference_period_coverage group by ein having count(*) filter (where status = 'loaded') = 2 order by ein limit 1`],
    ["a period that could not be read", `select ein from funder_reference_period_coverage where status = 'unread' order by ein limit 1`],
    ["the most officers paid compensation", `select ein from funder_reference_people where compensation_amt > 0 group by ein order by count(*) desc, ein limit 1`],
  ];
  const out: Array<[string, string]> = [];
  for (const [why, sql] of picks) {
    const r = await db.query(sql);
    const e = r[0] ? String(r[0].ein) : null;
    if (e && !out.some(([, x]) => x === e)) out.push([why, e]);
  }
  const rest = await db.query(`select ein from funder_reference_foundations order by md5(ein) limit ${Math.max(0, n) + out.length}`);
  for (const r of rest) {
    if (out.length >= n + picks.length) break;
    const e = String(r.ein);
    if (!out.some(([, x]) => x === e) && out.filter(([w]) => w === "pseudo-random").length < n) out.push(["pseudo-random", e]);
  }
  return out;
}

let SAMPLE_MODE = false;

async function main() {
  const dbSpec = arg("db");
  const einArg = arg("ein");
  const sampleArg = arg("sample");
  const all = process.argv.includes("--all");
  if (!dbSpec || (!einArg && !sampleArg && !all)) {
    console.error("usage: --db pglite:<dir>|supabase (--ein <9 digits>[,..] | --sample <number of pseudo-random funders> | --all) [--xml-dir <dir>] [--archives-dir <dir>] [--propublica <json>]");
    process.exit(2);
  }
  const xmlDir = arg("xml-dir");
  const db = await openDb(dbSpec);
  SAMPLE_MODE = (!!sampleArg || all) && !einArg;
  let chosen: Array<[string, string]>;
  if (einArg) chosen = einArg.split(",").map((e) => ["named", e] as [string, string]);
  else if (all) {
    chosen = (await db.listEins()).map((e) => ["every funder", e] as [string, string]);
  } else if (db.query) chosen = await pickSample(db, Number(sampleArg));
  else {
    // a live database offers no raw SQL: take evenly spaced funders from the sorted list
    const eins = await db.listEins();
    const n = Math.min(Number(sampleArg), eins.length);
    chosen = Array.from({ length: n }, (_, i) => ["evenly spaced", eins[Math.floor((i * eins.length) / n)]] as [string, string]);
  }
  console.log(`database: ${db.label}; verifying ${chosen.length} funder(s)${SAMPLE_MODE ? " (a repeatable, varied sample):" : ""}`);
  if (SAMPLE_MODE && !all) for (const [why, e] of chosen) console.log(`  ${e}  ${why}`);
  const ppLines: string[] = [];
  let done = 0;
  for (const [, ein] of chosen) {
    await verifyOne(db, ein, xmlDir, ppLines);
    if (all && ++done % 500 === 0) console.log(`  ${done}/${chosen.length} funders verified, ${compared} comparisons, ${mismatches} mismatch(es) so far`);
  }

  // ---- report ----
  console.log(`\ncompared ${compared} stored values/properties with the filing(s) of ${chosen.length} funder(s); ${mismatches} mismatch(es)`);
  for (const x of failures) console.log(`  MISMATCH ${x}`);
  console.log(`\nwhat the filing(s) carry that is NOT stored (leaf elements, by section): ${leafTotal - leafStored} of ${leafTotal} (${leafStored} stored)`);
  for (const [k, n] of [...uncovered.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  if (ppLines.length) {
    console.log("\nProPublica API cross-check:");
    for (const l of ppLines) console.log("  " + l);
  }
  await db.close();
  if (mismatches > 0) {
    console.log("\nRESULT: FAIL");
    process.exit(1);
  }
  console.log("\nRESULT: PASS -- every stored value equals the filing");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
