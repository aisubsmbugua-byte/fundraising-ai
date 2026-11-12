// STATE items 113 + 116 (ruling 0048 clause 4): the charities half of the internal funder database screen.
//
// (1) Migration 0091 -- the charity directory view, its snapshot and the search function -- on a REAL Postgres
// (PGlite) with every project migration applied unchanged, as a signed-in member, a stranger and anon, over
// charities seeded with the shapes the screen must get right (a charity with three periods whose LATEST period
// states no figure, a sponsor, one that is both, a funder with no Schedule I rows, a name with wildcard characters).
// (2) The pure logic in lib/funder-reference/charity-browse.ts and source scans for the ruling's "test of
// compliance": the charity screen reads only, with the user's session, never the service key; no donor is named.
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform, and it does not render the pages.
// The pages are verified by opening them against a database that has 0091 applied.
//
// Usage: npx tsx scripts/test-charity-screen.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootDatabase } from "./funder-reference-support";
import {
  CHARITY_RUN_KIND, DAF_COUNT_CAVEAT, GRANT_BANDS, KIND_LABELS, NO_DONOR_STATEMENT, charitySearchHref, charityStateChip, charityStateStatuses, describeCharityStates, grantBandValue, kindLabels, parseCharitySearch,
  type CharityRunRow,
} from "../lib/funder-reference/charity-browse";

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

interface Period { end: string; org: number | null; dafCnt?: number | null; dafValue?: number | null; rows?: number }
interface Seed { ein: string; name: string; city: string; state: string; charity: boolean; daf: boolean; periods: Period[] }

