// STATE item 116 (ruling 0047 clause 6): the sample verification for the public charity / donor-advised fund
// sponsor loader (lib/funder-reference/verify-990.ts, scripts/verify-public-charities.ts).
//
// HOW THIS IS TESTED. A world of real IRS returns (the five fixtures under scripts/fixtures/public-charities
// and variants moved to California) is built as index CSV + ZIP archives. The REAL loader
// (scripts/load-public-charities.ts) loads California into a local PostgreSQL (PGlite) with every migration
// applied. The REAL verifier script then checks it: it must PASS. Then, on copies of that database (or of
// the loader's caches), one fault at a time is planted and the verifier must FAIL and name it:
//   a changed amount; a dropped grant row; a zero where the return is silent; a wrong kind label; a changed
//   recipient; a changed byte count; a grants-to-individuals element and a person's name stored; a return
//   the loader wrongly dropped as out of scope; a return the header scan wrongly put outside the state;
//   outcome counts that do not add up; the run's index count; a readable return recorded as unread; a stored
//   document location that does not hold the return.
// A verifier that passed every one of those would be worthless, so each is a test of its own.
//
// WHAT THIS CANNOT PROVE: it runs on PGlite, not on the Supabase platform (the supabase reader in the script
// pages in primary-key order the way scripts/verify-funder-reference-example.ts does, but is not exercised
// here), and the world is a handful of real returns, not California.
//
// Usage: npx tsx scripts/test-public-charities-verify.ts

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { makeZip, type ZipItem } from "./funder-reference-test-support";
import { Checker, independentRejectReason, outcomeCountProblems, peopleOnReturn, readReturn, storedTotalsProblems, tokenize } from "../lib/funder-reference/verify-990";

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
const ID = { pump: "202401159349302015", union: "202431669349300713", hff: "202413209349311136", corey: "202440379349300239", levy: "202412979349301861" };

/** Moves a return's filer to California and gives it its own EIN, so one real return can stand for several California funders. */
function toCalifornia(xml: string, newEin: string): string {
  const i = xml.indexOf("<Filer>");
  const j = xml.indexOf("</Filer>");
  const filer = xml.slice(i, j).replace(/<EIN>\d{9}<\/EIN>/, `<EIN>${newEin}</EIN>`).replace(/<StateAbbreviationCd>[A-Z]{2}<\/StateAbbreviationCd>/, "<StateAbbreviationCd>CA</StateAbbreviationCd>");
  return xml.slice(0, i) + filer + xml.slice(j);
}

interface Item { id: string; ein: string; period: string; name: string; xml: string | null; indexBatch: string; inBatch?: string }
const withTs = (xml: string, ts: string) => xml.replace(/<ReturnTs>[^<]*<\/ReturnTs>/, `<ReturnTs>${ts}</ReturnTs>`);
const withLine1 = (xml: string, amt: number) => xml.replace(/(<GrantsToDomesticOrgsGrp>\s*<TotalAmt>)\d+/, `$1${amt}`);
const unionCA = toCalifornia(read(ID.union), "310628642");
const hffCA = toCalifornia(read(ID.hff), "043521744");
const levyCA = toCalifornia(read(ID.levy), "592999521");
const pump2022 = read(ID.pump).replace("<TaxPeriodEndDt>2023-12-31</TaxPeriodEndDt>", "<TaxPeriodEndDt>2022-12-31</TaxPeriodEndDt>").replace("<TaxPeriodBeginDt>2023-01-01</TaxPeriodBeginDt>", "<TaxPeriodBeginDt>2022-01-01</TaxPeriodBeginDt>");
const ids = { pumpAmend: "202450000000000001", pump2022: "202350000000000002", pumpBroken: "202550000000000003", unionCA: "202450000000000011", hffCA: "202450000000000012", levyCA: "202450000000000013", pf: "202450000000000004" };

