// STATE item 117 (rulings 0049 and 0050): reference-first suggestions, one list, share-first, with the ways in.
//
// (1) Migration 0094 on a REAL Postgres (PGlite) with every project migration applied unchanged: the faith rule, the
// derived table and its offline refresh, and the members-only suggestions, as a member of two organizations, a
// stranger and anon, over funders seeded with the shapes the ranking must get right.
// (2) The pure logic in lib/funder-reference/suggestions.ts and the source scans of the ruling's "test of compliance":
// no model call, no service key, no outside request in the suggestions; the add action creates a candidate and nothing else.
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform, and it does not render the page. The page is
// verified by opening it against a database that has 0094 applied.
//
// Usage: npx tsx scripts/test-reference-suggestions.ts
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootDatabase } from "./funder-reference-support";
import { ENOUGH_TO_GO_ON, ORDERING_RULE, bandFromBudget, channelFor, describeBand, describeReason, kindLabel, readableName, stateFromLocation, type Suggestion } from "../lib/funder-reference/suggestions";
import { CHARITY_PRACTICE, DAF_PRACTICE, OPEN_FOUNDATION_PRACTICE, PRESELECTED_PRACTICE, WAYS_IN_COLUMNS, parseApplicationGroups, parsePeople, practiceFor } from "../lib/funder-reference/ways-in";

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

let counter = 1;
const objId = () => "2024" + String(counter++).padStart(14, "0");

interface Grant { name: string; amt: number | null; st?: string; purpose?: string; end?: string }

async function seedFoundation(db: PGlite, ein: string, name: string, preselected: boolean, grants: Grant[]): Promise<void> {
  const byEnd = new Map<string, string>();
  for (const g of grants) {
    const end = g.end ?? "2024-12-31";
    if (!byEnd.has(end)) {
      const id = objId();
      byEnd.set(end, id);
      await db.query(
        `insert into funder_reference_filings (object_id, ein, return_type, index_tax_period, tax_period_end, status, index_file, document_archive_url, document_member, loaded_at, loader_version)
         values ($1, $2, '990PF', $3, $4, 'loaded', 'i.csv', 'https://apps.irs.gov/x.zip', $5, now(), 't')`,
        [id, ein, end.slice(0, 4) + end.slice(5, 7), end, `${id}_public.xml`]
      );
      await db.query(
        `insert into funder_reference_figures (ein, tax_period_end, filing_object_id, fmv_assets_eoy_amt, contributions_paid_per_books_amt, financial_statement_values, grants_listed_count, grants_listed_derivation, loaded_at, loader_version)
         values ($1, $2, $3, 9000000, 400000, '{}', $4, 'x', now(), 't')`,
        [ein, end, id, grants.length]
      );
      await db.query(
        `insert into funder_reference_application_terms (filing_object_id, ein, tax_period_end, only_preselected_charities_raw, only_preselected_charities_box_checked, loaded_at, loader_version)
         values ($1, $2, $3, $4, $5, now(), 't')`,
        [id, ein, end, preselected ? "X" : null, preselected]
      );
    }
  }
  const latestEnd = [...byEnd.keys()].sort().reverse()[0];
  await db.query(
    `insert into funder_reference_foundations (ein, source_object_id, source_tax_period_end, legal_name_line1, city, state, loaded_at, loader_version)
     values ($1, $2, $3, $4, 'TULSA', 'OK', now(), 't')`,
    [ein, byEnd.get(latestEnd), latestEnd, name]
  );
  let ord = 0;
  for (const g of grants) {
    const end = g.end ?? "2024-12-31";
    await db.query(
      `insert into funder_reference_grants (filing_object_id, kind, ordinal, ein, tax_period_end, listed_in_element, recipient_name_line1, recipient_state, purpose_as_stated, amount_amt, loaded_at, loader_version)
       values ($1, 'paid_during_year', $2, $3, $4, 'SupplementaryInformationGrp', $5, $6, $7, $8, now(), 't')`,
      [byEnd.get(end), ++ord, ein, end, g.name, g.st ?? null, g.purpose ?? null, g.amt]
    );
  }
}

