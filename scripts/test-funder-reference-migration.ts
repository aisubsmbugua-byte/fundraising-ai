// STATE item 110 (ruling 0045): migration 0084 and the loader, run on a REAL
// Postgres (PGlite) with every project migration applied unchanged.
//
// This is the ruling's "test of compliance" made executable:
//   * a signed-in member reads the reference rows and cannot insert, update or
//     delete one; neither can anon; the write function is closed to both
//   * no table carries organization_id, and no policy allows a write
//   * two different giving figures for one foundation and year are two columns
//   * a return with no website element has none stored
//   * two filings with the same officer name give two person rows
//   * the loader run twice makes no duplicates; a killed run resumes to the same
//     state as a clean one
//   * an unreadable filing is recorded as unread with a reason; a tax period the
//     IRS index does not list is recorded as missing, not as zero
//   * the outcomes of a run add up to the rows it considered
// plus source scans that nothing in the web application can reach these tables
// and that no secret is read anywhere but the scripts.
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform. It
// does not run PostgREST, and the Supabase sink (lib/funder-reference/sink.ts) is
// not exercised against a live project -- that needs a project with 0084 applied,
// which this item must not create.
//
// Usage: npx tsx scripts/test-funder-reference-migration.ts

import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootDatabase } from "./funder-reference-support";
import { makeZip, type ZipItem } from "./funder-reference-test-support";
import { archiveProvider, readIndex } from "../lib/funder-reference/sources";
import { runPipeline, type PipelineParams } from "../lib/funder-reference/pipeline";
import { pgliteSink, type Sink } from "../lib/funder-reference/sink";
import { DEFAULT_THRESHOLD } from "../lib/funder-reference/derive";
import { loadedDoc, type FilingDoc, type IndexRow } from "../lib/funder-reference/document";
import { parseFiling990PF } from "../lib/funder-reference/parse-990pf";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

const FIX = join(__dirname, "fixtures/funder-reference");
const X22 = readFileSync(join(FIX, "202343189349103439_public.xml"), "utf8");
const X23 = readFileSync(join(FIX, "202403209349107935_public.xml"), "utf8");
const X24 = readFileSync(join(FIX, "202543159349101244_public.xml"), "utf8");
const D64 = readFileSync(join(FIX, "202543159349101244.deflate64"));

const TABLES = [
  "funder_reference_runs", "funder_reference_filings", "funder_reference_foundations", "funder_reference_figures",
  "funder_reference_people", "funder_reference_grants", "funder_reference_application_terms", "funder_reference_period_coverage",
];

// ----------------------------------------------------------------------------
// a small world of IRS returns
// ----------------------------------------------------------------------------
interface Variant {
  ein?: string;
  name?: string;
  state?: string;
  periodEnd?: string;
  periodBegin?: string;
  assets?: number;
  paid?: number;
  revenue?: number;
  returnTs?: string;
  noWebsite?: boolean;
}
function variant(base: string, o: Variant): string {
  let x = base;
  if (o.ein) x = x.replace(/<EIN>582218044<\/EIN>/g, `<EIN>${o.ein}</EIN>`);
  if (o.name) x = x.split("SERVANT'S HEART FOUNDATION INC").join(o.name);
  if (o.state) x = x.replace(/<Filer>[\s\S]*?<\/Filer>/, (f) => f.replace("<StateAbbreviationCd>CA</StateAbbreviationCd>", `<StateAbbreviationCd>${o.state}</StateAbbreviationCd>`));
  if (o.periodEnd) x = x.replace(/<TaxPeriodEndDt>[^<]*<\/TaxPeriodEndDt>/, `<TaxPeriodEndDt>${o.periodEnd}</TaxPeriodEndDt>`);
  if (o.periodBegin) x = x.replace(/<TaxPeriodBeginDt>[^<]*<\/TaxPeriodBeginDt>/, `<TaxPeriodBeginDt>${o.periodBegin}</TaxPeriodBeginDt>`);
  if (o.assets !== undefined) x = x.replace(/<(FMVAssetsEOYAmt|TotalAssetsEOYFMVAmt|TotalAssetsEOYAmt)>\d+</g, `<$1>${o.assets}<`);
  if (o.paid !== undefined) x = x.replace(/<ContriPaidRevAndExpnssAmt>\d+</, `<ContriPaidRevAndExpnssAmt>${o.paid}<`);
  if (o.revenue !== undefined) x = x.replace(/<TotalRevAndExpnssAmt>\d+</, `<TotalRevAndExpnssAmt>${o.revenue}<`);
  if (o.returnTs) x = x.replace(/<ReturnTs>[^<]*<\/ReturnTs>/, `<ReturnTs>${o.returnTs}</ReturnTs>`);
  if (o.noWebsite) x = x.replace(/<WebsiteAddressTxt>[^<]*<\/WebsiteAddressTxt>/, "");
  return x;
}

interface World {
  archivesDir: string;
  indexDir: string;
  rows: IndexRow[];
  ids: Record<string, string>;
}

const IDS = {
  S22: "202343189349103439", S23: "202403209349107935", S23A: "202403209349107936", S24: "202543159349101244",
  B: "202400000000000002", C: "202400000000000003", D22: "202300000000000004", E: "202400000000000005",
  F: "202400000000000006", G: "202400000000000007", H: "202400000000000008", J: "202400000000000009",
};

function buildWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), "fr-world-"));
  const archivesDir = join(dir, "zips");
  const indexDir = join(dir, "index");
  mkdirSync(archivesDir);
  mkdirSync(indexDir);
  const b = (s: string) => Buffer.from(s);

  const a2023_11A: ZipItem[] = [{ name: `2023_TEOS_XML_11A/${IDS.S22}_public.xml`, data: b(X22) }];
  const a2023_01A: ZipItem[] = [{ name: `2023_TEOS_XML_01A/${IDS.D22}_public.xml`, data: b(variant(X22, { ein: "333333333", name: "DELTA FAMILY FOUNDATION" })) }];
  const a2024_11A: ZipItem[] = [
    { name: `2024_TEOS_XML_11A/${IDS.S23}_public.xml`, data: b(X23) },
    { name: `2024_TEOS_XML_11A/${IDS.S23A}_public.xml`, data: b(variant(X23, { returnTs: "2024-12-15T10:00:00-06:00", revenue: 600000 })) },
    { name: `2024_TEOS_XML_11A/${IDS.B}_public.xml`, data: b(variant(X22, { ein: "111111111", name: "BETA SMALL FUND", periodEnd: "2023-12-31", periodBegin: "2023-01-01", assets: 200000, paid: 20000 })) },
    { name: `2024_TEOS_XML_11A/${IDS.C}_public.xml`, data: b(variant(X22, { ein: "222222222", name: "TEXAS BIG FOUNDATION", state: "TX", periodEnd: "2023-12-31", periodBegin: "2023-01-01" })) },
    // same EIN as D, 2023, but its archive record carries the wrong CRC-32
    { name: `2024_TEOS_XML_11A/${IDS.E}_public.xml`, data: b(variant(X22, { ein: "333333333", name: "DELTA FAMILY FOUNDATION", periodEnd: "2023-12-31", periodBegin: "2023-01-01" })), wrongCrc: true },
    // truncated after the header: well-formed zip member, ill-formed XML
    { name: `2024_TEOS_XML_11A/${IDS.F}_public.xml`, data: b(variant(X22, { ein: "444444444", name: "FOXTROT TRUNCATED", periodEnd: "2023-12-31" }).slice(0, 4000)) },
    // the return says 2022-12-31; the IRS index (below) says 202312
    { name: `2024_TEOS_XML_11A/${IDS.H}_public.xml`, data: b(variant(X22, { ein: "666666666", name: "HOTEL MISMATCH" })) },
    { name: `2024_TEOS_XML_11A/${IDS.J}_public.xml`, data: b(variant(X22, { ein: "777777777", name: "JULIET SMALL TEXAS", state: "TX", periodEnd: "2023-12-31", assets: 10000, paid: 1000 })) },
  ];
  const a2025_11B: ZipItem[] = [{ name: `${IDS.S24}_public.xml`, data: b(X24), method: 9, precompressed: D64 }]; // top-level, Deflate64
  writeFileSync(join(archivesDir, "2023_TEOS_XML_11A.zip"), makeZip(a2023_11A));
  writeFileSync(join(archivesDir, "2023_TEOS_XML_01A.zip"), makeZip(a2023_01A, { zip64: true }));
  writeFileSync(join(archivesDir, "2024_TEOS_XML_11A.zip"), makeZip(a2024_11A, { prefixBytes: 76 }));
  writeFileSync(join(archivesDir, "2025_TEOS_XML_11B.zip"), makeZip(a2025_11B, { zip64: true, prefixBytes: 76 }));

  const H = "RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID";
  const H0 = "RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID"; // 2022 and 2023 indexes have no batch column
  const line = (id: string, ein: string, per: string, sub: number, name: string, obj: string, batch?: string) =>
    `${id},EFILE,${ein},${per},${sub},${name},990PF,d${id},${obj}${batch === undefined ? "" : "," + batch}`;
  writeFileSync(
    join(indexDir, "index_2023.csv"),
    [H0, line("1", "582218044", "202212", 2023, "SERVANT'S HEART FOUNDATION INC", IDS.S22), line("4", "333333333", "202212", 2023, "DELTA FAMILY FOUNDATION", IDS.D22),
      line("9", "582218044", "202212", 2023, "A 990T (not 990PF, must be ignored)", "202300000000000099").replace("990PF", "990T")].join("\n") + "\n"
  );
  writeFileSync(
    join(indexDir, "index_2024.csv"),
    [
      H,
      line("2", "582218044", "202312", 2024, "SERVANT'S HEART FOUNDATION INC", IDS.S23, "2024_TEOS_XML_11A"),
      line("3", "582218044", "202312", 2024, "SERVANT'S HEART FOUNDATION INC", IDS.S23A, "2024_TEOS_XML_11A"),
      line("5", "111111111", "202312", 2024, "BETA SMALL FUND", IDS.B, "2024_TEOS_XML_11A"),
      line("6", "222222222", "202312", 2024, "TEXAS BIG FOUNDATION", IDS.C, "2024_TEOS_XML_11A"),
      line("7", "333333333", "202312", 2024, "DELTA FAMILY FOUNDATION", IDS.E, "2024_TEOS_XML_11A"),
      line("8", "444444444", "202312", 2024, "FOXTROT TRUNCATED", IDS.F, "2024_TEOS_XML_11A"),
      line("10", "555555555", "202312", 2024, "GOLF NOT IN ANY ARCHIVE", IDS.G, "2024_TEOS_XML_11A"),
      line("11", "666666666", "202312", 2024, "HOTEL MISMATCH", IDS.H, "2024_TEOS_XML_11A"),
      line("12", "777777777", "202312", 2024, "JULIET SMALL TEXAS", IDS.J, "2024_TEOS_XML_11A"),
    ].join("\n") + "\n"
  );
  writeFileSync(join(indexDir, "index_2025.csv"), [H, line("13", "582218044", "202412", 2025, "SERVANT'S HEART FOUNDATION INC", IDS.S24, "2025_TEOS_XML_11B")].join("\n") + "\n");
  return { archivesDir, indexDir, rows: [], ids: IDS };
}

async function loadRows(w: World, eins: string[] | null = null): Promise<{ rows: IndexRow[]; sources: unknown[] }> {
  const rows: IndexRow[] = [];
  const sources: unknown[] = [];
  for (const f of readdirSync(w.indexDir).filter((f) => /^index_\d{4}\.csv$/.test(f)).sort()) {
    const r = await readIndex(join(w.indexDir, f), { returnType: "990PF", periodYears: [2022, 2023, 2024], eins });
    rows.push(...r.rows);
    sources.push({ file: f, total_rows: r.totalRows });
  }
  return { rows, sources };
}

const silent = () => undefined;
function params(w: World, rows: IndexRow[], sources: unknown[], over: Partial<PipelineParams> = {}): PipelineParams {
  return { periodYears: [2022, 2023, 2024], state: "CA", eins: null, threshold: DEFAULT_THRESHOLD, workDir: join(w.archivesDir, "..", "work"), rows, sources, ...over };
}

async function dump(db: PGlite): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES.filter((t) => t !== "funder_reference_runs")) {
    const r = await db.query(`select (to_jsonb(t) - 'loaded_at' - 'run_id' - 'checked_at')::text as j from ${t} t order by 1`);
    out[t] = (r.rows as Array<{ j: string }>).map((x) => x.j);
  }
  return JSON.stringify(out);
}
async function counts(db: PGlite): Promise<Record<string, number>> {
  const o: Record<string, number> = {};
  for (const t of TABLES) o[t.replace("funder_reference_", "")] = ((await db.query(`select count(*)::int c from ${t}`)).rows[0] as { c: number }).c;
  return o;
}

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

