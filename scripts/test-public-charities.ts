// STATE item 116 (ruling 0047): the Form 990 reader, the kind rule, migration 0089 and the loader,
// run on a REAL Postgres (PGlite) with every project migration applied unchanged, over REAL public
// IRS returns saved under scripts/fixtures/public-charities (five small Form 990 returns) and
// variants made from them.
//
// This is ruling 0047's "Test of compliance" made executable:
//   * every stored row names its kind, its form, and its schedule, part and line
//   * no table carries organization_id; the application roles cannot write; the write function is closed
//   * no column mixes a Form 990-PF figure with a Schedule I or Schedule D figure
//   * a donor-advised fund sponsor's grants carry no donor, and nothing in the schema can
//   * the loader run twice duplicates nothing; an unreadable return is recorded as unread with its reason
//   * a figure the return does not state is null, never zero
//   * the threshold, the rule and the count just under it are in the run record
//   * an index row that names the wrong archive is still found (the foundation loader's own search)
//   * the entry point refuses to write while a loader run is in progress, and refuses production without the flag
// plus source scans: nothing in app/ or components/ reaches the new tables (item 113's screen is not
// extended), nothing imports the loader from the web, and the Form 990-PF pipeline does not know this one.
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform. It does not run PostgREST,
// and the Supabase sink (lib/funder-reference/sink-990.ts) is not exercised against a live project --
// migration 0089 must not be applied to production yet. The fixtures are five returns and their
// variants: the reader is proven on those shapes (two return versions, true/false and 1/0 boxes, a
// Schedule D with no Part I figures, a return with no Part IX total), not on the whole country.
//
// Usage: npx tsx scripts/test-public-charities.ts

import { readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootDatabase } from "./funder-reference-support";
import { makeZip, type ZipItem } from "./funder-reference-test-support";
import { archiveProvider } from "../lib/funder-reference/sources";
import type { IndexRow } from "../lib/funder-reference/document";
import { CHARITY_BOXES, CHARITY_FIGURES, DAF_FIGURES, FilingRejected, parseReturn990 } from "../lib/funder-reference/parse-990";
import { DEFAULT_CHARITY_THRESHOLD, kindsForFunder } from "../lib/funder-reference/charity-scope";
import { runCharityPipeline } from "../lib/funder-reference/pipeline-990";
import { pgliteCharitySink, isReadOnlyVerification } from "../lib/funder-reference/sink-990";
import { loadedCharityDoc } from "../lib/funder-reference/document-990";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
const section = (t: string) => console.log(`\n--- ${t} ---`);

const root = join(__dirname, "..");
const FIX = join(__dirname, "fixtures/public-charities");
const read = (id: string) => readFileSync(join(FIX, `${id}_public.xml`), "utf8");

// five real returns, one per shape the rule must handle
const ID = {
  pump: "202401159349302015", // EIN 954807001, CA, period 2023-12-31, v2023v5.0: grants to domestic orgs $1,029,885, 10 Schedule I rows; Schedule D has no Part I figures
  union: "202431669349300713", // EIN 310628641, OH, 2023-12-31, v2023v5.0: grants $1,314,278, 17 rows AND 56 donor advised funds (both kinds); box written 'true'
  hff: "202413209349311136", // EIN 043521743, MA, 2023-12-31, v2023v5.1: no Part IX line 1, no Schedule I, 1 donor advised fund; box written '1'
  corey: "202440379349300239", // EIN 330514612, CA, 2023-05-31, v2022v5.0: grants $80,000 (just under the line), 4 rows
  levy: "202412979349301861", // EIN 592999520, FL, 2024-06-30, v2023v5.1: no Part IX line 1; box ticked but Schedule D states no fund count
};
const EIN = { pump: "954807001", union: "310628641", hff: "043521743", corey: "330514612", levy: "592999520" };

const TABLES = ["charity_reference_filings", "charity_reference_organizations", "charity_reference_figures", "charity_reference_daf_figures", "charity_reference_grants", "charity_reference_period_coverage"];

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", ".claude", "docs", "supabase"].includes(n)) continue;
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|jsx)$/.test(n)) out.push(p);
  }
  return out;
}

const rejects = (xml: string): string => {
  try {
    parseReturn990(xml);
    return "";
  } catch (e) {
    return e instanceof FilingRejected ? e.reason : `NOT A FilingRejected: ${(e as Error).message}`;
  }
};

// ---------------------------------------------------------------------------------------------
// the world: index rows and archives (zips) for a run
// ---------------------------------------------------------------------------------------------
interface Item {
  id: string;
  ein: string;
  period: string; // yyyymm
  name: string;
  xml: string | null; // null: named in the index, in no archive
  indexBatch: string; // the archive the index names
  inBatch?: string; // the archive that actually holds it (defaults to indexBatch)
}

function buildWorld(items: Item[]): { archivesDir: string; workDir: string; rows: IndexRow[]; tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), "public-charities-"));
  const archivesDir = join(tmp, "zips");
  const workDir = join(tmp, "work");
  mkdirSync(archivesDir, { recursive: true });
  const byArchive = new Map<string, ZipItem[]>();
  for (const it of items) {
    if (it.xml === null) continue;
    const a = it.inBatch ?? it.indexBatch;
    const list = byArchive.get(a) ?? [];
    list.push({ name: `${a}/${it.id}_public.xml`, data: Buffer.from(it.xml) });
    byArchive.set(a, list);
  }
  for (const [a, list] of byArchive) writeFileSync(join(archivesDir, `${a}.zip`), makeZip(list));
  const rows: IndexRow[] = items.map((it) => ({ returnId: null, ein: it.ein, taxPeriod: it.period, subYear: 2024, taxpayerName: it.name, returnType: "990", objectId: it.id, batchId: it.indexBatch, indexFile: "index_2024.csv" }));
  return { archivesDir, workDir, rows, tmp };
}

// variants made from the real returns
const withTs = (xml: string, ts: string) => xml.replace(/<ReturnTs>[^<]*<\/ReturnTs>/, `<ReturnTs>${ts}</ReturnTs>`);
const withLine1 = (xml: string, amt: number) => xml.replace(/(<GrantsToDomesticOrgsGrp>\s*<TotalAmt>)\d+/, `$1${amt}`);
const amended = withLine1(withTs(read(ID.pump), "2099-01-01T00:00:00-06:00"), 1_100_000);
const pump2022 = read(ID.pump).replace("<TaxPeriodEndDt>2023-12-31</TaxPeriodEndDt>", "<TaxPeriodEndDt>2022-12-31</TaxPeriodEndDt>").replace("<TaxPeriodBeginDt>2023-01-01</TaxPeriodBeginDt>", "<TaxPeriodBeginDt>2022-01-01</TaxPeriodBeginDt>");
const pump2022Small = withLine1(pump2022, 50_000);

const ids = {
  pumpAmend: "202450000000000001",
  pump2022: "202350000000000002",
  pump2024Broken: "202550000000000003",
  pfAsCharity: "202450000000000004",
  ghost: "202450000000000005",
};