const CATALOG: Item[] = [
  // California, in scope
  { id: ID.pump, ein: "954807001", period: "202312", name: "PUMP", xml: read(ID.pump), indexBatch: "2024_TEOS_XML_01A" },
  { id: ids.pumpAmend, ein: "954807001", period: "202312", name: "PUMP", xml: withLine1(withTs(read(ID.pump), "2099-01-01T00:00:00-06:00"), 1_100_000), indexBatch: "2024_TEOS_XML_01A" },
  { id: ids.pump2022, ein: "954807001", period: "202212", name: "PUMP", xml: withLine1(pump2022, 50_000), indexBatch: "2024_TEOS_XML_01A" },
  { id: ids.pumpBroken, ein: "954807001", period: "202412", name: "PUMP", xml: "<Return><ReturnHeader><this is not well formed", indexBatch: "2024_TEOS_XML_01A" },
  // the index names archive 05A; the return is in 06A (the roughly 6% drift in report 0034)
  { id: ids.unionCA, ein: "310628642", period: "202312", name: "UNION COUNTY CF", xml: unionCA, indexBatch: "2024_TEOS_XML_05A", inBatch: "2024_TEOS_XML_06A" },
  { id: ids.hffCA, ein: "043521744", period: "202312", name: "HEALTH FUND", xml: hffCA, indexBatch: "2024_TEOS_XML_11A" },
  // California, not in scope (just under the line; a box ticked with no fund count)
  { id: ID.corey, ein: "330514612", period: "202305", name: "COREY", xml: read(ID.corey), indexBatch: "2024_TEOS_XML_02A" },
  { id: ids.levyCA, ein: "592999521", period: "202406", name: "LEVY CA", xml: levyCA, indexBatch: "2024_TEOS_XML_10A" },
  // other states (header scan puts them outside California)
  { id: ID.union, ein: "310628641", period: "202312", name: "UNION OH", xml: read(ID.union), indexBatch: "2024_TEOS_XML_06A" },
  { id: ID.hff, ein: "043521743", period: "202312", name: "HFF MA", xml: read(ID.hff), indexBatch: "2024_TEOS_XML_11A" },
  { id: ID.levy, ein: "592999520", period: "202406", name: "LEVY FL", xml: read(ID.levy), indexBatch: "2024_TEOS_XML_10A" },
  // a Form 990-PF handed in as a 990
  { id: ids.pf, ein: "700000009", period: "202312", name: "A PRIVATE FOUNDATION", xml: read(ID.pump).replace("<ReturnTypeCd>990</ReturnTypeCd>", "<ReturnTypeCd>990PF</ReturnTypeCd>").replace(/<EIN>954807001<\/EIN>/, "<EIN>700000009</EIN>"), indexBatch: "2024_TEOS_XML_01A" },
];

function buildWorld(items: Item[], tmp: string) {
  const archives = join(tmp, "zips");
  const index = join(tmp, "index");
  mkdirSync(archives, { recursive: true });
  mkdirSync(index, { recursive: true });
  const byArchive = new Map<string, ZipItem[]>();
  for (const it of items) {
    if (it.xml === null) continue;
    const a = it.inBatch ?? it.indexBatch;
    byArchive.set(a, [...(byArchive.get(a) ?? []), { name: `${a}/${it.id}_public.xml`, data: Buffer.from(it.xml) }]);
  }
  for (const [a, list] of byArchive) writeFileSync(join(archives, `${a}.zip`), makeZip(list));
  const lines = ["RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID"];
  items.forEach((it, i) => lines.push(`${100 + i},EFILE,${it.ein},${it.period},2024,${it.name},990,9349${i},${it.id},${it.indexBatch}`));
  writeFileSync(join(index, "index_2024.csv"), lines.join("\n") + "\n");
  return { archives, index };
}

