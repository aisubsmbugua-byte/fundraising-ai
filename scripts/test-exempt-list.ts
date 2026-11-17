// STATE item 119, stage two (ruling 0053): the IRS list of exempt organizations.
//
// (1) Migration 0102 on a REAL Postgres (PGlite) with every project migration applied unchanged: the apply function judges the stored rows
//     (tiers, drops, shared keys, loaded funders), the member read carries the IRS facts, leaves out a lead that is a loaded funder under
//     another name, and adds the listed church extension and grantmaking funders; the Solomon EIN is checked; members cannot touch the table.
// (2) The loader's side: its upload filter against the database's own rule over 1,500 real listed names, its key against the database's key,
//     and its reading of real lines of the IRS file.
// (3) The pure wording, and the source scans of the ruling's "test of compliance".
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform, it does not render the page, and the live table is not read.
//
// Usage: npx tsx scripts/test-exempt-list.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootDatabase } from "./funder-reference-support";
import { seedCharity, seedFoundation } from "./nofiling-test-support";
import { parseCsvLine } from "../lib/funder-reference/sources";
import {
  FILING_REQUIREMENT,
  TIER_LABELS,
  bmfIndex,
  bmfRow,
  describeIrs,
  filingRequirementWords,
  formatEin,
  formatRulingMonth,
  irsMark,
  leadKeyOf,
  nameKey,
  normalizeIrs,
  sendRow,
  toStoredRow,
  type IrsFacts,
} from "../lib/funder-reference/exempt-list";
import { NO_RETURN_MARK, buildLeadBasis, candidateEin, leadMark, leadTierLabel, normalizeLead, type NoFilingLead } from "../lib/funder-reference/nofiling-leads";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
const section = (t: string) => console.log(`\n--- ${t} ---`);

const ORG_A = "a0000000-0000-4000-8000-000000000001";
const ORG_B = "a0000000-0000-4000-8000-000000000002";
const MEMBER_A = "a1000000-0000-4000-8000-000000000001";
const MEMBER_B = "a1000000-0000-4000-8000-000000000002";
const STRANGER = "b1000000-0000-4000-8000-000000000001";

interface Fx { NAME: string; STATE: string; FILING_REQ_CD: string; STATUS: string; NTEE_CD: string; FOUNDATION: string }

