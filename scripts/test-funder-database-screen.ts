// STATE item 113 (ruling 0048): the internal, read-only funder database screen.
//
// Two halves. (1) Migration 0086 -- the directory view and the search function --
// run on a REAL Postgres (PGlite) with every project migration applied unchanged, as
// a signed-in member, a stranger and anon, over funders seeded with the shapes the
// screen must get right (a funder with three periods, one with no figures, one with
// an amount that is absent rather than zero, characters that are wildcards in LIKE).
// (2) The pure logic in lib/funder-reference/browse.ts, and source scans for the
// ruling's "test of compliance": the screen reads only, with the user's session, and
// calls nothing outside; the door is one function.
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform, and it
// does not render the pages. The pages are verified by opening them against a database
// that has 0086 applied (which ruling 0048 clause 7 holds until the owner says so).
//
// Usage: npx tsx scripts/test-funder-database-screen.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootDatabase } from "./funder-reference-support";
import {
  NOT_HELD, NOT_STATED, PAGE_SIZE, SIZE_BANDS, US_STATES, coverageText, describeStates, formatAmount, formatEin,
  formatPeriodEnd, formatRefreshed, pageCount, parseSearch, placeLine, preselectedText, searchHref, sizeBandValue, stateStatuses, type RunRow,
} from "../lib/funder-reference/browse";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
const section = (t: string) => console.log(`\n--- ${t} ---`);

const ORG = "a0000000-0000-4000-8000-000000000001";
const MEMBER = "a1000000-0000-4000-8000-000000000001";
const STRANGER = "b1000000-0000-4000-8000-000000000001";

interface Seed {
  ein: string;
  name: string;
  city: string;
  state: string;
  periods: Array<{ end: string; fmv: number | null; paid: number | null; preselected?: boolean | null; terms?: boolean }>;
}