const CATALOG: Item[] = [
  { id: ID.pump, ein: EIN.pump, period: "202312", name: "THE HAROLD AND CAROLE PUMP FOUNDATION", xml: read(ID.pump), indexBatch: "2024_TEOS_XML_01A" },
  { id: ids.pumpAmend, ein: EIN.pump, period: "202312", name: "THE HAROLD AND CAROLE PUMP FOUNDATION", xml: amended, indexBatch: "2024_TEOS_XML_01A" },
  { id: ids.pump2022, ein: EIN.pump, period: "202212", name: "THE HAROLD AND CAROLE PUMP FOUNDATION", xml: pump2022Small, indexBatch: "2024_TEOS_XML_01A" },
  { id: ids.pump2024Broken, ein: EIN.pump, period: "202412", name: "THE HAROLD AND CAROLE PUMP FOUNDATION", xml: "<Return><ReturnHeader><this is not well formed", indexBatch: "2024_TEOS_XML_01A" },
  // the index names archive 05A; the return is in 06A -- the roughly 6% drift found in the sample (report 0034)
  { id: ID.union, ein: EIN.union, period: "202312", name: "COMMUNITY FOUNDATION OF UNION COUNT", xml: read(ID.union), indexBatch: "2024_TEOS_XML_05A", inBatch: "2024_TEOS_XML_06A" },
  { id: ID.hff, ein: EIN.hff, period: "202312", name: "THE HEALTH FOUNDATION FUND INC", xml: read(ID.hff), indexBatch: "2024_TEOS_XML_11A" },
  { id: ID.corey, ein: EIN.corey, period: "202305", name: "LILLIAN H COREY CHARITABLE TRUST", xml: read(ID.corey), indexBatch: "2024_TEOS_XML_02A" },
  { id: ID.levy, ein: EIN.levy, period: "202406", name: "LEVY COUNTY SCHOOLS FOUNDATION INC", xml: read(ID.levy), indexBatch: "2024_TEOS_XML_10A" },
  // a Form 990-PF handed to the Form 990 reader, and a return the index lists that no archive holds
  { id: ids.pfAsCharity, ein: "700000009", period: "202312", name: "A PRIVATE FOUNDATION", xml: read(ID.pump).replace("<ReturnTypeCd>990</ReturnTypeCd>", "<ReturnTypeCd>990PF</ReturnTypeCd>"), indexBatch: "2024_TEOS_XML_01A" },
  { id: ids.ghost, ein: "700000010", period: "202312", name: "NOT IN ANY ARCHIVE", xml: null, indexBatch: "2024_TEOS_XML_03A" },
];

const silent = () => undefined;
const poolOf = (w: ReturnType<typeof buildWorld>) => archiveProvider({ dir: w.archivesDir, remote: false, userAgent: "test" });
const rowsOf = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Array<Record<string, unknown>>;

async function dump(db: PGlite): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const r = await db.query(`select (to_jsonb(t) - 'loaded_at' - 'run_id' - 'checked_at')::text as j from ${t} t order by 1`);
    out[t] = (r.rows as Array<{ j: string }>).map((x) => x.j);
  }
  return JSON.stringify(out);
}