async function main() {
  section("migration 0102 applies to a real Postgres, unchanged, after all earlier ones");
  const db = new PGlite();
  const boot = await bootDatabase(db);
  ok(`all ${boot.applied.length} migration files apply with no error`, boot.failures.length === 0, boot.failures.join("; "));
  ok("0102 is among them", boot.applied.some((f) => f.startsWith("0102_irs_exempt_organizations_list")));
  const sql102 = readFileSync(join(root, "supabase/migrations/0102_irs_exempt_organizations_list.sql"), "utf8").replace(/--.*$/gm, "");
  ok("0102 alters no loader table and writes no reference row of the filed returns", !/\balter\s+table\s+(funder|charity)_reference_(?!exempt|nofiling|curated)/i.test(sql102) && !/\b(insert\s+into|update|delete\s+from)\s+(funder|charity)_reference_(?!exempt|nofiling|curated)/i.test(sql102));
  {
    // The Supabase platform refuses an UPDATE or DELETE with no WHERE when it is reached through the API (safeupdate); PGlite does not. A function the
    // owner's scripts call through the API must therefore qualify every one. Found live 2026-11-17: 0102's apply, and 0100's build, did not.
    const strip = (s: string): string => { let prev = ""; while (prev !== s) { prev = s; s = s.replace(/\([^()]*\)/g, ""); } return s; };
    const functionBodies = (f: string): string[] => [...readFileSync(join(root, "supabase/migrations", f), "utf8").replace(/--.*$/gm, "").matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
    const latest = ["0099", "0100", "0101", "0102", "0103"].flatMap((p) => boot.applied.filter((f) => f.startsWith(p + "_")));
    const unqualified = (body: string): string[] => [...body.matchAll(/\b(update|delete\s+from)\b[^;]*;/gi)].map((m) => m[0]).filter((s) => !/\bwhere\b/i.test(strip(s)));
    const bad0103 = functionBodies("0103_exempt_list_apply_where_clauses.sql").flatMap(unqualified);
    ok("0103's replacement functions qualify every UPDATE and DELETE (the platform refuses a whole-table one through the API)", bad0103.length === 0, bad0103.join(" || ").slice(0, 300));
    ok("0103 replaces the two functions that did not (the apply of 0102 and the build of 0100)", /create or replace function funder_reference_exempt_list_apply/.test(readFileSync(join(root, "supabase/migrations/0103_exempt_list_apply_where_clauses.sql"), "utf8")) && /create or replace function funder_reference_nofiling_build/.test(readFileSync(join(root, "supabase/migrations/0103_exempt_list_apply_where_clauses.sql"), "utf8")));
    const replaced = new Set(["funder_reference_exempt_list_apply", "funder_reference_nofiling_build"]);
    const stillLive = latest.filter((f) => !f.startsWith("0103")).flatMap((f) => functionBodies(f).flatMap(unqualified));
    ok("the only unqualified statements left in the item's earlier migrations are the ones 0103 replaces (the apply's five, and the build's whole-table delete as 0099 first wrote it and 0100 repeated it)", stillLive.length === 7 && replaced.size === 2, String(stillLive.length));
  }
  ok("0102 reaches no outside service", !/\bhttp_|net\.http|create\s+extension|dblink|\bcopy\b/i.test(sql102.replace(/'[^']*'/g, "''")));

  await db.query(`insert into organizations (id, name) values ($1, 'Org A'), ($2, 'Org B')`, [ORG_A, ORG_B]);
  await db.query(`insert into auth.users (id, email) values ($1, 'a@test'), ($2, 'b@test'), ($3, 'x@test')`, [MEMBER_A, MEMBER_B, STRANGER]);
  await db.query(`insert into profiles (id, organization_id, email) values ($1, $2, 'a@test'), ($3, $4, 'b@test')`, [MEMBER_A, ORG_A, MEMBER_B, ORG_B]);
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
  const one = async <T,>(q: string, a: unknown[] = []): Promise<T> => (await db.query(q, a)).rows[0] as T;

  // ---- the loader's side against the database's own rule, over real listed names
  section("the loader's name key is the database's, and its upload filter never leaves out a row the database would keep (1,500 real listed names)");
  const fx = JSON.parse(readFileSync(join(root, "scripts/fixtures/exempt-list-names.json"), "utf8")) as Fx[];
  {
    ok("the fixture holds 1,500 distinct real listed organizations", fx.length === 1500, String(fx.length));
    const sqlKeys = (await db.query(`select funder_reference_name_key(n) as k from unnest($1::text[]) with ordinality as t(n, o) order by o`, [fx.map((r) => r.NAME)])).rows.map((r) => (r as { k: string | null }).k);
    const bad = fx.map((r, i) => ({ n: r.NAME, ts: nameKey(r.NAME), sql: sqlKeys[i] })).filter((x) => x.ts !== x.sql);
    ok("the TypeScript name key equals the database's name key for every one of them", bad.length === 0, JSON.stringify(bad.slice(0, 5)));
    ok("the fixture exercises the odd cases the IRS file has: a leading THE, a leading digit, an ampersand, a hyphen, a slash", fx.some((r) => /^THE /.test(r.NAME)) && fx.some((r) => /^\d/.test(r.NAME)) && fx.some((r) => /&/.test(r.NAME)) && fx.some((r) => /-/.test(r.NAME)) && fx.some((r) => /\//.test(r.NAME)));
    // the IRS file carries no commas, periods or apostrophes, but the filings' recipient names do, and the database's key is shared with them
    const extra = ["(230) THE LAWRENCE AND LILLIAN SOLOMON FOUNDATION INC", "1ST BAPTIST, INC.", "O'BRIEN FUND", "St. Mary's Church Extension Fund", "  The   Solomon Foundation  ", "THE THE X", "ÉCOLE FUND", "(12)", "...", "", "THE", "THEO FUND", "THE-FUND"];
    const extraSql = (await db.query(`select funder_reference_name_key(n) as k from unnest($1::text[]) with ordinality as t(n, o) order by o`, [extra])).rows.map((r) => (r as { k: string | null }).k);
    const extraBad = extra.map((n, i) => ({ n, ts: nameKey(n), sql: extraSql[i] })).filter((x) => x.ts !== x.sql);
    ok("and the same holds for names with the punctuation, case and spacing filings have (grant numbers, commas, periods, apostrophes, accents, empty)", extraBad.length === 0, JSON.stringify(extraBad));
    // load them as raw rows (no lead keys) and let the database judge them
    const rows = fx.map((r, i) => ({
      ein: "9" + String(i).padStart(8, "0"), name: r.NAME, state: r.STATE || null, filing_req_cd: r.FILING_REQ_CD, status_cd: r.STATUS || null,
      ntee_cd: r.NTEE_CD || null, foundation_code: r.FOUNDATION || null, list_version: "t", list_posted: "2026-11-10",
    }));
    await db.query(
      `insert into funder_reference_exempt_list (ein, name, state, filing_req_cd, status_cd, ntee_cd, foundation_code, list_version, list_posted)
       select ein, name, state, filing_req_cd, status_cd, ntee_cd, foundation_code, list_version, list_posted::date
       from jsonb_to_recordset($1::jsonb) as x(ein text, name text, state text, filing_req_cd text, status_cd text, ntee_cd text, foundation_code text, list_version text, list_posted text)`,
      [JSON.stringify(rows)]
    );
    const summary = (await one<{ s: Record<string, number> }>(`select funder_reference_exempt_list_apply() as s`)).s;
    const kept = (await db.query(`select ein, name, state, filing_req_cd, status_cd, ntee_cd, foundation_code, tier from funder_reference_exempt_list`)).rows as Array<Record<string, string | number | null>>;
    ok("the database gave a tier to some of them and dropped the rest (no lead keys loaded)", kept.length > 100 && kept.length < 1500 && kept.every((r) => r.tier !== null), `${kept.length}: ${JSON.stringify(summary)}`);
    const none = new Set<string>();
    const missed = kept.filter((r) => !sendRow({ NAME: String(r.name), STATE: String(r.state ?? ""), FILING_REQ_CD: String(r.filing_req_cd), STATUS: String(r.status_cd ?? ""), NTEE_CD: String(r.ntee_cd ?? "") }, none));
    ok("every row the database gives a tier to would have been sent by the loader (its filter is a superset)", missed.length === 0, JSON.stringify(missed.slice(0, 5)));
    const sent = fx.filter((r) => sendRow(r, none)).length;
    ok("the loader's filter is wider than the rule but still a filter: it sends at least what the database keeps and not the whole file", sent >= kept.length && sent < fx.length, `${sent} sent, ${kept.length} kept, ${fx.length} read`);
    ok("tiers follow the ruling over real names: tier 1 names say extension/loan/gift/donor-advised; tier 2 categories begin T2 to T5; tier 3 is not a church (foundation code 10)",
      kept.every((r) => (r.tier === 1 && /church extension|extension fund|loan fund|charitable gift|gift fund|donor[ -]?advised/i.test(String(r.name))) || (r.tier === 2 && /^T[2-5]/.test(String(r.ntee_cd))) || (r.tier === 3 && r.foundation_code !== "10" && /\b(foundation|fund|funds|trust|endowment)\b/i.test(String(r.name)))));
    ok("a row that must file, or whose exemption is not unconditional, never has a tier", kept.every((r) => ["06", "13"].includes(String(r.filing_req_cd)) && r.status_cd === "01"));
    await db.query(`delete from funder_reference_exempt_list`);
  }

  section("the loader reads real lines of the IRS file as the ruling says");
  {
    const lines = readFileSync(join(root, "scripts/fixtures/exempt-list-sample.csv"), "utf8").split("\n").filter(Boolean);
    const idx = bmfIndex(parseCsvLine(lines[0]));
    const parsed = lines.slice(1).map((l) => bmfRow(parseCsvLine(l), idx));
    ok("four real rows are read: the Solomon Foundation, a church extension society, a loan fund, a Lutheran church extension fund", parsed.length === 4 && parsed.some((r) => r.EIN === "274214240" && r.NAME === "SOLOMON FOUNDATION" && r.STATE === "CO" && r.FILING_REQ_CD === "13" && r.NTEE_CD === "X19" && r.RULING === "201103" && r.STREET === "16995 PINE LN"));
    ok("a header without a needed column is refused, not guessed at", (() => { try { bmfIndex(["EIN", "NAME"]); return false; } catch (e) { return /no STREET column|no ICO column|IRS layout/.test(String(e)); } })());
    ok("with no lead keys the loader sends all four (each is a no-return religious organization in a tier's words)", parsed.every((r) => sendRow(r, new Set())));
    ok("an ordinary church is not sent, and neither is a fund-named organization that must file", !sendRow({ NAME: "FIRST BAPTIST CHURCH", STATE: "TX", FILING_REQ_CD: "06", STATUS: "01", NTEE_CD: "" }, new Set()) && !sendRow({ NAME: "BIG FUND TRUST", STATE: "TX", FILING_REQ_CD: "01", STATUS: "01", NTEE_CD: "" }, new Set()));
    ok("an organization of any filing requirement is sent when its key is a lead's", sendRow({ NAME: "The Quiet Giving Fund", STATE: "tn", FILING_REQ_CD: "01", STATUS: "01", NTEE_CD: "" }, new Set(["QUIET GIVING FUND|TN"])));
    const stored = toStoredRow(parsed[2], "eo-bmf-2026-11-10", "2026-11-10");
    ok("a stored row keeps the IRS's own fields as listed, trimmed, with the list's version and posting date", stored.ein === "274214240" && stored.name === "SOLOMON FOUNDATION" && stored.ntee_cd === "X19" && stored.filing_req_cd === "13" && stored.list_version === "eo-bmf-2026-11-10" && stored.list_posted === "2026-11-10" && stored.in_care_of === "% THE SOLOMON FOUNDATION");
    ok("leadKeyOf matches the database's lead key shape: key|STATE, state upper-cased and trimmed", leadKeyOf("THE Solomon Foundation", " co ") === "SOLOMON FOUNDATION|CO" && leadKeyOf("", "CO") === null && leadKeyOf("X", null) === "X|");
  }

  // ---- the scenario
  section("the scenario: leads found in filings, loaded funders, and the IRS list");
  await seedFoundation(db, "111111111", "ALPHA GIVING FOUNDATION", false, [
    { name: "Hillside Church", amt: 20_000 }, { name: "Grace Ministries", amt: 20_000 }, { name: "Gospel Church", amt: 20_000 }, { name: "Trinity Church", amt: 20_000 }, { name: "Baptist Mission", amt: 20_000 }, { name: "Christ Church", amt: 20_000 },
    { name: "THE SOLOMON FOUNDATION", amt: 168_000, st: "CO", city: "PARKER", purpose: "CONTRIBUTION TO A DONOR ADVISED FUND" },
    { name: "ACME CHURCH EXTENSION FUND", amt: 5_000, st: "KS" },
    { name: "QUIET GIVING FUND", amt: 7_000, st: "TN", purpose: "gift to a donor advised fund" },
    { name: "TWIN CHARITABLE GIFT FUND", amt: 4_000, st: "TX" },
    { name: "FIDELITY INVESTMENTS CHARITABLE GIFT FUND", amt: 40_000, st: "MA" },
    { name: "UNLISTED LOAN FUND", amt: 3_000, st: "OH" },
  ]);
  await seedCharity(db, "811111111", "FIDELITY CHARITABLE", [{ name: "x Church", amt: 1 }], true);
  await seedCharity(db, "822222222", "GRACE LOAN FUND", [{ name: "x Church", amt: 1 }]);
  await seedCharity(db, "833333333", "HOPE GIFT FUND", [{ name: "x Church", amt: 1 }]);
  await db.query(`select funder_reference_refresh_directory()`);
  await db.query(`select charity_reference_refresh_directory()`);
  await db.query(`select * from funder_reference_refresh_faith_giving('0', ':')`);
  await db.query(`select funder_reference_nofiling_scan_keys('0', ':')`);
  await db.query(`select funder_reference_nofiling_scan_rows('0', ':')`);
  const leadsBuilt = Number((await one<{ n: number }>(`select funder_reference_nofiling_build() as n`)).n);
  ok("six leads were found in the filings before any IRS list is loaded", leadsBuilt === 6, String(leadsBuilt));
  const beforeList = (await as("authenticated", MEMBER_B, async () => (await db.query(`select lead_key, origin, irs from reference_nofiling_leads(50, 0)`)).rows)) as Array<{ lead_key: string; origin: string; irs: unknown }>;
  ok("with no IRS list loaded, Fidelity's alias is offered (the stage-one limit) and every irs field is empty except the curated record's EIN has no list row", beforeList.some((r) => r.lead_key === "FIDELITY INVESTMENTS CHARITABLE GIFT FUND|MA") && beforeList.every((r) => r.irs === null), JSON.stringify(beforeList.map((r) => [r.lead_key, r.irs])));

  const ins = async (r: Record<string, string>) =>
    db.query(
      `insert into funder_reference_exempt_list (ein, name, street, city, state, zip, ruling_ym, ntee_cd, foundation_code, filing_req_cd, status_cd, list_version, list_posted)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'eo-bmf-2026-11-10', '2026-11-10')`,
      [r.ein, r.name, r.street ?? null, r.city ?? null, r.state, r.zip ?? null, r.ruling ?? null, r.ntee ?? null, r.found ?? null, r.req, r.status ?? "01"]
    );
  await ins({ ein: "274214240", name: "SOLOMON FOUNDATION", street: "16995 PINE LN", city: "PARKER", state: "CO", zip: "80134-6515", ruling: "201103", ntee: "X19", found: "16", req: "13" });
  await ins({ ein: "811111111", name: "FIDELITY INVESTMENTS CHARITABLE GIFT FUND", city: "BOSTON", state: "MA", req: "01", found: "15" });
  await ins({ ein: "555000001", name: "QUIET GIVING FUND", city: "NASHVILLE", state: "TN", req: "01", found: "15" });
  await ins({ ein: "555000002", name: "TWIN CHARITABLE GIFT FUND", city: "AUSTIN", state: "TX", req: "06", found: "10" });
  await ins({ ein: "555000003", name: "THE TWIN CHARITABLE GIFT FUND", city: "DALLAS", state: "TX", req: "13", found: "10" });
  await ins({ ein: "555000004", name: "ACME CHURCH EXTENSION FUND", city: "WICHITA", state: "KS", req: "06", found: "10", ruling: "194603" });
  await ins({ ein: "431151795", name: "LUTHERAN CHURCH EXTENSION FUND-MO SYNOD", street: "10733 SUNSET OFFICE DR STE 300", city: "SAINT LOUIS", state: "MO", zip: "63127-1020", ruling: "194107", req: "06", found: "10" });
  await ins({ ein: "611279821", name: "KEREN HATORAH", city: "BROOKLYN", state: "NY", ntee: "T30", found: "10", req: "13" });
  await ins({ ein: "666000001", name: "SAN ANTONIO PRESBYTERIAN FOUNDATION INC", city: "SAN ANTONIO", state: "TX", found: "17", req: "13" });
  await ins({ ein: "666000002", name: "GOSPEL FOUNDATION CHURCH OF GOD", city: "ALBANY", state: "NY", found: "10", req: "06" });
  await ins({ ein: "666000003", name: "BIG FUND TRUST", city: "TOLEDO", state: "OH", found: "15", req: "01" });
  await ins({ ein: "666000004", name: "ZETA CHURCH EXTENSION FUND", city: "TOLEDO", state: "OH", req: "06", status: "02" });
  await ins({ ein: "822222222", name: "GRACE LOAN FUND", city: "AUSTIN", state: "TX", req: "06" });
  await ins({ ein: "844444444", name: "HOPE GIFT FUND", city: "AUSTIN", state: "TX", req: "06" });
  await ins({ ein: "777000001", name: "ORG A CHURCH EXTENSION FUND", city: "SEATTLE", state: "WA", req: "06" });

  section("apply: the database judges the stored rows by the ruling");
  {
    const s1 = (await one<{ s: Record<string, number> }>(`select funder_reference_exempt_list_apply() as s`)).s;
    const s2 = (await one<{ s: Record<string, number> }>(`select funder_reference_exempt_list_apply() as s`)).s;
    ok("running apply again changes nothing (idempotent)", JSON.stringify(s1) === JSON.stringify(s2), `${JSON.stringify(s1)} vs ${JSON.stringify(s2)}`);
    ok("fifteen rows loaded, three dropped (a church by IRS class, one that must file with no lead key, a conditional exemption), twelve kept", Number(s1.rows) === 12, JSON.stringify(s1));
    ok("tiers: seven by name (tier 1), one by IRS category (tier 2), two by a fund-like name that is not a church (tier 3), two kept only to match a lead", s1.tier1 === 7 && s1.tier2 === 1 && s1.tier3 === 2 && s1.kept_only_to_match_a_lead === 2, JSON.stringify(s1));
    const row = async (ein: string) => await one<Record<string, unknown>>(`select * from funder_reference_exempt_list where ein = $1`, [ein]);
    ok("the dropped ones are gone and the kept ones are there", !(await row("666000002")) && !(await row("666000003")) && !(await row("666000004")) && !!(await row("274214240")) && !!(await row("811111111")));
    ok("the name key is the database's key plus the state: 'THE TWIN...' and 'TWIN...' share one, and two stored rows share it", (await row("555000003")).name_key === "TWIN CHARITABLE GIFT FUND|TX" && Number((await row("555000003")).key_count) === 2 && Number((await row("555000004")).key_count) === 1);
    ok("an EIN a loaded charity holds is flagged (the alias row and Grace); a name and state a loaded charity holds (seeded in Texas) is flagged (Grace, Hope); neither flag is on the others", (await row("811111111")).loaded_ein === true && (await row("822222222")).loaded_ein === true && (await row("822222222")).loaded_name === true && (await row("844444444")).loaded_name === true && (await row("844444444")).loaded_ein === false && (await row("555000004")).loaded_ein === false && (await row("555000004")).loaded_name === false);
    ok("offered means tier 1 or 2", (await row("555000004")).offered === true && (await row("611279821")).offered === true && (await row("666000001")).offered === false && (await row("274214240")).offered === false);
    ok("the summary counts what a member could be offered: six (Lutheran, Org A's, Acme, two Twins, Keren), not the two loaded funders", s1.offered === 6, JSON.stringify(s1));
    const offeredTier = Number((await one<{ t: number }>(`select funder_reference_exempt_list_offered_tier() as t`)).t);
    ok("offering tier 3 is a change of this one value, and it takes effect on the next apply", offeredTier === 2);
    await db.query(`create or replace function funder_reference_exempt_list_offered_tier() returns integer language sql immutable as $$ select 3 $$`);
    await db.query(`select funder_reference_exempt_list_apply()`);
    ok("…(trial) with the value 3 the tier 3 organization is offered", (await row("666000001")).offered === true);
    await db.query(`create or replace function funder_reference_exempt_list_offered_tier() returns integer language sql immutable as $$ select 2 $$`);
    await db.query(`select funder_reference_exempt_list_apply()`);
    ok("…and restored to 2 it is held again", (await row("666000001")).offered === false);
  }

  section("the Solomon Foundation record: its EIN was checked against the IRS list (ruling 0053 clause 6)");
  {
    const c = await one<{ ein: string; ein_note: string; sources: Array<{ url: string; read_on: string }>; address: string }>(`select ein, ein_note, sources, address from funder_reference_curated_funders where lead_key = 'SOLOMON FOUNDATION|CO'`);
    ok("the EIN is unchanged and its note says it was checked against the IRS list on 2026-11-17, with the file and what agreed", c.ein === "274214240" && /Checked 2026-11-17 against the IRS Exempt Organizations Business Master File/.test(c.ein_note) && /eo3\.csv/.test(c.ein_note) && /Name, city and street agree/.test(c.ein_note), c.ein_note);
    ok("it no longer says unverified, and the IRS file is a fourth source with the date read; the three it had are unchanged", !/not verified against the IRS/.test(c.ein_note) && c.sources.length === 4 && c.sources[3].read_on === "2026-11-17" && /irs\.gov/.test(c.sources[3].url) && /thesolomonfoundation\.org/.test(c.sources[0].url));
    const listed = await one<{ name: string; street: string; filing_req_cd: string; ntee_cd: string }>(`select name, street, filing_req_cd, ntee_cd from funder_reference_exempt_list where ein = '274214240'`);
    ok("the list's row for that EIN says what the note says", listed.name === "SOLOMON FOUNDATION" && listed.street === "16995 PINE LN" && listed.filing_req_cd === "13" && listed.ntee_cd === "X19");
  }

  section("the read: the IRS facts, the alias removed, the listed funders added, nothing hidden for what the IRS says");
  type R = { lead_key: string; origin: string; irs: Record<string, unknown> | null; stated_ein: string | null; funders_count: number; total_matches: number; display_name: string; daf_signal: boolean };
  const read = async (uid: string | null) => (await as("authenticated", uid, async () => (await db.query(`select * from reference_nofiling_leads(50, 0)`)).rows)) as R[];
  const b = await read(MEMBER_B);
  {
    ok("a member sees eight: the curated record, four found in filings, three listed by the IRS", b.length === 8 && Number(b[0].total_matches) === 8, JSON.stringify(b.map((r) => [r.origin, r.lead_key])));
    ok("order: curated first, then filings by funders named and then name, then the listed funders by tier and then name", b.map((r) => r.lead_key).join(" / ") === [
      "SOLOMON FOUNDATION|CO", "ACME CHURCH EXTENSION FUND|KS", "QUIET GIVING FUND|TN", "TWIN CHARITABLE GIFT FUND|TX", "UNLISTED LOAN FUND|OH",
      "LUTHERAN CHURCH EXTENSION FUND MO SYNOD|MO", "ORG A CHURCH EXTENSION FUND|WA", "KEREN HATORAH|NY"].join(" / "), b.map((r) => r.lead_key).join(" / "));
    ok("origins: curated, filings, listed", b[0].origin === "curated" && b.slice(1, 5).every((r) => r.origin === "filings") && b.slice(5).every((r) => r.origin === "irs_list"));
    ok("Fidelity's alias (a lead whose IRS entry has the EIN of a loaded charity) is not shown again", !b.some((r) => r.lead_key.startsWith("FIDELITY INVESTMENTS")));
    const solomon = b[0].irs as Record<string, unknown>;
    ok("the curated Solomon Foundation carries the IRS row tied by EIN: name, street, filing requirement 13, category X19, ruling 2011-03", !!solomon && solomon.ein === "274214240" && solomon.match === "ein" && solomon.filing_req_cd === "13" && solomon.ntee_cd === "X19" && solomon.ruling_ym === "201103" && solomon.street === "16995 PINE LN" && solomon.list_posted === "2026-11-10", JSON.stringify(solomon));
    const acme = b[1].irs as Record<string, unknown>;
    ok("a lead found in filings with exactly one listed organization of its name and state carries it, matched by name and state", acme?.ein === "555000004" && acme.match === "name_and_state" && acme.filing_req_cd === "06" && acme.ambiguous === false, JSON.stringify(acme));
    const quiet = b[2].irs as Record<string, unknown>;
    ok("one the IRS says files a return is still shown, with that filing requirement (it is labelled, not hidden)", quiet?.filing_req_cd === "01" && quiet.ein === "555000001");
    const twin = b[3].irs as Record<string, unknown>;
    ok("a key two listed organizations share is not matched, and says how many", twin?.ambiguous === true && Number(twin.matches) === 2 && twin.ein === undefined, JSON.stringify(twin));
    ok("a lead with no listed organization carries nothing from the list", b[4].irs === null);
    ok("a listed funder has no counts of funders, no stated EIN from a filing and no share (the IRS list is its only source)", b.slice(5).every((r) => Number(r.funders_count) === 0 && r.stated_ein === null && (r.irs as Record<string, unknown>).match === "listed"));
    ok("the listed funders are tier 1, tier 1, tier 2", b.slice(5).map((r) => (r.irs as Record<string, unknown>).tier).join() === "1,1,2");
    ok("a listed funder's name and place are as the IRS lists them", b[5].display_name === "LUTHERAN CHURCH EXTENSION FUND-MO SYNOD" && (b[5].irs as Record<string, unknown>).city === "SAINT LOUIS" && (b[5].irs as Record<string, unknown>).zip === "63127-1020");
    ok("not shown: the tier 3 organization, the two the database already holds (by EIN and by name and state), and the Solomon Foundation a second time", !b.some((r) => /SAN ANTONIO PRESBYTERIAN|GRACE LOAN|HOPE GIFT/.test(r.display_name)) && b.filter((r) => /SOLOMON/.test(r.display_name.toUpperCase())).length === 1);
    ok("an organization of a church extension fund's name is not repeated as a listed funder when it is already a lead found in filings (Acme, Twin)", b.filter((r) => /ACME|TWIN/.test(r.lead_key)).length === 2 && b.filter((r) => /ACME|TWIN/.test(r.lead_key)).every((r) => r.origin === "filings"));
  }
  {
    const a = await read(MEMBER_A);
    ok("tenant filter: an organization sees seven, leaving out the listed funder it already holds a candidate for… (before it does, it sees all eight)", a.length === 8);
    await db.query(`insert into candidates (organization_id, name, channel, source, dedupe_key, status) values ($1, 'Org A Church Extension Fund', 'regranting', 'manual', 'x|org a church extension fund|', 'pending')`, [ORG_A]);
    const a2 = await read(MEMBER_A);
    ok("…after Org A holds it, it is left out for Org A only", a2.length === 7 && !a2.some((r) => r.lead_key === "ORG A CHURCH EXTENSION FUND|WA") && (await read(MEMBER_B)).length === 8);
    ok("a signed-in person with no organization sees none", (await read(STRANGER)).length === 0);
    const anon = await as("anon", null, async () => refused(`select * from reference_nofiling_leads(25, 0)`));
    ok("anon is refused", /permission denied|must be/i.test(anon), anon);
  }

  section("nothing writes or reads the table directly; the list is replaced whole and the curated record stays");
  {
    const w = async (q: string) => as("authenticated", MEMBER_A, async () => refused(q));
    ok("a member cannot read the table", /permission denied/i.test(await w(`select * from funder_reference_exempt_list`)));
    ok("a member cannot insert, update or delete", /permission denied|row-level security/i.test(await w(`insert into funder_reference_exempt_list (ein, name, filing_req_cd, list_version, list_posted) values ('999999999', 'X', '06', 'v', '2026-11-10')`)) && /permission denied/i.test(await w(`update funder_reference_exempt_list set name = 'x'`)) && /permission denied/i.test(await w(`delete from funder_reference_exempt_list`)));
    ok("a member cannot run apply, and anon cannot", /permission denied/i.test(await w(`select funder_reference_exempt_list_apply()`)) && /permission denied/i.test(await as("anon", null, async () => refused(`select funder_reference_exempt_list_apply()`))));
    ok("an EIN must be nine digits", /check|violat/i.test(await refused(`insert into funder_reference_exempt_list (ein, name, filing_req_cd, list_version, list_posted) values ('12-345', 'X', '06', 'v', '2026-11-10')`)));
    ok("the same EIN twice is refused (the file lists none twice)", /duplicate|unique/i.test(await refused(`insert into funder_reference_exempt_list (ein, name, filing_req_cd, list_version, list_posted) values ('274214240', 'X', '06', 'v', '2026-11-10')`)));
    await db.query(`delete from funder_reference_exempt_list`);
    await db.query(`select funder_reference_exempt_list_apply()`);
    const afterClear = await read(MEMBER_B);
    ok("replacing the list whole (here: emptied) leaves the curated record and the leads found in filings, with no IRS facts", afterClear.length === 6 && afterClear[0].origin === "curated" && afterClear.every((r) => r.irs === null), JSON.stringify(afterClear.map((r) => [r.lead_key, r.irs !== null])));
    ok("and the alias is offered again until the list is loaded (the honest stage-one state)", afterClear.some((r) => r.lead_key.startsWith("FIDELITY INVESTMENTS")));
  }

  section("the pure wording: what the IRS list says, in the IRS's own words, and nothing a model wrote");
  {
    const facts: IrsFacts = { ein: "274214240", name: "SOLOMON FOUNDATION", in_care_of: null, street: "16995 PINE LN", city: "PARKER", state: "CO", zip: "80134-6515", ruling_ym: "201103", ntee_cd: "X19", foundation_code: "16", filing_req_cd: "13", status_cd: "01", tier: 3, list_version: "eo-bmf-2026-11-10", list_posted: "2026-11-10", ambiguous: false, match: "ein" };
    ok("the filing requirement codes are the IRS's (06 church, 13 religious organization, 01 files)", FILING_REQUIREMENT["06"].words === "Not required to file (church)" && FILING_REQUIREMENT["13"].words === "Not required to file (religious organization)" && FILING_REQUIREMENT["01"].meaning === "files" && FILING_REQUIREMENT["13"].meaning === "not_required");
    ok("irsMark says what the list says: not required, files, ambiguous, or nothing for a lead with no entry", irsMark(facts) === "The IRS list says it is not required to file; no giving figures" && irsMark({ ...facts, filing_req_cd: "01" }) === "The IRS list says it files a return; none is in the database, so no giving figures" && /More than one organization/.test(irsMark({ ...facts, ambiguous: true, matches: 2 }) ?? "") && irsMark(null) === null);
    ok("describeIrs states the listing, the EIN with how it was tied, and the listed ruling month, category and filing requirement", describeIrs(facts).join(" | ") === "On the IRS list as SOLOMON FOUNDATION, 16995 PINE LN, PARKER, CO 80134-6515. | EIN 27-4214240, from the IRS list, matched by EIN. | ruled exempt March 2011 · IRS category X19 · filing requirement: not required to file (religious organization).", describeIrs(facts).join(" | "));
    ok("a name-and-state match says so, and an ambiguous one tells the person to check", /matched by name and state/.test(describeIrs({ ...facts, match: "name_and_state" })[1]) && /2 organizations on the IRS list share this name and state/.test(describeIrs({ ...facts, ambiguous: true, matches: 2 })[0]) && describeIrs(null).length === 0);
    ok("formatting: EIN with a hyphen, ruling month in words, an unknown code shown as a code", formatEin("274214240") === "27-4214240" && formatRulingMonth("194603") === "March 1946" && formatRulingMonth("1946") === "1946" && formatRulingMonth(null) === null && filingRequirementWords("99") === "code 99");
    ok("normalizeIrs reads the function's object, ambiguous, or nothing", normalizeIrs({ ein: "274214240", filing_req_cd: "13", name: "S", tier: 3, match: "ein", ambiguous: false })?.tier === 3 && normalizeIrs({ ambiguous: true, matches: 2 })?.ambiguous === true && normalizeIrs(null) === null && normalizeIrs({ name: "x" }) === null);
    const lead: NoFilingLead = { lead_key: "K|CO", display_name: "X", city: null, state: "CO", stated_ein: null, funders_count: 0, faith_funders_count: 0, grants_count: 0, periods_count: 0, last_period_end: null, signal: "irs_list", daf_signal: false, sample: [], rule_version: "exempt-list-lead-v1", origin: "irs_list", curated: null, irs: { ...facts, tier: 1, match: "listed" }, total_matches: 1 };
    ok("the mark: the IRS's words where a listed organization is tied to the lead, the curated mark for a record, the ruling's words otherwise", leadMark(lead) === "The IRS list says it is not required to file; no giving figures" && leadMark({ ...lead, irs: null }) === NO_RETURN_MARK && leadMark({ ...lead, curated: { kind: "other_funder" } as never }) === "Recorded from its own website; no filing figures");
    ok("the tier label appears only on a listed funder", leadTierLabel(lead) === TIER_LABELS[1] && leadTierLabel({ ...lead, origin: "filings" }) === null && leadTierLabel({ ...lead, irs: { ...facts, tier: 2 } }) === TIER_LABELS[2]);
    ok("the EIN carried to a candidate: a filing's stated one; else the IRS list's for this very organization; never one from an ambiguous match, never none made up", candidateEin({ stated_ein: "123456789", curated: null, irs: null }) === "123456789" && candidateEin({ stated_ein: null, curated: null, irs: facts }) === "274214240" && candidateEin({ stated_ein: null, curated: null, irs: { ...facts, ambiguous: true } }) === null && candidateEin({ stated_ein: null, curated: null, irs: null }) === null && candidateEin({ stated_ein: "274214240", curated: { kind: "church_extension_fund" } as never, irs: facts }) === "274214240");
    ok("normalizeLead keeps the IRS facts and the listed origin", normalizeLead({ lead_key: "K|", display_name: "X", origin: "irs_list", irs: { ein: "274214240", filing_req_cd: "06", name: "X", tier: 1, match: "listed" } }).irs?.tier === 1 && normalizeLead({ lead_key: "K|", display_name: "X", origin: "irs_list" }).origin === "irs_list" && normalizeLead({ lead_key: "K|", display_name: "X", origin: "filings" }).irs === null);
    const basis = buildLeadBasis(lead, "2026-11-17T00:00:00Z");
    ok("the basis kept on a candidate carries the IRS facts as a snapshot, with the list's version and posting date", (basis.irs as IrsFacts).list_version === "eo-bmf-2026-11-10" && (basis.irs as IrsFacts).list_posted === "2026-11-10" && basis.origin === "irs_list");
  }

  section("source scans: no model, no outside request at page time; the loader talks only to your own database and reads only local files");
  {
    const strip = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "") : "");
    const page = ["lib/funder-reference/nofiling-leads.ts", "lib/funder-reference/exempt-list.ts", "app/(dashboard)/discovery/reference-lead-actions.ts", "app/(dashboard)/discovery/reference-leads.tsx", "app/(dashboard)/discovery/add-lead-button.tsx"];
    ok("all five page-side files exist", page.every((f) => strip(f).length > 0));
    ok("none calls a model, uses a service key or admin client, makes an outside request or reads a file", page.every((f) => !/anthropic|claude-|SERVICE_ROLE|createAdminClient|service[_-]?key|\bfetch\(|XMLHttpRequest|axios|node:fs|readFileSync/i.test(strip(f))));
    ok("the page reads the list only through the member-only function (it never names the table)", !/funder_reference_exempt_list/.test(page.map(strip).join("\n")));
    const loader = strip("scripts/load-exempt-list.ts");
    ok("the loader's only requests go to the database named by NEXT_PUBLIC_SUPABASE_URL", (loader.match(/fetch\(/g) ?? []).length === 4 && (loader.match(/fetch\(`\$\{base\}\/rest\/v1\//g) ?? []).length === 4 && !/https?:\/\//.test(loader.replace(/"[^"]*irs\.gov[^"]*"/g, "")));
    ok("the loader reads the files from the directory you name, keeps nothing outside the repository, and calls no model", /--dir/.test(loader) && /createReadStream\(join\(dir, f\)/.test(loader) && !/anthropic|claude-|openai/i.test(loader));
    ok("the loader refuses a missing file or a layout change rather than guessing", /is missing/.test(loader) && /bmfIndex/.test(loader));
    ok("the loader replaces the table whole and then has the database judge it", /method: "DELETE"/.test(loader) && /funder_reference_exempt_list_apply/.test(loader));
    const act = strip("app/(dashboard)/discovery/reference-lead-actions.ts");
    ok("the add action still creates one pending candidate and nothing else", (act.match(/\.from\(["'](\w+)["']\)/g) ?? []).every((m) => /candidates|screening_rules/.test(m)) && /\.from\("candidates"\)\s*\.insert/.test(act) && /status:\s*"pending"/.test(act) && /ein:\s*candidateEin\(lead\)/.test(act));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