let objectCounter = 1;
async function seed(db: PGlite, s: Seed): Promise<void> {
  let latest: string | null = null;
  let latestEnd = "";
  const objs: Array<{ id: string; end: string }> = [];
  for (const p of s.periods) {
    const id = "2023" + String(objectCounter++).padStart(14, "0");
    objs.push({ id, end: p.end });
    await db.query(
      `insert into funder_reference_filings (object_id, ein, return_type, index_tax_period, tax_period_end, status, index_file, document_archive_url, document_member, loaded_at, loader_version)
       values ($1, $2, '990PF', $3, $4, 'loaded', 'index_2024.csv', 'https://apps.irs.gov/x.zip', $5, now(), 't')`,
      [id, s.ein, p.end.slice(0, 4) + p.end.slice(5, 7), p.end, `${id}_public.xml`]
    );
    await db.query(
      `insert into funder_reference_figures (ein, tax_period_end, filing_object_id, fmv_assets_eoy_amt, contributions_paid_per_books_amt, financial_statement_values, grants_listed_count, grants_listed_derivation, loaded_at, loader_version)
       values ($1, $2, $3, $4, $5, '{}', 3, 'the 3 listed grants', now(), 't')`,
      [s.ein, p.end, id, p.fmv, p.paid]
    );
    if (p.terms !== false) {
      await db.query(
        `insert into funder_reference_application_terms (filing_object_id, ein, tax_period_end, only_preselected_charities_raw, only_preselected_charities_box_checked, loaded_at, loader_version)
         values ($1, $2, $3, $4, $5, now(), 't')`,
        [id, s.ein, p.end, p.preselected ? "X" : null, p.preselected ?? null]
      );
    }
    await db.query(
      `insert into funder_reference_period_coverage (ein, period_year, status, filing_object_id, note, checked_at) values ($1, $2, 'loaded', $3, 'loaded', now())`,
      [s.ein, Number(p.end.slice(0, 4)), id]
    );
    if (p.end > latestEnd) {
      latestEnd = p.end;
      latest = id;
    }
  }
  if (!latest) {
    // a funder with no figures at all still needs a filing to be a foundation
    const id = "2023" + String(objectCounter++).padStart(14, "0");
    await db.query(
      `insert into funder_reference_filings (object_id, ein, return_type, index_tax_period, tax_period_end, status, index_file, document_archive_url, document_member, loaded_at, loader_version)
       values ($1, $2, '990PF', '202412', '2024-12-31', 'loaded', 'index_2024.csv', 'https://apps.irs.gov/x.zip', 'm.xml', now(), 't')`,
      [id, s.ein]
    );
    latest = id;
    latestEnd = "2024-12-31";
  }
  await db.query(
    `insert into funder_reference_foundations (ein, source_object_id, source_tax_period_end, legal_name_line1, city, state, loaded_at, loader_version)
     values ($1, $2, $3, $4, $5, $6, now(), 't')`,
    [s.ein, latest, latestEnd, s.name, s.city, s.state]
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

async function main() {
  // ================================================================ the migration
  section("migration 0086 applies to a real Postgres, unchanged, after all earlier ones");
  const db = new PGlite();
  const boot = await bootDatabase(db);
  ok(`all ${boot.applied.length} migration files apply with no error`, boot.failures.length === 0, boot.failures.join("; "));
  ok("0086 is the directory migration and is among them", boot.applied.some((f) => f.startsWith("0086_funder_reference_directory")));
  const sql = readFileSync(join(root, "supabase/migrations/0086_funder_reference_directory.sql"), "utf8");
  ok("it creates no table and no index, and writes nothing (additive, read-only: ruling 0048 clauses 1 and 7)", !/create\s+(unique\s+)?(table|index)/i.test(sql) && !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop\s)/i.test(sql.replace(/--.*$/gm, "")));

  ok("0087 (the faster search) is among them", boot.applied.some((f) => f.startsWith("0087_funder_reference_search_pages_first")));
  ok("0088 (the snapshot) is among them", boot.applied.some((f) => f.startsWith("0088_funder_reference_directory_snapshot")));
  const sql88 = readFileSync(join(root, "supabase/migrations/0088_funder_reference_directory_snapshot.sql"), "utf8").replace(/--.*$/gm, "");
  ok("0088 touches none of the loader's tables: it creates one materialized view with its own indexes and three functions, and writes no row", /create materialized view funder_reference_directory_snapshot/.test(sql88) && [...sql88.matchAll(/create\s+(unique\s+)?index\s+\w+\s+on\s+(\w+)/gi)].every((m) => m[2] === "funder_reference_directory_snapshot") && !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop\s)/i.test(sql88) && !/alter\s+table/i.test(sql88));
  const sql87 = readFileSync(join(root, "supabase/migrations/0087_funder_reference_search_pages_first.sql"), "utf8").replace(/--.*$/gm, "");
  ok("0087 creates no table or index and writes nothing; it only replaces the search function", !/create\s+(unique\s+)?(table|index|view)/i.test(sql87) && !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop\s)/i.test(sql87) && /create or replace function funder_reference_search/.test(sql87));

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
  const refused = async (q: string): Promise<string> => {
    try {
      await db.query(q);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  // ---- seed
  await seed(db, { ein: "111111111", name: "ALPHA FAMILY FOUNDATION", city: "TULSA", state: "OK", periods: [
    { end: "2022-12-31", fmv: 900_000, paid: 40_000 },
    { end: "2023-12-31", fmv: 1_200_000, paid: 55_000, preselected: true },
    { end: "2024-12-31", fmv: 1_500_000, paid: 60_000, preselected: false },
  ] });
  await seed(db, { ein: "222222222", name: "BETA CHARITABLE TRUST", city: "AUSTIN", state: "TX", periods: [{ end: "2024-12-31", fmv: 250_000_000, paid: 9_000_000, preselected: true }] });
  await seed(db, { ein: "333333333", name: "GAMMA FOUNDATION", city: "TULSA", state: "OK", periods: [{ end: "2024-12-31", fmv: null, paid: null, terms: false }] });
  await seed(db, { ein: "444444444", name: "DELTA ORPHAN FUND", city: "OMAHA", state: "NE", periods: [] });
  await seed(db, { ein: "555555555", name: "100% KIND_HEARTS FUND", city: "RENO", state: "NV", periods: [{ end: "2024-12-31", fmv: 5_000_000, paid: 0 }] });
  await seed(db, { ein: "666666666", name: "O'BRIEN & SONS FOUNDATION", city: "ST. PAUL", state: "MN", periods: [{ end: "2024-12-31", fmv: 5_000_000, paid: 100_000 }] });
  await seed(db, { ein: "777777777", name: "ZETA TWIN FOUNDATION", city: "TULSA", state: "OK", periods: [{ end: "2024-12-31", fmv: 5_000_000, paid: 100_000 }] });

  // the search reads a snapshot (0088); it holds nothing until the service key refreshes it
  const preRefresh = (await db.query(`select count(*)::int c from funder_reference_directory_snapshot`)).rows[0] as { c: number };
  ok("before a refresh the snapshot is empty: the search lags the loader until it is refreshed", preRefresh.c === 0);
  await db.query(`select funder_reference_refresh_directory()`);

  section("the directory shows one funder per row with the figures of its LATEST period only");
  {
    const rows = (await as("authenticated", MEMBER, async () => (await db.query(`select * from funder_reference_directory order by ein`)).rows)) as Array<Record<string, unknown>>;
    ok("one row per funder", rows.length === 7, String(rows.length));
    const a = rows.find((r) => r.ein === "111111111")!;
    ok("the latest period's assets are shown, not an older one's", Number(a.fmv_assets_eoy_amt) === 1_500_000 && new Date(a.figures_period_end as string).toISOString().startsWith("2024-12-31"), JSON.stringify(a));
    ok("its three tax periods are counted as held", a.periods_held === 3);
    ok("the pre-selected box is read from the SAME filing as the figures (latest: unmarked)", a.only_preselected_charities_box_checked === false);
    const d = rows.find((r) => r.ein === "444444444")!;
    ok("a funder with no figures has no figures period and null amounts, not zero", d.figures_period_end === null && d.fmv_assets_eoy_amt === null && d.contributions_paid_per_books_amt === null);
    const g = rows.find((r) => r.ein === "333333333")!;
    ok("an amount the return does not carry stays null (absent), and a missing terms row gives a null box", g.fmv_assets_eoy_amt === null && g.only_preselected_charities_box_checked === null);
    const z = rows.find((r) => r.ein === "555555555")!;
    ok("a real zero stays zero", Number(z.contributions_paid_per_books_amt) === 0);
    ok("no column is a single 'giving' figure; the paid column is named for the form line", !Object.keys(a).some((k) => /^giving|total_giving/.test(k)) && "contributions_paid_per_books_amt" in a);
  }

  section("search: name, EIN and city");
  const search = async (args: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> => {
    const a = { p_query: null, p_state: null, p_min_assets: null, p_max_assets: null, p_preselected: "any", p_sort: "name", p_descending: false, p_limit: 25, p_offset: 0, ...args };
    return as("authenticated", MEMBER, async () =>
      (await db.query(`select * from funder_reference_search($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9)`, [a.p_query, a.p_state, a.p_min_assets, a.p_max_assets, a.p_preselected, a.p_sort, a.p_descending, a.p_limit, a.p_offset])).rows as Array<Record<string, unknown>>
    );
  };
  const eins = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.ein as string);
  {
    ok("no query lists every funder", (await search()).length === 7);
    ok("a name word matches regardless of case", eins(await search({ p_query: "alpha" })).join() === "111111111");
    ok("several words must ALL match, in any order", eins(await search({ p_query: "foundation family" })).join() === "111111111");
    ok("a word that is not there matches nothing", (await search({ p_query: "alpha beta" })).length === 0);
    ok("a city matches", eins(await search({ p_query: "tulsa" })).sort().join() === "111111111,333333333,777777777");
    ok("an EIN with a dash matches by its start", eins(await search({ p_query: "22-2222" })).join() === "222222222");
    ok("an EIN given whole matches", eins(await search({ p_query: "222222222" })).join() === "222222222");
    ok("two digits are not an EIN search (too short to mean it); they match names", (await search({ p_query: "22" })).length === 0);
    ok("a percent sign is a character, not a wildcard", eins(await search({ p_query: "100%" })).join() === "555555555" && (await search({ p_query: "%" })).length === 1);
    ok("an underscore is a character, not a wildcard", eins(await search({ p_query: "kind_hearts" })).join() === "555555555" && (await search({ p_query: "kind-hearts" })).length === 0);
    ok("an apostrophe and an ampersand are ordinary characters", eins(await search({ p_query: "o'brien &" })).join() === "666666666");
    ok("a backslash does not break the search", (await search({ p_query: "a\\" })).length === 0);
    ok("a quote-and-semicolon string is only text", (await search({ p_query: "'; drop table funder_reference_foundations; --" })).length === 0 && ((await db.query(`select count(*)::int c from funder_reference_foundations`)).rows[0] as { c: number }).c === 7);
  }

  section("search: filters");
  {
    ok("state filters", eins(await search({ p_state: "OK" })).sort().join() === "111111111,333333333,777777777");
    ok("a state with no loaded funders returns no rows (the screen says why)", (await search({ p_state: "FL" })).length === 0);
    ok("a size band's lower bound includes the bound", eins(await search({ p_min_assets: 5_000_000, p_max_assets: 9_999_999 })).sort().join() === "555555555,666666666,777777777");
    ok("a size filter leaves out a funder with no assets figure; it is never counted as zero", !eins(await search({ p_max_assets: 999_999 })).includes("333333333") && !eins(await search({ p_max_assets: 999_999 })).includes("444444444"));
    ok("an upper bound alone works", eins(await search({ p_max_assets: 999_999 })).join() === "");
    ok("'marked' returns only funders whose latest filing ticks the box", eins(await search({ p_preselected: "marked" })).join() === "222222222");
    ok("'not_marked' returns every funder that does not tick it, including one with no terms row", eins(await search({ p_preselected: "not_marked" })).sort().join() === "111111111,333333333,444444444,555555555,666666666,777777777");
    ok("filters combine", eins(await search({ p_state: "OK", p_min_assets: 1_000_000 })).sort().join() === "111111111,777777777");
  }

  section("search: order and paging");
  {
    ok("name order is A to Z, ignoring case (digits first)", eins(await search({ p_sort: "name" })).join() === "555555555,111111111,222222222,444444444,333333333,666666666,777777777");
    ok("descending name order reverses it", eins(await search({ p_sort: "name", p_descending: true }))[0] === "777777777");
    const byAssets = eins(await search({ p_sort: "assets", p_descending: true }));
    ok("assets, largest first; funders with no figure come LAST, not first", byAssets[0] === "222222222" && byAssets.slice(-2).sort().join() === "333333333,444444444", byAssets.join());
    const byAssetsAsc = eins(await search({ p_sort: "assets", p_descending: false }));
    ok("assets, smallest first; absent figures still come last", byAssetsAsc[0] === "111111111" && byAssetsAsc.slice(-2).sort().join() === "333333333,444444444", byAssetsAsc.join());
    ok("a tie is broken by EIN, so paging is stable (5M ties: 555, 666, 777)", byAssetsAsc.slice(1, 4).join() === "555555555,666666666,777777777", byAssetsAsc.join());
    ok("grants-paid order is by the per-books line, and zero sorts as zero not as absent", eins(await search({ p_sort: "grants_paid", p_descending: true })).join().startsWith("222222222,666666666,777777777,111111111,555555555"));
    const p1 = await search({ p_limit: 3, p_offset: 0 });
    const p2 = await search({ p_limit: 3, p_offset: 3 });
    const p3 = await search({ p_limit: 3, p_offset: 6 });
    ok("pages do not overlap and cover every funder", new Set([...eins(p1), ...eins(p2), ...eins(p3)]).size === 7 && p1.length === 3 && p2.length === 3 && p3.length === 1);
    ok("total_matches is the whole match count on every page", [...p1, ...p2, ...p3].every((r) => Number(r.total_matches) === 7));
    ok("a page past the end has no rows", (await search({ p_limit: 3, p_offset: 30 })).length === 0);
    ok("a limit above 100 is held to 100; a limit below 1 is held to 1", (await search({ p_limit: 100000 })).length === 7 && (await search({ p_limit: 0 })).length === 1);
    ok("unknown sort is refused, not quietly replaced", (await as("authenticated", MEMBER, () => refused(`select * from funder_reference_search(null, null, null, null, 'any', 'name; drop table x', false, 25, 0)`))).includes("unknown p_sort"));
    ok("unknown pre-selected filter is refused", (await as("authenticated", MEMBER, () => refused(`select * from funder_reference_search(null, null, null, null, 'bogus', 'name', false, 25, 0)`))).includes("unknown p_preselected"));
  }

  section("the search gives the same row for every funder as the directory view (two code paths, one meaning)");
  {
    const viewRows = (await as("authenticated", MEMBER, async () => (await db.query(`select ein, name, city, state, figures_period_end, figures_filing_object_id, fmv_assets_eoy_amt, contributions_paid_per_books_amt, grants_listed_count, only_preselected_charities_box_checked, periods_held from funder_reference_directory order by ein`)).rows)) as Array<Record<string, unknown>>;
    const key = (r: Record<string, unknown>) => JSON.stringify(Object.entries(r).filter(([k]) => k !== "total_matches").sort(([a], [b]) => a.localeCompare(b)));
    const variants: Array<Record<string, unknown>> = [
      {}, { p_sort: "assets" }, { p_sort: "grants_paid", p_descending: true }, { p_min_assets: 1 }, { p_preselected: "marked" }, { p_preselected: "not_marked", p_sort: "assets" },
    ];
    for (const v of variants) {
      const got = (await search({ ...v, p_limit: 100 })).sort((a, b) => String(a.ein).localeCompare(String(b.ein)));
      const want = viewRows.filter((r) => got.some((g) => g.ein === r.ein));
      ok(`every funder returned matches the view's row, field for field: ${JSON.stringify(v)}`, got.length > 0 && got.length === want.length && got.every((g, i) => key(g) === key(want[i])), `${got.length} vs ${want.length}`);
    }
    const names = (await search({ p_sort: "name", p_limit: 100 })).map((r) => r.ein);
    ok("name order uses the light path (no figures) and still returns each funder's full row", names.length === 7 && (await search({ p_sort: "name", p_limit: 1 }))[0].figures_period_end !== undefined);
  }

  section("access: read-only, signed-in members only (ruling 0045 clause 1 is untouched)");
  {
    const stranger = await as("authenticated", STRANGER, async () => (await db.query(`select count(*)::int c from funder_reference_directory`)).rows[0] as { c: number });
    ok("a signed-in user with no organization sees no rows", stranger.c === 0);
    const strangerSearch = await as("authenticated", STRANGER, async () => (await db.query(`select * from funder_reference_search()`)).rows);
    ok("and the search returns nothing for them", strangerSearch.length === 0);
    ok("anon cannot read the view", (await as("anon", null, () => refused(`select * from funder_reference_directory`))).length > 0);
    ok("anon cannot call the search", (await as("anon", null, () => refused(`select * from funder_reference_search()`))).length > 0);
    ok("a member cannot insert into, update or delete through the view", (await as("authenticated", MEMBER, () => refused(`insert into funder_reference_directory (ein) values ('999999999')`))).length > 0 && (await as("authenticated", MEMBER, () => refused(`update funder_reference_directory set city = 'X'`))).length > 0 && (await as("authenticated", MEMBER, () => refused(`delete from funder_reference_directory`))).length > 0);
    const meta = (await db.query(`select p.provolatile, p.prosecdef, (select reloptions::text from pg_class where relname = 'funder_reference_directory') as vopts from pg_proc p where proname = 'funder_reference_search'`)).rows[0] as { provolatile: string; prosecdef: boolean; vopts: string };
    ok("the search is STABLE (it cannot write); it is SECURITY DEFINER only because the snapshot has no row-level security, and it checks membership first", meta.provolatile === "s" && meta.prosecdef === true && /my_organization_id\(\) is null/.test(sql88), JSON.stringify(meta));
    ok("the live view still runs as the caller (security_invoker)", /security_invoker=true/.test(meta.vopts ?? ""), meta.vopts);
    ok("nobody can read the snapshot directly (it has no row-level security, so no privilege is granted)", (await as("authenticated", MEMBER, () => refused(`select * from funder_reference_directory_snapshot`))).length > 0 && (await as("anon", null, () => refused(`select * from funder_reference_directory_snapshot`))).length > 0);
    ok("only the service role can refresh it", (await as("authenticated", MEMBER, () => refused(`select funder_reference_refresh_directory()`))).length > 0 && (await as("anon", null, () => refused(`select funder_reference_refresh_directory()`))).length > 0);
    const when = await as("authenticated", MEMBER, async () => (await db.query(`select funder_reference_directory_refreshed_at() as t`)).rows[0] as { t: unknown });
    ok("a member can read when the snapshot was last refreshed", when.t !== null && when.t !== undefined);
    const whenStranger = await as("authenticated", STRANGER, async () => (await db.query(`select funder_reference_directory_refreshed_at() as t`)).rows[0] as { t: unknown });
    ok("a signed-in user with no organization is told nothing", whenStranger.t === null);
    ok("anon cannot ask when it was refreshed", (await as("anon", null, () => refused(`select funder_reference_directory_refreshed_at()`))).length > 0);
    const count = ((await db.query(`select count(*)::int c from funder_reference_foundations`)).rows[0] as { c: number }).c;
    ok("the reference tables are exactly as they were (nothing the screen did wrote)", count === 7);

    // lag and refresh: a funder loaded after the snapshot is not in the search until the next refresh
    await seed(db, { ein: "888888888", name: "ETA LATE ARRIVAL FUND", city: "BOISE", state: "ID", periods: [{ end: "2024-12-31", fmv: 2_000_000, paid: 10_000 }] });
    ok("a funder loaded after the snapshot is NOT in the search yet (the screen says when it was refreshed)", (await search({ p_query: "late arrival" })).length === 0);
    await db.query(`select funder_reference_refresh_directory()`);
    ok("after a refresh it is", eins(await search({ p_query: "late arrival" })).join() === "888888888");
    ok("a refresh does not duplicate or lose funders", (await search({ p_limit: 100 })).length === 8);
  }
  await db.close();

  // ================================================================ the pure logic
  section("the search form is read safely");
  {
    const d = parseSearch({});
    ok("defaults: name A to Z, page 1, any state, any size", d.sort === "name" && d.descending === false && d.page === 1 && d.state === "" && d.minAssets === null && d.preselected === "any");
    ok("a dollar sort starts largest-first unless the form says otherwise", parseSearch({ sort: "assets" }).descending === true && parseSearch({ sort: "assets", dir: "asc" }).descending === false);
    ok("junk falls back to defaults, never an error", (() => { const j = parseSearch({ state: "ZZ", size: "???", sort: "drop", preselected: "x", page: "-4", dir: "up" }); return j.state === "" && j.minAssets === null && j.sort === "name" && j.preselected === "any" && j.page === 1; })());
    ok("a state code is accepted in any case", parseSearch({ state: "ok" }).state === "OK");
    ok("a repeated parameter uses the first", parseSearch({ q: ["a", "b"] }).q === "a");
    ok("a query is trimmed and held to 120 characters", parseSearch({ q: "  " + "x".repeat(300) }).q.length === 120);
    ok("a size band sets both bounds", (() => { const b = parseSearch({ size: "1m-10m" }); return b.minAssets === 1_000_000 && b.maxAssets === 9_999_999 && sizeBandValue(b) === "1m-10m"; })());
    ok("every size band is a distinct value", new Set(SIZE_BANDS.map((b) => b.value)).size === SIZE_BANDS.length);
    const input = parseSearch({ q: "tulsa", state: "OK", size: "10m-100m", sort: "assets", page: "3" });
    const href = searchHref("/funders", input);
    ok("a search round-trips through its own link", JSON.stringify(parseSearch(Object.fromEntries(new URL("http://x" + href).searchParams))) === JSON.stringify(input), href);
    ok("a default search has a bare link", searchHref("/funders", parseSearch({})) === "/funders");
    ok("pagination arithmetic", pageCount(0) === 1 && pageCount(25) === 1 && pageCount(26) === 2 && pageCount(PAGE_SIZE * 4) === 4);
  }

  section("which states are loaded and verified comes from the runs, not from a guess");
  {
    const run = (state: string | null, status: string, started: string, complete?: boolean): RunRow => ({ status, started_at: started, parameters: state ? { state } : {}, counts: complete === undefined ? {} : { supervisor: { complete } } });
    const s = stateStatuses([
      run("OK", "completed", "2026-11-10T01:00:00Z", true),
      run("TX", "completed", "2026-11-10T01:00:00Z", false),
      run("CA", "completed", "2026-11-09T01:00:00Z"), // run before the check existed
      run("CA", "interrupted", "2026-11-10T11:00:00Z"), // a later failed attempt does not unload it
      run("NH", "completed", "2026-11-10T20:00:00Z", false), // still being checked
      run("NY", "interrupted", "2026-11-10T02:00:00Z"),
      run("NY", "completed", "2026-11-10T03:00:00Z", true), // the retry completed
      run(null, "running", "2026-11-10T06:00:00Z"), // the supervisor's own row
      run("OK", "completed", "2026-11-09T01:00:00Z", false), // an older run does not override the latest
    ]);
    ok("verified only when the latest completed run says its sample check passed", s.OK === "verified" && s.NY === "verified");
    ok("complete=false and a run with no check recorded are 'not verified', not hidden", s.TX === "not_verified" && s.CA === "not_verified" && s.NH === "not_verified");
    ok("a state with no completed run is not loaded", s.FL === "not_loaded" && s.AK === "not_loaded");
    ok("every state and district is covered", Object.keys(s).length === Object.keys(US_STATES).length && Object.keys(US_STATES).length === 51);
    const d = describeStates(s);
    ok("the summary lists add up", d.loaded.length + d.notLoaded.length === 51 && d.verified.length + d.notVerified.length === d.loaded.length && d.verified.join() === "NY,OK");
  }

  section("absent, not held and zero are never confused");
  {
    ok("when the search list was refreshed is said in words, and 'not yet' when it never was", formatRefreshed("2026-11-10T22:00:51.469Z") === "November 10, 2026, 22:00 UTC" && formatRefreshed(null) === "not yet" && formatRefreshed("junk") === "not yet");
    ok("a figure the return does not carry reads as not stated, never $0", formatAmount(null) === NOT_STATED && formatAmount(undefined) === NOT_STATED && formatAmount("") === NOT_STATED);
    ok("a real zero reads as $0", formatAmount(0) === "$0");
    ok("a stored amount is whole dollars with separators", formatAmount(1234567) === "$1,234,567" && formatAmount("250000000") === "$250,000,000");
    ok("a tax period end is written in words with no time-zone shift", formatPeriodEnd("2024-12-31") === "December 31, 2024" && formatPeriodEnd("2023-01-01") === "January 1, 2023" && formatPeriodEnd(null) === NOT_STATED);
    ok("an EIN is shown with its dash", formatEin("582218044") === "58-2218044");
    ok("an address with nothing is said, not blank", placeLine(null, null) === "Address not stated on the return" && placeLine("Tulsa", "OK") === "Tulsa, OK");
    ok("a missing year says not held, with the reason; it does not say the funder gave nothing", coverageText(undefined) === NOT_HELD && /no return/.test(coverageText("no_filing_in_index")) && !/gave nothing|\$0/.test(coverageText("no_filing_in_index")));
    ok("an unreadable filing says so and carries the loader's reason", /could not be read: bad zip/.test(coverageText("unread", "bad zip")));
    const marked = preselectedText(true, true);
    ok("a ticked box says exactly that and that it does not accept unsolicited requests", /gives only to pre-selected/.test(marked.label) && /unsolicited/.test(marked.note ?? ""));
    const unmarked = preselectedText(false, true);
    ok("an unticked box is NOT turned into 'accepts requests'", !/accepts? (new )?requests/i.test(unmarked.label) && /not a statement that the funder accepts requests/.test(unmarked.note ?? ""));
    ok("no terms row is not held", preselectedText(null, false).label === NOT_HELD);
  }

  // ================================================================ source scans
  section("the screen reads only, with the user's session, and calls nothing outside (ruling 0048 clauses 1, 5, 6)");
  {
    const files = [...walk(join(root, "app/(dashboard)/funders")), join(root, "lib/funder-reference/read.ts"), join(root, "lib/funder-reference/browse.ts"), join(root, "lib/funder-reference/access.ts")];
    const src = (f: string) => readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const all = files.map((f) => [f, src(f)] as const);
    ok("the screen has pages, a gate, a loading and an error state", ["page.tsx", "layout.tsx", "loading.tsx", "error.tsx", "not-found.tsx"].every((n) => files.some((f) => f.endsWith(`funders/${n}`))));
    ok("no write call anywhere (insert, update, delete, upsert)", all.every(([, s]) => !/\.(insert|update|delete|upsert)\s*\(/.test(s)), all.filter(([, s]) => /\.(insert|update|delete|upsert)\s*\(/.test(s)).map(([f]) => f).join());
    ok("the only rpcs are the read-only search and the read-only 'when was it refreshed'; the screen never calls the refresh", all.every(([, s]) => [...s.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)].every((m) => m[1] === "funder_reference_search" || m[1] === "funder_reference_directory_refreshed_at")) && all.every(([, s]) => !/funder_reference_refresh_directory/.test(s)));
    ok("every table read is a reference table (or the profile's own superadmin flag in the door)", all.every(([, s]) => [...s.matchAll(/\.from\(\s*["']([^"']+)["']/g)].every((m) => /^funder_reference_/.test(m[1]) || m[1] === "profiles")));
    ok("the service key and the admin client are never imported", all.every(([, s]) => !/supabase\/admin|SERVICE_ROLE|createAdminClient|process\.env/.test(s)));
    ok("no server action: nothing on the screen can be posted to", all.every(([, s]) => !/["']use server["']/.test(s)));
    ok("no call to any outside service", all.every(([, s]) => !/\bfetch\s*\(|axios|XMLHttpRequest|anthropic|postmark|resend/i.test(s)));
    ok("nothing reaches the pipeline: no import of prospects, candidates, drafts, strategy, matching or scoring", all.every(([, s]) => !/from\s+["']@\/lib\/(prospects|candidates|drafts|strategy|screening|scoring|discovery|channel-match|send-draft|draft-send)/.test(s)));
    ok("the search page reads with the signed-in session (lib/supabase/server)", /lib\/supabase\/server/.test(src(join(root, "app/(dashboard)/funders/page.tsx"))));
    ok("the door is ONE function, used by the screen's layout and the sidebar entry", /canOpenFunderDatabase/.test(src(join(root, "app/(dashboard)/funders/layout.tsx"))) && /canOpenFunderDatabase\(supabase, user\.id\)/.test(src(join(root, "app/(dashboard)/layout.tsx"))) && /showFunderDatabase \? \[/.test(src(join(root, "app/(dashboard)/layout.tsx"))));
    ok("the door admits only a superadmin profile", /is_superadmin === true/.test(src(join(root, "lib/funder-reference/access.ts"))));
    ok("a person turned away is redirected", /redirect\("\/pipeline"\)/.test(src(join(root, "app/(dashboard)/funders/layout.tsx"))));
  }

  section("it is built to the app's customer-facing standards (ruling 0048 clause 6)");
  {
    const page = readFileSync(join(root, "app/(dashboard)/funders/page.tsx"), "utf8");
    const funder = readFileSync(join(root, "app/(dashboard)/funders/[ein]/page.tsx"), "utf8");
    ok("both pages use the shared tokens in lib/ui.ts", /from "@\/lib\/ui"/.test(page) && /from "@\/lib\/ui"/.test(funder));
    ok("every search field has a label tied to it", [...page.matchAll(/<(input|select)\s+id="(\w+)"/g)].every((m) => new RegExp(`htmlFor="${m[2]}"`).test(page)) && [...page.matchAll(/<(input|select)\s+id=/g)].length === 6);
    ok("search fields use the shared field style (border-box)", [...page.matchAll(/<(input|select)\b[^>]*>/g)].every((m) => /style=\{fieldStyle\}/.test(m[0])));
    ok("tables have column and row headers", /scope="col"/.test(page) && /scope="row"/.test(page) && /scope="col"/.test(funder) && /scope="row"/.test(funder));
    ok("tables scroll inside their card instead of widening the page", /tableWrapStyle/.test(page) && /tableWrapStyle/.test(funder));
    ok("an empty, loading and error state exist and say what happened", /No funders match/.test(page) && /role="alert"/.test(page) && /Loading/.test(readFileSync(join(root, "app/(dashboard)/funders/loading.tsx"), "utf8")));
    ok("a state that is not loaded is said to be not loaded, not 'no results'", /is not loaded yet/.test(page) && /not the same as having none|does not mean it has none/.test(page));
    ok("a state not yet verified is labeled so on the list and on the funder", /not yet verified/.test(page) && /not yet verified/.test(funder));
    const visible = (page + funder).replace(/import[^\n]*\n/g, "");
    ok("no table or column name is shown to the reader as a label", ![...visible.matchAll(/>\s*([^<>{}]*_amt[^<>{}]*)\s*</g)].length && ![...visible.matchAll(/label:\s*"[^"]*_[a-z]+[^"]*"/g)].length);
    ok("the donor-advised and public-charity kinds are not shown (item 116 is not loaded)", !/donor-advised|Schedule I|public charity/i.test(page + funder));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
