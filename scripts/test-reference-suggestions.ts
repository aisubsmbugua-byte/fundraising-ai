// STATE item 117 (ruling 0049): reference-first suggestions.
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
import { bandFromBudget, channelFor, describeBand, describeReason, kindLabel, readableName, stateFromLocation, type Suggestion } from "../lib/funder-reference/suggestions";

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
  section("migration 0094 applies to a real Postgres, unchanged, after all earlier ones");
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
  // C1: a public charity whose Schedule I names two faith recipients
  await seedCharity(db, "777777777", "ETA REGRANTING CHARITY", [{ name: "Global Missions Fund", amt: 60_000, st: "CA" }, { name: "Youth Gospel Ministries", amt: 25_000, st: "CA" }, { name: "Hospital Guild", amt: 10_000 }]);

  // C2: a donor-advised fund sponsor that gives to the most faith-named recipients of all
  await seedCharity(db, "888888888", "THETA GIFT FUND SPONSOR", [{ name: "Church A", amt: 10_000 }, { name: "Church B", amt: 10_000 }, { name: "Church C", amt: 10_000 }, { name: "Church D", amt: 10_000 }], true);
  await db.query(`select funder_reference_refresh_directory()`);
  await db.query(`select charity_reference_refresh_directory()`);

  section("the offline refresh: per EIN range, repeatable, named by rule version");
  {
    const r1 = (await db.query(`select * from funder_reference_refresh_faith_giving('0', ':')`)).rows as Array<{ source: string; funders: number }>;
    ok("it reports how many funders it computed per kind", r1.some((r) => r.source === "private_foundation" && Number(r.funders) === 6) && r1.some((r) => r.source === "public_charity" && Number(r.funders) === 2), JSON.stringify(r1));
    await db.query(`select * from funder_reference_refresh_faith_giving('0', ':')`);
    const n = ((await db.query(`select count(*)::int c from funder_reference_faith_giving`)).rows[0] as { c: number }).c;
    ok("running it again duplicates nothing", n === 8, String(n));
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

  section("the suggestions: members only, ranked by the printed rule");
  const sugg = async (uid: string | null, args = "null, null, null, 'main', 25, 0") =>
    (await as("authenticated", uid, async () => (await db.query(`select * from reference_funder_suggestions(${args})`)).rows)) as Array<Record<string, unknown>>;
  {
    const rows = await sugg(MEMBER_A, "5000, 250000, 'CA', 'main', 25, 0");
    const eins = rows.map((r) => r.ein);
    ok("with a 5,000 to 250,000 band: F1 (3 in band), the charity (2), F2 (1) are suggested, in that order", JSON.stringify(eins) === JSON.stringify(["111111111", "777777777", "222222222"]), JSON.stringify(eins));
    ok("a funder with no faith-named grant is not suggested", !eins.includes("444444444"));
    ok("a funder whose only faith-named grant is outside the band is not suggested", !eins.includes("555555555"));
    ok("a funder whose faith-named grant states no amount is not suggested when a band is set (it cannot be in the band)", !eins.includes("666666666"));
    ok("a funder that takes no unsolicited requests is held out of the default list", !eins.includes("333333333"));
    const f1 = rows[0];
    ok("F1 reports its band count, its faith count, its share and its state count", Number(f1.faith_in_band_count) === 3 && Number(f1.faith_count) === 5 && Number(f1.faith_share) === 0.8333 && Number(f1.faith_in_state_count) === 2, JSON.stringify(f1));
    ok("the charity is labelled a public charity and carries its own giving figure", rows[1].source === "public_charity" && Number(rows[1].giving_amt) === 900000);
    ok("the size shown for a foundation is its stated paid-per-books figure with its period", Number(f1.giving_amt) === 400000 && String(f1.giving_period_end).includes("2024"));
    ok("every row carries the rule version and a total count", rows.every((r) => r.rule_version === "faith-name-v1" && Number(r.total_matches) === 3));
    const noBand = await sugg(MEMBER_A, "null, null, null, 'main', 25, 0");
    ok("with no band every faith-named grant counts, so the big ones appear (F5, F6) and the order is by count", noBand.some((r) => r.ein === "555555555") && noBand.some((r) => r.ein === "666666666") && noBand[0].ein === "111111111");
    ok("the state argument changes no order and filters nothing", JSON.stringify((await sugg(MEMBER_A, "5000, 250000, null, 'main', 25, 0")).map((r) => r.ein)) === JSON.stringify(eins) && (await sugg(MEMBER_A, "5000, 250000, null, 'main', 25, 0"))[0].faith_in_state_count === null);
    const held = await sugg(MEMBER_A, "5000, 250000, null, 'held_out', 25, 0");
    ok("the held-out heading lists only the funder whose filing says pre-selected charities only", JSON.stringify(held.map((r) => r.ein)) === JSON.stringify(["333333333"]) && held[0].takes_no_unsolicited === true, JSON.stringify(held.map((r) => r.ein)));
    const daf = await sugg(MEMBER_A, "5000, 250000, null, 'daf', 25, 0");
    ok("a donor-advised fund sponsor is in its own group: it has the most faith-named grants in the band (4) and is still not in the main list", JSON.stringify(daf.map((r) => r.ein)) === JSON.stringify(["888888888"]) && daf[0].is_daf_sponsor === true && !eins.includes("888888888"), JSON.stringify(daf.map((r) => r.ein)));
    ok("an unknown group is refused, not quietly treated as the main list", /unknown p_group/.test(await as("authenticated", MEMBER_A, async () => refused(`select * from reference_funder_suggestions(null, null, null, 'everything', 25, 0)`))));
    const page2 = await sugg(MEMBER_A, "5000, 250000, null, 'main', 1, 1");
    ok("paging is stable: the second page of one is the second funder", page2.length === 1 && page2[0].ein === "777777777" && Number(page2[0].total_matches) === 3);
    ok("an unknown limit is bounded, not an error", (await sugg(MEMBER_A, "null, null, null, 'main', 100000, 0")).length > 0);
  }

  section("who may read it");
  {
    ok("a signed-in person with no organization gets nothing", (await sugg(STRANGER)).length === 0);
    ok("anon cannot call it", (await refused(`set role anon; select * from reference_funder_suggestions(); reset role;`)) !== "" , "anon ran it");
    await db.exec(`reset role`);
    await as("authenticated", MEMBER_A, async () => undefined);
    const readMember = (await as("authenticated", MEMBER_A, async () => (await db.query(`select count(*)::int c from funder_reference_faith_giving`)).rows[0])) as { c: number };
    ok("a member reads the derived table", readMember.c === 8);
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
    const a = (await sugg(MEMBER_A, "5000, 250000, null, 'main', 25, 0")).map((r) => r.ein);
    ok("after F1 became a candidate and F2 a prospect (EIN written with a dash), organization A is offered only the charity", JSON.stringify(a) === JSON.stringify(["777777777"]), JSON.stringify(a));
    const b = (await sugg(MEMBER_B, "5000, 250000, null, 'main', 25, 0")).map((r) => r.ein);
    ok("organization B still sees all three: another organization's queue never hides a funder", JSON.stringify(b) === JSON.stringify(["111111111", "777777777", "222222222"]), JSON.stringify(b));
    const bad = await refused(`insert into candidates (name, channel, organization_id, ein, status, source) values ('X', 'foundation', '${ORG_A}', '12-345', 'pending', 'reference_database')`);
    ok("a candidate's EIN must be nine digits", /candidates_ein_format|check constraint/i.test(bad), bad);
  }

  section("0095: the band count by binary search equals counting one by one");
  {
    ok("0095, 0096 and 0097 are among the applied migrations", boot.applied.some((f) => f.startsWith("0095_reference_suggestions_band_count_by_search")) && boot.applied.some((f) => f.startsWith("0096_reference_suggestions_rank_narrow_rows")) && boot.applied.some((f) => f.startsWith("0097_reference_suggestions_groups_and_speed")));
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
    const files = walk(join(root, "lib/funder-reference")).filter((f) => /suggestions/.test(f)).concat(walk(join(root, "app/(dashboard)/discovery")).filter((f) => /reference-suggest|suggested/.test(f)));
    ok("the suggestions code exists", files.length >= 2, files.join(","));
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const noComments = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok("no model call, no service key and no outside request in the suggestions", !/anthropic|MODEL_API_KEY|SERVICE_ROLE|createServiceClient|createAdminClient|fetch\(|OpenAI/i.test(noComments));
    const action = files.find((f) => /actions\.ts$/.test(f));
    const actionText = action ? readFileSync(action, "utf8").replace(/\/\/.*$/gm, "") : "";
    ok("adding a funder inserts a candidate and creates no prospect, contact, draft or message", /from\("candidates"\)\s*\.insert|\.from\("candidates"\)[\s\S]{0,40}\.insert/.test(actionText) && !/from\("(prospects|contacts|drafts|interactions|stage_changes)"\)/.test(actionText) && !/upsertContact|sendDraft|sendEmail/.test(actionText));
    const accept = readFileSync(join(root, "app/(dashboard)/discovery/actions.ts"), "utf8");
    ok("accepting a candidate carries its EIN to the prospect", /ein:\s*candidate\.ein/.test(accept));
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
    const s: Suggestion = { ein: "111111111", source: "private_foundation", name: "X", city: null, state: null, is_daf_sponsor: false, grants_counted: 6, periods_counted: 2, faith_count: 5, faith_in_band_count: 3, faith_share: 0.8333, faith_last_period_end: "2024-12-31", faith_in_state_count: 0, giving_amt: null, giving_period_end: null, takes_no_unsolicited: false, faith_amounts_capped: false, faith_sample: [], rule_version: "faith-name-v1", total_matches: 1 };
    const lines = describeReason(s, b, "CA").join(" ");
    ok("the reason is made only of the stored counts: 3 of 5 in band, 83% of 6, last year, none in CA", /3 of its 5 grants/.test(lines) && /83% of the 6 grants/.test(lines) && /2024/.test(lines) && /None of those went to recipients in CA/.test(lines), lines);
    ok("with no band the reason says how many grants went to faith-named recipients and does not invent a band", /5 of its listed grants went to faith-named recipients/.test(describeReason(s, null, null).join(" ")));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