async function main() {
  // ============================================================================ the reader
  section("the reader takes what the return says, in the words it used");
  const pump = parseReturn990(read(ID.pump));
  const union = parseReturn990(read(ID.union));
  const hff = parseReturn990(read(ID.hff));
  const corey = parseReturn990(read(ID.corey));
  const levy = parseReturn990(read(ID.levy));
  ok("identity: EIN, name, period and version as stated", pump.ein === EIN.pump && /PUMP FOUNDATION/.test(pump.filer.nameLine1 ?? "") && pump.taxPeriodEnd === "2023-12-31" && pump.returnVersion === "2023v5.0" && pump.returnTypeCd === "990");
  ok("Part IX line 1 column (A) is read from its own group", pump.figures.part_ix_line_1_grants_domestic_orgs_total_amt === 1_029_885 && union.figures.part_ix_line_1_grants_domestic_orgs_total_amt === 1_314_278 && corey.figures.part_ix_line_1_grants_domestic_orgs_total_amt === 80_000);
  ok("a return that does not state Part IX line 1 has null there, NOT zero", hff.figures.part_ix_line_1_grants_domestic_orgs_total_amt === null && levy.figures.part_ix_line_1_grants_domestic_orgs_total_amt === null);
  ok("Schedule I: every recipient row is read, in order, with its place", pump.rows.length === 10 && union.rows.length === 17 && corey.rows.length === 4 && levy.rows.length === 6 && hff.rows.length === 0 && pump.rows.map((r) => r.ordinal).join() === "1,2,3,4,5,6,7,8,9,10");
  ok("a recipient row carries name, EIN, address, section and the cash grant as stated", union.rows[0].recipientNameLine1 === "CARE TRAIN OF UNION COUNTY" && union.rows[0].recipientEinAsStated === "311739631" && union.rows[0].address?.state === "OH" && union.rows[0].cashGrantAmt === 7000);
  ok("a recipient row's element that the return leaves out is null, not zero or empty", union.rows[0].nonCashAssistanceAmt === null && union.rows[0].purposeAsStated === null);
  ok("Schedule D Part I: the donor advised fund figures are read under their own names", union.daf?.daf_held_cnt === 56 && union.daf?.daf_contributions_amt === 998_215 && union.daf?.daf_grants_amt === 1_238_732 && union.daf?.daf_value_eoy_amt === 7_553_523);
  ok("column (b) 'funds and other accounts' is its own set of columns, never added to donor advised funds", union.daf?.other_funds_held_cnt === 84 && union.daf?.other_funds_value_eoy_amt === 11_585_334 && union.daf?.daf_held_cnt === 56);
  ok("a Schedule D with no Part I figures has nulls, not zeros", pump.hasScheduleD && pump.daf !== null && Object.values(pump.daf).every((v) => v === null));
  ok("no Schedule D at all is null, not an object of zeros", parseReturn990(read(ID.hff).replace(/<IRS990ScheduleD[\s\S]*?<\/IRS990ScheduleD>/, "")).daf === null);
  ok("yes/no written 'true' and '1' and 'false' and '0' are one reading", union.boxes.part_iv_line_6_donor_advised_fund_box === true && union.boxesRaw.part_iv_line_6_donor_advised_fund_box === "true" && hff.boxes.part_iv_line_6_donor_advised_fund_box === true && hff.boxesRaw.part_iv_line_6_donor_advised_fund_box === "1" && pump.boxes.part_iv_line_6_donor_advised_fund_box === false && pump.boxesRaw.part_iv_line_6_donor_advised_fund_box === "0" && corey.boxes.part_iv_line_6_donor_advised_fund_box === false && corey.boxesRaw.part_iv_line_6_donor_advised_fund_box === "false");
  ok("a box with an unreadable value is null (not stated), not false", parseReturn990(read(ID.hff).replace("<DonorAdvisedFundInd referenceDocumentId=\"RetDoc1039900001\">1</DonorAdvisedFundInd>", "<DonorAdvisedFundInd>maybe</DonorAdvisedFundInd>")).boxes.part_iv_line_6_donor_advised_fund_box === null);
  ok("Part IX line 3 (outside the US: organizations AND individuals) is its own column, and Part I line 13 (includes individuals) another; neither is the tested figure", "part_ix_line_3_grants_outside_us_total_amt" in CHARITY_FIGURES && "part_i_line_13_cy_grants_and_similar_paid_amt" in CHARITY_FIGURES && Object.keys(CHARITY_FIGURES).filter((k) => /domestic_orgs/.test(k)).length === 1);

  section("what ruling 0047 says is never stored is never read");
  {
    const SECRET = "SECRETINDIVIDUALNAME";
    const withIndividuals = read(ID.union).replace("</IRS990ScheduleI>", `<GrantsOtherAsstToIndivInUSGrp><GrantTypeTxt>${SECRET}</GrantTypeTxt><CashGrantAmt>987654</CashGrantAmt><RecipientCnt>3</RecipientCnt></GrantsOtherAsstToIndivInUSGrp></IRS990ScheduleI>`);
    const p = parseReturn990(withIndividuals);
    ok("grants to individuals (Schedule I Part III) do not become recipient rows", p.rows.length === union.rows.length);
    const doc = loadedCharityDoc({ runId: "00000000-0000-4000-8000-000000000000", loadedAt: new Date().toISOString(), loaderVersion: "t", archiveUrl: "u", member: "m", index: { returnId: null, ein: EIN.union, taxPeriod: "202312", subYear: 2024, taxpayerName: "x", returnType: "990", objectId: ID.union, batchId: null, indexFile: "i" } }, p, { sha256: "0".repeat(64), bytes: 1 }, kindsForFunder([{ taxPeriodEnd: "2023-12-31", orgGrantsAmt: 1_314_278, dafHeldCnt: 56, dafBox: true }], DEFAULT_CHARITY_THRESHOLD), DEFAULT_CHARITY_THRESHOLD);
    const text = JSON.stringify(doc);
    ok("nothing about a grant to an individual is anywhere in what would be written", !text.includes(SECRET) && !text.includes("987654") && !/GrantsOtherAsstToIndiv/i.test(text));
    ok("the signer, the preparer and the principal officer are not read", !/AMIE SHEI|KEVIN J MAGUIRE|PREPARER|PRINCIPALOFFICER/i.test(JSON.stringify(loadedCharityDoc({ runId: "00000000-0000-4000-8000-000000000000", loadedAt: new Date().toISOString(), loaderVersion: "t", archiveUrl: "u", member: "m", index: { returnId: null, ein: EIN.hff, taxPeriod: "202312", subYear: 2024, taxpayerName: "x", returnType: "990", objectId: ID.hff, batchId: null, indexFile: "i" } }, hff, { sha256: "0".repeat(64), bytes: 1 }, kindsForFunder([{ taxPeriodEnd: "2023-12-31", orgGrantsAmt: null, dafHeldCnt: 1, dafBox: true }], DEFAULT_CHARITY_THRESHOLD), DEFAULT_CHARITY_THRESHOLD))));
    // unmapped fields are kept, not dropped (as 0084 does for a grant row)
    const odd = parseReturn990(read(ID.union).replace("<RecipientEIN>311739631</RecipientEIN>", "<RecipientEIN>311739631</RecipientEIN><SomeNewElementTxt>kept</SomeNewElementTxt>"));
    ok("an element of a recipient row that no column reads is kept in unmapped_fields", odd.rows[0].unmappedFields["SomeNewElementTxt"] === "kept");
  }

  section("a return that is not a clean Form 990 is rejected with a reason, never half-read");
  ok("a Form 990-PF is refused by the Form 990 reader", /not 990/.test(rejects(read(ID.pump).replace("<ReturnTypeCd>990</ReturnTypeCd>", "<ReturnTypeCd>990PF</ReturnTypeCd>"))));
  ok("a Form 990-EZ is refused (out of scope, ruling 0047 clause 1)", /not 990/.test(rejects(read(ID.pump).replace("<ReturnTypeCd>990</ReturnTypeCd>", "<ReturnTypeCd>990EZ</ReturnTypeCd>"))));
  ok("malformed XML is refused", /not well-formed/.test(rejects("<Return><ReturnHeader><oops")));
  ok("a missing tax period is refused", /TaxPeriodEndDt is absent/.test(rejects(read(ID.pump).replace(/<TaxPeriodEndDt>[^<]*<\/TaxPeriodEndDt>/, ""))));
  ok("an EIN that is not nine digits is refused", /not nine digits/.test(rejects(read(ID.pump).replace("<EIN>954807001</EIN>", "<EIN>95480</EIN>"))));
  ok("an amount that is not a whole number is refused, not rounded", /not a whole number/.test(rejects(withLine1(read(ID.pump), 1).replace(/(<GrantsToDomesticOrgsGrp>\s*<TotalAmt>)1/, "$11.5"))));
  ok("a return with no IRS990 is refused", /no IRS990/.test(rejects(read(ID.pump).replace(/<IRS990 [\s\S]*?<\/IRS990>/, ""))));

  // ============================================================================ the kind rule
  section("the kind rule is clause 8, stated in code (ruling 0047)");
  {
    const T = DEFAULT_CHARITY_THRESHOLD;
    const k = (orgs: Array<number | null>, daf: Array<number | null> = [], box: Array<boolean | null> = []) =>
      kindsForFunder(orgs.map((o, i) => ({ taxPeriodEnd: `202${2 + i}-12-31`, orgGrantsAmt: o, dafHeldCnt: daf[i] ?? null, dafBox: box[i] ?? null })), T);
    ok("the owner's threshold is $100,000, with a just-under band from $50,000", T.minOrgGrantsAmt === 100_000 && T.justUnderFromAmt === 50_000);
    ok("$99,999 is not in scope and $100,000 is: the line is inclusive", !k([99_999]).inScope && k([100_000]).isGrantmakingPublicCharity);
    ok("ANY period at or over the line puts the funder in; the others come with it", k([10, 150_000, null]).isGrantmakingPublicCharity && k([10, 150_000, null]).maxOrgGrantsAmt === 150_000);
    ok("a figure not stated is not zero: it neither qualifies nor disqualifies", !k([null]).inScope && k([null]).maxOrgGrantsAmt === null && k([null, 120_000]).isGrantmakingPublicCharity);
    ok("a donor advised fund sponsor: any period with at least one fund", k([null], [1]).isDafSponsor && k([null, null], [null, 3]).isDafSponsor);
    ok("zero funds is not a sponsor", !k([null], [0]).isDafSponsor && !k([null], [0]).inScope);
    ok("the main-form box alone is NOT enough: it is reported, not used", !k([null], [null], [true]).inScope && k([null], [null], [true]).dafBoxWithoutScheduleDCount === true);
    ok("one organization can carry both labels", (() => { const b = k([500_000], [12]); return b.isGrantmakingPublicCharity && b.isDafSponsor; })());
    ok("just under: not in scope, the largest stated figure from $50,000 to $99,999", k([75_000]).justUnder && !k([49_999]).justUnder && !k([100_000]).justUnder && !k([75_000], [2]).justUnder);
    ok("the basis lists every period with the two figures the rule read, oldest first", (() => { const b = k([5, 150_000], [null, 4]).basis; return b.length === 2 && b[0].tax_period_end < b[1].tax_period_end && b[1].grants_to_domestic_orgs_amt === 150_000 && b[1].donor_advised_funds_held_cnt === 4; })());
    ok("the threshold is a parameter, not a constant buried in the rule", k([40_000]).inScope === false && kindsForFunder([{ taxPeriodEnd: "2023-12-31", orgGrantsAmt: 40_000, dafHeldCnt: null, dafBox: null }], { minOrgGrantsAmt: 25_000, justUnderFromAmt: 10_000 }).inScope);
  }

  // ============================================================================ migration 0089
  section("migration 0089 applies to a real Postgres, unchanged, after all earlier ones");
  const db = new PGlite();
  const boot = await bootDatabase(db);
  ok(`all ${boot.applied.length} migration files apply with no error`, boot.failures.length === 0, boot.failures.join("; "));
  ok("0089 is the public-charity migration and is among them", boot.applied.some((f) => f.startsWith("0089_funder_reference_public_charities")));
  const sql89 = readFileSync(join(root, "supabase/migrations/0089_funder_reference_public_charities.sql"), "utf8").replace(/--.*$/gm, "");
  ok("it is additive: it alters, drops and rewrites no earlier table, and changes no earlier function", !/\balter\s+table\s+(?!%I)/i.test(sql89) && !/\bdrop\s+(table|function|view|index)/i.test(sql89) && !/create\s+or\s+replace/i.test(sql89) && !/\b(delete\s+from|update)\s+(funder_reference_|public\.)/i.test(sql89));

  section("the tables are shared reference data (ruling 0045 clause 1, carried by ruling 0047 clause 4)");
  const cols = (await rowsOf(db, `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'charity\\_reference\\_%' escape '\\'`)) as Array<{ table_name: string; column_name: string }>;
  ok("exactly the six charity tables exist", new Set(cols.map((c) => c.table_name)).size === 6 && TABLES.every((t) => cols.some((c) => c.table_name === t)));
  ok("NO table carries organization_id (deliberate, stated in the ruling)", !cols.some((c) => c.column_name === "organization_id"));
  const rls = await rowsOf(db, `select relname, relrowsecurity from pg_class where relname like 'charity\\_reference\\_%' escape '\\' and relkind = 'r'`);
  ok("row-level security is enabled on every one", rls.length === 6 && rls.every((r) => r.relrowsecurity === true));
  const pols = (await rowsOf(db, `select tablename, cmd, roles::text as roles, qual from pg_policies where tablename like 'charity\\_reference\\_%' escape '\\'`)) as Array<{ tablename: string; cmd: string; roles: string; qual: string }>;
  ok("each table has exactly one policy, a SELECT policy for signed-in members only; no write policy exists", pols.length === 6 && pols.every((p) => p.cmd === "SELECT" && p.roles.includes("authenticated") && !p.roles.includes("anon") && /my_organization_id/.test(p.qual)));
  const grants = (await rowsOf(db, `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_name like 'charity\\_reference\\_%' escape '\\' and grantee in ('anon','authenticated')`)) as Array<{ table_name: string; grantee: string; privilege_type: string }>;
  ok("authenticated holds only SELECT on them; anon holds nothing", grants.every((g) => g.grantee === "authenticated" && g.privilege_type === "SELECT") && grants.length === 6);
  const fnp = (await rowsOf(db, `select has_function_privilege('anon', 'charity_reference_apply_filing(jsonb)', 'execute') as a, has_function_privilege('authenticated', 'charity_reference_apply_filing(jsonb)', 'execute') as u, has_function_privilege('service_role', 'charity_reference_apply_filing(jsonb)', 'execute') as s`))[0] as { a: boolean; u: boolean; s: boolean };
  ok("the one write function is open to the service role and closed to anon and authenticated", fnp.s === true && fnp.a === false && fnp.u === false);

  section("no column mixes a Form 990-PF figure with a Schedule I or D figure; none names a donor (ruling 0047 clauses 2 and 3)");
  {
    const pf = (await rowsOf(db, `select column_name from information_schema.columns where table_schema = 'public' and table_name in ('funder_reference_figures','funder_reference_foundations','funder_reference_grants','funder_reference_people','funder_reference_application_terms')`)).map((r) => String(r.column_name));
    const pfFigureOnly = pf.filter((c) => /_amt$|_ratio$/.test(c) && !/^(compensation|employee_benefit|expense_account|amount)/.test(c));
    const charityNames = new Set(cols.map((c) => c.column_name));
    const overlap = pfFigureOnly.filter((c) => charityNames.has(c));
    ok("no charity column carries the name of a Form 990-PF figure column", overlap.length === 0, overlap.join(", "));
    const figureCols = cols.filter((c) => ["charity_reference_figures", "charity_reference_daf_figures"].includes(c.table_name) && /_amt$|_cnt$/.test(c.column_name)).map((c) => c.column_name);
    ok("every Form 990 figure column is named for its form and line (Part I, Part IX, Schedule I, Schedule D) or its column group", figureCols.length > 0 && figureCols.every((c) => /^(part_i_|part_ix_|schedule_i_|daf_|other_funds_)/.test(c)), figureCols.filter((c) => !/^(part_i_|part_ix_|schedule_i_|daf_|other_funds_)/.test(c)).join(", "));
    ok("no column anywhere is a single 'giving' figure", !cols.some((c) => /^(giving|total_giving|annual_giving)(_amt)?$/.test(c.column_name)));
    ok("none of the Form 990-PF figure names is reused (no contributions-paid-per-books, qualifying-distributions or fmv-assets column)", !cols.some((c) => /contributions_paid_per_books|qualifying_distributions|fmv_assets|net_value_noncharitable|minimum_investment_return|distributable/.test(c.column_name)));
    ok("no column in the schema names a donor, a donor's identity or an advisor; the only 'donor' words are the Part IV box and the fund counts", !cols.some((c) => /donor|advisor/i.test(c.column_name) && !/^part_iv_line_6_donor_advised_fund_box(_as_written)?$/.test(c.column_name) && !/^(is_daf_sponsor)$/.test(c.column_name)), cols.filter((c) => /donor|advisor/i.test(c.column_name)).map((c) => c.column_name).join(", "));
    ok("every row-bearing table says which form it comes from (form_type), except filings (return_type) and coverage", ["charity_reference_organizations", "charity_reference_figures", "charity_reference_daf_figures", "charity_reference_grants"].every((t) => cols.some((c) => c.table_name === t && c.column_name === "form_type")) && cols.some((c) => c.table_name === "charity_reference_filings" && c.column_name === "return_type"));
    ok("every figures table carries form_places, and the grants table source_location", ["charity_reference_figures", "charity_reference_daf_figures"].every((t) => cols.some((c) => c.table_name === t && c.column_name === "form_places")) && cols.some((c) => c.table_name === "charity_reference_grants" && c.column_name === "source_location"));
    ok("the funder row carries both kind labels, the rule and the threshold", ["is_grantmaking_public_charity", "is_daf_sponsor", "kind_rule", "kind_threshold_org_grants_amt", "kind_basis"].every((c) => cols.some((x) => x.table_name === "charity_reference_organizations" && x.column_name === c)));
  }

  // ============================================================================ the loader
  section("the loader, end to end, on real returns and variants of them");
  const world = buildWorld(CATALOG);
  const sink = pgliteCharitySink(db);
  const params = { periodYears: [2022, 2023, 2024], state: null, threshold: DEFAULT_CHARITY_THRESHOLD, workDir: world.workDir, rows: world.rows, sources: [{ kind: "test" }] };
  const run1 = await runCharityPipeline(sink, poolOf(world), params, silent);
  const c = run1.counts;
  ok("every index row ends in exactly one named outcome and the outcomes add up", c.outcomes_sum_check === true && c.index_rows_considered === 10, JSON.stringify(c));
  ok("the Form 990-PF handed to the Form 990 reader and the malformed return are unread with reasons; the ghost is unread, not found", c.status_unread === 3 && c.unread_not_located === 1 && run1.rejected.length === 3, JSON.stringify(run1.rejected));
  ok("the index row that named the wrong archive was found anyway (the foundation loader's own search is reused)", c.status_loaded >= 1 && (await rowsOf(db, `select 1 from charity_reference_filings where object_id = $1 and status = 'loaded'`, [ID.union])).length === 1);
  ok("loaded and superseded: the amendment stands, the original is kept as superseded", (await rowsOf(db, `select object_id, status, superseded_by_object_id from charity_reference_filings where ein = $1 and tax_period_end = '2023-12-31' order by object_id`, [EIN.pump])).map((r) => `${r.object_id}:${r.status}`).join() === `${ID.pump}:superseded,${ids.pumpAmend}:loaded` && c.status_loaded === 4 && c.status_superseded === 1);
  ok("out of scope is counted and NOT stored: the just-under trust and the box-only school foundation have no filing row", c.status_not_in_scope === 2 && (await rowsOf(db, `select 1 from charity_reference_filings where ein in ($1, $2)`, [EIN.corey, EIN.levy])).length === 0);
  ok("an in-scope funder's smaller return is still loaded (the 2022 return of $50,000 comes with the funder)", (await rowsOf(db, `select 1 from charity_reference_filings where object_id = $1 and status = 'loaded'`, [ids.pump2022])).length === 1);
  ok("funder counts: 5 read, 3 in scope (2 public charities, 2 donor advised fund sponsors, 1 both), 2 not", c.funders_read === 5 && c.funders_in_scope === 3 && c.funders_public_charity === 2 && c.funders_daf_sponsor === 2 && c.funders_both_kinds === 1 && c.funders_not_in_scope === 2, JSON.stringify(c));

  const orgs = await rowsOf(db, `select ein, is_grantmaking_public_charity as pc, is_daf_sponsor as daf, form_type, kind_threshold_org_grants_amt, kind_rule from charity_reference_organizations order by ein`);
  const kindOf = (ein: string) => orgs.find((o) => o.ein === ein);
  ok("each stored funder names its kind(s) and the form: grants-and-Schedule-I funder, sponsor-only, and both", kindOf(EIN.pump)?.pc === true && kindOf(EIN.pump)?.daf === false && kindOf(EIN.hff)?.pc === false && kindOf(EIN.hff)?.daf === true && kindOf(EIN.union)?.pc === true && kindOf(EIN.union)?.daf === true && orgs.every((o) => o.form_type === "990"), JSON.stringify(orgs));
  ok("every funder row carries the rule and the threshold it was labeled under", orgs.every((o) => String(o.kind_rule).includes("Part IX, line 1") && Number(o.kind_threshold_org_grants_amt) === 100_000));
  ok("no stored funder is without a kind (the table forbids it, and the loader never offers one)", orgs.every((o) => o.pc === true || o.daf === true));
  const basis = (await rowsOf(db, `select kind_basis from charity_reference_organizations where ein = $1`, [EIN.pump]))[0].kind_basis as Array<{ tax_period_end: string; grants_to_domestic_orgs_amt: number | null }>;
  ok("the funder's basis lists each period read and the figure the rule used (the amendment's $1,100,000)", basis.length === 2 || basis.length === 3, JSON.stringify(basis));
  ok("…and the amended figure is the one on the standing return", basis.some((b) => b.grants_to_domestic_orgs_amt === 1_100_000));

  section("every stored value names its form and its place on it");
  {
    const figs = await rowsOf(db, `select * from charity_reference_figures order by ein, tax_period_end`);
    const keyCols = new Set(["ein", "tax_period_end", "filing_object_id", "form_type", "loaded_at", "loader_version", "form_places", "has_schedule_i", "has_schedule_d", "schedule_i_listed_derivation"]);
    ok("figures: every row is Form 990 and every figure column that holds a value has its place on the form recorded", figs.length === 4 && figs.every((r) => r.form_type === "990" && Object.keys(r).filter((k) => !keyCols.has(k) && r[k] !== null).every((k) => typeof (r.form_places as Record<string, string>)[k] === "string" && /(Form 990|Schedule [ID]|Derived)/.test((r.form_places as Record<string, string>)[k]))), JSON.stringify(figs[0]?.form_places).slice(0, 300));
    ok("figures: every named column in the reader's tables has a place", [...Object.keys(CHARITY_FIGURES), ...Object.keys(CHARITY_BOXES)].every((k) => figs.every((r) => k in (r.form_places as object))));
    const un = figs.find((r) => r.ein === EIN.hff)!;
    ok("a return with no Part IX line 1 stores null there, not zero", un.part_ix_line_1_grants_domestic_orgs_total_amt === null);
    ok("a return with no Schedule I says so and says that is not 'gave nothing'", un.has_schedule_i === false && /not one that gave nothing/.test(String(un.schedule_i_listed_derivation)) && Number(un.schedule_i_rows_listed_count) === 0 && un.schedule_i_cash_grants_listed_sum_amt === null);
    const pf = figs.find((r) => r.filing_object_id === ids.pumpAmend)!;
    ok("the derived Schedule I figures name the set they ranged over", Number(pf.schedule_i_rows_listed_count) === 10 && /10 recipient row\(s\) listed on Schedule I, Part II/.test(String(pf.schedule_i_listed_derivation)));
    const grants = await rowsOf(db, `select * from charity_reference_grants`);
    ok("grants: every row is Form 990, names Schedule I Part II as where it sat, and carries its filing and loader version", grants.length > 0 && grants.every((g) => g.form_type === "990" && /Schedule I \(Form 990\), Part II/.test(String(g.source_location)) && g.filing_object_id && g.loader_version));
    const daf = await rowsOf(db, `select * from charity_reference_daf_figures order by ein`);
    ok("donor advised fund figures: the sponsor's counts and totals as filed, each with its Schedule D place", daf.some((d) => d.ein === EIN.union && Number(d.daf_held_cnt) === 56 && Number(d.daf_grants_amt) === 1_238_732) && daf.every((d) => d.form_type === "990" && /Schedule D, Part I, line 1, column \(a\)/.test(String((d.form_places as Record<string, string>).daf_held_cnt))));
    ok("a Schedule D with no Part I figures is stored with nulls, not zeros", (() => { const d = daf.find((x) => x.filing_object_id === ids.pumpAmend); return !!d && d.daf_held_cnt === null && d.daf_grants_amt === null; })());
    ok("a return with no Schedule D produces no donor advised fund row at all, while one with a Schedule D does", (() => {
      const noD = parseReturn990(read(ID.hff).replace(/<IRS990ScheduleD[\s\S]*?<\/IRS990ScheduleD>/, ""));
      const prov = { runId: "00000000-0000-4000-8000-000000000000", loadedAt: new Date().toISOString(), loaderVersion: "t", archiveUrl: "u", member: "m", index: { returnId: null, ein: EIN.hff, taxPeriod: "202312", subYear: 2024, taxpayerName: "x", returnType: "990", objectId: ID.hff, batchId: null, indexFile: "i" } };
      const k = kindsForFunder([{ taxPeriodEnd: "2023-12-31", orgGrantsAmt: 200_000, dafHeldCnt: null, dafBox: true }], DEFAULT_CHARITY_THRESHOLD);
      return loadedCharityDoc(prov, noD, { sha256: "0".repeat(64), bytes: 1 }, k, DEFAULT_CHARITY_THRESHOLD).daf === null && loadedCharityDoc(prov, hff, { sha256: "0".repeat(64), bytes: 1 }, k, DEFAULT_CHARITY_THRESHOLD).daf !== null;
    })() && (await rowsOf(db, `select 1 from charity_reference_daf_figures where filing_object_id = $1`, [ID.hff])).length === 1);
    ok("a donor advised fund sponsor's recipients are its own grants: the grants rows hold no donor, advisor or fund column", !(await rowsOf(db, `select column_name from information_schema.columns where table_name = 'charity_reference_grants' and column_name ~* '(donor|advisor|fund)'`)).length);
    ok("every Schedule I row of the sponsor is stored under the sponsor's EIN", (await rowsOf(db, `select count(*)::int as n from charity_reference_grants where ein = $1`, [EIN.union]))[0].n === 17);
  }

  section("coverage says what is held and what is not; absence is never 'gave nothing'");
  {
    const cov = await rowsOf(db, `select ein, period_year, status, note from charity_reference_period_coverage order by ein, period_year`);
    const get = (ein: string, y: number) => cov.find((r) => r.ein === ein && r.period_year === y);
    ok("the 2022 and 2023 returns are held for the funder that has them", get(EIN.pump, 2022)?.status === "loaded" && get(EIN.pump, 2023)?.status === "loaded");
    ok("a 2024 return that could not be read is 'unread', not 'held' and not absent", get(EIN.pump, 2024)?.status === "unread", JSON.stringify(get(EIN.pump, 2024)));
    ok("a year with no return in the index is 'no_filing_in_index', worded as an absence in the data", get(EIN.union, 2022)?.status === "no_filing_in_index" && /absence in the data, not a statement that nothing was given/.test(String(get(EIN.union, 2022)?.note)));
    ok("coverage is written only for stored funders", cov.every((r) => [EIN.pump, EIN.union, EIN.hff].includes(String(r.ein))));
  }

  section("an unreadable return is recorded as unread, with the reason");
  {
    const un = await rowsOf(db, `select object_id, status, status_note from charity_reference_filings where status = 'unread' order by object_id`);
    ok("three unread filing rows, each with a reason", un.length === 3 && un.every((u) => String(u.status_note).length > 10), JSON.stringify(un));
    ok("the 990-PF-as-990 return names the type it found", un.some((u) => u.object_id === ids.pfAsCharity && /ReturnTypeCd is "990PF", not 990/.test(String(u.status_note))));
    ok("the malformed return says it is not well-formed", un.some((u) => u.object_id === ids.pump2024Broken && /not well-formed XML/.test(String(u.status_note))));
    ok("the return no archive holds says where it looked", un.some((u) => u.object_id === ids.ghost && /not found: no member named/.test(String(u.status_note))));
  }

  section("the run record holds the threshold, the rule, and the count just under it");
  {
    const run = (await rowsOf(db, `select parameters, counts, status, loader_version from funder_reference_runs where id = $1`, [run1.runId]))[0];
    const par = run.parameters as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cnt = run.counts as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("the run is recorded as this kind, completed, with its loader version", run.status === "completed" && par.kind === "public_charity_and_daf_sponsor" && par.returnType === "990" && run.loader_version === "funder-reference-loader/990-1.0.0");
    ok("the threshold is a recorded parameter", par.threshold.minOrgGrantsAmt === 100_000 && par.threshold.justUnderFromAmt === 50_000 && cnt.threshold.min_org_grants_amt === 100_000);
    ok("the rule is recorded in words on the run", /Part IX, line 1, column \(A\)/.test(par.rule) && /Schedule D, Part I, line 1, column \(a\)/.test(par.rule));
    ok("the count of funders just under the line is reported (the $80,000 trust)", cnt.funders_just_under_threshold === 1);
    ok("the forms not covered are stated", JSON.stringify(par.formsNotCovered) === JSON.stringify(["990-EZ", "990-N"]));
    ok("what the totals range over is named", /Form 990 returns with a tax period ending in 2022\/2023\/2024/.test(cnt.set));
    ok("returns that do not state the Part IX figure are counted, not treated as zero", cnt.returns_not_stating_part_ix_line_1_total >= 2 && cnt.returns_stating_part_ix_line_1_total >= 3 && cnt.funders_with_no_part_ix_line_1_total_in_any_return === 2);
    ok("a box ticked with no fund count on Schedule D is reported (and the funder is not stored)", cnt.funders_with_daf_box_but_no_schedule_d_fund_count === 1);
  }

  section("the loader run twice duplicates nothing; a resumed run reuses pass A");
  {
    const before = await dump(db);
    const run2 = await runCharityPipeline(sink, poolOf(world), params, silent);
    const after = await dump(db);
    ok("a second run changes no stored row (same dump)", before === after);
    ok("…it considered the same rows and wrote none of them again (all eight stored filing rows were found identical)", run2.counts.rows_written === 0 && run2.counts.rows_unchanged === 8, JSON.stringify({ w: run2.counts.rows_written, u: run2.counts.rows_unchanged }));
    ok("…and its pass A came from the cache of the first", run2.counts.pass_a_cache_hits > 0);
    ok("…and the outcomes still add up", run2.counts.outcomes_sum_check === true);
    ok("the row counts per table are exactly what the first run left", (await rowsOf(db, `select count(*)::int as n from charity_reference_filings`))[0].n === 8 && (await rowsOf(db, `select count(*)::int as n from charity_reference_organizations`))[0].n === 3);
    const dry = await runCharityPipeline(sink, poolOf(world), { ...params, dryRun: true }, silent);
    ok("a dry run writes nothing and reaches the same outcomes", dry.counts.outcomes_sum_check && (await dump(db)) === after && dry.counts.status_not_in_scope === 2);
    const rewrite = await runCharityPipeline(sink, poolOf(world), { ...params, rewriteAll: true }, silent);
    ok("rewrite-all writes every in-scope return again (needed after a threshold change) and still duplicates nothing", rewrite.counts.rows_unchanged === 0 && (await rowsOf(db, `select count(*)::int as n from charity_reference_organizations`))[0].n === 3 && (await rowsOf(db, `select count(*)::int as n from charity_reference_grants where ein = $1`, [EIN.union]))[0].n === 17);
  }

  section("a state run keeps only that state's filers (headers first, then the whole return)");
  {
    const w2 = buildWorld(CATALOG.filter((x) => [ID.pump, ID.corey, ID.union, ID.hff, ID.levy].includes(x.id)));
    const db2 = new PGlite();
    await bootDatabase(db2);
    const r = await runCharityPipeline(pgliteCharitySink(db2), poolOf(w2), { periodYears: [2022, 2023, 2024], state: "CA", threshold: DEFAULT_CHARITY_THRESHOLD, workDir: w2.workDir, rows: w2.rows, sources: [] }, silent);
    ok("only the two California filers are read; the other three are counted out of the state and stored nowhere", r.counts.out_of_scope_state === 3 && r.counts.funders_read === 2 && r.counts.status_loaded === 1 && r.counts.status_not_in_scope === 1 && r.counts.outcomes_sum_check, JSON.stringify(r.counts));
    ok("the run records the state it was for", ((await rowsOf(db2, `select parameters from funder_reference_runs`))[0].parameters as Record<string, unknown>).state === "CA");
    ok("a different state's return was not stored", (await rowsOf(db2, `select 1 from charity_reference_filings where ein = $1`, [EIN.union])).length === 0);
    await db2.close();
    rmSync(w2.tmp, { recursive: true, force: true });
  }

  section("a signed-in member can read the rows and cannot write one; anon can do neither");
  {
    const ORG = "a0000000-0000-4000-8000-000000000001";
    const MEMBER = "a1000000-0000-4000-8000-000000000001";
    await db.query(`insert into organizations (id, name) values ($1, 'Org A')`, [ORG]);
    await db.query(`insert into auth.users (id, email) values ($1, 'a1@test')`, [MEMBER]);
    await db.query(`insert into profiles (id, organization_id, email) values ($1, $2, 'a1@test')`, [MEMBER, ORG]);
    async function as<T>(role: string, uid: string | null, fn: () => Promise<T>): Promise<T> {
      await db.exec(`set role ${role}`);
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ""]);
      try {
        return await fn();
      } finally {
        await db.exec(`reset role`);
        await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
      }
    }
    const refused = async (q: string): Promise<string> => {
      try {
        await db.query(q);
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const member = await as("authenticated", MEMBER, async () => Promise.all(TABLES.map(async (t) => [t, ((await db.query(`select count(*)::int c from ${t}`)).rows[0] as { c: number }).c] as const)));
    ok("a member reads every charity table and finds rows in each", member.every(([, n]) => n > 0), JSON.stringify(member));
    const anon = await as("anon", null, () => Promise.all(TABLES.map((t) => refused(`select count(*) from ${t}`))));
    ok("anon is refused every read", anon.every((m) => m.length > 0));
    for (const stmt of [
      `insert into charity_reference_organizations (ein, source_object_id, source_tax_period_end, is_daf_sponsor, is_grantmaking_public_charity, kind_rule, kind_threshold_org_grants_amt, kind_basis, loaded_at, loader_version) values ('999999999', 'x', '2023-12-31', true, false, 'r', 1, '[]', now(), 'x')`,
      `update charity_reference_organizations set city = 'nowhere'`,
      `delete from charity_reference_grants`,
      `update charity_reference_figures set part_i_line_8_cy_contributions_grants_amt = 0`,
    ]) {
      const msg = await as("authenticated", MEMBER, () => refused(stmt));
      ok(`a member cannot: ${stmt.slice(0, 55)}...`, msg.length > 0 && /permission denied|row-level security/.test(msg), msg);
    }
    ok("neither anon nor a member can call the write function", (await as("authenticated", MEMBER, () => refused(`select charity_reference_apply_filing('{}'::jsonb)`))).length > 0 && (await as("anon", null, () => refused(`select charity_reference_apply_filing('{}'::jsonb)`))).length > 0);
    ok("nothing the member attempted changed a row", (await rowsOf(db, `select count(*)::int as n from charity_reference_organizations`))[0].n === 3 && (await rowsOf(db, `select count(*)::int as n from charity_reference_organizations where city = 'nowhere'`))[0].n === 0);
  }

  section("the loader's own constraints hold what the ruling forbids");
  {
    const r1 = await sink.applyFiling({ filing: { object_id: "999999999999999999", ein: "123456789", return_type: "990PF", index_tax_period: "202312", tax_period_end: "2023-12-31", status: "loaded", index_file: "i", document_archive_url: "u", document_member: "m", loaded_at: new Date().toISOString(), loader_version: "t" }, charity: null, figures: null, daf: null, grants: [] }).then(() => "", (e: Error) => e.message);
    ok("a filing row that says it is not a Form 990 is refused by the table", /return_type|check constraint/i.test(r1), r1);
    const real = parseReturn990(read(ID.union));
    const none = loadedCharityDoc({ runId: "00000000-0000-4000-8000-000000000000", loadedAt: new Date().toISOString(), loaderVersion: "t", archiveUrl: "u", member: "m", index: { returnId: null, ein: EIN.union, taxPeriod: "202312", subYear: 2024, taxpayerName: "x", returnType: "990", objectId: "999999999999999998", batchId: null, indexFile: "i" } }, real, { sha256: "0".repeat(64), bytes: 1 }, { ...kindsForFunder([{ taxPeriodEnd: "2023-12-31", orgGrantsAmt: 1, dafHeldCnt: 0, dafBox: false }], DEFAULT_CHARITY_THRESHOLD) }, DEFAULT_CHARITY_THRESHOLD);
    const r2 = await sink.applyFiling(none).then(() => "", (e: Error) => e.message);
    ok("a funder with neither label is refused by the table", /check constraint|violates/i.test(r2), r2);
  }
  await db.close();

  // ============================================================================ the entry point
  section("the entry point refuses what ruling 0047 clauses 6 and 7 forbid");
  {
    const tmp = mkdtempSync(join(tmpdir(), "public-charities-entry-"));
    const dbdir = join(tmp, "db");
    const idxdir = join(tmp, "index");
    mkdirSync(idxdir, { recursive: true });
    const pre = new PGlite(dbdir);
    await bootDatabase(pre);
    await pre.query(`insert into funder_reference_runs (loader_version, status, parameters) values ('funder-reference-loader/1.0.0', 'running', '{"state":"NY"}')`);
    await pre.close();
    const run = (args: string[], env: Record<string, string> = {}) => spawnSync("npx", ["tsx", join(root, "scripts/load-public-charities.ts"), "--work-dir", join(tmp, "work"), "--index-dir", idxdir, "--state", "CA", ...args], { encoding: "utf8", env: { ...process.env, ...env }, cwd: root });
    const a = run(["--target", `pglite:${dbdir}`]);
    ok("while a loader run is recorded as running it refuses and writes nothing (exit 3)", a.status === 3 && /refusing: 1 loader run\(s\) are recorded as running/.test(a.stderr + a.stdout), `${a.status} ${a.stderr.slice(0, 300)}`);
    // a full-database verification that has finished loading and is only re-reading filings writes nothing: it does not block
    const verifying = { full_verify: true };
    const vstates = { states: { CA: { status: "verifying" } } };
    ok("a read-only full verification (full_verify, every state 'verifying') does not count as a run in progress", isReadOnlyVerification({ parameters: verifying, counts: vstates }));
    ok("the same run while a state is still loading DOES count", !isReadOnlyVerification({ parameters: verifying, counts: { states: { CA: { status: "loading" }, NY: { status: "verifying" } } } }));
    ok("a run without full_verify, without state detail, or with an unreadable shape DOES count", !isReadOnlyVerification({ parameters: {}, counts: vstates }) && !isReadOnlyVerification({ parameters: verifying, counts: {} }) && !isReadOnlyVerification({ parameters: verifying, counts: null }) && !isReadOnlyVerification({ parameters: null, counts: null }) && !isReadOnlyVerification({ parameters: verifying, counts: { states: {} } }));
    const dbdir2 = join(tmp, "db2");
    const pre3 = new PGlite(dbdir2);
    await bootDatabase(pre3);
    await pre3.query(`insert into funder_reference_runs (loader_version, status, parameters, counts) values ('funder-reference-loader/1.0.0', 'running', '{"kind":"all_states_supervisor","full_verify":true}', '{"states":{"CA":{"status":"verifying"}}}')`);
    await pre3.close();
    const v = run(["--target", `pglite:${dbdir2}`]);
    ok("with only a read-only verification running, the entry point passes the guard (it goes on to the missing index files, not exit 3)", v.status !== 3 && !/refusing/.test(v.stderr + v.stdout) && /index_YYYY\.csv/.test(v.stderr + v.stdout), `${v.status} ${(v.stderr + v.stdout).slice(0, 300)}`);
    const b = run(["--target", "supabase"], { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" });
    ok("it refuses the real project without --confirm-write-to-supabase (exit 2)", b.status === 2 && /refusing: --target supabase writes to the real project/.test(b.stderr + b.stdout), `${b.status} ${b.stderr.slice(0, 300)}`);
    const d = run(["--target", "none"]);
    ok("--target none without --dry-run is refused", d.status === 2 && /only valid with --dry-run/.test(d.stderr + d.stdout), `${d.status} ${d.stderr.slice(0, 200)}`);
    const e = spawnSync("npx", ["tsx", join(root, "scripts/load-public-charities.ts"), "--work-dir", join(tmp, "work")], { encoding: "utf8", cwd: root });
    ok("it will not start without a state: the first trial is one state", e.status === 2 && /usage/.test(e.stderr + e.stdout));
    const pre2 = new PGlite(dbdir);
    await pre2.waitReady;
    ok("the refused runs wrote no charity row", ((await pre2.query(`select count(*)::int as n from charity_reference_filings`)).rows[0] as { n: number }).n === 0);
    await pre2.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  // ============================================================================ source scans
  section("nothing in the web application reaches these tables; no secret near the client (hard rule 5)");
  {
    const files = walk(root);
    const web = files.filter((f) => !f.startsWith(join(root, "scripts") + "/") && !f.startsWith(join(root, "lib/funder-reference") + "/"));
    const touching = web.filter((f) => /charity_reference|funder-reference\/(pipeline-990|sink-990|parse-990|document-990|charity-scope)/.test(readFileSync(f, "utf8")));
    ok(`none of the ${web.length} application source files (app/, components/, other lib/) mentions the new tables or imports the Form 990 loader (item 113's screen is NOT extended)`, touching.length === 0, touching.join(", "));
    const screen = files.filter((f) => f.startsWith(join(root, "app/(dashboard)/funders")) || /lib\/funder-reference\/(read|browse|access)\.ts$/.test(f));
    ok("the funder database screen and its reads do not mention the new tables", screen.every((f) => !/charity_reference/.test(readFileSync(f, "utf8"))));
    const lib = files.filter((f) => f.startsWith(join(root, "lib/funder-reference") + "/") && /(parse-990|charity-scope|document-990|sink-990|pipeline-990)\.ts$/.test(f));
    ok(`the ${lib.length} new library files import nothing from next or react, are not client components, and read no environment variable`, lib.length === 5 && lib.every((f) => { const s = readFileSync(f, "utf8"); return !/from ["'](next|react)/.test(s) && !/["']use client["']/.test(s) && !/process\.env/.test(s); }));
    const pf = readFileSync(join(root, "lib/funder-reference/pipeline.ts"), "utf8");
    ok("the Form 990-PF pipeline does not know the Form 990 pipeline exists", !/pipeline-990|parse-990\b|charity/i.test(pf.replace(/\/\/.*$/gm, "")));
    const sup = [join(root, "lib/funder-reference/supervisor.ts"), join(root, "scripts/load-all-states.ts"), join(root, "scripts/load-funder-reference.ts")];
    ok("the supervisor, the all-states command and the foundation loader do not reference the Form 990 loader", sup.every((f) => !/pipeline-990|load-public-charities|charity_reference/.test(readFileSync(f, "utf8"))));
    ok("only the two foundation scripts and the Form 990 entry point read the service key, and only from the environment", files.filter((f) => /SUPABASE_SERVICE_ROLE_KEY/.test(readFileSync(f, "utf8")) && /\/(load|verify)-(funder-reference|public-charities)/.test(f)).every((f) => /scripts\/(load|verify)-(funder-reference|public-charities)/.test(f)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  rmSync(world.tmp, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