const tsx = (args: string[]) => spawnSync("npx", ["tsx", ...args], { encoding: "utf8", cwd: root, maxBuffer: 64 * 1024 * 1024 });

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "charity-verify-"));
  try {
    // ============================================================================ the pure parts
    section("the verifier's own XML reader and reading of a return");
    {
      ok("it reads a real return and finds the period, the EIN and Part IX line 1 without the loader's reader", (() => {
        const r = readReturn(Buffer.from(read(ID.pump)));
        return !("error" in r) && r.ein === "954807001" && r.periodEnd === "2023-12-31" && r.orgGrants === 1029885 && r.rejectReasons.length === 0;
      })());
      const bad = (xml: string) => { try { tokenize(xml); return false; } catch { return true; } };
      ok("it refuses a DOCTYPE, an unclosed element and text outside the root (it never half-reads)", bad("<!DOCTYPE x [<!ENTITY a 'b'>]><Return/>") && bad("<Return><A></Return>") && bad("junk<Return/>") && bad("<Return/><Return/>"));
      ok("a Form 990-PF is not a clean Form 990 by its reading; so is a figure that is not a whole number", /990PF/.test(independentRejectReason(Buffer.from(read(ID.pump).replace("<ReturnTypeCd>990</ReturnTypeCd>", "<ReturnTypeCd>990PF</ReturnTypeCd>"))) ?? "") && /not a whole number/.test(independentRejectReason(Buffer.from(read(ID.pump).replace(/(<CYTotalRevenueAmt>)\d+/, "$112.5"))) ?? ""));
      ok("a clean return gives no reject reason", independentRejectReason(Buffer.from(read(ID.hff))) === null);
      const u = readReturn(Buffer.from(read(ID.union))) as Exclude<ReturnType<typeof readReturn>, { error: string }>;
      const h = readReturn(Buffer.from(read(ID.hff))) as Exclude<ReturnType<typeof readReturn>, { error: string }>;
      ok("the donor advised fund box reads the same whether the return wrote 'true' or '1'", u.dafBox === true && h.dafBox === true && u.dafHeld === 56 && h.dafHeld === 1);
      ok("a figure the return does not state is null, not zero (the health foundation has no Part IX line 1)", h.orgGrants === null);
    }
    section("the run-level outcome check");
    {
      const good = { status: "completed", counts: { index_rows_considered: 10, out_of_scope_state: 3, status_unread: 1, status_not_in_scope: 2, status_loaded: 3, status_superseded: 1, outcomes_sum_check: true } };
      ok("a finished run whose outcomes add up has no problem", outcomeCountProblems(good).length === 0);
      ok("outcomes that do not add up are named", outcomeCountProblems({ ...good, counts: { ...good.counts, status_loaded: 4 } }).some((p) => /do not add up/.test(p)));
      ok("a run that did not finish, or has no record, is a problem", outcomeCountProblems({ ...good, status: "running" }).some((p) => /not completed/.test(p)) && outcomeCountProblems(null).length === 1);
      const st = (state: string, loaded: number, sup: number, status = "completed") => ({ status, parameters: { state }, counts: { status_loaded: loaded, status_superseded: sup, status_unread: 0 } });
      ok("stored totals equal the sum of every state's latest run", storedTotalsProblems({ loaded: 13622, superseded: 339, unread: 0 }, [st("AE", 3, 0), st("CA", 13619, 339), st("CA", 13617, 339)]).length === 0);
      ok("a total that is one state's alone no longer passes once a second state is loaded", storedTotalsProblems({ loaded: 13622, superseded: 339, unread: 0 }, [st("CA", 13619, 339)]).length === 1);
      ok("a stored total off by one is named", storedTotalsProblems({ loaded: 13621, superseded: 339, unread: 0 }, [st("AE", 3, 0), st("CA", 13619, 339)]).some((p) => /13621 loaded/.test(p)));
      ok("a state's unfinished run is not counted", storedTotalsProblems({ loaded: 13619, superseded: 339, unread: 0 }, [st("AE", 3, 0, "running"), st("CA", 13619, 339)]).length === 0);
      {
        const xml = "<Return><ReturnData><IRS990><Form990PartVIISectionAGrp><PersonNm>JANE Q OFFICER</PersonNm></Form990PartVIISectionAGrp><ContractorCompensationGrp><ContractorName><PersonNm>DONOR NETWORK WEST</PersonNm></ContractorName></ContractorCompensationGrp></IRS990></ReturnData></Return>";
        const people = peopleOnReturn(tokenize(xml));
        ok("an officer's name counts as a person on the return; a PersonNm under ContractorName (which can be a business) does not (found on the first real California check)", people.has("jane q officer") && !people.has("donor network west"), [...people].join("|"));
      }
      const ck = new Checker();
      ck.ein = "123456789";
      ck.eq("x", 0, null, "int");
      ck.eq("y", 5, 5, "int");
      ok("a stored zero where the return is silent is reported as an invented zero; equal values are not reported", ck.lines.length === 1 && /invented zero/.test(ck.lines[0]) && ck.compared === 2, ck.lines.join("|"));
    }

    // ============================================================================ the real loader on a real world
    section("the real loader loads California; the real verifier passes it");
    const world = buildWorld(CATALOG, tmp);
    const dbDir = join(tmp, "db-base");
    const workDir = join(tmp, "work");
    const load = tsx(["scripts/load-public-charities.ts", "--work-dir", workDir, "--index-dir", world.index, "--archives-dir", world.archives, "--state", "CA", "--target", `pglite:${dbDir}`]);
    ok("the loader ran to the end on the California world", load.status === 0 && /outcomes_sum_check": true/.test(load.stdout), `${load.status} ${load.stderr.slice(0, 500)}`);

    const verify = (dir: string, extra: string[] = [], work = workDir, resultName = "result.json") => {
      const resultFile = join(tmp, resultName);
      const r = tsx(["scripts/verify-public-charities.ts", "--target", `pglite:${dir}`, "--state", "CA", "--archives-dir", world.archives, "--index-dir", world.index, "--work-dir", work, "--result-file", resultFile, ...extra]);
      let rec: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { rec = JSON.parse(readFileSync(resultFile, "utf8")); } catch { /* a crash leaves no result file */ }
      return { status: r.status, out: r.stdout + r.stderr, rec };
    };
    const rowsIn = async (dir: string, sql: string) => { const d = new PGlite(dir); await d.waitReady; const r = (await d.query(sql)).rows as Array<Record<string, unknown>>; await d.close(); return r; };
    const digest = async (dir: string) => {
      const d = new PGlite(dir);
      await d.waitReady;
      let all = "";
      for (const t of ["charity_reference_filings", "charity_reference_organizations", "charity_reference_figures", "charity_reference_daf_figures", "charity_reference_grants", "charity_reference_period_coverage", "funder_reference_runs"]) all += JSON.stringify((await d.query(`select to_jsonb(t)::text as j from ${t} t order by 1`)).rows);
      await d.close();
      return all;
    };

    const before = await digest(dbDir);
    const base = verify(dbDir);
    ok("the unmodified California load VERIFIES: exit 0 and RESULT: PASS", base.status === 0 && /RESULT: PASS/.test(base.out), base.out.slice(-1500));
    ok("it checked all three stored California funders (the amendment, its superseded original, the 2022 return and the return in the archive the index did not name included)", base.rec.funders_checked === 3 && base.rec.funders_in_state === 3 && base.rec.filings_checked === 5, JSON.stringify({ c: base.rec.funders_checked, f: base.rec.filings_checked }));
    ok("it compared many values and found no mismatch, explained or not", base.rec.compared > 300 && base.rec.mismatches === 0 && base.rec.unexplained === 0, `${base.rec.compared} ${base.rec.mismatches}`);
    ok("it recorded the seed, the mode, the exception list's hash and its own version", base.rec.seed === "charity-reference-sample/1" && base.rec.mode === "sample" && /^[0-9a-f]{64}$/.test(base.rec.exceptions_sha256) && /verify-public-charities/.test(base.rec.verifier));
    ok("the three audits ran: header (returns outside California re-read), scope (returns not stored re-read), unread (the broken 2024 return)", base.rec.audits.header.sampled >= 3 && base.rec.audits.header.said_not_in_state_but_return_is_in_state === 0 && base.rec.audits.scope.sampled === 2 && base.rec.audits.scope.in_scope_but_not_stored === 0 && base.rec.audits.unread.sampled >= 1 && base.rec.audits.unread.readable_by_verifier === 0, JSON.stringify(base.rec.audits));
    ok("the index count was checked against the run's rows considered", base.rec.outcome_counts.index_rows_counted === CATALOG.length, String(base.rec.outcome_counts.index_rows_counted));
    ok("it wrote nothing to the database: every table and the run record are byte-for-byte what they were", (await digest(dbDir)) === before);
    const again = verify(dbDir, ["--sample-size", "2"], workDir, "result-2a.json");
    const again2 = verify(dbDir, ["--sample-size", "2"], workDir, "result-2b.json");
    ok("a smaller sample is repeatable: the same seed and the same funders give the same funders, in both runs", again.rec.funders_checked === 2 && JSON.stringify(again.rec.must_include) === JSON.stringify(again2.rec.must_include) && again.rec.compared === again2.rec.compared && again.status === 0, `${again.rec.funders_checked}`);
    const full = verify(dbDir, ["--full"], workDir, "result-full.json");
    ok("--full checks every funder", full.rec.mode === "full" && full.rec.funders_checked === 3 && full.status === 0);
    const noArchives = tsx(["scripts/verify-public-charities.ts", "--target", `pglite:${dbDir}`, "--state", "CA"]);
    ok("without archives, index or work directory it cannot say verified (exit 1, and it says what is missing)", noArchives.status === 1 && /NOT VERIFIED BECAUSE/.test(noArchives.stdout) && /archives/.test(noArchives.stdout));

    // ============================================================================ planted faults, one at a time
    section("planted faults: each must be caught, and named");
    const ein = { pump: "954807001", union: "310628642", hff: "043521744" };
    let n = 0;
    async function fault(label: string, sql: string | null, expect: RegExp, opts: { extra?: string[]; mutateWork?: (w: string) => void; counts?: boolean } = {}) {
      const dir = join(tmp, `db-fault-${++n}`);
      cpSync(dbDir, dir, { recursive: true });
      const work = join(tmp, `work-fault-${n}`);
      cpSync(workDir, work, { recursive: true });
      if (sql) { const d = new PGlite(dir); await d.waitReady; await d.exec(sql); await d.close(); }
      opts.mutateWork?.(work);
      const r = verify(dir, opts.extra ?? [], work, `result-fault-${n}.json`);
      ok(`${label}: exit 1, RESULT: FAIL, and the report names it`, r.status === 1 && /RESULT: FAIL/.test(r.out) && expect.test(r.out) && (r.rec.unexplained > 0 || r.rec.problems.length > 0), `${r.status} ${r.out.slice(0, 1200)}`);
      return r;
    }
    const pumpStanding = ids.pumpAmend;
    await fault("a changed amount (Part IX line 1 of the amendment)", `update charity_reference_figures set part_ix_line_1_grants_domestic_orgs_total_amt = 1100001 where filing_object_id = '${pumpStanding}'`, /part_ix_line_1_grants_domestic_orgs_total_amt: stored "1100001" but the filing gives "1100000"/);
    await fault("a changed grant amount on one recipient row", `update charity_reference_grants set cash_grant_amt = cash_grant_amt + 1 where filing_object_id = '${ids.unionCA}' and ordinal = 2`, /grant 2 cash_grant_amt: stored/);
    await fault("a dropped grant row", `delete from charity_reference_grants where filing_object_id = '${ids.unionCA}' and ordinal = 5`, /number of stored grant rows: stored "16" but the filing gives "17"|grant 5 row exists/);
    await fault("a zero where the return is silent (Part IX line 1 on a return that states none)", `update charity_reference_figures set part_ix_line_1_grants_domestic_orgs_total_amt = 0 where filing_object_id = '${ids.hffCA}'`, /invented zero/);
    await fault("a zero where the return is silent (a donor advised fund count on a sponsor's other-funds column)", `update charity_reference_daf_figures set other_funds_held_cnt = 0 where filing_object_id = '${ids.hffCA}' and other_funds_held_cnt is null`, /other_funds_held_cnt: stored "0" but the filing gives nothing/ );
    await fault("a wrong kind label (a donor advised fund sponsor stored as not one)", `update charity_reference_organizations set is_daf_sponsor = false, is_grantmaking_public_charity = true where ein = '${ein.hff}'`, /is_daf_sponsor|is_grantmaking_public_charity/);
    await fault("a wrong kind basis (a period's grants figure changed)", `update charity_reference_organizations set kind_basis = jsonb_set(kind_basis, '{0,grants_to_domestic_orgs_amt}', '1') where ein = '${ein.union}'`, /kind_basis/);
    await fault("a wrong threshold recorded on the funder", `update charity_reference_organizations set kind_threshold_org_grants_amt = 1 where ein = '${ein.pump}'`, /kind_threshold_org_grants_amt/);
    await fault("a changed recipient name", `update charity_reference_grants set recipient_name_line1 = 'SOMEONE ELSE' where filing_object_id = '${ids.unionCA}' and ordinal = 1`, /recipient_name_line1: stored "SOMEONE ELSE"/);
    await fault("a changed unmapped element", `update charity_reference_grants set unmapped_fields = '{"Invented":"x"}'::jsonb where filing_object_id = '${ids.unionCA}' and ordinal = 1`, /unmapped_fields/);
    await fault("a changed byte count (what is compared is not what was loaded)", `update charity_reference_filings set xml_bytes = xml_bytes + 1 where object_id = '${ids.hffCA}'`, /xml_bytes: stored/);
    await fault("a changed organization identity (city)", `update charity_reference_organizations set city = 'NOWHERE' where ein = '${ein.pump}'`, /funder\.city: stored "NOWHERE"/);
    await fault("a grants-to-individuals element stored with a recipient row", `update charity_reference_grants set unmapped_fields = '{"GrantsOtherAsstToIndivInUSGrp/RecipientPersonNm":"A PERSON"}'::jsonb where filing_object_id = '${ids.unionCA}' and ordinal = 1`, /no stored column or unmapped element names a person, an individual recipient/);
    // a person on the return (an officer) stored in a text column
    {
      const person = /<PersonNm>([^<]{5,})<\/PersonNm>/.exec(unionCA)?.[1];
      ok("(the union fixture names a person on the return, for the next fault)", !!person);
      await fault("a person's name from the return stored in a grant row", `update charity_reference_grants set purpose_as_stated = '${(person ?? "x").replace(/'/g, "''")}' where filing_object_id = '${ids.unionCA}' and ordinal = 1`, /no stored string equals the name of a person on the return/);
    }
    await fault("a donor related to a recipient (a column that names a donor)", `alter table charity_reference_grants add column donor_name text; update charity_reference_grants set donor_name = 'A DONOR' where filing_object_id = '${ids.unionCA}' and ordinal = 1`, /exactly the columns migration 0089 defines|donor/);
    await fault("a stored return that is not a clean Form 990 would not have been stored (a filing's type changed)", `alter table charity_reference_filings drop constraint if exists charity_reference_filings_return_type_check; update charity_reference_filings set return_type = '990EZ' where object_id = '${ids.hffCA}'`, /return_type: stored "990EZ"/);
    await fault("a stored funder whose 2022 filing has gone (its kind basis still lists the period)", `delete from charity_reference_grants where filing_object_id = '${ids.pump2022}'; delete from charity_reference_daf_figures where filing_object_id = '${ids.pump2022}'; delete from charity_reference_period_coverage where filing_object_id = '${ids.pump2022}'; delete from charity_reference_figures where filing_object_id = '${ids.pump2022}'; delete from charity_reference_filings where object_id = '${ids.pump2022}'`, /kind_basis/);
    await fault("a coverage claim that is false (a held year recorded as not in the index)", `update charity_reference_period_coverage set status = 'no_filing_in_index', filing_object_id = null where ein = '${ein.pump}' and period_year = 2022`, /coverage 2022 status/);
    await fault("a superseded return recorded as standing (the amendment's original claims to stand)", `update charity_reference_filings set status = 'loaded', status_note = null, superseded_by_object_id = null where object_id = '${ID.pump}'`, /exactly one standing filing per tax period end|latest submitted one|status/);
    await fault("a readable return recorded as unread", `update charity_reference_filings set status = 'unread', status_note = 'parser error (a loader defect, not necessarily a bad filing): invented', superseded_by_object_id = null where object_id = '${ids.hffCA}'`, /unread filing: stored as unread/);
    await fault("a stored document location that does not hold the return", `update charity_reference_filings set document_archive_url = 'https://apps.irs.gov/pub/epostcard/990/xml/2024/2024_TEOS_XML_02A.zip' where object_id = '${ids.hffCA}'`, /the stored location does not hold the return/);

    // the loader's own bookkeeping
    await fault("outcome counts that do not add up", `update funder_reference_runs set counts = jsonb_set(counts, '{status_loaded}', '99') where parameters->>'kind' = 'public_charity_and_daf_sponsor'`, /do not add up/);
    await fault("the run's index row count is not what the index says", `update funder_reference_runs set counts = jsonb_set(jsonb_set(counts, '{index_rows_considered}', '999'), '{status_not_in_scope}', ((counts->>'status_not_in_scope')::int + 999 - (counts->>'index_rows_considered')::int)::text::jsonb) where parameters->>'kind' = 'public_charity_and_daf_sponsor'`, /the index lists/);
    await fault("a run that never finished", `update funder_reference_runs set status = 'failed' where parameters->>'kind' = 'public_charity_and_daf_sponsor'`, /not completed|no completed|run: /);
    // a charity the loader wrongly dropped: remove a qualifying funder's filings from the database but leave the loader's cache saying it was assessed
    await fault("a return the loader wrongly dropped as out of scope (the donor advised fund sponsor is missing from the database)", `delete from charity_reference_period_coverage where ein = '${ein.hff}'; delete from charity_reference_daf_figures where ein = '${ein.hff}'; delete from charity_reference_figures where ein = '${ein.hff}'; delete from charity_reference_organizations where ein = '${ein.hff}'; delete from charity_reference_filings where ein = '${ein.hff}'`, /scope audit: in scope by this return alone/);
    // a CA return the header scan put in Ohio: change the loader's own cache record
    await fault("a California return the header scan put outside the state", null, /header audit: the header scan put this return outside CA/, {
      mutateWork: (w) => {
        const p = join(w, "header-scan-cache.jsonl");
        const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { objectId: string; state: string | null; ein: string | null });
        const rec = lines.find((l) => l.objectId === ID.pump)!;
        rec.state = "OH";
        writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      },
    });
    // a return the loader says it read and assessed, which the verifier cannot read: the broken 2024 return, its unread record removed and the loader's cache made to claim it was assessed
    await fault("a not-stored return the loader read but the verifier cannot (the loader's cache claims a broken file was assessed)", `delete from charity_reference_period_coverage where filing_object_id = '${ids.pumpBroken}'; delete from charity_reference_filings where object_id = '${ids.pumpBroken}'`, /scope audit: the loader read this return and assessed it; the verifier finds it unreadable/, {
      mutateWork: (w) => {
        const p = join(w, "pass-a-990-cache.jsonl");
        const recs = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
        const rec = recs.find((r) => r.objectId === ids.pumpBroken)!;
        rec.outcome = "assessed";
        rec.facts = { orgGrantsAmt: 150000, dafHeldCnt: null, dafBox: null };
        rec.head = { taxPeriodEnd: "2024-12-31" };
        writeFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
      },
    });

    // ============================================================================ the verifier itself
    section("the verifier is read-only and prints no secret");
    const src = readFileSync(join(root, "scripts/verify-public-charities.ts"), "utf8");
    const lib = readFileSync(join(root, "lib/funder-reference/verify-990.ts"), "utf8");
    ok("the script has no insert, upsert, delete, rpc or write function call; its only update is the opt-in run annotation", !/\.(insert|upsert|delete)\(|\.rpc\(|charity_reference_apply_filing|insert into|delete from/i.test(src) && (src.match(/\)\.update\(\{|update funder_reference_runs|update charity_reference/g) ?? []).length === 2 &&/flag\("annotate-run"\)/.test(src));
    ok("it never prints the service key or the project URL", !/console\.(log|error)\([^)]*(SERVICE_ROLE|SUPABASE_URL|process\.env)/.test(src));
    ok("the library does no I/O: no fs, network, child process or environment read", !/from "node:(fs|http|https|net|child_process)"|process\.env|fetch\(/.test(lib));
    ok("the library imports nothing from the loader's reader, parser or row builder (independence)", !/from "\.\/(xml|parse-990|parse-990pf|document-990|document|pipeline-990|pipeline|charity-scope)"/.test(lib));
    ok("the application never reaches the verifier (hard rule 5: it holds the service key)", (() => {
      const bad: string[] = [];
      const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name) && /verify-990|verify-public-charities/.test(readFileSync(p, "utf8"))) bad.push(p); } };
      for (const dir of ["app", "components"]) walk(join(root, dir));
      for (const f of readdirSync(join(root, "lib"), { withFileTypes: true })) if (f.isFile() && /\.(ts|tsx)$/.test(f.name) && /verify-990|verify-public-charities/.test(readFileSync(join(root, "lib", f.name), "utf8"))) bad.push(f.name);
      return bad.length === 0;
    })());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
