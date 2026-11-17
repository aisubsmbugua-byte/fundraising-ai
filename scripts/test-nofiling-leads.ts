// STATE item 119 (ruling 0051, stage one): funders that file no return, found from the grants other organizations' filings name
// them in.
//
// (1) Migration 0099 on a REAL Postgres (PGlite) with every project migration applied unchanged: the name key, the signal rule, the
// two-pass offline scan and the build, then the members-only read, as a member of two organizations, a stranger and anon.
// (2) The source scans of the ruling's "test of compliance": no model call, no service key, no outside request in the leads.
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform, and it does not render the page.
//
// Usage: npx tsx scripts/test-nofiling-leads.ts
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootDatabase } from "./funder-reference-support";
import { seedCharity, seedFoundation } from "./nofiling-test-support";
import { CURATED_MARK, NO_RETURN_MARK, buildLeadBasis, channelForLead, describeLead, displayLeadName, leadKindLabel, normalizeLead, type NoFilingLead } from "../lib/funder-reference/nofiling-leads";

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

async function main() {
  section("migration 0099 applies to a real Postgres, unchanged, after all earlier ones");
  const db = new PGlite();
  const boot = await bootDatabase(db);
  ok(`all ${boot.applied.length} migration files apply with no error`, boot.failures.length === 0, boot.failures.join("; "));
  ok("0099 is among them", boot.applied.some((f) => f.startsWith("0099_funders_that_file_no_return")));
  const sql99 = readFileSync(join(root, "supabase/migrations/0099_funders_that_file_no_return.sql"), "utf8").replace(/--.*$/gm, "");
  ok("0099 changes no loader table and writes no reference row", !/\balter\s+table\s+(funder|charity)_reference_(?!nofiling|curated)/i.test(sql99) && !/\binsert\s+into\s+(funder|charity)_reference_(?!nofiling|curated)/i.test(sql99));

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

  section("the name key and the signal rule are named and exact");
  {
    const k = async (s: string | null) => (await one<{ r: string | null }>(`select funder_reference_name_key($1) as r`, [s])).r;
    ok("'THE SOLOMON FOUNDATION' and 'Solomon Foundation' are one key", (await k("THE SOLOMON FOUNDATION")) === (await k("Solomon Foundation")) && (await k("Solomon Foundation")) === "SOLOMON FOUNDATION");
    ok("a leading grant number '(230) ' is dropped", (await k("(230) THE LAWRENCE AND LILLIAN SOLOMON FOUNDATION INC")) === "LAWRENCE AND LILLIAN SOLOMON FOUNDATION INC");
    ok("punctuation collapses; a name beginning with a digit keeps it ('1ST BAPTIST, INC.' is '1ST BAPTIST INC')", (await k("1ST BAPTIST, INC.")) === "1ST BAPTIST INC");
    ok("empty and null give null, not an empty key", (await k("")) === null && (await k(null)) === null);
    const sig = async (fn: string, s: string) => (await one<{ r: boolean }>(`select ${fn}($1) as r`, [s])).r;
    const ps = (t: string) => sig("funder_reference_nofiling_purpose_signal", t);
    ok("purpose signal: the gift went INTO a donor advised or gift fund (contribution to, transfer into, establish, a fund contribution)",
      (await ps("CONTRIBUTION TO A DONOR ADVISED FUND FOR THE PURPOSE OF SUPPORTING OTHER CHARITABLE ORGANIZATIONS")) && (await ps("Gift to the donor-advised fund")) && (await ps("transfer into a gift fund account")) && (await ps("to establish a donor advised fund")) && (await ps("donor advised fund contribution")));
    ok("purpose signal does NOT fire on a bare mention of the giver's advice, re-granting, grantmaking or ordinary support (the measured defect of v1)",
      !(await ps("per donor advised recommendation")) && !(await ps("Grant recommended by a donor advised fund")) && !(await ps("re-granting program")) && !(await ps("grantmaking support")) && !(await ps("General support")) && !(await ps("OPERATING SUPPORT")) && !(await ps("loan fund")));
    ok("funder-like name: foundation, fund, trust, endowment as whole words; a museum is not", (await sig("funder_reference_nofiling_funder_like", "The Solomon Foundation")) && (await sig("funder_reference_nofiling_funder_like", "Legacy Fund")) && !(await sig("funder_reference_nofiling_funder_like", "Metropolitan Museum of Art")) && !(await sig("funder_reference_nofiling_funder_like", "Fundamental Church")));
    ok("name signal: church extension / loan fund", (await sig("funder_reference_nofiling_name_signal", "Chapel Church Extension Fund")) && !(await sig("funder_reference_nofiling_name_signal", "Hillside Church")));
    ok("the version is named", (await one<{ v: string }>(`select funder_reference_nofiling_rule_version() as v`)).v === "no-filing-lead-v2");
  }

  // ---- seed
  // F1: a faith-heavy funder (six faith-named grants) that names the Solomon Foundation as a donor advised fund contribution
  await seedFoundation(db, "111111111", "ALPHA GIVING FOUNDATION", false, [
    { name: "Hillside Church", amt: 20_000 }, { name: "Grace Ministries", amt: 20_000 }, { name: "Gospel Church", amt: 20_000 }, { name: "Trinity Church", amt: 20_000 }, { name: "Baptist Mission", amt: 20_000 }, { name: "Christ Church", amt: 20_000 },
    { name: "THE SOLOMON FOUNDATION", amt: 168_000, st: "CO", city: "PARKER", purpose: "CONTRIBUTION TO A DONOR ADVISED FUND FOR THE PURPOSE OF SUPPORTING OTHER CHARITABLE ORGANIZATIONS" },
    // the v1 defects: a museum whose purposes only mention the giver's advice / grantmaking is NOT a lead
    { name: "METROPOLITAN MUSEUM OF ART", amt: 5_000, st: "NY", purpose: "per donor advised recommendation" },
    { name: "METROPOLITAN MUSEUM OF ART", amt: 5_000, st: "NY", purpose: "grantmaking support" },
    // a fund-like name plus a gift INTO a donor advised fund IS a lead; a name that is not fund-like is not
    { name: "QUIET GIVING FUND", amt: 7_000, st: "TN", purpose: "gift to a donor advised fund" },
    { name: "PLAIN MISSION CHURCH", amt: 7_000, st: "KS", purpose: "contribution to a donor advised fund" },
  ]);
  // F2, F3: two more funders that name the same recipient with no signal of their own (so the count of funders is 3)
  await seedFoundation(db, "222222222", "BETA FAMILY FOUNDATION", false, [{ name: "Solomon Foundation", amt: 1_000, st: "co", city: "Parker", purpose: "OPERATING SUPPORT" }]);
  await seedCharity(db, "777777777", "ETA REGRANTING CHARITY", [{ name: "SOLOMON FOUNDATION", amt: 101_374, st: "CO", city: "PARKER", purpose: "RELIGION RELATED" }]);
  // F4: a funder with no faith-named giving that names a gift fund: a lead exists but is not offered (only dissimilar funders name it)
  await seedFoundation(db, "444444444", "DELTA ARTS FOUNDATION", false, [{ name: "ACME COMMUNITY GIFT FUND", amt: 9_000, st: "OH", purpose: "grantmaking" }]);
  // a recipient that matches a LOADED charity by name and state: never a lead (it files)
  await seedCharity(db, "888888888", "BETA GIFT FUND SPONSOR", [{ name: "x Church", amt: 1 }], true);
  await seedFoundation(db, "555555555", "EPSILON FOUNDATION", false, [
    { name: "Hillside Church", amt: 10_000 }, { name: "Grace Ministries", amt: 10_000 }, { name: "Gospel Church", amt: 10_000 }, { name: "Trinity Church", amt: 10_000 }, { name: "Baptist Mission", amt: 10_000 },
    { name: "BETA GIFT FUND SPONSOR", amt: 5_000, st: "TX", purpose: "donor advised fund" },
  ]);
  // a recipient whose STATED EIN is a loaded charity's EIN, under a different name: never a lead
  await seedCharity(db, "666666666", "ZETA CHARITY", [{ name: "Gift Fund Under Another Name", amt: 5_000, st: "TX", purpose: "gift fund", rein: "888-88-8888" }]);
  // no signal at all: never a lead
  await seedFoundation(db, "999000001", "ETA PLAIN FOUNDATION", false, [{ name: "Plain Church", amt: 5_000, st: "KS", purpose: "General support" }]);
  await db.query(`select funder_reference_refresh_directory()`);
  await db.query(`select charity_reference_refresh_directory()`);
  await db.query(`select * from funder_reference_refresh_faith_giving('0', ':')`);

  section("the offline scan and build: two passes, repeatable, named by rule version");
  {
    const keys = (await db.query(`select funder_reference_nofiling_scan_keys('0', ':') as n`)).rows[0] as { n: number };
    ok("pass 1 finds keys that carry a signal", Number(keys.n) >= 1, JSON.stringify(keys));
    const scanned = (await db.query(`select funder_reference_nofiling_scan_rows('0', ':') as n`)).rows[0] as { n: number };
    ok("pass 2 collects every paid grant naming those keys, signal or not (the Solomon Foundation: three)", Number(scanned.n) >= 3);
    const rowsSol = Number((await one<{ c: string }>(`select count(*) c from funder_reference_nofiling_rows where lead_key = 'SOLOMON FOUNDATION|CO'`)).c);
    ok("the three spellings, in two cases of state and two upper/lower cases, fall under one key and all three grants are kept", rowsSol === 3, String(rowsSol));
    await db.query(`select funder_reference_nofiling_scan_rows('0', ':')`);
    const dup = Number((await one<{ c: string }>(`select count(*) c from funder_reference_nofiling_rows where lead_key = 'SOLOMON FOUNDATION|CO'`)).c);
    ok("running pass 2 again duplicates nothing", dup === 3, String(dup));
    const built = Number((await one<{ n: number }>(`select funder_reference_nofiling_build() as n`)).n);
    await db.query(`select funder_reference_nofiling_build()`);
    const total = Number((await one<{ c: string }>(`select count(*) c from funder_reference_nofiling_leads`)).c);
    ok("building again duplicates nothing", total === built, `${total} vs ${built}`);
    const sol = await one<Record<string, unknown>>(`select * from funder_reference_nofiling_leads where lead_key = 'SOLOMON FOUNDATION|CO'`);
    ok("the Solomon Foundation is a lead: three different funders, one tax year, a donor-advised signal", Number(sol.funders_count) === 3 && Number(sol.grants_count) === 3 && sol.signal === "both" ? false : Number(sol.funders_count) === 3 && Number(sol.grants_count) === 3 && sol.daf_signal === true, JSON.stringify(sol));
    ok("only one of the three funders has enough faith-named grants to go on", Number(sol.faith_funders_count) === 1, JSON.stringify(sol.faith_funders_count));
    ok("the name is shown as most often stated, the place as stated", String(sol.display_name).toUpperCase().includes("SOLOMON FOUNDATION") && String(sol.city).toUpperCase() === "PARKER" && sol.state === "CO");
    ok("the sample carries funder, amount, purpose and a filing id for each grant", Array.isArray(sol.sample) && (sol.sample as Array<{ filing_object_id: string; funder_name: string }>).length === 3 && (sol.sample as Array<{ filing_object_id: string; funder_name: string }>).every((g) => /^2024\d{14}$/.test(g.filing_object_id) && !!g.funder_name));
    ok("the rule version is stored", sol.rule_version === "no-filing-lead-v2");
    const lk = (await db.query(`select lead_key from funder_reference_nofiling_leads`)).rows.map((r) => (r as { lead_key: string }).lead_key);
    ok("a recipient that matches a loaded charity by name and state is not a lead", !lk.includes("BETA GIFT FUND SPONSOR|TX"), lk.join(","));
    ok("a recipient whose stated EIN is a loaded charity's is not a lead", !lk.includes("GIFT FUND UNDER ANOTHER NAME|TX"), lk.join(","));
    ok("a recipient with no signal is not a lead", !lk.includes("PLAIN CHURCH|KS"), lk.join(","));
    ok("a museum whose purposes only mention the giver's advice or grantmaking is not a lead (the v1 defect)", !lk.includes("METROPOLITAN MUSEUM OF ART|NY"), lk.join(","));
    ok("a name that is not fund-like is not a lead on a purpose alone", !lk.includes("PLAIN MISSION CHURCH|KS"), lk.join(","));
    ok("a fund-like name with a gift into a donor advised fund is a lead", lk.includes("QUIET GIVING FUND|TN"), lk.join(","));
    ok("a recipient only a faith-less funder names IS computed, with a zero faith-funder count", lk.includes("ACME COMMUNITY GIFT FUND|OH") && Number((await one<{ c: number }>(`select faith_funders_count c from funder_reference_nofiling_leads where lead_key = 'ACME COMMUNITY GIFT FUND|OH'`)).c) === 0);
  }

  section("the read: members only, only leads a faith-giving funder named, excluding what the organization already holds");
  {
    const read = async (uid: string | null) => (await as("authenticated", uid, async () => (await db.query(`select * from reference_nofiling_leads(25, 0)`)).rows)) as Array<Record<string, unknown>>;
    const a = await read(MEMBER_A);
    ok("a member sees the Solomon Foundation (the curated record, once) and not the lead only a faith-less funder named", a.length === 2 && a[0].lead_key === "SOLOMON FOUNDATION|CO" && a[0].origin === "curated" && a[1].lead_key === "QUIET GIVING FUND|TN" && a[1].origin === "filings", JSON.stringify(a.map((r) => [r.lead_key, r.origin])));
    const cj = a[0].curated as { sources: Array<{ url: string }>; kind: string; website: string; ein_note: string; offers: string } | null;
    ok("the curated record carries its kind, website, what its site says, its sources and the EIN's provenance", !!cj && cj.kind === "church_extension_fund" && cj.website === "https://thesolomonfoundation.org/" && cj.sources.length === 4 && cj.sources.every((x) => /^https:\/\//.test(x.url)) && /Checked 2026-11-17 against the IRS/.test(cj.ein_note) && !/not verified against the IRS/.test(cj.ein_note) && /Legacy Fund/.test(cj.offers), JSON.stringify(cj));
    ok("it also carries what the filings add: three funders, one of them faith-giving", Number(a[0].funders_count) === 3 && Number(a[0].faith_funders_count) === 1 && a[0].stated_ein === "274214240");
    ok("the total is carried on each row", a.length > 0 && Number(a[0].total_matches) === 2);
    ok("a signed-in person with no organization sees none", (await read(STRANGER)).length === 0);
    const anon = await (async () => as("anon", null, async () => refused(`select * from reference_nofiling_leads(25, 0)`)))();
    ok("anon is refused", /permission denied|must be/i.test(anon), anon);
    await db.query(`insert into candidates (organization_id, name, channel, source, dedupe_key, status) values ($1, 'The Solomon Foundation', 'daf', 'manual', 'x|solomon foundation|', 'pending')`, [ORG_A]);
    ok("once Org A holds a candidate of that name it is no longer offered to Org A (the other lead still is)", (await read(MEMBER_A)).map((r) => r.lead_key).join() === "QUIET GIVING FUND|TN");
    ok("and is still offered to Org B (tenant isolation)", (await read(MEMBER_B)).length === 2);
  }

  section("the curated record is enduring, and offered without the relevance test");
  {
    await db.query(`select funder_reference_nofiling_build()`);
    await db.query(`delete from funder_reference_nofiling_leads`);
    const c = Number((await one<{ c: string }>(`select count(*) c from funder_reference_curated_funders where lead_key = 'SOLOMON FOUNDATION|CO'`)).c);
    ok("a rebuild and a full clear of the derived leads leave the curated record in place", c === 1);
    await db.query(`select funder_reference_nofiling_build()`);
    await db.query(`insert into funder_reference_curated_funders (lead_key, name, state, kind, sources, recorded_on) values ('ZED CHURCH EXTENSION FUND|KS', 'Zed Church Extension Fund', 'KS', 'church_extension_fund', '[{"url": "https://example.org/", "title": "x", "read_on": "2026-11-16"}]'::jsonb, '2026-11-16')`);
    const rows = (await as("authenticated", MEMBER_B, async () => (await db.query(`select lead_key, origin, faith_funders_count from reference_nofiling_leads(25, 0)`)).rows)) as Array<{ lead_key: string; origin: string; faith_funders_count: number }>;
    ok("a curated record no filing names is offered anyway, with zero funders (a person chose it)", rows.some((r) => r.lead_key === "ZED CHURCH EXTENSION FUND|KS" && r.origin === "curated" && Number(r.faith_funders_count) === 0), JSON.stringify(rows));
    ok("curated records come before derived leads", rows.length > 0 && rows.every((r, i) => i === 0 || !(r.origin === "curated" && rows[i - 1].origin === "filings")));
    ok("a curated record needs at least one source", /check|violat/i.test(await refused(`insert into funder_reference_curated_funders (lead_key, name, kind, sources, recorded_on) values ('Q|', 'Q', 'other_funder', '[]'::jsonb, '2026-11-16')`)));
    ok("an EIN must be nine digits", /check|violat/i.test(await refused(`insert into funder_reference_curated_funders (lead_key, name, kind, ein, sources, recorded_on) values ('Q2|', 'Q2', 'other_funder', '12-345', '[{"url":"https://x"}]'::jsonb, '2026-11-16')`)));
  }


  section("the pure logic: counts only, labels by what the database holds");
  {
    const base: NoFilingLead = {
      lead_key: "SOLOMON FOUNDATION|CO", display_name: "THE SOLOMON FOUNDATION", city: "PARKER", state: "CO", stated_ein: null, funders_count: 5, faith_funders_count: 5, grants_count: 5, periods_count: 3,
      last_period_end: "2024-12-31", signal: "purpose", daf_signal: true, sample: [], rule_version: "no-filing-lead-v2", origin: "filings", curated: null, irs: null, total_matches: 1,
    };
    ok("describeLead states counts from the row and nothing else", describeLead(base).join(" ") === "Named as a recipient by 5 different funders in 3 tax years, 5 grants in all. 5 of those funders have at least five faith-named grants of their own.", describeLead(base).join(" | "));
    ok("a single funder is singular", /by 1 different funder in 1 tax year, 1 grant in all/.test(describeLead({ ...base, funders_count: 1, periods_count: 1, grants_count: 1 }).join(" ")));
    ok("a filing-stated EIN is shown as stated; a curated record points to its note", /EIN as 27-4214240/.test(describeLead({ ...base, stated_ein: "274214240" }).join(" ")) && /see the note below/.test(describeLead({ ...base, stated_ein: "274214240", curated: { id: "x", kind: "church_extension_fund", address: null, website: null, contact: null, offers: null, ein_note: null, no_filing_note: null, sources: [], recorded_on: null } }).join(" ")));
    ok("the kind label is what a record says, else what the name and the givers' purposes point to, and says 'possible'", leadKindLabel({ ...base, curated: { id: "x", kind: "church_extension_fund" } as never }) === "Church extension fund" && leadKindLabel(base) === "Possible donor-advised fund" && leadKindLabel({ ...base, daf_signal: false, display_name: "CATHOLIC CHURCH EXTENSION SOCIETY" }) === "Possible church extension fund");
    ok("channel: a donor-advised signal or sponsor record goes to daf, the rest to regranting", channelForLead(base) === "daf" && channelForLead({ daf_signal: false, curated: null }) === "regranting" && channelForLead({ daf_signal: false, curated: { kind: "donor_advised_fund_sponsor" } as never }) === "daf");
    ok("a filing's upper-case name is made readable; a curated name is left exactly as recorded", displayLeadName(base) === "The Solomon Foundation" && displayLeadName({ display_name: "The Solomon Foundation", curated: { kind: "other_funder" } as never }) === "The Solomon Foundation");
    ok("normalizeLead reads an RPC row and keeps curated detail only for a curated origin", normalizeLead({ lead_key: "K|", display_name: "X", origin: "curated", curated: { kind: "other_funder", sources: [] }, funders_count: "2", sample: [] }).curated !== null && normalizeLead({ lead_key: "K|", display_name: "X", origin: "filings", curated: { kind: "x" } }).curated === null);
    const b = buildLeadBasis(base, "2026-11-16T00:00:00Z");
    ok("the basis kept on a candidate carries the rule version, the counts and the sample, as a snapshot", b.rule_version === "no-filing-lead-v2" && b.funders_count === 5 && b.basis_kind === "no_filing_lead" && b.added_at === "2026-11-16T00:00:00Z");
    ok("the two marks are the ruling's words", NO_RETURN_MARK === "No return in the database, so no giving figures" && CURATED_MARK === "Recorded from its own website; no filing figures");
  }

  section("source scans: no model, no service key, no outside request; the add action creates one candidate and nothing else");
  {
    const files = [
      "lib/funder-reference/nofiling-leads.ts",
      "app/(dashboard)/discovery/reference-lead-actions.ts",
      "app/(dashboard)/discovery/reference-leads.tsx",
      "app/(dashboard)/discovery/add-lead-button.tsx",
    ];
    const text = Object.fromEntries(files.map((f) => [f, existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8").replace(/\/\/.*$/gm, "") : ""]));
    ok("all four files exist", files.every((f) => text[f].length > 0));
    ok("none calls a model, uses a service key or admin client, or makes an outside request", files.every((f) => !/anthropic|claude-|SERVICE_ROLE|createAdminClient|service[_-]?key|\bfetch\(|XMLHttpRequest|axios/i.test(text[f])));
    const act = text["app/(dashboard)/discovery/reference-lead-actions.ts"];
    ok("the add action uses the signed-in user's session client only", /createClient\(\)/.test(act) && !/createServiceClient|serviceRole/i.test(act));
    ok("the add action inserts into candidates and nothing else (no prospect, contact, draft, message or stage change)", (act.match(/\.from\(["'](\w+)["']\)/g) ?? []).every((m) => /candidates|screening_rules/.test(m)) && /\.from\("candidates"\)\s*\.insert/.test(act) && !/prospects|contacts|drafts|interactions|messages|stage/i.test(act.replace(/revalidatePath[^;]*;/, "")));
    ok("the add action creates one pending candidate with the lead's own dedupe key", /status:\s*"pending"/.test(act) && /dedupe_key:\s*`lead:\$\{lead\.lead_key\}`/.test(act));
    ok("the page reads leads through the member-only function, not the tables", /reference_nofiling_leads/.test(text["lib/funder-reference/nofiling-leads.ts"]) && !/funder_reference_nofiling_(rows|keys|leads)|funder_reference_curated/.test(files.map((f) => text[f]).join("\n")));
    const sql = readFileSync(join(root, "supabase/migrations/0099_funders_that_file_no_return.sql"), "utf8") + readFileSync(join(root, "supabase/migrations/0101_nofiling_leads_rule_v2.sql"), "utf8");
    ok("the migrations reach no outside service (no http, no extension call)", !/\bhttp_|net\.http|create\s+extension|dblink|\bcopy\b/i.test(sql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''")));
  }

  section("nothing writes: members and anon cannot write or run the refresh");
  {
    const w = async (q: string) => as("authenticated", MEMBER_A, async () => refused(q));
    ok("a member cannot insert into the leads table", /permission denied|row-level security/i.test(await w(`insert into funder_reference_nofiling_leads (lead_key, display_name, funders_count, faith_funders_count, grants_count, periods_count, signal, daf_signal, rule_version) values ('X|', 'X', 1, 1, 1, 1, 'name', false, 'v')`)));
    ok("a member cannot update or delete a lead", /permission denied|row-level security/i.test(await w(`update funder_reference_nofiling_leads set funders_count = 9`)) && /permission denied/i.test(await w(`delete from funder_reference_nofiling_leads`)));
    ok("a member cannot write the curated table", /permission denied|row-level security/i.test(await w(`insert into funder_reference_curated_funders (lead_key, name, kind, sources, recorded_on) values ('M|', 'M', 'other_funder', '[{"url":"https://x"}]'::jsonb, '2026-11-16')`)) && /permission denied/i.test(await w(`update funder_reference_curated_funders set name = 'x'`)) && /permission denied/i.test(await w(`delete from funder_reference_curated_funders`)));
    ok("a member cannot read the staging tables", /permission denied/i.test(await w(`select * from funder_reference_nofiling_rows`)) && /permission denied/i.test(await w(`select * from funder_reference_nofiling_keys`)));
    ok("a member cannot run the scans or the build", /permission denied/i.test(await w(`select funder_reference_nofiling_build()`)) && /permission denied/i.test(await w(`select funder_reference_nofiling_scan_keys('0', ':')`)) && /permission denied/i.test(await w(`select funder_reference_nofiling_scan_rows('0', ':')`)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