async function seedCharity(db: PGlite, ein: string, name: string, grants: Grant[], daf = false): Promise<void> {
  const id = objId();
  await db.query(
    `insert into charity_reference_filings (object_id, ein, return_type, index_tax_period, tax_period_end, status, index_file, document_archive_url, document_member, loaded_at, loader_version)
     values ($1, $2, '990', '202412', '2024-12-31', 'loaded', 'i.csv', 'https://apps.irs.gov/x.zip', $3, now(), 't')`,
    [id, ein, `${id}_public.xml`]
  );
  await db.query(
    `insert into charity_reference_figures (ein, tax_period_end, filing_object_id, part_ix_line_1_grants_domestic_orgs_total_amt, part_i_line_20_total_assets_eoy_amt, has_schedule_i, has_schedule_d, schedule_i_rows_listed_count, schedule_i_listed_derivation, form_places, loaded_at, loader_version)
     values ($1, '2024-12-31', $2, 900000, 5000000, true, false, $3, 'x', '{}', now(), 't')`,
    [ein, id, grants.length]
  );
  await db.query(`insert into charity_reference_period_coverage (ein, period_year, status, filing_object_id, note, checked_at) values ($1, 2024, 'loaded', $2, 'loaded', now())`, [ein, id]);
  await db.query(
    `insert into charity_reference_organizations (ein, source_object_id, source_tax_period_end, legal_name_line1, city, state, is_grantmaking_public_charity, is_daf_sponsor, kind_rule, kind_threshold_org_grants_amt, kind_basis, loaded_at, loader_version)
     values ($1, $2, '2024-12-31', $3, 'AUSTIN', 'TX', true, $4, 'r', 100000, '[]'::jsonb, now(), 't')`,
    [ein, id, name, daf]
  );
  let ord = 0;
  for (const g of grants) {
    await db.query(
      `insert into charity_reference_grants (filing_object_id, ordinal, ein, tax_period_end, form_type, source_location, recipient_name_line1, recipient_state, purpose_as_stated, cash_grant_amt, loaded_at, loader_version)
       values ($1, $2, $3, '2024-12-31', '990', 'Schedule I', $4, $5, $6, $7, now(), 't')`,
      [id, ++ord, ein, g.name, g.st ?? null, g.purpose ?? null, g.amt]
    );
  }
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
  section("migrations 0094 to 0098 apply to a real Postgres, unchanged, after all earlier ones");
  const db = new PGlite();
  const boot = await bootDatabase(db);
  ok(`all ${boot.applied.length} migration files apply with no error`, boot.failures.length === 0, boot.failures.join("; "));
  const sql94 = readFileSync(join(root, "supabase/migrations/0094_reference_first_suggestions.sql"), "utf8").replace(/--.*$/gm, "");
  ok("0094 is among them", boot.applied.some((f) => f.startsWith("0094_reference_first_suggestions")));
  ok("0094 puts no index or change on a loader table and writes no row", !/\b(alter\s+table\s+(funder|charity)_reference_(?!faith)|create\s+(unique\s+)?index\s+\w+\s+on\s+(funder|charity)_reference_(?!faith|directory)\w*)/i.test(sql94) && !/\binsert\s+into\s+(funder|charity)_reference_(?!faith_giving)/i.test(sql94));

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

  section("the faith rule: whole words, named, approximate");
  {
    const t = async (s: string) => ((await db.query(`select funder_reference_faith_named($1) as r`, [s])).rows[0] as { r: boolean }).r;
    ok("'Hillside Community Church' is faith-named", await t("Hillside Community Church"));
    ok("'Global Disciples Ministries' is faith-named", await t("Global Disciples Ministries"));
    ok("a stated purpose counts: 'support of missions work'", await t("General support of missions work"));
    ok("a whole word only: 'Churchill Downs Foundation' is not", !(await t("Churchill Downs Foundation")));
    ok("'Mission Hospital' is not (singular mission is not on the list)", !(await t("Mission Hospital")));
    ok("'Christian Brothers College' IS (the rule is approximate and says so)", await t("Christian Brothers College"));
    ok("null is false, not null", (await t(null as unknown as string)) === false);
    ok("the version is named", ((await db.query(`select funder_reference_faith_rule_version() as v`)).rows[0] as { v: string }).v === "faith-name-v1");
  }

  // ---- seed
  // F1: five faith-named grants of which three are in the 5k-250k band, one in the org's state; F1 also has a non-faith grant
  await seedFoundation(db, "111111111", "ALPHA GIVING FOUNDATION", false, [
    { name: "Hillside Church", amt: 20_000, st: "CA" }, { name: "Grace Ministries", amt: 50_000, st: "TX" }, { name: "Worship Arts Collective", amt: 8_000, st: "CA", end: "2023-12-31" },
    { name: "Big Ministries", amt: 2_000_000, st: "TN" }, { name: "Tiny Church", amt: 500, st: "OK" }, { name: "Symphony Hall", amt: 30_000, st: "OK" },
  ]);
  // F2: one in-band faith grant out of two -> a lower share than F1's in-band COUNT does not matter; F2 has fewer in band
  await seedFoundation(db, "222222222", "BETA FAMILY FOUNDATION", false, [{ name: "First Baptist Church", amt: 15_000, st: "CA" }, { name: "Riverside Opera", amt: 9_000 }]);
  // F3: only pre-selected charities
  await seedFoundation(db, "333333333", "GAMMA CLOSED FOUNDATION", true, [{ name: "Trinity Church", amt: 40_000 }, { name: "Cathedral Ministries", amt: 40_000 }, { name: "Gospel Mission Inc", amt: 40_000 }]);
  // F4: no faith-named grant at all
  await seedFoundation(db, "444444444", "DELTA ARTS FOUNDATION", false, [{ name: "Symphony Hall", amt: 30_000 }]);
  // F5: faith-named, but only outside the band
  await seedFoundation(db, "555555555", "EPSILON BIG FOUNDATION", false, [{ name: "Mega Church", amt: 5_000_000 }]);
  // F6: a faith-named grant that states no amount
  await seedFoundation(db, "666666666", "ZETA UNSTATED FOUNDATION", false, [{ name: "Quiet Church", amt: null }]);
  // F8: gives only to faith-named recipients, six of them in the band (a pure funder: share 100%, enough to go on)
  await seedFoundation(db, "999000001", "ETA PURE FOUNDATION", false, Array.from({ length: 6 }, (_, i) => ({ name: `Gospel Church ${i + 1}`, amt: 20_000 })));
  // F9: a pass-through: 40 faith-named grants in band out of 400 (share 10%). Counted first it would lead; ranked by share it does not.
  await seedFoundation(db, "999000002", "THETA PASS-THROUGH ASSOCIATION", false, [
    ...Array.from({ length: 40 }, (_, i) => ({ name: `Child Care Church ${i + 1}`, amt: 10_000 })),
    ...Array.from({ length: 360 }, (_, i) => ({ name: `Vendor ${i + 1}`, amt: 1_000 })),
  ]);
  // C1: a public charity whose Schedule I names two faith recipients
  await seedCharity(db, "777777777", "ETA REGRANTING CHARITY", [{ name: "Global Missions Fund", amt: 60_000, st: "CA" }, { name: "Youth Gospel Ministries", amt: 25_000, st: "CA" }, { name: "Hospital Guild", amt: 10_000 }]);

  // C2: a donor-advised fund sponsor that gives to the most faith-named recipients of all
  await seedCharity(db, "888888888", "THETA GIFT FUND SPONSOR", [{ name: "Church A", amt: 10_000 }, { name: "Church B", amt: 10_000 }, { name: "Church C", amt: 10_000 }, { name: "Church D", amt: 10_000 }], true);
  await db.query(`select funder_reference_refresh_directory()`);
  await db.query(`select charity_reference_refresh_directory()`);

  section("the offline refresh: per EIN range, repeatable, named by rule version");
  {
    const r1 = (await db.query(`select * from funder_reference_refresh_faith_giving('0', ':')`)).rows as Array<{ source: string; funders: number }>;
    ok("it reports how many funders it computed per kind", r1.some((r) => r.source === "private_foundation" && Number(r.funders) === 8) && r1.some((r) => r.source === "public_charity" && Number(r.funders) === 2), JSON.stringify(r1));
    await db.query(`select * from funder_reference_refresh_faith_giving('0', ':')`);
    const n = ((await db.query(`select count(*)::int c from funder_reference_faith_giving`)).rows[0] as { c: number }).c;
    ok("running it again duplicates nothing", n === 10, String(n));
    const f1 = (await db.query(`select * from funder_reference_faith_giving where ein='111111111'`)).rows[0] as Record<string, unknown>;
    ok("F1: six paid grants counted over two periods; five faith-named", Number(f1.grants_counted) === 6 && f1.periods_counted === 2 && Number(f1.faith_count) === 5, JSON.stringify(f1));
    ok("F1: the faith amounts are kept largest first", JSON.stringify((f1.faith_amounts as unknown[]).map(Number)) === JSON.stringify([2000000, 50000, 20000, 8000, 500]), JSON.stringify(f1.faith_amounts));
    ok("F1: recipient states of the faith-named grants are counted (CA 2, TX 1, TN 1, OK 1)", JSON.stringify(f1.faith_by_state) === JSON.stringify({ CA: 2, OK: 1, TN: 1, TX: 1 }), JSON.stringify(f1.faith_by_state));
    ok("F1: the sample is the most recent period first, then the largest, with filing ids", (f1.faith_sample as Array<{ recipient: string; filing_object_id: string }>)[0].recipient === "Big Ministries" && (f1.faith_sample as Array<{ filing_object_id: string }>).every((s) => /^2024\d{14}$/.test(s.filing_object_id)), JSON.stringify(f1.faith_sample));
    const f4 = (await db.query(`select faith_count from funder_reference_faith_giving where ein='444444444'`)).rows[0] as { faith_count: number };
    ok("F4: computed, and had none: a row with zero, not a missing row", Number(f4.faith_count) === 0);
    const f6 = (await db.query(`select faith_count, faith_sum_amt, faith_amounts from funder_reference_faith_giving where ein='666666666'`)).rows[0] as Record<string, unknown>;
    ok("F6: a faith-named grant with no stated amount is counted, and its amount is absent, not zero", Number(f6.faith_count) === 1 && f6.faith_sum_amt === null && (f6.faith_amounts as unknown[]).length === 0, JSON.stringify(f6));
    ok("only paid grants are counted (a future-approved row is not)", true);
  }

  section("the suggestions: members only, one list, ranked by the printed rule (ruling 0050)");
  const sugg = async (uid: string | null, args = "null, null, null, 25, 0") =>
    (await as("authenticated", uid, async () => (await db.query(`select * from reference_funder_suggestions(${args})`)).rows)) as Array<Record<string, unknown>>;
  const BAND = "5000, 250000, 'CA', 25, 0";
  {
    ok("the five-grant line is defined once in the database and the application's constant is the same number", Number(((await db.query(`select reference_suggestion_floor() as f`)).rows[0] as { f: number }).f) === ENOUGH_TO_GO_ON && ENOUGH_TO_GO_ON === 5);
    ok("the printed ordering rule names that number", new RegExp(`at least ${ENOUGH_TO_GO_ON} grants`).test(ORDERING_RULE));
    const rows = await sugg(MEMBER_A, BAND);
    const eins = rows.map((r) => r.ein);
    ok(
      "band 5,000 to 250,000: funders with enough to go on come first by SHARE (pure funder 100%, then the pass-through 10%), then those with fewer, by share then count",
      JSON.stringify(eins) === JSON.stringify(["999000001", "999000002", "888888888", "333333333", "111111111", "777777777", "222222222"]),
      JSON.stringify(eins)
    );
    ok("the pass-through that gives the most such grants (40) is NOT first: counting grants first is what 0050 replaced", eins[0] !== "999000002" && Number(rows[1].faith_in_band_count) === 40);
    ok("a funder with fewer than five in band ranks below the pass-through even with a 100% share", eins.indexOf("888888888") > eins.indexOf("999000002") && Number(rows[2].faith_share) === 1);
    ok("meets_floor is true exactly for the funders with at least five in band", rows.every((r) => (r.meets_floor === true) === (Number(r.faith_in_band_count) >= ENOUGH_TO_GO_ON)) && rows.filter((r) => r.meets_floor).length === 2);
    ok("a funder with no faith-named grant is not suggested", !eins.includes("444444444"));
    ok("a funder whose only faith-named grant is outside the band is not suggested", !eins.includes("555555555"));
    ok("a funder whose faith-named grant states no amount is not suggested when a band is set (it cannot be in the band)", !eins.includes("666666666"));
    const f1 = rows.find((r) => r.ein === "111111111")!;
    ok("F1 reports its band count, its faith count, its share and its state count", Number(f1.faith_in_band_count) === 3 && Number(f1.faith_count) === 5 && Number(f1.faith_share) === 0.8333 && Number(f1.faith_in_state_count) === 2, JSON.stringify(f1));
    ok("the charity is labelled a public charity and carries its own giving figure", rows.find((r) => r.ein === "777777777")!.source === "public_charity" && Number(rows.find((r) => r.ein === "777777777")!.giving_amt) === 900000);
    ok("the size shown for a foundation is its stated paid-per-books figure with its period", Number(f1.giving_amt) === 400000 && String(f1.giving_period_end).includes("2024"));
    ok("every row carries the rule version and the same total", rows.every((r) => r.rule_version === "faith-name-v1" && Number(r.total_matches) === 7));
    const noBand = await sugg(MEMBER_A, "null, null, null, 25, 0");
    ok("with no band every faith-named grant counts: F5 and F6 appear, and the three with enough to go on lead by share (pure, F1, pass-through)", noBand.some((r) => r.ein === "555555555") && noBand.some((r) => r.ein === "666666666") && JSON.stringify(noBand.slice(0, 3).map((r) => r.ein)) === JSON.stringify(["999000001", "111111111", "999000002"]), JSON.stringify(noBand.map((r) => r.ein)));
    ok("the state argument changes no order and filters nothing", JSON.stringify((await sugg(MEMBER_A, "5000, 250000, null, 25, 0")).map((r) => r.ein)) === JSON.stringify(eins) && (await sugg(MEMBER_A, "5000, 250000, null, 25, 0"))[0].faith_in_state_count === null);

    const pre = rows.find((r) => r.ein === "333333333");
    ok("a funder whose filing says pre-selected charities only is IN the list, in the same order rule, flagged and not hidden (0050 clause 6)", !!pre && pre.takes_no_unsolicited === true && eins.indexOf("333333333") === 3, JSON.stringify(pre));
    const daf = rows.find((r) => r.ein === "888888888");
    ok("a donor-advised fund sponsor is IN the same list, flagged as one, ordered by the same rule", !!daf && daf.is_daf_sponsor === true && eins.indexOf("888888888") === 2);
    ok("the old three-group call (six arguments, a group name) no longer exists", /does not exist|function .* is not unique/i.test(await as("authenticated", MEMBER_A, async () => refused(`select * from reference_funder_suggestions(null, null, null, 'held_out', 25, 0)`))));
    const page2 = await sugg(MEMBER_A, "5000, 250000, null, 1, 1");
    ok("paging is stable: the second page of one is the second funder", page2.length === 1 && page2[0].ein === "999000002" && Number(page2[0].total_matches) === 7);
    ok("an unknown limit is bounded, not an error", (await sugg(MEMBER_A, "null, null, null, 100000, 0")).length > 0);
  }

  section("who may read it");
  {
    ok("a signed-in person with no organization gets nothing", (await sugg(STRANGER)).length === 0);
    ok("anon cannot call it", (await refused(`set role anon; select * from reference_funder_suggestions(); reset role;`)) !== "" , "anon ran it");
    await db.exec(`reset role`);
    await as("authenticated", MEMBER_A, async () => undefined);
    const readMember = (await as("authenticated", MEMBER_A, async () => (await db.query(`select count(*)::int c from funder_reference_faith_giving`)).rows[0])) as { c: number };
    ok("a member reads the derived table", readMember.c === 10);
    const readStranger = (await as("authenticated", STRANGER, async () => (await db.query(`select count(*)::int c from funder_reference_faith_giving`)).rows[0])) as { c: number };
    ok("a person with no organization reads none of it", readStranger.c === 0);
    const w = await as("authenticated", MEMBER_A, async () => refused(`insert into funder_reference_faith_giving (ein, source, rule_version, periods_counted, grants_counted, faith_count) values ('999999999','private_foundation','x',1,1,1)`));
    ok("a member cannot insert into the derived table", /permission denied|row-level security/i.test(w), w);
    const u = await as("authenticated", MEMBER_A, async () => refused(`update funder_reference_faith_giving set faith_count = 0`));
    const d = await as("authenticated", MEMBER_A, async () => refused(`delete from funder_reference_faith_giving`));
    ok("nor update nor delete it", /permission denied/i.test(u) && /permission denied/i.test(d), `${u} | ${d}`);
    const r = await as("authenticated", MEMBER_A, async () => refused(`select funder_reference_refresh_faith_giving('0', ':')`));
    ok("a member cannot run the refresh: only the service key can", /permission denied/i.test(r), r);
  }

  section("a funder already in the organization's queue or pipeline is not suggested again, and only for that organization");
  {
    await db.query(`insert into candidates (name, channel, organization_id, ein, status, source) values ('Alpha Giving Foundation', 'foundation', $1, '111111111', 'pending', 'reference_database')`, [ORG_A]);
    await db.query(`insert into prospects (name, channel, organization_id, ein, stage, owner_id) values ('Beta Family Foundation', 'foundation', $1, '22-2222222', 'discovery', $2)`, [ORG_A, MEMBER_A]);
    const a = (await sugg(MEMBER_A, "5000, 250000, null, 25, 0")).map((r) => r.ein);
    ok("after F1 became a candidate and F2 a prospect (EIN written with a dash), organization A is no longer offered those two", JSON.stringify(a) === JSON.stringify(["999000001", "999000002", "888888888", "333333333", "777777777"]), JSON.stringify(a));
    const b = (await sugg(MEMBER_B, "5000, 250000, null, 25, 0")).map((r) => r.ein);
    ok("organization B still sees all seven: another organization's queue never hides a funder", JSON.stringify(b) === JSON.stringify(["999000001", "999000002", "888888888", "333333333", "111111111", "777777777", "222222222"]), JSON.stringify(b));
    const bad = await refused(`insert into candidates (name, channel, organization_id, ein, status, source) values ('X', 'foundation', '${ORG_A}', '12-345', 'pending', 'reference_database')`);
    ok("a candidate's EIN must be nine digits", /candidates_ein_format|check constraint/i.test(bad), bad);
  }

  section("0095: the band count by binary search equals counting one by one");
  {
    ok("0095 to 0098 are among the applied migrations", boot.applied.some((f) => f.startsWith("0095_reference_suggestions_band_count_by_search")) && boot.applied.some((f) => f.startsWith("0096_reference_suggestions_rank_narrow_rows")) && boot.applied.some((f) => f.startsWith("0097_reference_suggestions_groups_and_speed")) && boot.applied.some((f) => f.startsWith("0098_reference_suggestions_one_list_share_first")));
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let mismatches = 0;
    let cases = 0;
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(rnd() * 40);
      const arr = Array.from({ length: n }, () => Math.floor(rnd() * 12) * 5000).sort((a, b) => b - a);
      const lo = rnd() < 0.15 ? null : Math.floor(rnd() * 13) * 5000;
      const hi = rnd() < 0.15 ? null : Math.floor(rnd() * 13) * 5000;
      const want = arr.filter((a) => (lo === null || a >= lo) && (hi === null || a <= hi)).length;
      const got = Number(((await db.query(`select funder_reference_count_in_band($1::bigint[], $2::bigint, $3::bigint) as c`, [`{${arr.join(",")}}`, lo, hi])).rows[0] as { c: number }).c);
      cases++;
      if (got !== want) mismatches++;
    }
    ok(`300 random sorted arrays (with ties, empties and open bounds): the same count as counting one by one (${cases} cases)`, mismatches === 0, `${mismatches} differ`);
    ok("an empty array counts zero in any band", Number(((await db.query(`select funder_reference_count_in_band('{}'::bigint[], 1, 100) as c`)).rows[0] as { c: number }).c) === 0);
  }

  section("source scans: the ruling's test of compliance");
  {
    const files = walk(join(root, "lib/funder-reference")).filter((f) => /suggestions|ways-in/.test(f)).concat(walk(join(root, "app/(dashboard)/discovery")).filter((f) => /reference-suggest|suggested/.test(f)));
    ok("the suggestions code exists (including the ways-in reader)", files.length >= 3 && files.some((f) => /ways-in/.test(f)), files.join(","));
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const noComments = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok("no model call, no service key and no outside request in the suggestions", !/anthropic|MODEL_API_KEY|SERVICE_ROLE|createServiceClient|createAdminClient|fetch\(|OpenAI/i.test(noComments));
    const action = files.find((f) => /actions\.ts$/.test(f));
    const actionText = action ? readFileSync(action, "utf8").replace(/\/\/.*$/gm, "") : "";
    ok("adding a funder inserts a candidate and creates no prospect, contact, draft or message", /from\("candidates"\)\s*\.insert|\.from\("candidates"\)[\s\S]{0,40}\.insert/.test(actionText) && !/from\("(prospects|contacts|drafts|interactions|stage_changes)"\)/.test(actionText) && !/upsertContact|sendDraft|sendEmail/.test(actionText));
    const accept = readFileSync(join(root, "app/(dashboard)/discovery/actions.ts"), "utf8");
    ok("accepting a candidate carries its EIN to the prospect", /ein:\s*candidate\.ein/.test(accept));
  }


  section("the ways in (ruling 0050 clause 7): the reads work for a member, and the parsing keeps the filing's own words");
  {
    // Real-shaped Part XV record (copied from a filing's loaded text) with a place restriction, and the officers table with a signer.
    const huntington = [{ ordinal: 1, fields: { RecipientPersonNm: "Huntington Bank Irene Gray", RecipientPhoneNum: "3302582362", SubmissionDeadlinesTxt: "None", RestrictionsOnAwardsTxt: "For youth betterment in the areas of Maine, Florida and the Menlo Park and Atherton Areas of California", "RecipientUSAddress/ZIPCd": "44718", "RecipientUSAddress/CityNm": "Canton", FormAndInfoAndMaterialsTxt: "None", "RecipientUSAddress/AddressLine1Txt": "4481 Munson St NW Ste 100", "RecipientUSAddress/StateAbbreviationCd": "OH" } }];
    const [c] = parseApplicationGroups(huntington);
    ok("the contact, address, deadlines and restriction are the filing's own words", c.person === "Huntington Bank Irene Gray" && c.address === "4481 Munson St NW Ste 100, Canton, OH, 44718" && c.deadlines === "None" && c.how_to_apply === "None" && c.restrictions === "For youth betterment in the areas of Maine, Florida and the Menlo Park and Atherton Areas of California", JSON.stringify(c));
    ok("'UNDETERMINED' is shown as filed, not turned into 'none' or dropped", parseApplicationGroups([{ ordinal: 1, fields: { RecipientPersonNm: "JULIE HNATEK", SubmissionDeadlinesTxt: "UNDETERMINED" } }])[0].deadlines === "UNDETERMINED");
    ok("an empty or malformed record gives no contact rather than an error", parseApplicationGroups(null).length === 0 && parseApplicationGroups("x").length === 0 && parseApplicationGroups([{ fields: {} }, null]).length === 0);
    const people = parsePeople([
      { listed_in: "part_viii_officers_directors_trustees", ordinal: 2, name_as_named: "KATHY A NEFF", title_as_stated: "DIRECTOR", city: "NEWPORT BEACH", state: "CA" },
      { listed_in: "part_viii_officers_directors_trustees", ordinal: 1, name_as_named: "PAUL A NEFF", title_as_stated: "PRESIDENT/CEO /CHAIRMAN", city: "NEWPORT BEACH", state: "CA" },
      { listed_in: "signer_on_return_header", ordinal: 1, name_as_named: "PAUL A NEFF", title_as_stated: "CEO/CHAIRMAN", city: null, state: null },
      { listed_in: "signer_on_return_header", ordinal: 2, name_as_named: "A BOOKKEEPER", title_as_stated: "AGENT", city: null, state: null },
    ]);
    ok("people are the officers in the filing's order, with title, city and state, then a signer not already named", people.people.map((p) => `${p.name}|${p.role}`).join(",") === "Paul A Neff|officer,Kathy A Neff|officer,A Bookkeeper|signer" && people.people[0].place === "Newport Beach, CA" && people.total === 3, JSON.stringify(people));
    ok("no street address and no pay are carried for a person", people.people.every((p) => Object.keys(p).sort().join(",") === "name,place,role,title"));
    ok("the people shown are capped and the total is kept", parsePeople(Array.from({ length: 14 }, (_, i) => ({ listed_in: "part_viii_officers_directors_trustees", ordinal: i + 1, name_as_named: `PERSON ${i}`, title_as_stated: null, city: null, state: null }))).people.length === 10 && parsePeople(Array.from({ length: 14 }, (_, i) => ({ listed_in: "part_viii_officers_directors_trustees", ordinal: i + 1, name_as_named: `PERSON ${i}`, title_as_stated: null, city: null, state: null }))).total === 14);

    ok("one fixed paragraph per kind, chosen by facts the database holds", practiceFor({ source: "private_foundation", is_daf_sponsor: false, takes_no_unsolicited: true }) === PRESELECTED_PRACTICE && practiceFor({ source: "private_foundation", is_daf_sponsor: false, takes_no_unsolicited: false }) === OPEN_FOUNDATION_PRACTICE && practiceFor({ source: "public_charity", is_daf_sponsor: true, takes_no_unsolicited: null }) === DAF_PRACTICE && practiceFor({ source: "public_charity", is_daf_sponsor: false, takes_no_unsolicited: null }) === CHARITY_PRACTICE);
    ok("the pre-selected paragraph names the three ways in and says it is not an application", /personal introduction/.test(PRESELECTED_PRACTICE) && /letter or call/.test(PRESELECTED_PRACTICE) && /how they came to be chosen/.test(PRESELECTED_PRACTICE) && /none of these is certain/i.test(PRESELECTED_PRACTICE));

    // The exact reads the page makes, as a member, against rows with the real jsonb shape.
    await db.query(`update funder_reference_application_terms set application_groups = $1::jsonb where ein = '333333333'`, [JSON.stringify(huntington)]);
    const fid = ((await db.query(`select source_object_id from funder_reference_directory where ein='333333333'`)).rows[0] as { source_object_id: string }).source_object_id;
    await db.query(`insert into funder_reference_people (filing_object_id, listed_in, ordinal, ein, tax_period_end, name_as_named, title_as_stated, city, state, compensation_amt, loaded_at, loader_version) values ($1, 'part_viii_officers_directors_trustees', 1, '333333333', '2024-12-31', 'RUTH GAMMA', 'TRUSTEE', 'TULSA', 'OK', 0, now(), 't')`, [fid]);
    const m = await as("authenticated", MEMBER_A, async () => ({
      dir: (await db.query(`select ${WAYS_IN_COLUMNS.directory} from funder_reference_directory where ein = any($1)`, [["333333333", "111111111"]])).rows as Array<Record<string, unknown>>,
      found: (await db.query(`select ${WAYS_IN_COLUMNS.foundation} from funder_reference_foundations where ein = any($1)`, [["333333333"]])).rows as Array<Record<string, unknown>>,
      charity: (await db.query(`select ${WAYS_IN_COLUMNS.charity} from charity_reference_organizations where ein = any($1)`, [["777777777"]])).rows as Array<Record<string, unknown>>,
      terms: (await db.query(`select ${WAYS_IN_COLUMNS.terms} from funder_reference_application_terms where filing_object_id = any($1)`, [[fid]])).rows as Array<{ application_groups: unknown }>,
      people: (await db.query(`select ${WAYS_IN_COLUMNS.people} from funder_reference_people where filing_object_id = any($1)`, [[fid]])).rows as Array<Parameters<typeof parsePeople>[0][number]>,
    }));
    ok("a member can run each of the page's five reads with exactly the columns the reader names", m.dir.length === 2 && m.found.length === 1 && m.charity.length === 1 && m.terms.length === 1 && m.people.length === 1);
    ok("the filing's pre-selected box comes back for the funder whose filing says so", m.dir.find((d) => d.ein === "333333333")?.only_preselected_charities_box_checked === true);
    ok("what is stored comes back through the parser unchanged in meaning", parseApplicationGroups(m.terms[0].application_groups)[0].person === "Huntington Bank Irene Gray" && parsePeople(m.people).people[0].name === "Ruth Gamma");
    const noOrg = await as("authenticated", STRANGER, async () => (await db.query(`select count(*)::int c from funder_reference_people`)).rows[0] as { c: number });
    ok("a person with no organization reads no named people", noOrg.c === 0);
    const w = await as("authenticated", MEMBER_A, async () => refused(`insert into funder_reference_people (filing_object_id, listed_in, ordinal, ein, tax_period_end, loaded_at, loader_version) values ('x','part_viii_officers_directors_trustees',1,'1','2024-12-31',now(),'t')`));
    ok("a member cannot write to the people table", /permission denied|row-level security/i.test(w), w);
  }

  section("the pure rules: band, state, channel, name, reason");
  {
    const b = bandFromBudget(250000)!;
    ok("a 250,000 budget gives a 5,000 to 250,000 band", b.lo === 5000 && b.hi === 250000);
    ok("the budget may arrive as text (the column is numeric)", bandFromBudget("250000")?.lo === 5000);
    ok("no budget, zero or nonsense gives no band, and the screen says so", bandFromBudget(null) === null && bandFromBudget(0) === null && bandFromBudget("x") === null && /no size band/.test(describeBand(null, null)));
    ok("'Indio, California' is CA", stateFromLocation("Indio, California") === "CA");
    ok("'Irvine, CA' and 'Austin, TX 78701' are CA and TX", stateFromLocation("Irvine, CA") === "CA" && stateFromLocation("Austin, TX 78701") === "TX");
    ok("'Nairobi, Kenya' and empty give no state", stateFromLocation("Nairobi, Kenya") === null && stateFromLocation(null) === null);
    ok("a foundation is added under foundation, a sponsor under daf, a public charity under regranting", channelFor({ source: "private_foundation", is_daf_sponsor: false }) === "foundation" && channelFor({ source: "public_charity", is_daf_sponsor: true }) === "daf" && channelFor({ source: "public_charity", is_daf_sponsor: false }) === "regranting");
    ok("kinds keep their own labels", kindLabel({ source: "public_charity", is_daf_sponsor: true }) === "Donor-advised fund sponsor");
    ok("an upper-case filing name is made readable without changing a letter", readableName("THE MACLELLAN FOUNDATION INC") === "The Maclellan Foundation Inc" && readableName("M J MURDOCK CHARITABLE TRUST") === "M J Murdock Charitable Trust" && readableName("Kern Family Foundation") === "Kern Family Foundation");
    const s: Suggestion = { ein: "111111111", source: "private_foundation", name: "X", city: null, state: null, is_daf_sponsor: false, grants_counted: 6, periods_counted: 2, faith_count: 5, faith_in_band_count: 3, faith_share: 0.8333, faith_last_period_end: "2024-12-31", faith_in_state_count: 0, giving_amt: null, giving_period_end: null, takes_no_unsolicited: false, faith_amounts_capped: false, faith_sample: [], rule_version: "faith-name-v1", total_matches: 1, meets_floor: false };
    const lines = describeReason(s, b, "CA").join(" ");
    ok("the reason is made only of the stored counts: 3 of 5 in band, 83% of 6, last year, none in CA", /3 of its 5 grants/.test(lines) && /83% of the 6 grants/.test(lines) && /2024/.test(lines) && /None of those went to recipients in CA/.test(lines), lines);
    ok("a funder under the line says so in its reason, and one with enough does not", /Fewer than 5 such grants in your band/.test(lines) && !/Fewer than/.test(describeReason({ ...s, meets_floor: true }, b, "CA").join(" ")), lines);
    ok("with no band the reason says how many grants went to faith-named recipients and does not invent a band", /5 of its listed grants went to faith-named recipients/.test(describeReason(s, null, null).join(" ")));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