let counter = 1;
async function seed(db: PGlite, s: Seed): Promise<void> {
  const ids: Array<{ id: string; end: string }> = [];
  for (const p of s.periods) {
    const id = "2024" + String(counter++).padStart(14, "0");
    ids.push({ id, end: p.end });
    await db.query(
      `insert into charity_reference_filings (object_id, ein, return_type, index_tax_period, tax_period_end, status, index_file, document_archive_url, document_member, loaded_at, loader_version)
       values ($1, $2, '990', $3, $4, 'loaded', 'index_2025.csv', 'https://apps.irs.gov/pub/epostcard/990/xml/2025/x.zip', $5, now(), 't')`,
      [id, s.ein, p.end.slice(0, 4) + p.end.slice(5, 7), p.end, `${id}_public.xml`]
    );
    await db.query(
      `insert into charity_reference_figures (ein, tax_period_end, filing_object_id, part_ix_line_1_grants_domestic_orgs_total_amt, part_i_line_20_total_assets_eoy_amt, has_schedule_i, has_schedule_d, schedule_i_rows_listed_count, schedule_i_listed_derivation, form_places, loaded_at, loader_version)
       values ($1, $2, $3, $4, 5000000, true, $5, $6, 'the rows listed', '{}', now(), 't')`,
      [s.ein, p.end, id, p.org, p.dafCnt !== undefined, p.rows ?? 0]
    );
    if (p.dafCnt !== undefined) {
      await db.query(
        `insert into charity_reference_daf_figures (filing_object_id, ein, tax_period_end, daf_held_cnt, daf_value_eoy_amt, form_places, loaded_at, loader_version) values ($1, $2, $3, $4, $5, '{}', now(), 't')`,
        [id, s.ein, p.end, p.dafCnt, p.dafValue ?? null]
      );
    }
    await db.query(`insert into charity_reference_period_coverage (ein, period_year, status, filing_object_id, note, checked_at) values ($1, $2, 'loaded', $3, 'loaded', now())`, [s.ein, Number(p.end.slice(0, 4)), id]);
  }
  const latest = [...ids].sort((a, b) => b.end.localeCompare(a.end))[0];
  const basis = s.periods.map((p) => ({ tax_period_end: p.end, grants_to_domestic_orgs_amt: p.org, donor_advised_funds_held_cnt: p.dafCnt ?? null, donor_advised_fund_box: false }));
  await db.query(
    `insert into charity_reference_organizations (ein, source_object_id, source_tax_period_end, legal_name_line1, city, state, is_grantmaking_public_charity, is_daf_sponsor, kind_rule, kind_threshold_org_grants_amt, kind_basis, loaded_at, loader_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'Part IX, line 1 and Schedule D', 100000, $9::jsonb, now(), 't')`,
    [s.ein, latest.id, latest.end, s.name, s.city, s.state, s.charity, s.daf, JSON.stringify(basis)]
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
  section("migration 0091 applies to a real Postgres, unchanged, after all earlier ones");
  const db = new PGlite();
  const boot = await bootDatabase(db);
  ok(`all ${boot.applied.length} migration files apply with no error`, boot.failures.length === 0, boot.failures.join("; "));
  ok("0092 (the value sort) is among them and replaces only the function", boot.applied.some((f) => f.startsWith("0092_charity_reference_search_daf_value_sort")) && !/create\s+(unique\s+)?(table|index|view|materialized)/i.test(readFileSync(join(root, "supabase/migrations/0092_charity_reference_search_daf_value_sort.sql"), "utf8").replace(/--.*$/gm, "")));
  const sql93 = readFileSync(join(root, "supabase/migrations/0093_charity_reference_read_policy_once_per_query.sql"), "utf8").replace(/--.*$/gm, "");
  ok("0093 replaces only the six read policies, with the same rule evaluated once per query, and changes no table, column, index or grant", boot.applied.some((f) => f.startsWith("0093_charity_reference_read_policy")) && /drop policy/.test(sql93) && /\(select my_organization_id\(\)\) is not null/.test(sql93) && !/\b(alter\s+table|create\s+table|create\s+index|grant|revoke)\b/i.test(sql93));
  ok("0091 is the charity directory migration and is among them", boot.applied.some((f) => f.startsWith("0091_charity_reference_directory")));
  const sql91 = readFileSync(join(root, "supabase/migrations/0091_charity_reference_directory.sql"), "utf8").replace(/--.*$/gm, "");
  ok("0091 adds a view, a snapshot with its own indexes and three functions; it writes no row and puts no index or change on a loader table", /create view charity_reference_directory\b/.test(sql91) && /create materialized view charity_reference_directory_snapshot/.test(sql91) && !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop|alter\s+table)\b/i.test(sql91) && !/create\s+(unique\s+)?index\s+\w+\s+on\s+charity_reference_(filings|organizations|figures|daf_figures|grants|period_coverage)\b/i.test(sql91));

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

  // ---- seed: the shapes the screen must get right
  await seed(db, { ein: "111111111", name: "ALPHA COMMUNITY FOUNDATION", city: "TULSA", state: "OK", charity: true, daf: false, periods: [
    { end: "2022-12-31", org: 150_000, rows: 5 }, { end: "2023-12-31", org: 400_000, rows: 7 }, { end: "2024-12-31", org: null, rows: 0 } ] });
  await seed(db, { ein: "222222222", name: "BETA SPONSOR TRUST", city: "AUSTIN", state: "TX", charity: false, daf: true, periods: [
    { end: "2024-12-31", org: 20_000, dafCnt: 120, dafValue: 90_000_000, rows: 40 } ] });
  await seed(db, { ein: "333333333", name: "GAMMA BOTH KINDS", city: "TULSA", state: "OK", charity: true, daf: true, periods: [
    { end: "2023-12-31", org: 5_000_000, dafCnt: 3, rows: 12 }, { end: "2024-12-31", org: 7_000_000, dafCnt: 4, dafValue: 1_000_000, rows: 14 } ] });
  await seed(db, { ein: "444444444", name: "DELTA BIG GIVER", city: "OMAHA", state: "NE", charity: true, daf: false, periods: [{ end: "2024-12-31", org: 25_000_000, rows: 90 }] });
  await seed(db, { ein: "555555555", name: "100% KIND_HEARTS FUND", city: "RENO", state: "NV", charity: true, daf: false, periods: [{ end: "2024-12-31", org: 100_000, rows: 1 }] });
  await seed(db, { ein: "666666666", name: "ZERO DAF SPONSOR", city: "RENO", state: "NV", charity: false, daf: true, periods: [{ end: "2024-12-31", org: null, dafCnt: 0 }] });

  const pre = (await db.query(`select count(*)::int c from charity_reference_directory_snapshot`)).rows[0] as { c: number };
  ok("before a refresh the snapshot is empty: the search lags the loader until it is refreshed", pre.c === 0);
  await db.query(`select charity_reference_refresh_directory()`);

  section("the directory shows one funder per row, with the latest figures and the rule's own maxima");
  {
    const rows = (await as("authenticated", MEMBER, async () => (await db.query(`select * from charity_reference_directory order by ein`)).rows)) as Array<Record<string, unknown>>;
    ok("one row per funder", rows.length === 6, String(rows.length));
    const a = rows.find((r) => r.ein === "111111111")!;
    ok("the LATEST period's figure is shown as the latest (here: not stated, so null, not the older 400,000 and not zero)", a.grants_domestic_orgs_amt === null && new Date(a.figures_period_end as string).toISOString().startsWith("2024-12-31"), JSON.stringify(a));
    ok("the size used to sort and filter is the LARGEST stated figure over the periods held (the figure the rule tests)", Number(a.grants_domestic_orgs_max_amt) === 400_000, JSON.stringify(a));
    ok("its three periods are counted as held", a.periods_held === 3);
    const s = rows.find((r) => r.ein === "222222222")!;
    ok("a sponsor carries its fund count and value, and no grants figure it did not state", Number(s.daf_held_max_cnt) === 120 && Number(s.daf_value_eoy_amt) === 90_000_000);
    const b = rows.find((r) => r.ein === "333333333")!;
    ok("a funder that is both carries both flags, and the latest sponsor figures", b.is_grantmaking_public_charity === true && b.is_daf_sponsor === true && Number(b.daf_held_max_cnt) === 4);
    const d = rows.find((r) => r.ein === "444444444")!;
    ok("a charity with no donor-advised fund figures has null, not zero", d.daf_held_max_cnt === null && d.daf_value_eoy_amt === null);
    const z = rows.find((r) => r.ein === "666666666")!;
    ok("a reported zero fund count stays zero (a real zero is not absent)", Number(z.daf_held_max_cnt) === 0);
    ok("no column is a single 'giving' figure and none names a donor", !Object.keys(a).some((k) => /^giving|total_giving|donor_name|donor_id/.test(k)));
  }

  section("search: name, EIN and city");
  const search = async (args: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> => {
    const a = { p_query: null, p_state: null, p_kind: "any", p_min_grants: null, p_max_grants: null, p_sort: "name", p_descending: false, p_limit: 25, p_offset: 0, ...args };
    return as("authenticated", MEMBER, async () =>
      (await db.query(`select * from charity_reference_search($1, $2, $3, $4::bigint, $5::bigint, $6, $7, $8, $9)`, [a.p_query, a.p_state, a.p_kind, a.p_min_grants, a.p_max_grants, a.p_sort, a.p_descending, a.p_limit, a.p_offset])).rows as Array<Record<string, unknown>>
    );
  };
  const eins = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.ein as string);
  {
    ok("no query lists every funder", (await search()).length === 6);
    ok("a name word matches regardless of case", eins(await search({ p_query: "alpha" })).join() === "111111111");
    ok("several words must ALL match, in any order", eins(await search({ p_query: "foundation community" })).join() === "111111111");
    ok("a city matches", eins(await search({ p_query: "tulsa" })).sort().join() === "111111111,333333333");
    ok("an EIN with a dash matches by its start", eins(await search({ p_query: "22-2222" })).join() === "222222222");
    ok("a percent sign is a character, not a wildcard", eins(await search({ p_query: "100%" })).join() === "555555555" && (await search({ p_query: "%" })).length === 1);
    ok("a state filter", eins(await search({ p_state: "NV" })).sort().join() === "555555555,666666666");
    const total = await search({ p_limit: 2 });
    ok("total_matches counts every match, whatever the page", total.length === 2 && Number(total[0].total_matches) === 6);
  }

  section("search: kind, size and sort (kinds are never blended)");
  {
    ok("kind 'charity' returns the funders carrying the public-charity flag (including one that is also a sponsor)", eins(await search({ p_kind: "charity" })).sort().join() === "111111111,333333333,444444444,555555555");
    ok("kind 'daf' returns the sponsors (including the one that is also a charity)", eins(await search({ p_kind: "daf" })).sort().join() === "222222222,333333333,666666666");
    ok("kind 'both' returns only a funder that is both", eins(await search({ p_kind: "both" })).join() === "333333333");
    ok("a funder that is both is ONE funder in 'any', not two", (await search({ p_kind: "any" })).filter((r) => r.ein === "333333333").length === 1);
    ok("a size band bounds the largest stated figure; a funder with no figure is left out, never counted as zero", eins(await search({ p_min_grants: 1_000_000, p_max_grants: 9_999_999 })).join() === "333333333" && !eins(await search({ p_min_grants: 0 })).includes("666666666"));
    ok("sorting by grants puts the largest first and the funder with no figure last", eins(await search({ p_sort: "grants", p_descending: true })).join() === "444444444,333333333,111111111,555555555,222222222,666666666", eins(await search({ p_sort: "grants", p_descending: true })).join());
    ok("sorting by donor-advised funds puts the most first; a funder with none stated is last", eins(await search({ p_sort: "daf_funds", p_descending: true })).slice(0, 3).join() === "222222222,333333333,666666666");
    ok("sorting by donor-advised fund value puts the largest value first, and a funder with no value is last (0092)", eins(await search({ p_sort: "daf_value", p_descending: true })).slice(0, 2).join() === "222222222,333333333", eins(await search({ p_sort: "daf_value", p_descending: true })).join());
    ok("an unknown sort is refused, not quietly replaced", (await as("authenticated", MEMBER, () => refused(`select * from charity_reference_search(null, null, 'any', null, null, 'bogus')`))).length > 0);
    ok("an unknown kind is refused", (await as("authenticated", MEMBER, () => refused(`select * from charity_reference_search(null, null, 'private_foundation')`))).length > 0);
  }

  section("access: read-only, signed-in members only (ruling 0045 clause 1 is untouched)");
  {
    const stranger = await as("authenticated", STRANGER, async () => (await db.query(`select count(*)::int c from charity_reference_directory`)).rows[0] as { c: number });
    ok("a signed-in user with no organization sees no rows", stranger.c === 0);
    ok("and the search returns nothing for them", (await as("authenticated", STRANGER, async () => (await db.query(`select * from charity_reference_search()`)).rows)).length === 0);
    ok("anon cannot read the view", (await as("anon", null, () => refused(`select * from charity_reference_directory`))).length > 0);
    ok("anon cannot call the search", (await as("anon", null, () => refused(`select * from charity_reference_search()`))).length > 0);
    ok("a member cannot write through the view or the tables", (await as("authenticated", MEMBER, () => refused(`insert into charity_reference_directory (ein) values ('999999999')`))).length > 0 && (await as("authenticated", MEMBER, () => refused(`update charity_reference_organizations set city = 'X'`))).length > 0 && (await as("authenticated", MEMBER, () => refused(`delete from charity_reference_filings`))).length > 0);
    const meta = (await db.query(`select p.provolatile, p.prosecdef, (select reloptions::text from pg_class where relname = 'charity_reference_directory') as vopts from pg_proc p where proname = 'charity_reference_search'`)).rows[0] as { provolatile: string; prosecdef: boolean; vopts: string | null };
    ok("the search is STABLE (it cannot write); SECURITY DEFINER only because the snapshot has no row-level security, and it checks membership first", meta.provolatile === "s" && meta.prosecdef === true && /my_organization_id\(\) is null/.test(sql91), JSON.stringify(meta));
    ok("the live view still runs as the caller (security_invoker)", /security_invoker=true/.test(meta.vopts ?? ""), String(meta.vopts));
    ok("nobody can read the snapshot directly", (await as("authenticated", MEMBER, () => refused(`select * from charity_reference_directory_snapshot`))).length > 0 && (await as("anon", null, () => refused(`select * from charity_reference_directory_snapshot`))).length > 0);
    ok("only the service role can refresh it", (await as("authenticated", MEMBER, () => refused(`select charity_reference_refresh_directory()`))).length > 0 && (await as("anon", null, () => refused(`select charity_reference_refresh_directory()`))).length > 0);
    const when = await as("authenticated", MEMBER, async () => (await db.query(`select charity_reference_directory_refreshed_at() as t`)).rows[0] as { t: unknown });
    ok("a member can read when the snapshot was last refreshed; a stranger is told nothing", when.t !== null && (await as("authenticated", STRANGER, async () => ((await db.query(`select charity_reference_directory_refreshed_at() as t`)).rows[0] as { t: unknown }).t)) === null);
    await db.query(`insert into charity_reference_grants (filing_object_id, ordinal, ein, tax_period_end, source_location, recipient_name_line1, cash_grant_amt, loaded_at, loader_version)
                    select object_id, 1, ein, tax_period_end, 'Schedule I, Part II', 'A RECIPIENT', 1000, now(), 't' from charity_reference_filings where ein = '444444444'`);
    const direct = async (uid: string | null) => as("authenticated", uid, async () => Promise.all(["filings", "organizations", "figures", "daf_figures", "grants", "period_coverage"].map(async (t) => ((await db.query(`select count(*)::int c from charity_reference_${t}`)).rows[0] as { c: number }).c)));
    const mine = await direct(MEMBER);
    ok("after 0093 a member still reads every charity table and a stranger reads none (the rule is unchanged)", mine.every((c) => c > 0) && (await direct(STRANGER)).every((c) => c === 0) && (await as("anon", null, () => refused(`select * from charity_reference_filings`))).length > 0, JSON.stringify(mine));
    const n = ((await db.query(`select count(*)::int c from charity_reference_organizations`)).rows[0] as { c: number }).c;
    ok("the reference tables are exactly as they were (nothing the screen did wrote)", n === 6);

    await seed(db, { ein: "777777777", name: "ETA LATE ARRIVAL", city: "BOISE", state: "ID", charity: true, daf: false, periods: [{ end: "2024-12-31", org: 300_000, rows: 3 }] });
    ok("a funder loaded after the snapshot is NOT in the search yet", (await search({ p_query: "late arrival" })).length === 0);
    await db.query(`select charity_reference_refresh_directory()`);
    ok("after a refresh it is, with nothing duplicated or lost", eins(await search({ p_query: "late arrival" })).join() === "777777777" && (await search({ p_limit: 100 })).length === 7);
  }
  await db.close();

  section("the search form is read safely");
  {
    const d = parseCharitySearch({});
    ok("defaults: name A to Z, page 1, any state, any kind, any size", d.sort === "name" && d.descending === false && d.page === 1 && d.state === "" && d.kind === "any" && d.minGrants === null);
    ok("a dollar sort starts largest-first unless the form says otherwise", parseCharitySearch({ sort: "grants" }).descending === true && parseCharitySearch({ sort: "grants", dir: "asc" }).descending === false);
    ok("junk falls back to defaults, never an error", (() => { const j = parseCharitySearch({ state: "ZZ", size: "???", sort: "drop", kind: "x", page: "-4", dir: "up" }); return j.state === "" && j.minGrants === null && j.sort === "name" && j.kind === "any" && j.page === 1; })());
    ok("a kind is accepted only if it is one of the three", parseCharitySearch({ kind: "daf" }).kind === "daf" && parseCharitySearch({ kind: "foundation" }).kind === "any");
    ok("a state code is accepted in any case; a repeated parameter uses the first", parseCharitySearch({ state: "ok" }).state === "OK" && parseCharitySearch({ q: ["a", "b"] }).q === "a");
    ok("every size band is a distinct value and sets both bounds", new Set(GRANT_BANDS.map((b) => b.value)).size === GRANT_BANDS.length && (() => { const b = parseCharitySearch({ size: "1m-10m" }); return b.minGrants === 1_000_000 && b.maxGrants === 9_999_999 && grantBandValue(b) === "1m-10m"; })());
    const input = parseCharitySearch({ q: "tulsa", state: "OK", kind: "both", size: "10m-plus", sort: "daf_funds", page: "3" });
    const href = charitySearchHref("/funders/charities", input);
    ok("a search round-trips through its own link", JSON.stringify(parseCharitySearch(Object.fromEntries(new URL(href, "http://x").searchParams))) === JSON.stringify(input), href);
    ok("the default search link is the bare path", charitySearchHref("/funders/charities", parseCharitySearch({})) === "/funders/charities");
    ok("the kind labels are the three kinds and 'any'", Object.keys(KIND_LABELS).sort().join() === "any,both,charity,daf" && kindLabels(true, true).length === 2 && kindLabels(false, false).length === 0);
  }

  section("which states are loaded and what their check said");
  {
    const run = (state: string, v: string | null, status = "completed", at = "2026-11-11T10:00:00Z", kind = CHARITY_RUN_KIND): CharityRunRow => ({ status, started_at: at, parameters: { state, kind }, v });
    const s = charityStateStatuses([run("MO", "verified"), run("OH", "verified_within_tolerance"), run("WI", "not_verified"), run("AK", null), run("TX", "verified", "running"), run("NY", "verified", "completed", "2026-11-11T10:00:00Z", "some_foundation_kind")]);
    ok("a verified, a within-tolerance and a not-verified state are told apart", s.MO === "verified" && s.OH === "verified_within_tolerance" && s.WI === "not_verified");
    ok("a completed run with no check result is 'check not recorded', never guessed to have passed", s.AK === "check_not_recorded");
    ok("a run that has not completed, and a run of another kind, do not make a state loaded", s.TX === "not_loaded" && s.NY === "not_loaded");
    const later = charityStateStatuses([run("MO", "not_verified", "completed", "2026-11-11T09:00:00Z"), run("MO", "verified", "completed", "2026-11-11T12:00:00Z")]);
    ok("the latest completed run decides", later.MO === "verified");
    const d = describeCharityStates(s);
    ok("the summary counts each status separately", d.exact.join() === "MO" && d.withinTolerance.join() === "OH" && d.notVerified.join() === "WI" && d.notRecorded.join() === "AK" && d.loaded.length === 4);
    ok("every status has a chip text of its own", ["verified", "verified_within_tolerance", "not_verified", "check_not_recorded", "not_loaded"].every((k) => charityStateChip(k as never)?.text) && new Set(["verified", "verified_within_tolerance", "not_verified", "check_not_recorded", "not_loaded"].map((k) => charityStateChip(k as never)!.text)).size === 5);
  }

  section("test of compliance (ruling 0048): reads only, user's session, no donor, one door");
  {
    const files = [...walk(join(root, "app/(dashboard)/funders/charities")), join(root, "lib/funder-reference/charity-read.ts"), join(root, "lib/funder-reference/charity-browse.ts"), join(root, "app/(dashboard)/funders/FunderTabs.tsx")];
    const src = files.map((f) => ({ f, s: readFileSync(f, "utf8") }));
    ok("no charity screen file imports the service key or an admin client", src.every((x) => !/SUPABASE_SERVICE_ROLE_KEY|service[_-]?role|createAdminClient|lib\/supabase\/admin/i.test(x.s)));
    ok("no charity screen file writes (insert, update, delete, upsert, rpc other than the two reads)", src.every((x) => !/\.(insert|update|delete|upsert)\(/.test(x.s)) && src.every((x) => [...x.s.matchAll(/\.rpc\("([a-z_]+)"/g)].every((m) => ["charity_reference_search", "charity_reference_directory_refreshed_at"].includes(m[1]))));
    ok("no file creates a prospect, calls an AI model or makes a request to another site", src.every((x) => !/prospects|anthropic|fetch\(/i.test(x.s)));
    ok("the charity pages sit under the funders layout, whose one door is canOpenFunderDatabase", /canOpenFunderDatabase/.test(readFileSync(join(root, "app/(dashboard)/funders/layout.tsx"), "utf8")) && files.filter((f) => /page\.tsx$/.test(f)).every((f) => f.includes("/app/(dashboard)/funders/charities")));
    ok("the no-donor statement is on the search page and the funder page", src.filter((x) => /page\.tsx$/.test(x.f)).every((x) => /NO_DONOR_STATEMENT/.test(x.s)) && /No donor, advisor or fund is named/.test(NO_DONOR_STATEMENT));
    ok("the donor-advised fund count carries its caveat on the search page and the funder page", /DAF_COUNT_CAVEAT/.test(src.find((x) => x.f.endsWith("charities/page.tsx"))!.s) && /DAF_COUNT_CAVEAT/.test(src.find((x) => x.f.includes("[ein]"))!.s) && /dollar amount/.test(DAF_COUNT_CAVEAT));
    ok("the pages never present a missing figure as zero (they use the stored value or the named absence)", src.filter((x) => /page\.tsx$/.test(x.f)).every((x) => !/\?\?\s*0\b/.test(x.s)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