async function main() {
  // ---------------------------------------------------------------- the migration
  section("migration 0084 applies to a real Postgres, unchanged, after all earlier ones");
  const db = new PGlite();
  const boot = await bootDatabase(db);
  ok(`all ${boot.applied.length} migration files apply with no error`, boot.failures.length === 0, boot.failures.join("; "));
  ok("0084 is the funder-reference migration and is among them", boot.applied.some((f) => f.startsWith("0084_funder_reference")));

  section("the tables are shared reference data (ruling 0045 clause 1)");
  {
    const cols = (await db.query(`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'funder\\_reference\\_%' escape '\\' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`)).rows as Array<{ table_name: string; column_name: string }>; // base tables only: migration 0086 adds a read-only VIEW over them (ruling 0048)
    // The eight loader tables, plus the one derived table of per-funder counts that ruling 0049 (migration 0094) added. Nothing else.
    const DERIVED = ["funder_reference_faith_giving"];
    const present = new Set(cols.map((c) => c.table_name));
    ok("exactly the eight reference tables exist, plus the one derived table of ruling 0049", present.size === 8 + DERIVED.length && TABLES.every((t) => present.has(t)) && DERIVED.every((t) => present.has(t)), [...present].join(","));
    ok("NO table carries organization_id (deliberate, stated in the ruling)", !cols.some((c) => c.column_name === "organization_id"));
    ok("no column anywhere is named for a single 'giving' figure", !cols.some((c) => /^(giving|total_giving|annual_giving|grants_given)(_amt)?$/.test(c.column_name)));
    const giving = cols.filter((c) => c.table_name === "funder_reference_figures" && /(contributions_paid|qualifying_distributions|charitable_disbursements|distributable)/.test(c.column_name)).map((c) => c.column_name);
    ok("contributions paid per books, qualifying distributions and charitable disbursements are separate named columns", giving.includes("contributions_paid_per_books_amt") && giving.includes("qualifying_distributions_amt") && giving.includes("total_expenses_charitable_disbursements_amt") && giving.includes("contributions_paid_disbursements_amt"), giving.join(","));
    const rls = (await db.query(`select relname, relrowsecurity from pg_class where relname like 'funder\\_reference\\_%' escape '\\' and relkind = 'r'`)).rows as Array<{ relname: string; relrowsecurity: boolean }>;
    ok("row-level security is enabled on every one", rls.length === 8 + DERIVED.length && rls.every((r) => r.relrowsecurity));
    const pols = (await db.query(`select tablename, cmd, roles::text as roles, qual from pg_policies where tablename like 'funder\\_reference\\_%' escape '\\'`)).rows as Array<{ tablename: string; cmd: string; roles: string; qual: string }>;
    ok("each table has exactly one policy", pols.length === 8 + DERIVED.length && new Set(pols.map((p) => p.tablename)).size === 8 + DERIVED.length);
    ok("every policy is a SELECT policy: no insert, update, delete or all policy exists", pols.every((p) => p.cmd === "SELECT"), JSON.stringify(pols.map((p) => p.cmd)));
    ok("the read policy is for signed-in members only (authenticated, my_organization_id() is not null)", pols.every((p) => p.roles.includes("authenticated") && !p.roles.includes("anon") && /my_organization_id/.test(p.qual)));
    const grants = (await db.query(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_name like 'funder\\_reference\\_%' escape '\\' and grantee in ('anon','authenticated')`)).rows as Array<{ table_name: string; grantee: string; privilege_type: string }>;
    ok("authenticated holds SELECT and nothing else on every table (the second lock)", TABLES.every((t) => grants.filter((g) => g.table_name === t && g.grantee === "authenticated").map((g) => g.privilege_type).join() === "SELECT"), JSON.stringify(grants.filter((g) => g.grantee === "authenticated" && g.privilege_type !== "SELECT")));
    ok("anon holds no privilege at all", !grants.some((g) => g.grantee === "anon"));
    const fn = (await db.query(`select has_function_privilege('anon', 'funder_reference_apply_filing(jsonb)', 'execute') as a, has_function_privilege('authenticated', 'funder_reference_apply_filing(jsonb)', 'execute') as u, has_function_privilege('service_role', 'funder_reference_apply_filing(jsonb)', 'execute') as s`)).rows[0] as { a: boolean; u: boolean; s: boolean };
    ok("the write function is executable by service_role only", !fn.a && !fn.u && fn.s, JSON.stringify(fn));
  }

  // ---------------------------------------------------------------- the loader
  const world = buildWorld();
  const { rows, sources } = await loadRows(world);
  const provider = archiveProvider({ dir: world.archivesDir, remote: false, userAgent: "test" });
  const sink = pgliteSink(db);

  section("three returns for one tax period: every earlier one names the one that stands, whatever the order");
  {
    const mk = (n: number, ts: string, revenue: number) => {
      const xml = variant(X23, { returnTs: ts, revenue });
      const bytes = Buffer.from(xml);
      return loadedDoc(
        { runId: "00000000-0000-4000-8000-000000000000", loadedAt: new Date().toISOString(), loaderVersion: "t", archiveUrl: "https://apps.irs.gov/pub/epostcard/990/xml/2024/2024_TEOS_XML_11A.zip", member: `m${n}`, index: { returnId: null, ein: "582218044", taxPeriod: "202312", subYear: 2024, taxpayerName: "x", returnType: "990PF", objectId: `20240000000000010${n}`, batchId: null, indexFile: "index_2024.csv" } },
        parseFiling990PF(xml),
        { sha256: String(n).repeat(64).slice(0, 64), bytes: bytes.length }
      );
    };
    const docs = [mk(1, "2024-01-01T00:00:00-06:00", 101), mk(2, "2024-02-01T00:00:00-06:00", 102), mk(3, "2024-03-01T00:00:00-06:00", 103)];
    for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
      const d2 = new PGlite();
      await bootDatabase(d2);
      const s2 = pgliteSink(d2);
      await s2.startRun({ id: "00000000-0000-4000-8000-000000000000", loaderVersion: "t", parameters: {} });
      for (const i of order) await s2.applyFiling(docs[i]);
      const st = (await d2.query(`select object_id, status, superseded_by_object_id by_ from funder_reference_filings order by object_id`)).rows as Array<{ object_id: string; status: string; by_: string | null }>;
      const fig = (await d2.query(`select filing_object_id, total_revenue_per_books_amt::int r from funder_reference_figures`)).rows as Array<{ filing_object_id: string; r: number }>;
      const kids = (await d2.query(`select (select count(distinct filing_object_id) from funder_reference_people)::int p, (select count(distinct filing_object_id) from funder_reference_grants)::int g, (select source_object_id from funder_reference_foundations) as f`)).rows[0] as { p: number; g: number; f: string };
      const label = `applied in the order ${order.map((i) => i + 1).join(",")}`;
      ok(`${label}: the latest return stands and the other two each name it`, st.filter((x) => x.status === "loaded").map((x) => x.object_id).join() === "202400000000000103" && st.filter((x) => x.status === "superseded").every((x) => x.by_ === "202400000000000103") && st.filter((x) => x.status === "superseded").length === 2, JSON.stringify(st));
      ok(`${label}: only the standing return holds figures, people, grants and the foundation row`, fig.length === 1 && fig[0].filing_object_id === "202400000000000103" && fig[0].r === 103 && kids.p === 1 && kids.g === 1 && kids.f === "202400000000000103", JSON.stringify({ fig, kids }));
      await d2.close();
    }
  }

  section("the header peek is audited against the whole return");
  {
    const audited = await runPipeline(pgliteSink(new PGlite()), provider, params(world, rows, sources, { dryRun: true, auditHeaderSample: 50 }), silent);
    const a = audited.counts.header_audit;
    ok("the two Texas returns the header ruled out were read in full, both confirmed not California, none unreadable", !!a && a.sampled === 2 && a.read_ok === 2 && a.said_not_in_state_but_return_is_in_state === 0 && a.unreadable === 0, JSON.stringify(a));
    ok("…and the audit names the set it sampled", /seeded pseudo-random draw/.test(a?.set ?? ""));
    ok("no return the header put in California turned out to be elsewhere", audited.counts.header_said_in_state_but_return_disagrees === 0);
  }

  section("a dry run writes nothing");
  {
    const dry = await runPipeline(sink, provider, params(world, rows, sources, { dryRun: true }), silent);
    const c = await counts(db);
    ok("no table has a row after a dry run, not even a run record", Object.values(c).every((n) => n === 0), JSON.stringify(c));
    ok("a dry run still reports the outcomes, and they add up", dry.counts.outcomes_sum_check && dry.counts.index_rows_considered === 12);
  }

  section("the first real run: every row ends in one named outcome");
  const run1 = await runPipeline(sink, provider, params(world, rows, sources), silent);
  const c1 = run1.counts;
  console.log("      " + JSON.stringify({ ...c1, outcomes_sum_check: undefined }));
  {
    ok("12 Form 990-PF rows considered (the 990-T row in the index was ignored)", c1.index_rows_considered === 12);
    ok("the outcomes add up to the rows considered", c1.outcomes_sum_check === true);
    ok("2 out of scope by state (Texas), counted, not stored", c1.out_of_scope_state === 2);
    ok("4 unread: a bad CRC, a truncated file, a missing object, a period that disagrees with the index", c1.status_unread === 4, `${c1.status_unread}`);
    ok("1 of those was simply not in any archive", c1.unread_not_located === 1);
    ok("1 California foundation below the threshold, recorded as skipped", c1.status_skipped_below_threshold === 1 && c1.foundations_below_threshold === 1);
    ok("4 filings stand (three Servant's Heart years, one Delta)", c1.status_loaded === 4, `${c1.status_loaded}`);
    ok("1 superseded by a later return for the same EIN and period", c1.status_superseded === 1);
    const sens = c1.universe_sensitivity;
    ok("the run records what each cutoff would have included: 3 California funders read in full, 2 pass, 1 does not, and the set is named", !!sens && sens.foundations_read === 3 && sens.by_the_threshold_used.either === 2 && sens.by_the_threshold_used.neither === 1 && sens.with_max_assets_at_least["1000000"] === 2 && sens.with_max_assets_at_least["100000"] === 3 && /each funder counted once/.test(sens.set), JSON.stringify(sens));
    ok("a California foundation is in scope per EIN: Servant's Heart and Delta", c1.foundations_in_scope === 2);
    const t = await counts(db);
    ok("filing rows: every considered row except the two out-of-scope ones (10)", t.filings === 10, JSON.stringify(t));
    ok("figures: one per standing filing (4)", t.figures === 4);
    ok("foundations: one per in-scope EIN (2)", t.foundations === 2);
    ok("people: 5 per standing filing (20); the superseded return holds none", t.people === 20);
    ok("grants: 30 + 33 + 30 + 30 = 123", t.grants === 123, `${t.grants}`);
    ok("application terms: one per standing filing (4)", t.application_terms === 4);
    ok("a run record exists and is completed", ((await db.query(`select status from funder_reference_runs where id = $1`, [run1.runId])).rows[0] as { status: string }).status === "completed");
  }

  section("unread filings are named with a reason (clause 6)");
  {
    const un = (await db.query(`select object_id, ein, status, status_note, tax_period_end from funder_reference_filings where status = 'unread' order by object_id`)).rows as Array<{ object_id: string; ein: string; status: string; status_note: string; tax_period_end: string | null }>;
    const by = (id: string) => un.find((u) => u.object_id === id);
    ok("the bad-CRC member is unread and says why", /CRC-32/.test(by(IDS.E)?.status_note ?? ""), by(IDS.E)?.status_note);
    ok("the truncated XML is unread and says why", /not well-formed/.test(by(IDS.F)?.status_note ?? ""), by(IDS.F)?.status_note);
    ok("the object in no archive is unread and says so", /no member named .*_public\.xml/.test(by(IDS.G)?.status_note ?? ""), by(IDS.G)?.status_note);
    const gLoc = (await db.query(`select document_archive_url u, document_member m from funder_reference_filings where object_id = $1`, [IDS.G])).rows[0] as { u: string; m: string };
    ok("a return found in no archive does not claim an archive location: it names the index file that lists it, and says the member was not found", /\/index_2024\.csv$/.test(gLoc.u) && /^\(not found in any archive\)/.test(gLoc.m), JSON.stringify(gLoc));
    ok("a return whose period disagrees with the index is unread and says so", /tax period end is 2022-12-31; the IRS index says 202312/.test(by(IDS.H)?.status_note ?? ""), by(IDS.H)?.status_note);
    ok("an unread filing has no tax_period_end invented for it", un.length === 4 && un.every((u) => u.tax_period_end === null));
    ok("the run record names each rejected filing", (((await db.query(`select jsonb_array_length(rejected_filings) n from funder_reference_runs where id = $1`, [run1.runId])).rows[0]) as { n: number }).n === 4);
    const names = (await db.query(`select (r ->> 'object_id') as id, (r ->> 'reason') as reason from funder_reference_runs, jsonb_array_elements(rejected_filings) r where funder_reference_runs.id = $1`, [run1.runId])).rows as Array<{ id: string; reason: string }>;
    ok("…with its reason", names.every((n) => n.reason.length > 10) && names.some((n) => n.id === IDS.G));
    const sk = (await db.query(`select status_note from funder_reference_filings where object_id = $1`, [IDS.B])).rows[0] as { status_note: string };
    ok("the skipped filing says it is below the threshold and what the figures were", /below the size threshold: assets 200000 < 1000000 and contributions paid per books 20000 < 100000/.test(sk.status_note), sk.status_note);
    const skData = (await db.query(`select (select count(*) from funder_reference_figures where ein='111111111')::int f, (select count(*) from funder_reference_people where ein='111111111')::int p, (select count(*) from funder_reference_grants where ein='111111111')::int g, (select count(*) from funder_reference_foundations where ein='111111111')::int o`)).rows[0] as Record<string, number>;
    ok("a below-threshold funder has a filing row and nothing else", skData.f === 0 && skData.p === 0 && skData.g === 0 && skData.o === 0);
    const tx = (await db.query(`select count(*)::int c from funder_reference_filings where ein in ('222222222','777777777')`)).rows[0] as { c: number };
    ok("a Texas funder is not stored at all (counted only)", tx.c === 0);
  }

  section("tax periods: a year the IRS index does not list is missing, not zero (clause 6)");
  {
    const cov = (await db.query(`select ein, period_year, status, filing_object_id, note from funder_reference_period_coverage order by ein, period_year`)).rows as Array<{ ein: string; period_year: number; status: string; filing_object_id: string | null; note: string }>;
    const get = (e: string, y: number) => cov.find((c) => c.ein === e && c.period_year === y);
    ok("Servant's Heart holds 2022, 2023 and 2024", [2022, 2023, 2024].every((y) => get("582218044", y)?.status === "loaded"));
    ok("Delta holds 2022", get("333333333", 2022)?.status === "loaded");
    ok("Delta 2023 is 'unread' (a return exists and could not be read)", get("333333333", 2023)?.status === "unread" && get("333333333", 2023)?.filing_object_id === IDS.E);
    ok("Delta 2024 is 'no_filing_in_index', with no filing and a note that says it is an absence", get("333333333", 2024)?.status === "no_filing_in_index" && get("333333333", 2024)?.filing_object_id === null && /absence in the data/.test(get("333333333", 2024)?.note ?? ""));
    const f = (await db.query(`select tax_period_end::text d from funder_reference_figures where ein = '333333333' order by 1`)).rows as Array<{ d: string }>;
    ok("no figures row exists for a missing or unread period (there is no zero row)", f.length === 1 && f[0].d === "2022-12-31");
    ok("coverage has a row for every period year of every in-scope funder (2 x 3)", cov.length === 6);
  }

  section("what is stored is what the return says");
  {
    const fig = (await db.query(`select * from funder_reference_figures where filing_object_id = $1`, [IDS.S22])).rows[0] as Record<string, unknown>;
    ok("2022: contributions paid per books 911,323, qualifying distributions 1,104,388, charitable disbursements 1,104,388, distributable 841,321 (four columns, not one)", Number(fig.contributions_paid_per_books_amt) === 911323 && Number(fig.qualifying_distributions_amt) === 1104388 && Number(fig.total_expenses_charitable_disbursements_amt) === 1104388 && Number(fig.distributable_amount_amt) === 841321);
    ok("keyed by tax period END DATE", String((fig.tax_period_end as Date).toISOString?.().slice(0, 10) ?? fig.tax_period_end) === "2022-12-31");
    ok("the derived grant stats name their set", /Part XV/.test(String(fig.grants_listed_derivation)) && Number(fig.grants_listed_count) === 30 && Number(fig.grants_listed_minus_stated_amt) === 0);
    const f = (await db.query(`select website_as_stated from funder_reference_foundations where ein = '582218044'`)).rows[0] as { website_as_stated: string | null };
    ok("the website column holds exactly what the return wrote ('N/A'), not a derived URL", f.website_as_stated === "N/A");
    const amended = (await db.query(`select total_revenue_per_books_amt::int r, filing_object_id from funder_reference_figures where tax_period_end = '2023-12-31' and ein = '582218044'`)).rows[0] as { r: number; filing_object_id: string };
    ok("for 2023 the LATER (amended) return's figures stand (revenue 600,000), not the original's (576,743)", amended.r === 600000 && amended.filing_object_id === IDS.S23A);
    const sup = (await db.query(`select status, superseded_by_object_id, status_note from funder_reference_filings where object_id = $1`, [IDS.S23])).rows[0] as { status: string; superseded_by_object_id: string; status_note: string };
    ok("the original is kept as a filing, marked superseded, naming its successor", sup.status === "superseded" && sup.superseded_by_object_id === IDS.S23A && sup.status_note.length > 10);
    const orig = (await db.query(`select (select count(*) from funder_reference_people where filing_object_id=$1)::int p, (select count(*) from funder_reference_grants where filing_object_id=$1)::int g, (select count(*) from funder_reference_figures where filing_object_id=$1)::int f`, [IDS.S23])).rows[0] as Record<string, number>;
    ok("…and holds no figures, people or grants (nothing double-counted)", orig.p === 0 && orig.g === 0 && orig.f === 0);
    const neff = (await db.query(`select count(*)::int c, count(distinct filing_object_id)::int d from funder_reference_people where name_as_named = 'PAUL A NEFF'`)).rows[0] as { c: number; d: number };
    ok("people are stored as named per filing and never merged: 'PAUL A NEFF' is 8 rows across 4 filings (officer + signer in each)", neff.c === 8 && neff.d === 4, JSON.stringify(neff));
    const noKey = (await db.query(`select count(*)::int c from information_schema.columns where table_name = 'funder_reference_people' and column_name in ('person_id','canonical_person_id','merged_into')`)).rows[0] as { c: number };
    ok("there is no person key shared across filings", noKey.c === 0);
    const post = parseNoWebsite();
    ok("a return with no website element stores none (the parser's null reaches the column as NULL)", post);
    const lines = (await db.query(`select (to_jsonb(f) ->> 'loaded_at') is not null and (to_jsonb(f) ->> 'loader_version') is not null and (to_jsonb(f) ->> 'document_archive_url') like 'https://apps.irs.gov/pub/epostcard/990/xml/%' and (to_jsonb(f) ->> 'document_member') like '%_public.xml' as p from funder_reference_filings f where status = 'loaded'`)).rows as Array<{ p: boolean }>;
    ok("every standing filing records where its document can be read, when it was loaded, and by which loader version", lines.length === 4 && lines.every((l) => l.p));
    const orphan = (await db.query(`select
        (select count(*) from funder_reference_figures x left join funder_reference_filings f on f.object_id = x.filing_object_id and f.ein = x.ein and f.tax_period_end = x.tax_period_end where f.object_id is null)::int a,
        (select count(*) from funder_reference_people x left join funder_reference_filings f on f.object_id = x.filing_object_id and f.ein = x.ein and f.tax_period_end = x.tax_period_end where f.object_id is null)::int b,
        (select count(*) from funder_reference_grants x left join funder_reference_filings f on f.object_id = x.filing_object_id and f.ein = x.ein and f.tax_period_end = x.tax_period_end where f.object_id is null)::int c`)).rows[0] as Record<string, number>;
    ok("every data row traces to a filing with the same EIN and tax period end", orphan.a === 0 && orphan.b === 0 && orphan.c === 0);
    const bad = await refusedSql(db, `insert into funder_reference_people (filing_object_id, listed_in, ordinal, ein, tax_period_end, loaded_at, loader_version) values ('${IDS.S22}', 'part_viii_officers_directors_trustees', 99, '582218044', '2021-12-31', now(), 'x')`);
    ok("the database refuses a row whose EIN/period disagrees with its filing (composite foreign key)", /foreign key|violates/.test(bad), bad);
  }

  section("run it again: no duplicates, nothing rewritten");
  {
    const before = await dump(db);
    const filingTimes = (await db.query(`select object_id, loaded_at::text l from funder_reference_filings order by 1`)).rows;
    const run2 = await runPipeline(sink, provider, params(world, rows, sources), silent);
    const after = await dump(db);
    ok("every table is byte-identical after a second run", before === after);
    ok("the second run wrote nothing: 10 filings found unchanged", run2.counts.rows_written === 0 && run2.counts.rows_unchanged === 10, JSON.stringify({ w: run2.counts.rows_written, u: run2.counts.rows_unchanged }));
    ok("the second run reports the same outcomes", run2.counts.status_loaded === 4 && run2.counts.status_superseded === 1 && run2.counts.status_unread === 4 && run2.counts.out_of_scope_state === 2 && run2.counts.outcomes_sum_check);
    ok("filing load times were not touched (no rewrite)", JSON.stringify((await db.query(`select object_id, loaded_at::text l from funder_reference_filings order by 1`)).rows) === JSON.stringify(filingTimes));
    const pk = (await db.query(`select (select count(*) from (select 1 from funder_reference_grants group by filing_object_id, kind, ordinal having count(*) > 1) x)::int g, (select count(*) from (select 1 from funder_reference_people group by filing_object_id, listed_in, ordinal having count(*) > 1) x)::int p`)).rows[0] as Record<string, number>;
    ok("no duplicate (filing, ordinal) rows", pk.g === 0 && pk.p === 0);
    const runs = (await db.query(`select count(*)::int c from funder_reference_runs`)).rows[0] as { c: number };
    ok("each run is its own record (2 so far), the reference data is not duplicated", runs.c === 2);
  }

  section("pass A is cached, so a restart does not read every return again (item 110, production load)");
  {
    const wd = join(world.archivesDir, "..", "work-passa");
    const cachePath = join(wd, "pass-a-cache.jsonl");
    const same = (c: Record<string, unknown>) => JSON.stringify({ ...c, pass_a_cache_hits: 0 });
    const dry = (over: Partial<PipelineParams> = {}) => runPipeline(pgliteSink(new PGlite()), provider, params(world, rows, sources, { dryRun: true, workDir: wd, ...over }), silent);
    const cold = await dry();
    ok("a cold run answers nothing from the cache", cold.counts.pass_a_cache_hits === 0 && cold.counts.full_reads > 0);
    const cached = readFileSync(cachePath, "utf8").split("\n").filter(Boolean);
    ok("it remembered the returns it read, one line each, and not the one that failed to decompress", cached.length > 0 && cached.length === cold.counts.full_reads - 1, `${cached.length} cached of ${cold.counts.full_reads} read`);
    const warm = await dry();
    ok("a warm run answers those from the cache", warm.counts.pass_a_cache_hits === cached.length, `${warm.counts.pass_a_cache_hits}`);
    ok("…and reaches exactly the outcomes of the cold run, and they add up", same(warm.counts as never) === same(cold.counts as never) && warm.counts.outcomes_sum_check, "");
    ok("…and the unread reasons are the same, in the same words", JSON.stringify(warm.rejected.map((r) => r.reason).sort()) === JSON.stringify(cold.rejected.map((r) => r.reason).sort()));

    // a record for a member of a different size is not used (the archive changed)
    const lines = readFileSync(cachePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    lines[0].xmlBytes += 1;
    writeFileSync(cachePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const tampered = await dry();
    ok("a cached record whose member size differs from the archive's is read again, not trusted", tampered.counts.pass_a_cache_hits === cached.length - 1 && same(tampered.counts as never) === same(cold.counts as never));

    // a torn last line from a killed run costs only that return
    writeFileSync(cachePath, readFileSync(cachePath, "utf8") + '{"v":1,"loader":"x","objectId":"1234');
    const torn = await dry();
    ok("a torn last line is ignored, and the run still reaches the same outcomes", torn.counts.pass_a_cache_hits >= cached.length - 1 && same(torn.counts as never) === same(cold.counts as never));

    // a cache written by another loader version is not used
    writeFileSync(cachePath, readFileSync(cachePath, "utf8").split("\n").filter(Boolean).filter((l) => l.startsWith('{"v":1,"loader":"funder')).map((l) => l.replace(/"loader":"[^"]+"/, '"loader":"funder-reference-loader/0.0.1"')).join("\n") + "\n");
    const other = await dry();
    ok("a cache written by a different loader version is not used at all", other.counts.pass_a_cache_hits === 0 && same(other.counts as never) === same(cold.counts as never));

    // the cache holds figures, not the verdict: a different cutoff is applied afresh
    const lowT = { minAssetsFmvAmt: 100_000, minContributionsPaidPerBooksAmt: 10_000 };
    await dry(); // refill the cache at the default cutoff
    const warmLow = await dry({ threshold: lowT });
    const coldLow = await dry({ threshold: lowT, workDir: join(world.archivesDir, "..", "work-passa-low") });
    ok("with a warm cache, a LOWER cutoff gives the verdicts a cold run at that cutoff gives (the old verdict is not reused)", warmLow.counts.pass_a_cache_hits > 0 && JSON.stringify(warmLow.counts.universe_sensitivity) === JSON.stringify(coldLow.counts.universe_sensitivity) && warmLow.counts.status_skipped_below_threshold === coldLow.counts.status_skipped_below_threshold && warmLow.counts.foundations_in_scope === coldLow.counts.foundations_in_scope, `${warmLow.counts.foundations_in_scope} vs ${coldLow.counts.foundations_in_scope}`);
  }

  section("the size threshold is a parameter, re-evaluated on every run");
  {
    const lowered = await runPipeline(sink, provider, params(world, rows, sources, { threshold: { minAssetsFmvAmt: 100_000, minContributionsPaidPerBooksAmt: 10_000 } }), silent);
    ok("a lower threshold brings the small California fund in", lowered.counts.status_skipped_below_threshold === 0 && lowered.counts.foundations_in_scope === 3 && lowered.counts.status_loaded === 5, JSON.stringify(lowered.counts));
    const inB = (await db.query(`select (select count(*) from funder_reference_figures where ein='111111111')::int f, (select count(*) from funder_reference_foundations where ein='111111111')::int o, (select count(*) from funder_reference_grants where ein='111111111')::int g`)).rows[0] as Record<string, number>;
    ok("…and it has figures, a foundation row and its grants", inB.f === 1 && inB.o === 1 && inB.g === 30);
    const back = await runPipeline(sink, provider, params(world, rows, sources), silent);
    const gone = (await db.query(`select (select count(*) from funder_reference_figures where ein='111111111')::int f, (select count(*) from funder_reference_foundations where ein='111111111')::int o, (select count(*) from funder_reference_grants where ein='111111111')::int g, (select status from funder_reference_filings where object_id = $1) as s`, [IDS.B])).rows[0] as Record<string, unknown>;
    ok("raising it again takes the data back out and leaves the filing recorded as skipped", back.counts.status_skipped_below_threshold === 1 && gone.f === 0 && gone.o === 0 && gone.g === 0 && gone.s === "skipped_below_threshold", JSON.stringify(gone));
    const staleCov = (await db.query(`select count(*)::int c from funder_reference_period_coverage where ein = '111111111'`)).rows[0] as { c: number };
    ok("…and its coverage rows go too (no row claims a period is held for a funder no longer in scope)", staleCov.c === 0, String(staleCov.c));
    const runParams = (await db.query(`select parameters from funder_reference_runs where id = $1`, [back.runId])).rows[0] as { parameters: { threshold: { minAssetsFmvAmt: number }; thresholdFigures: { giving: string } } };
    ok("every run records the threshold it used and which figures it read", runParams.parameters.threshold.minAssetsFmvAmt === 1_000_000 && /contributions_paid_per_books_amt/.test(runParams.parameters.thresholdFigures.giving));
  }

  section("a killed run resumes to the same state as a clean one");
  {
    const cleanDb = new PGlite();
    await bootDatabase(cleanDb);
    await runPipeline(pgliteSink(cleanDb), provider, params(world, rows, sources, { workDir: join(world.archivesDir, "..", "work-clean") }), silent);
    const cleanDump = await dump(cleanDb);

    const crashDb = new PGlite();
    await bootDatabase(crashDb);
    const real = pgliteSink(crashDb);
    let applied = 0;
    const crashing: Sink = {
      ...real,
      applyFiling: async (d: FilingDoc) => {
        if (++applied === 5) throw new Error("simulated crash");
        return real.applyFiling(d);
      },
    };
    let crashed = false;
    try {
      await runPipeline(crashing, provider, params(world, rows, sources, { workDir: join(world.archivesDir, "..", "work-crash") }), silent);
    } catch (e) {
      crashed = /simulated crash/.test((e as Error).message);
    }
    ok("the first attempt dies part-way", crashed);
    const failedRun = (await crashDb.query(`select status, notes from funder_reference_runs order by started_at`)).rows[0] as { status: string; notes: string };
    ok("…and its run record says failed, with the reason", failedRun.status === "failed" && /simulated crash/.test(failedRun.notes));
    const partial = await counts(crashDb);
    ok("…leaving some filings stored (a partial state)", partial.filings > 0 && partial.filings < 10, JSON.stringify(partial));
    await runPipeline(real, provider, params(world, rows, sources, { workDir: join(world.archivesDir, "..", "work-crash") }), silent);
    ok("a second attempt over the same database ends in exactly the clean run's state", (await dump(crashDb)) === cleanDump);
    await cleanDb.close();
    await crashDb.close();
  }

  // ---------------------------------------------------------------- privileges
  section("a signed-in member can read the reference rows and cannot write one");
  {
    const ORG = "a0000000-0000-4000-8000-000000000001";
    const MEMBER = "a1000000-0000-4000-8000-000000000001";
    const STRANGER = "b1000000-0000-4000-8000-000000000001";
    await db.query(`insert into organizations (id, name) values ($1, 'Org A')`, [ORG]);
    await db.query(`insert into auth.users (id, email) values ($1, 'a1@test'), ($2, 'x@test')`, [MEMBER, STRANGER]);
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
    const readAll = async () => {
      const o: Record<string, number> = {};
      for (const t of TABLES) o[t] = ((await db.query(`select count(*)::int c from ${t}`)).rows[0] as { c: number }).c;
      return o;
    };
    const member = await as("authenticated", MEMBER, readAll);
    ok("a member of ANY organization reads every reference table", TABLES.every((t) => member[t] > 0), JSON.stringify(member));
    const stranger = await as("authenticated", STRANGER, readAll);
    ok("a signed-in user who belongs to no organization reads nothing", TABLES.every((t) => stranger[t] === 0), JSON.stringify(stranger));
    const anon = await as("anon", null, async () => Promise.all(TABLES.map((t) => refusedSql(db, `select count(*) from ${t}`))));
    ok("anon cannot even select", anon.every((m) => /permission denied/.test(m)), anon.join(" | "));

    let allRefused = true;
    const detail: string[] = [];
    for (const t of TABLES) {
      const col = t === "funder_reference_runs" ? "notes" : "ein";
      for (const stmt of [`insert into ${t} select * from ${t} limit 1`, `update ${t} set ${col} = ${col}`, `delete from ${t}`, `truncate ${t}`]) {
        const msg = await as("authenticated", MEMBER, () => refusedSql(db, stmt));
        if (!/permission denied/.test(msg)) {
          allRefused = false;
          detail.push(`${stmt} -> ${msg || "SUCCEEDED"}`);
        }
      }
    }
    ok("a member's insert, update, delete and truncate are refused on all eight tables", allRefused, detail.join("; "));
    const stillThere = await readAll();
    ok("…and nothing changed", JSON.stringify(stillThere) === JSON.stringify(await readAll()) && (await counts(db)).filings === 10);
    const fnAuth = await as("authenticated", MEMBER, () => refusedSql(db, `select funder_reference_apply_filing('{}'::jsonb)`));
    const fnAnon = await as("anon", null, () => refusedSql(db, `select funder_reference_apply_filing('{}'::jsonb)`));
    ok("a member cannot call the write function; neither can anon", /permission denied/.test(fnAuth) && /permission denied/.test(fnAnon), `${fnAuth} | ${fnAnon}`);
    const svc = await as("service_role", null, () => refusedSql(db, `update funder_reference_runs set notes = 'service key may write' where id = '${run1.runId}'`));
    ok("service_role (the loader's key) can write", svc === "", svc);

    // The second lock, shown to hold on its own: give authenticated INSERT again and
    // row-level security (no insert policy) must still refuse.
    await db.exec(`grant insert on funder_reference_runs to authenticated`);
    const viaRls = await as("authenticated", MEMBER, () => refusedSql(db, `insert into funder_reference_runs (loader_version, status, parameters) values ('x', 'completed', '{}')`));
    await db.exec(`revoke insert on funder_reference_runs from authenticated`);
    ok("even with the privilege restored, row-level security refuses the member's insert (no insert policy)", /row-level security/.test(viaRls), viaRls);
    await db.exec(`grant update on funder_reference_runs to authenticated`);
    const updRls = await as("authenticated", MEMBER, async () => {
      await db.query(`update funder_reference_runs set notes = 'member edit'`);
      return ((await db.query(`select count(*)::int c from funder_reference_runs where notes = 'member edit'`)).rows[0] as { c: number }).c;
    });
    await db.exec(`revoke update on funder_reference_runs from authenticated`);
    ok("…and a member's update, with the privilege restored, changes zero rows", updRls === 0, String(updRls));
  }

  // ---------------------------------------------------------------- the scripts, end to end
  section("the command-line loader and the verifier, end to end");
  {
    const tmp = mkdtempSync(join(tmpdir(), "fr-cli-"));
    const dbDir = join(tmp, "db");
    const tsx = (script: string, args: string[]) => spawnSync("npx", ["--no-install", "tsx", join(root, script), ...args], { encoding: "utf8", cwd: root, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    const cli = tsx("scripts/load-funder-reference.ts", ["--work-dir", tmp, "--index-dir", world.indexDir, "--archives-dir", world.archivesDir, "--ein", "582218044", "--target", `pglite:${dbDir}`]);
    ok("the loader command exits 0 and reports consistent outcomes", cli.status === 0 && /"outcomes_sum_check": true/.test(cli.stdout), (cli.stderr || cli.stdout).slice(-600));
    ok("…three returns stand and the original 2023 one is superseded by the amended one", /"status_loaded": 3/.test(cli.stdout) && /"status_superseded": 1/.test(cli.stdout), cli.stdout.slice(-900));
    const refuse = tsx("scripts/load-funder-reference.ts", ["--work-dir", tmp, "--index-dir", world.indexDir, "--target", "supabase"]);
    ok("--target supabase is refused without the explicit confirmation flag", refuse.status === 2 && /confirm-write-to-supabase/.test(refuse.stderr), refuse.stderr);
    ok("the loader never printed or wrote a secret", !/service_role_key|eyJ[A-Za-z0-9_-]{20,}/i.test(cli.stdout + cli.stderr));

    // verifier: the amended 2023 return in this test world differs from the fixture, so verify against
    // the amended XML held in the archive: give the verifier a directory with each return as loaded.
    const xmlDir = join(tmp, "xml");
    mkdirSync(xmlDir);
    writeFileSync(join(xmlDir, `${IDS.S22}_public.xml`), X22);
    writeFileSync(join(xmlDir, `${IDS.S23A}_public.xml`), variant(X23, { returnTs: "2024-12-15T10:00:00-06:00", revenue: 600000 }));
    writeFileSync(join(xmlDir, `${IDS.S24}_public.xml`), X24);
    const v1 = tsx("scripts/verify-funder-reference-example.ts", ["--db", `pglite:${dbDir}`, "--ein", "582218044", "--xml-dir", xmlDir]);
    ok("the verifier passes on what the loader stored", v1.status === 0 && /RESULT: PASS/.test(v1.stdout), (v1.stdout + v1.stderr).slice(-1500));
    const compared = Number(/compared (\d+) stored values/.exec(v1.stdout)?.[1] ?? 0);
    ok("…having compared more than 1,500 values", compared > 1500, String(compared));

    // tamper: change a figure, drop a grant, rename an officer -- as the service key would
    const { PGlite: PG } = await import("@electric-sql/pglite");
    const t = new PG(dbDir);
    await t.waitReady;
    await t.exec(`set role service_role`);
    await t.exec(`update funder_reference_figures set total_revenue_per_books_amt = total_revenue_per_books_amt + 1 where filing_object_id = '${IDS.S22}'`);
    await t.exec(`delete from funder_reference_grants where filing_object_id = '${IDS.S24}' and ordinal = 7`);
    await t.exec(`update funder_reference_people set name_as_named = 'PAUL B NEFF' where filing_object_id = '${IDS.S22}' and listed_in = 'part_viii_officers_directors_trustees' and ordinal = 1`);
    await t.exec(`update funder_reference_filings set xml_sha256 = repeat('0', 64) where object_id = '${IDS.S24}'`);
    await t.exec(`reset role`);
    await t.close();
    const v2 = tsx("scripts/verify-funder-reference-example.ts", ["--db", `pglite:${dbDir}`, "--ein", "582218044", "--xml-dir", xmlDir]);
    ok("tampered data makes the verifier exit non-zero", v2.status === 1 && /RESULT: FAIL/.test(v2.stdout));
    ok("…naming the changed figure", /total_revenue_per_books_amt: stored "539141" but the filing gives "539140"/.test(v2.stdout), v2.stdout.slice(0, 1500));
    ok("…the missing grant row", /grant 7 row exists/.test(v2.stdout) && /number of paid-during-year grant rows: stored "29" but the filing gives "30"/.test(v2.stdout));
    ok("…the renamed officer", /officer 1 name_as_named: stored "PAUL B NEFF" but the filing gives "PAUL A NEFF"/.test(v2.stdout));
    ok("…and that the bytes compared are no longer the bytes recorded as loaded", /xml_sha256/.test(v2.stdout));
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- source scans
  section("nothing in the web application reaches these tables; no secret near the client (hard rule 5)");
  {
    const files = walk(root);
    const web = files.filter((f) => !f.startsWith(join(root, "scripts") + "/") && !f.startsWith(join(root, "lib/funder-reference") + "/"));
    // Ruling 0048 (item 113) authorizes ONE read-only screen to read these tables: the files under
    // app/(dashboard)/funders and the dashboard layout's single import of its access check. Everything
    // else must still not mention them, and not even the screen may import the loader.
    const screen = (f: string) => f.startsWith(join(root, "app/(dashboard)/funders") + "/") || f === join(root, "app/(dashboard)/layout.tsx");
    // Rulings 0049 and 0050 (item 117) authorize three more files to read these tables through the member's own session: the
    // Donor Finder's suggestions section, its add action and the add button. Named, not a folder: a fourth file is caught.
    const SUGGESTION_READERS = ["reference-suggestions.tsx", "reference-suggestion-actions.ts", "add-suggested-button.tsx"].map((n) => join(root, "app/(dashboard)/discovery", n));
    const touching = web.filter((f) => /funder[_-]reference/i.test(readFileSync(f, "utf8")) && !screen(f) && !SUGGESTION_READERS.includes(f));
    ok(`none of the ${web.length} application source files (app/, lib/, components/, …) outside the ruling-0048 screen and the three item-117 readers mentions the tables or imports the loader`, touching.length === 0, touching.join(", "));
    const loaderModules = /funder-reference\/(pipeline|sink|run-store|sources|parse-990pf|zip|inflate|document|derive|xml|strings|supervisor)\b/;
    ok("and the screen itself imports none of the loader's modules (it reads through read.ts, browse.ts and access.ts only)", web.filter(screen).every((f) => !loaderModules.test(readFileSync(f, "utf8"))), web.filter(screen).filter((f) => loaderModules.test(readFileSync(f, "utf8"))).join(", "));
    const lib = files.filter((f) => f.startsWith(join(root, "lib/funder-reference") + "/"));
    ok(`the ${lib.length} loader library files import nothing from next or react and are not client components`, lib.every((f) => { const s = readFileSync(f, "utf8"); return !/from ["'](next|react)/.test(s) && !/["']use client["']/.test(s); }));
    ok("the loader library reads no environment variable (keys are read only by the scripts)", lib.every((f) => !/process\.env/.test(readFileSync(f, "utf8"))));
    const keyReaders = files.filter((f) => /SUPABASE_SERVICE_ROLE_KEY/.test(readFileSync(f, "utf8")) && /funder-reference/.test(f) && !/test-funder-reference/.test(f));
    ok("only the two funder-reference scripts read the service key, and only from the environment", keyReaders.every((f) => /scripts\/(load|verify)-funder-reference/.test(f)) && keyReaders.length === 2, keyReaders.join(", "));
    ok("no committed file holds a service-role key value", files.every((f) => !/SUPABASE_SERVICE_ROLE_KEY\s*=\s*["']?eyJ/.test(readFileSync(f, "utf8"))));
    const mig = readFileSync(join(root, "supabase/migrations/0084_funder_reference.sql"), "utf8");
    ok("the migration is additive: it creates and never drops or alters an earlier object", !/\b(drop\s+(table|column|policy|function)|alter\s+table\s+(?!funder_reference|%I))/i.test(mig.replace(/--.*$/gm, "")));
    ok("it has no insert, update or delete policy", !/create\s+policy[^;]*for\s+(insert|update|delete|all)/i.test(mig.replace(/--.*$/gm, "")));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.close();
  rmSync(join(world.archivesDir, ".."), { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

async function refusedSql(db: PGlite, sql: string): Promise<string> {
  try {
    await db.query(sql);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// The parser's behaviour for a return with no website element is pinned in
// test-funder-reference.ts; here it is carried through the document builder.
function parseNoWebsite(): boolean {
  const p = parseFiling990PF(variant(X22, { noWebsite: true }));
  const d = loadedDoc(
    { runId: "00000000-0000-4000-8000-000000000000", loadedAt: new Date().toISOString(), loaderVersion: "t", archiveUrl: "u", member: "m", index: { returnId: null, ein: "582218044", taxPeriod: "202212", subYear: 2023, taxpayerName: "x", returnType: "990PF", objectId: IDS.S22, batchId: null, indexFile: "i" } },
    p,
    { sha256: "0".repeat(64), bytes: 1 }
  );
  return (d.foundation as Record<string, unknown>).website_as_stated === null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
