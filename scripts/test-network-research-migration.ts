// STATE item 112, slice B (ruling 0044): migration 0085 run on a REAL Postgres.
//
// Applies the project's actual migrations, 0001 through the highest-numbered file
// (0083 and 0085 included; 0084 belongs to another item and is applied if it is
// present), to an in-process PostgreSQL (@electric-sql/pglite, a devDependency), then
// runs assertions against the live constraints, triggers, cascades and row-level
// security of network_person_findings -- as the `authenticated` role, not as the
// superuser, wherever row-level security is the point.
//
// The shim below (the roles, the `auth` schema, a `storage` stub, the default grants)
// is the same minimal stand-in scripts/test-network-identity-migration.ts uses; every
// migration file is applied UNCHANGED, in order. If a migration needs something the
// shim lacks, applying it fails here and the test says which file.
//
// WHAT THIS CANNOT PROVE (named so nobody over-reads a green run): it is PGlite's
// Postgres, not the Supabase platform. It does not run PostgREST, so it does not prove
// what the HTTP API accepts; and it does not model Supabase's auth.uid() beyond reading
// the `request.jwt.claim.sub` setting the way Supabase does. The live isolation suite
// (scripts/test-tenant-isolation.ts, which needs a real project) remains the check
// against the deployed database.
//
// Mutation checks for the guards in the migration are run by
// scripts/mutation-check-network-research.ts.
//
// Usage: npx tsx scripts/test-network-research-migration.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PEOPLE_DATA_BROKER_HOSTS, SOCIAL_NETWORK_HOSTS } from "../lib/network-identity";
import { FINDING_KINDS } from "../lib/network-research";

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

const SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  create schema extensions;
`;

const GRANTS = `
  grant usage on schema public to authenticated;
  grant all on all tables in schema public to authenticated;
  grant all on all sequences in schema public to authenticated;
  grant execute on all functions in schema public to authenticated;
`;

const A_ORG = "a0000000-0000-4000-8000-000000000001";
const B_ORG = "b0000000-0000-4000-8000-000000000002";
const A1 = "a1000000-0000-4000-8000-000000000001";
const A2 = "a2000000-0000-4000-8000-000000000002";
const B1 = "b1000000-0000-4000-8000-000000000001";

async function main() {
  const db = new PGlite();

  type Row = Record<string, unknown>;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];

  // Runs fn as an `authenticated` session whose JWT subject is `userId`.
  async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role`);
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
  }
  // Resolves to the error message when the statement is refused, "" when it succeeds.
  async function refused(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await db.query(sql, params);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  // --- 1. apply every migration, unchanged ---------------------------------

  section("the project's migrations apply to a real Postgres, unchanged");
  await db.exec(SHIM);
  const files = readdirSync(join(root, "supabase/migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const failures: string[] = [];
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
    } catch (e) {
      failures.push(`${f}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  ok(`all ${files.length} migration files apply with no error`, failures.length === 0, failures.join("; "));
  ok("0083 and 0085 are among the files applied", files.some((f) => f.startsWith("0083_network_identity")) && files.some((f) => f === "0085_network_person_findings.sql"));
  await db.exec(GRANTS);
  const pgVersion = (await q("select version() as v"))[0].v as string;
  console.log(`      (database: ${pgVersion.split(",")[0]})`);

  // --- fixtures -----------------------------------------------------------

  await db.query(`insert into organizations (id, name) values ($1, 'Org A'), ($2, 'Org B')`, [A_ORG, B_ORG]);
  await db.query(`insert into auth.users (id, email) values ($1, 'a1@test'), ($2, 'a2@test'), ($3, 'b1@test')`, [A1, A2, B1]);
  await db.query(
    `insert into profiles (id, organization_id, email) values ($1, $4, 'a1@test'), ($2, $4, 'a2@test'), ($3, $5, 'b1@test')`,
    [A1, A2, B1, A_ORG, B_ORG]
  );

  let n = 0;
  async function insertRow(table: string, cols: Record<string, unknown>): Promise<string> {
    const keys = Object.keys(cols);
    const rows = await q(`insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, keys.map((k) => cols[k]));
    return rows[0].id as string;
  }
  async function person(org: string, by: string, over: Record<string, unknown> = {}): Promise<string> {
    n++;
    return insertRow("network_connections", { organization_id: org, recorded_by: by, person_name: `Person ${n}`, strength: "warm", ...over });
  }
  async function candidate(org: string, conn: string, rank: number, over: Record<string, unknown> = {}): Promise<string> {
    return insertRow("network_identity_candidates", {
      organization_id: org,
      network_connection_id: conn,
      label: `Candidate ${rank}`,
      source_url: `https://example.org/people/${conn}/${rank}`,
      agreement: JSON.stringify({ facts: {} }),
      rank,
      ...over,
    });
  }
  // A confirmed person with `k` candidates, the first of which is the chosen one.
  async function confirmedPerson(org: string, by: string, k = 2, over: Record<string, unknown> = {}): Promise<{ id: string; cands: string[] }> {
    const id = await person(org, by, over);
    const cands: string[] = [];
    for (let r = 1; r <= k; r++) cands.push(await candidate(org, id, r));
    await db.query(
      `update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`,
      [id, cands[0], by]
    );
    return { id, cands };
  }
  let f = 0;
  async function finding(org: string, conn: string, over: Record<string, unknown> = {}): Promise<string> {
    f++;
    return insertRow("network_person_findings", {
      organization_id: org,
      network_connection_id: conn,
      kind: "employer",
      organization_named: `Grace Church ${f}`,
      source_url: `https://example.org/f/${f}`,
      supported: true,
      ...over,
    });
  }
  const conn = async (id: string): Promise<Row> => (await q(`select * from network_connections where id = $1`, [id]))[0];
  const fnd = async (id: string): Promise<Row | undefined> => (await q(`select * from network_person_findings where id = $1`, [id]))[0];
  const findCount = async (connId: string): Promise<number> => Number((await q(`select count(*)::int as c from network_person_findings where network_connection_id = $1`, [connId]))[0].c);
  const candCount = async (connId: string): Promise<number> => Number((await q(`select count(*)::int as c from network_identity_candidates where network_connection_id = $1`, [connId]))[0].c);
  // A bare insert for refusal tests (all valid unless `over` says otherwise).
  const tryInsert = (connId: string, over: Record<string, unknown> = {}, org = A_ORG) => {
    f++;
    const cols: Record<string, unknown> = { organization_id: org, network_connection_id: connId, kind: "employer", organization_named: `Org ${f}`, source_url: `https://example.org/t/${f}`, supported: true, ...over };
    const keys = Object.keys(cols);
    return refused(`insert into network_person_findings (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => cols[k]));
  };

  // --- 2. shape ------------------------------------------------------------

  section("network_person_findings: shape, defaults, and no contact detail");
  const cols = await q(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'network_person_findings' and table_schema = 'public'`);
  const col = (name: string) => cols.find((c) => c.column_name === name);
  const names = cols.map((c) => String(c.column_name));
  ok(
    "the table has exactly the columns the brief names (plus the restore pair and the support detail)",
    JSON.stringify([...names].sort()) ===
      JSON.stringify(["ai_run_id", "created_at", "id", "kind", "network_connection_id", "organization_id", "organization_named", "restored_at", "restored_by", "role_text", "source_passage", "source_title", "source_url", "status", "struck_at", "struck_by", "support_detail", "supported"]),
    names.join(", ")
  );
  ok("supported is boolean NOT NULL with no default (code must say)", col("supported")?.data_type === "boolean" && col("supported")?.is_nullable === "NO" && col("supported")?.column_default === null);
  ok("status is text NOT NULL default 'included'", col("status")?.is_nullable === "NO" && /included/.test(String(col("status")?.column_default)));
  ok("organization_named and role_text are nullable text; source_url is NOT NULL", col("organization_named")?.is_nullable === "YES" && col("role_text")?.is_nullable === "YES" && col("source_url")?.is_nullable === "NO");
  ok("organization_id is NOT NULL and defaults to my_organization_id() (hard rule 6)", col("organization_id")?.is_nullable === "NO" && /my_organization_id/.test(String(col("organization_id")?.column_default)));
  ok("support_detail is jsonb NOT NULL default '{}'", col("support_detail")?.data_type === "jsonb" && col("support_detail")?.is_nullable === "NO" && /\{\}/.test(String(col("support_detail")?.column_default)));
  ok("no email, phone, handle, address, social, linkedin, twitter, facebook, contact, mobile, whatsapp, website or profile column exists", !names.some((c) => /email|phone|handle|address|social|linkedin|twitter|facebook|contact|mobile|whatsapp|website|profile/.test(c)), names.join(", "));
  ok("the only column with 'url' in its name is the captured source_url", names.filter((c) => /url/.test(c)).join() === "source_url");
  ok("row-level security is enabled on the table", (await q(`select relrowsecurity from pg_class where relname = 'network_person_findings'`))[0].relrowsecurity === true);

  {
    const c = await confirmedPerson(A_ORG, A1);
    const id = await finding(A_ORG, c.id);
    const r = (await fnd(id)) as Row;
    ok("a finding written with only the required columns takes the defaults: included, no strike, no restore, empty detail", r.status === "included" && r.struck_by === null && r.struck_at === null && r.restored_by === null && r.restored_at === null && JSON.stringify(r.support_detail) === "{}");
  }

  // --- 3. the closed list ---------------------------------------------------

  section("the kind is a CLOSED list (ruling 0044 clause 3), enforced by the database");
  {
    const c = await confirmedPerson(A_ORG, A1);
    const accepted: string[] = [];
    for (const kind of FINDING_KINDS) {
      const over: Record<string, unknown> = kind === "title" ? { kind, organization_named: null, role_text: "Treasurer" } : { kind, organization_named: "Grace Church" };
      if ((await tryInsert(c.id, over)) === "") accepted.push(kind);
    }
    ok(`all ${FINDING_KINDS.length} kinds of the closed list are accepted`, accepted.length === FINDING_KINDS.length, accepted.join());
    const sneaked: string[] = [];
    for (const kind of ["family", "children", "spouse", "health", "medical", "wealth", "finances", "net_worth", "income", "politics", "political_party", "religious_membership", "religion", "home_address", "address", "private_life", "Employer", "EMPLOYER", " employer", "employer ", "", "other", "employer;"]) {
      if ((await tryInsert(c.id, { kind })) === "") sneaked.push(kind);
    }
    ok("a finding of ANY other kind -- family, children, health, wealth, politics, religious membership, home address, private life -- is refused, as is a case or spacing variant of a real kind", sneaked.length === 0, `accepted: ${sneaked.join(" | ")}`);
    ok("a null kind is refused", /null value|not-null|violates/i.test(await tryInsert(c.id, { kind: null })));
    const def = String((await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'network_person_findings_kind_check'`))[0].d);
    const inDb = Array.from(def.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).sort();
    ok("the kinds in the database are exactly FINDING_KINDS from lib/network-research.ts (no drift)", JSON.stringify(inDb) === JSON.stringify([...FINDING_KINDS].sort()), inDb.join());
  }

  section("a finding names something: a bare title names the role, every other kind names an organization");
  {
    const c = await confirmedPerson(A_ORG, A1);
    ok("a title with no role is refused", /shape_check/.test(await tryInsert(c.id, { kind: "title", organization_named: null, role_text: null })));
    ok("a title naming only an organization (no role) is refused", /shape_check/.test(await tryInsert(c.id, { kind: "title", organization_named: "Grace Church", role_text: null })));
    ok("a bare title (role, no organization) is accepted", (await tryInsert(c.id, { kind: "title", organization_named: null, role_text: "Senior Pastor" })) === "");
    for (const kind of ["employer", "board_seat", "school", "org_leadership_role", "public_affiliation"]) {
      ok(`${kind} with no organization is refused`, /shape_check/.test(await tryInsert(c.id, { kind, organization_named: null, role_text: "Chair" })));
    }
    ok("a board seat naming the organization and the role is accepted", (await tryInsert(c.id, { kind: "board_seat", organization_named: "Hope Foundation", role_text: "Trustee" })) === "");
  }

  section("the text columns are absent or real, never blank or unbounded");
  {
    const c = await confirmedPerson(A_ORG, A1);
    ok("a blank organization is refused", /text_check/.test(await tryInsert(c.id, { organization_named: "   " })));
    ok("a blank role is refused", /text_check/.test(await tryInsert(c.id, { role_text: " " })));
    ok("an organization of 301 characters is refused; 300 is accepted", /text_check/.test(await tryInsert(c.id, { organization_named: "o".repeat(301) })) && (await tryInsert(c.id, { organization_named: "o".repeat(300) })) === "");
    ok("a role of 301 characters is refused; 300 is accepted", /text_check/.test(await tryInsert(c.id, { role_text: "r".repeat(301) })) && (await tryInsert(c.id, { role_text: "r".repeat(300) })) === "");
    ok("a source title over 600 characters is refused", /text_check/.test(await tryInsert(c.id, { source_title: "t".repeat(601) })));
    ok("a passage over 4000 characters is refused; 4000 is accepted", /text_check/.test(await tryInsert(c.id, { source_passage: "p".repeat(4001) })) && (await tryInsert(c.id, { source_passage: "p".repeat(4000) })) === "");
    ok("a support_detail that is not a JSON object is refused", /support_detail_check/.test(await tryInsert(c.id, { support_detail: "[1]" })));
    ok("a null supported is refused (the code must say true or false)", /null value|not-null|violates/i.test(await tryInsert(c.id, { supported: null })));
    ok("an unsupported finding (supported = false) is STORED, not refused", (await tryInsert(c.id, { supported: false })) === "");
    ok("a null source_url is refused", /null value|not-null|violates/i.test(await tryInsert(c.id, { source_url: null })));
  }

  // --- 4. status and who/when ----------------------------------------------

  section("the status and the who/when say one thing, never two (like 0077's and 0083's decision checks)");
  {
    const c = await confirmedPerson(A_ORG, A1);
    const id = await finding(A_ORG, c.id);
    ok("an unknown status is refused", /status_check|decision_check/.test(await refused(`update network_person_findings set status = 'approved' where id = $1`, [id])));
    ok("'struck' with no striker and no time is refused", /decision_check/.test(await refused(`update network_person_findings set status = 'struck' where id = $1`, [id])));
    ok("'struck' with a striker but no time is refused", /decision_check/.test(await refused(`update network_person_findings set status = 'struck', struck_by = $2 where id = $1`, [id, A1])));
    ok("'struck' with a time but no striker is refused", /decision_check/.test(await refused(`update network_person_findings set status = 'struck', struck_at = now() where id = $1`, [id])));
    ok("'included' carrying a strike is refused", /decision_check/.test(await refused(`update network_person_findings set struck_by = $2, struck_at = now() where id = $1`, [id, A1])));
    ok("'included' with half a restore (who, no when) is refused", /decision_check/.test(await refused(`update network_person_findings set restored_by = $2 where id = $1`, [id, A1])));
    ok("'struck' carrying a restore is refused", /decision_check/.test(await refused(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now(), restored_by = $2, restored_at = now() where id = $1`, [id, A1])));
    ok("'struck' with a striker and a time is accepted", (await refused(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1`, [id, A1])) === "");
    ok("back to 'included' with a restorer and a time (the strike cleared) is accepted", (await refused(`update network_person_findings set status = 'included', struck_by = null, struck_at = null, restored_by = $2, restored_at = now() where id = $1`, [id, A2])) === "");
    const r = (await fnd(id)) as Row;
    ok("the restored finding records who restored it and when, and carries no strike", r.status === "included" && r.restored_by === A2 && r.restored_at !== null && r.struck_by === null && r.struck_at === null);
    ok("a fresh strike clears the old restore (the last human action is the one recorded)", (await refused(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now(), restored_by = null, restored_at = null where id = $1`, [id, A1])) === "" && (await fnd(id))?.restored_by === null);
    ok("a struck finding is still there (a strike never removes it)", (await fnd(id))?.status === "struck");
    ok("a finding cannot be born already struck (no striker, no time)", /decision_check/.test(await tryInsert(c.id, { status: "struck" })));
    ok("... nor born struck with a striker and time and a restore too", /decision_check/.test(await tryInsert(c.id, { status: "struck", struck_by: A1, struck_at: new Date().toISOString(), restored_by: A1, restored_at: new Date().toISOString() })));
  }

  // --- 5. the source ---------------------------------------------------------

  section("a finding's source is an http(s) page and never a social network or people-data broker (ruling 0044 clause 4)");
  {
    const c = await confirmedPerson(A_ORG, A1);
    const insertUrl = (url: string) => tryInsert(c.id, { source_url: url, organization_named: `Org for ${url}` });
    const all = [...SOCIAL_NETWORK_HOSTS, ...PEOPLE_DATA_BROKER_HOSTS];
    const accepted: string[] = [];
    for (const host of all) if ((await insertUrl(`https://${host}/in/jane`)) === "") accepted.push(host);
    ok(`every one of the ${all.length} hosts the code refuses is refused by the database too (no drift)`, accepted.length === 0, `accepted: ${accepted.join(", ")}`);
    const subAccepted: string[] = [];
    for (const host of all) {
      for (const url of [`https://www.${host}/x`, `http://sub.deep.${host}:8080/x?y=1`, `https://${host.toUpperCase()}/X`, `https://user:pw@${host}/x`, `https://${host}#frag`]) {
        if ((await insertUrl(url)) === "") subAccepted.push(url);
      }
    }
    ok("subdomains, ports, upper case, user-info and fragments of those hosts are refused too", subAccepted.length === 0, subAccepted.slice(0, 5).join(", "));
    ok("a host that merely contains a refused name is accepted (notlinkedin.com, linkedin.com.example.org, mylinkedin.com, x.com.au)", (await insertUrl("https://notlinkedin.com/a")) === "" && (await insertUrl("https://linkedin.com.example.org/b")) === "" && (await insertUrl("https://mylinkedin.com/c")) === "" && (await insertUrl("https://x.com.au/d")) === "");
    const bad: string[] = [];
    for (const url of ["ftp://example.org/a", "javascript:alert(1)", "example.org/a", "https://", "data:text/html,x", " https://example.org/a"]) if ((await insertUrl(url)) === "") bad.push(url);
    ok("a non-http(s) or hostless source is refused", bad.length === 0, bad.join(", "));
    ok("an ordinary https page is accepted", (await insertUrl("https://www.gracechurch.org/staff/jane-whitcombe")) === "");
    const def = String((await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'network_person_findings_source_url_check'`))[0].d);
    const alt = def.match(/\(\^\|\\\.\)\(([^)]*)\)\$/);
    const inDb = alt ? alt[1].split("|").map((h) => h.replace(/\\\./g, ".")).sort() : [];
    ok("the host list in the migration is exactly SOCIAL_NETWORK_HOSTS + PEOPLE_DATA_BROKER_HOSTS from lib/network-identity.ts", JSON.stringify(inDb) === JSON.stringify([...all].sort()), `db: ${inDb.length}, code: ${all.length}`);
    const def0083 = String((await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'network_identity_candidates_source_url_check'`))[0].d);
    const alt0083 = def0083.match(/\(\^\|\\\.\)\(([^)]*)\)\$/);
    ok("... and the same list as 0083's candidate constraint (the two tables cannot drift apart)", !!alt && !!alt0083 && alt[1] === alt0083[1]);
  }

  // --- 6. once per person ------------------------------------------------------

  section("one finding is stored once per person, so a second research run does not duplicate");
  {
    const c = await confirmedPerson(A_ORG, A1);
    const base = { kind: "board_seat", organization_named: "Hope Foundation", role_text: "Trustee", source_url: "https://example.org/hope/board" };
    ok("the first is accepted", (await tryInsert(c.id, base)) === "");
    ok("the same finding again is refused (unique person, kind, organization, role, source)", /unique_finding/.test(await tryInsert(c.id, base)));
    ok("... case does not make it new", /unique_finding/.test(await tryInsert(c.id, { ...base, organization_named: "HOPE FOUNDATION", role_text: "trustee" })));
    ok("a bare title is unique too (a missing organization reads as empty, not as 'distinct nulls')", (await tryInsert(c.id, { kind: "title", organization_named: null, role_text: "Treasurer", source_url: "https://example.org/t1" })) === "" && /unique_finding/.test(await tryInsert(c.id, { kind: "title", organization_named: null, role_text: "TREASURER", source_url: "https://example.org/t1" })));
    ok("the same claim from a different source is a different finding", (await tryInsert(c.id, { ...base, source_url: "https://example.org/hope/about" })) === "");
    ok("a different role at the same organization and source is a different finding", (await tryInsert(c.id, { ...base, role_text: "Secretary" })) === "");
    ok("the same finding for a different person is fine", (await tryInsert((await confirmedPerson(A_ORG, A1)).id, base)) === "");
    // A struck finding keeps its place: the same finding cannot be written again to replace it.
    const sid = await finding(A_ORG, c.id, { organization_named: "Struck Org", source_url: "https://example.org/s" });
    await db.query(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1`, [sid, A1]);
    ok("a struck finding cannot be resurrected by a re-run: writing it again is refused", /unique_finding/.test(await tryInsert(c.id, { organization_named: "Struck Org", source_url: "https://example.org/s" })));
  }

  // --- 7. the gate -----------------------------------------------------------------

  section("a finding can be born only for a CONFIRMED person who is not do-not-research (clause 2's gate, in the database)");
  {
    const unconfirmed = await person(A_ORG, A1);
    ok("an unconfirmed person cannot be given a finding, by any path", /identity is confirmed/.test(await tryInsert(unconfirmed)));
    const withCands = await person(A_ORG, A1);
    await candidate(A_ORG, withCands, 1);
    ok("... even one with candidates waiting for a human choice", /identity is confirmed/.test(await tryInsert(withCands)));
    const none = await person(A_ORG, A1);
    await db.query(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [none, A1]);
    ok("a 'none of these' person cannot be given a finding", /identity is confirmed/.test(await tryInsert(none)));
    const dnr = await person(A_ORG, A1, { do_not_research: true });
    ok("a do-not-research person cannot be given a finding", /marked do not research/.test(await tryInsert(dnr)));
    const c = await confirmedPerson(A_ORG, A1);
    ok("a confirmed person can", (await tryInsert(c.id)) === "");
    const asA = await as(A1, () => tryInsert(unconfirmed).then((m) => m));
    ok("... and as a signed-in team member the gate holds just the same (security definer, not RLS, enforces it)", /identity is confirmed/.test(asA), asA);
  }

  // --- 8. org match ----------------------------------------------------------------

  section("org-match triggers: every cross-table reference (hard rule 6)");
  {
    const cA = await confirmedPerson(A_ORG, A1);
    const cB = await confirmedPerson(B_ORG, B1);
    ok("a finding for Org B's person cannot be written as Org A's row", /organization_id must match the referenced network connection/.test(await tryInsert(cB.id, {}, A_ORG)));
    const signedIn = await as(A1, async () => {
      f++;
      return refused(`insert into network_person_findings (network_connection_id, kind, organization_named, source_url, supported) values ($1, 'employer', 'X', $2, true)`, [cB.id, `https://example.org/x/${f}`]);
    });
    ok("... and as a signed-in Org A user (organization_id from the column default) it is refused too", signedIn !== "", signedIn);
    const own = await finding(A_ORG, cA.id);
    ok("a finding cannot be repointed at another organization's person", /cannot be edited|organization_id must match/.test(await refused(`update network_person_findings set network_connection_id = $2 where id = $1`, [own, cB.id])));
    const runA = (await q(`insert into ai_runs (organization_id, operation) values ($1, 'network_research') returning id`, [A_ORG]))[0].id as string;
    const runB = (await q(`insert into ai_runs (organization_id, operation) values ($1, 'network_research') returning id`, [B_ORG]))[0].id as string;
    ok("a finding may cite its own organization's run", (await tryInsert(cA.id, { ai_run_id: runA })) === "");
    ok("a finding citing another organization's run is refused", /ai run's organization_id/.test(await tryInsert(cA.id, { ai_run_id: runB })));
    ok("the org-match functions are all security definer with search_path pinned", Number((await q(`select count(*)::int as c from pg_proc where proname in ('enforce_network_finding_connection','enforce_network_finding_run_org_match','enforce_network_finding_human','clear_network_findings_after_identity_change') and prosecdef and proconfig::text like '%search_path=public%'`))[0].c) === 4);
  }

  section("a strike or a restore is recorded as the human who made it, in the same organization");
  {
    const c = await confirmedPerson(A_ORG, A1);
    const id = await finding(A_ORG, c.id);
    ok("a strike cannot name a striker from another organization", /same organization/.test(await refused(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1`, [id, B1])));
    const forged = await as(A1, () => refused(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1`, [id, A2]));
    ok("a signed-in user cannot record a strike as a different teammate", /recorded as the person who made it/.test(forged), forged);
    const mine = await as(A1, () => refused(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1`, [id, A1]));
    ok("... but they can record it as themselves", mine === "", mine);
    const forgedRestore = await as(A1, () => refused(`update network_person_findings set status = 'included', struck_by = null, struck_at = null, restored_by = $2, restored_at = now() where id = $1`, [id, A2]));
    ok("a signed-in user cannot record a RESTORE as a different teammate", /recorded as the person who made it/.test(forgedRestore), forgedRestore);
    const mineRestore = await as(A1, () => refused(`update network_person_findings set status = 'included', struck_by = null, struck_at = null, restored_by = $2, restored_at = now() where id = $1`, [id, A1]));
    ok("... but they can restore as themselves", mineRestore === "", mineRestore);
  }

  // --- 9. nothing is editable but a strike -------------------------------------------

  section("nothing about a finding is editable except striking and restoring it");
  {
    const c = await confirmedPerson(A_ORG, A1);
    const other = await confirmedPerson(A_ORG, A1);
    const id = await finding(A_ORG, c.id, { organization_named: "Grace Church", role_text: "Trustee", kind: "board_seat", source_title: "Staff", source_passage: "Jane is a trustee of Grace Church" });
    const edits: [string, string, unknown][] = [
      ["kind", "kind = 'employer'", undefined],
      ["organization_named", "organization_named = 'Somewhere Else'", undefined],
      ["role_text", "role_text = 'Chair'", undefined],
      ["source_url", "source_url = 'https://example.org/other'", undefined],
      ["source_title", "source_title = 'Typed title'", undefined],
      ["source_passage", "source_passage = 'Typed passage'", undefined],
      ["supported (an unsupported finding cannot be made supported by hand)", "supported = false", undefined],
      ["support_detail", `support_detail = '{"x":1}'`, undefined],
      ["created_at", "created_at = now() - interval '1 year'", undefined],
      ["organization_id", `organization_id = '${B_ORG}'`, undefined],
    ];
    for (const [name, set] of edits) {
      // (organization_id is refused by the org-match trigger, which fires before the guard; either refusal is the point.)
      ok(`${name} cannot be edited`, /cannot be edited|organization_id must match/.test(await refused(`update network_person_findings set ${set} where id = $1`, [id])), name);
    }
    ok("network_connection_id cannot be edited (moved to another person of the same organization)", /cannot be edited/.test(await refused(`update network_person_findings set network_connection_id = $2 where id = $1`, [id, other.id])));
    const runA = (await q(`insert into ai_runs (organization_id, operation) values ($1, 'network_research') returning id`, [A_ORG]))[0].id as string;
    ok("ai_run_id cannot be pointed at a different run", /cannot be edited/.test(await refused(`update network_person_findings set ai_run_id = $2 where id = $1`, [id, runA])));
    ok("an edit that changes nothing is accepted (a save that sets a column to its own value)", (await refused(`update network_person_findings set kind = kind, source_url = source_url where id = $1`, [id])) === "");
    ok("striking is accepted", (await refused(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1`, [id, A1])) === "");
    const r = (await fnd(id)) as Row;
    ok("... and nothing else about the finding changed", r.kind === "board_seat" && r.organization_named === "Grace Church" && r.role_text === "Trustee" && r.source_passage === "Jane is a trustee of Grace Church" && r.supported === true);
    // The foreign key's own SET NULL must keep working (a deleted ledger row must not be blocked by the guard).
    const withRun = await finding(A_ORG, c.id, { ai_run_id: runA });
    const del = await refused(`delete from ai_runs where id = $1`, [runA]);
    const after = await fnd(withRun);
    console.log(`      (deleting the ledger row the finding cites: ${del === "" ? "allowed" : `refused by the ledger itself: ${del}`}; the finding's ai_run_id afterwards: ${after?.ai_run_id === null ? "null" : "still set"})`);
    ok("deleting a ledger row the finding cites is never blocked by the findings guard: either the ledger refuses (rows are retained) or the finding stays with its reference cleared (the table stays erasable)", (del === "" && after?.ai_run_id === null) || (del !== "" && !/cannot be edited/.test(del)), del);
  }

  // --- 10. row-level security --------------------------------------------------------

  section("row-level security: organization-scoped, striking allowed, deleting never offered");
  {
    const pA = await confirmedPerson(A_ORG, A1);
    const pB = await confirmedPerson(B_ORG, B1);
    const fA = await finding(A_ORG, pA.id);
    const fB = await finding(B_ORG, pB.id);
    const seenByA = await as(A1, async () => (await q(`select id from network_person_findings`)).map((r) => r.id));
    ok("Org A's user sees Org A's findings and none of Org B's", seenByA.includes(fA) && !seenByA.includes(fB));
    const seenByB = await as(B1, async () => (await q(`select id from network_person_findings`)).map((r) => r.id));
    ok("Org B's user sees Org B's findings and none of Org A's", seenByB.includes(fB) && !seenByB.includes(fA));
    ok("Org B cannot strike Org A's finding (the update matches no row)", (await as(B1, async () => (await q(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1 returning id`, [fA, B1])).length)) === 0 && (await fnd(fA))?.status === "included");
    ok("Org A's user can strike their own finding", (await as(A1, async () => (await q(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1 returning id`, [fA, A1])).length)) === 1 && (await fnd(fA))?.status === "struck");
    ok("NOBODY can delete a finding directly: not Org A's user on their own finding, not Org B on Org A's", (await as(A1, async () => (await q(`delete from network_person_findings where id = $1 returning id`, [fA])).length)) === 0 && (await as(B1, async () => (await q(`delete from network_person_findings where id = $1 returning id`, [fA])).length)) === 0 && !!(await fnd(fA)));
    ok("... a struck finding STAYS recorded (clause 5)", (await fnd(fA))?.status === "struck");
    const wrong = await as(A1, async () => {
      f++;
      return refused(`insert into network_person_findings (organization_id, network_connection_id, kind, organization_named, source_url, supported) values ($1, $2, 'employer', 'X', $3, true)`, [B_ORG, pA.id, `https://example.org/w/${f}`]);
    });
    ok("a signed-in user cannot write a finding into another organization (the policy's check)", wrong !== "", wrong);
    const own = await as(A1, async () => {
      f++;
      return refused(`insert into network_person_findings (network_connection_id, kind, organization_named, source_url, supported) values ($1, 'school', 'Rice University', $2, true)`, [pA.id, `https://example.org/own/${f}`]);
    });
    ok("a signed-in user can record a finding for their own organization's confirmed person (organization_id from the default)", own === "", own);
    const policies = await q(`select cmd from pg_policies where tablename = 'network_person_findings' order by cmd`);
    ok("the policies are select, insert and update -- there is deliberately NO delete policy", JSON.stringify(policies.map((p) => p.cmd)) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]), JSON.stringify(policies));
  }

  // --- 11. findings cannot outlive the identity they rest on ---------------------------

  section("editing a confirmed person's facts deletes their findings (and only theirs)");
  for (const [column, value] of [["person_name", "Someone Else"], ["affiliation", "Another Church"], ["title", "Elder"], ["city", "Dallas"], ["state", "OK"]] as const) {
    const c = await confirmedPerson(A_ORG, A1, 2, { affiliation: "Grace Church", title: "Pastor", city: "Austin", state: "TX" });
    const bystander = await confirmedPerson(A_ORG, A1);
    for (let i = 0; i < 3; i++) await finding(A_ORG, c.id);
    await finding(A_ORG, bystander.id);
    await db.query(`update network_connections set ${column} = $2 where id = $1`, [c.id, value]);
    ok(`changing ${column}: the person is back to unconfirmed and all 3 findings are gone; another person's finding is untouched`, (await conn(c.id)).identity_status === "unconfirmed" && (await findCount(c.id)) === 0 && (await findCount(bystander.id)) === 1);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2, { title: "Pastor" });
    await finding(A_ORG, c.id);
    await db.query(`update network_connections set title = null where id = $1`, [c.id]);
    ok("a clearing edit (a fact removed) deletes the findings too", (await findCount(c.id)) === 0 && (await conn(c.id)).identity_status === "unconfirmed");
  }
  {
    const c = await confirmedPerson(A_ORG, A1);
    await finding(A_ORG, c.id);
    await finding(A_ORG, c.id);
    await db.query(`update network_connections set notes = 'new notes', how_known = 'church', strength = 'close' where id = $1`, [c.id]);
    ok("editing notes, how_known or strength (not identifying facts) keeps the confirmation AND the findings", (await conn(c.id)).identity_status === "confirmed" && (await findCount(c.id)) === 2);
    await db.query(`update network_connections set person_name = person_name, city = city where id = $1`, [c.id]);
    ok("a save that sets the facts to their own values keeps them too", (await findCount(c.id)) === 2);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2, { city: "Austin" });
    await finding(A_ORG, c.id);
    await as(A1, () => q(`update network_connections set city = 'Dallas' where id = $1`, [c.id]));
    ok("the same holds when a signed-in team member makes the edit under row-level security (the trigger is security definer)", (await findCount(c.id)) === 0 && (await conn(c.id)).identity_status === "unconfirmed");
  }

  section("a human reset, 'none of these', do-not-research and a different confirmation all delete the findings");
  {
    const c = await confirmedPerson(A_ORG, A1);
    await finding(A_ORG, c.id);
    await finding(A_ORG, c.id);
    await db.query(`update network_connections set identity_status = 'unconfirmed', identity_candidate_id = null, identity_decided_by = null, identity_decided_at = null where id = $1`, [c.id]);
    ok("resetting the identity (the columns the reset action writes) deletes the findings", (await findCount(c.id)) === 0);
  }
  {
    const c = await confirmedPerson(A_ORG, A1);
    await finding(A_ORG, c.id);
    await db.query(`update network_connections set identity_status = 'none_of_these', identity_candidate_id = null, identity_decided_by = $2, identity_decided_at = now() where id = $1`, [c.id, A1]);
    ok("moving a confirmed person to 'none of these' deletes the findings", (await findCount(c.id)) === 0);
  }
  {
    const c = await confirmedPerson(A_ORG, A1);
    await finding(A_ORG, c.id);
    await finding(A_ORG, c.id);
    await db.query(`update network_connections set do_not_research = true where id = $1`, [c.id]);
    ok("marking a confirmed person do-not-research deletes the findings (and 0083 voids the confirmation)", (await findCount(c.id)) === 0 && (await conn(c.id)).identity_status === "unconfirmed");
    ok("... and then no finding can be born for them", /marked do not research|identity is confirmed/.test(await tryInsert(c.id)));
  }
  {
    // Defence in depth: the do-not-research clause stands on its own. 0083's trigger normally voids a confirmation
    // before this one runs; with that trigger switched off for the statement, the flag ALONE must still clear the findings.
    const c = await confirmedPerson(A_ORG, A1);
    await finding(A_ORG, c.id);
    await finding(A_ORG, c.id);
    await db.exec(`alter table network_connections disable trigger network_connections_identity_reset; alter table network_connections disable trigger network_connections_identity_clear_candidates`);
    await db.query(`update network_connections set do_not_research = true where id = $1`, [c.id]);
    await db.exec(`alter table network_connections enable trigger network_connections_identity_reset; alter table network_connections enable trigger network_connections_identity_clear_candidates`);
    ok("the do-not-research clause works by itself: even if the person were left 'confirmed' (0083's reset and candidate-clearing switched off for the statement), setting the flag deletes the findings", (await conn(c.id)).identity_status === "confirmed" && (await findCount(c.id)) === 0, `${(await conn(c.id)).identity_status} / ${await findCount(c.id)}`);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2);
    await finding(A_ORG, c.id);
    await db.query(`update network_connections set identity_candidate_id = $2 where id = $1`, [c.id, c.cands[1]]);
    ok("confirming a DIFFERENT candidate of the same person (re-pointing the confirmation) deletes the findings that rested on the first", (await conn(c.id)).identity_status === "confirmed" && (await findCount(c.id)) === 0);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    await finding(A_ORG, c.id);
    await db.query(`delete from network_identity_candidates where id = $1`, [c.cands[2]]);
    ok("deleting a candidate that was NOT chosen leaves the confirmation and the findings", (await conn(c.id)).identity_status === "confirmed" && (await findCount(c.id)) === 1);
    await db.query(`delete from network_identity_candidates where id = $1`, [c.cands[0]]);
    ok("deleting the CHOSEN candidate voids the confirmation (0083) and takes the findings with it", (await conn(c.id)).identity_status === "unconfirmed" && (await findCount(c.id)) === 0 && (await candCount(c.id)) === 1);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    await finding(A_ORG, c.id);
    const msg = await refused(`delete from network_identity_candidates where network_connection_id = $1`, [c.id]);
    ok("deleting ALL of a confirmed person's candidates in one statement works and clears the findings", msg === "" && (await findCount(c.id)) === 0, msg);
  }
  {
    const a = await confirmedPerson(A_ORG, A1, 2, { city: "Austin" });
    const b = await confirmedPerson(A_ORG, A1, 2, { city: "Austin" });
    const keep = await confirmedPerson(A_ORG, A1, 2, { city: "Austin" });
    for (const p of [a, b, keep]) {
      await finding(A_ORG, p.id);
      await finding(A_ORG, p.id);
    }
    await db.query(`update network_connections set city = 'Dallas' where id = any($1::uuid[])`, [[a.id, b.id]]);
    ok("one statement editing two confirmed people clears each person's findings and nobody else's", (await findCount(a.id)) === 0 && (await findCount(b.id)) === 0 && (await findCount(keep.id)) === 2);
    const asHuman = await as(A1, async () => (await q(`select count(*)::int as c from network_person_findings where network_connection_id = $1`, [keep.id]))[0].c);
    ok("the bystander's findings are still visible to the signed-in team", Number(asHuman) === 2);
  }

  section("erasing a person erases their findings");
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    for (let i = 0; i < 4; i++) await finding(A_ORG, c.id);
    const sid = await finding(A_ORG, c.id);
    await db.query(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1`, [sid, A1]);
    const msg = await refused(`delete from network_connections where id = $1`, [c.id]);
    ok("erasing a CONFIRMED person with findings (one struck) succeeds", msg === "", msg);
    ok("... and every finding is gone with them, struck or not", (await findCount(c.id)) === 0 && (await candCount(c.id)) === 0);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2);
    await finding(A_ORG, c.id);
    await finding(A_ORG, c.id);
    const asB = await as(B1, async () => (await q(`delete from network_connections where id = $1 returning id`, [c.id])).length);
    ok("Org B erasing Org A's person removes nothing", asB === 0 && (await findCount(c.id)) === 2);
    const asA = await as(A1, async () => (await q(`delete from network_connections where id = $1 returning id`, [c.id])).length);
    ok("a signed-in Org A user erasing their own person works under row-level security even though findings have no delete policy (the cascade is not a user delete)", asA === 1 && (await findCount(c.id)) === 0);
  }
  {
    const many: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await confirmedPerson(A_ORG, A1, 2);
      await finding(A_ORG, c.id);
      await finding(A_ORG, c.id);
      many.push(c.id);
    }
    const msg = await refused(`delete from network_connections where id = any($1::uuid[])`, [many]);
    const left = Number((await q(`select count(*)::int as c from network_person_findings where network_connection_id = any($1::uuid[])`, [many]))[0].c);
    ok("a bulk erase of five confirmed people succeeds and leaves no findings", msg === "" && left === 0, msg);
  }

  // --- 12. a human flow, end to end, under RLS -------------------------------------------

  section("the flow as a signed-in team member: confirm, research, strike, restore, edit, confirm again");
  {
    const p = await person(A_ORG, A1, { affiliation: "Grace Church", title: "Pastor", city: "Austin", state: "TX" });
    const cand = await candidate(A_ORG, p, 1);
    const out = await as(A1, async () => {
      const steps: string[] = [];
      const conf = await q(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1 and identity_status = 'unconfirmed' returning id`, [p, cand, A1]);
      steps.push(String(conf.length));
      for (let i = 1; i <= 3; i++) {
        await q(`insert into network_person_findings (network_connection_id, kind, organization_named, source_url, supported) values ($1, 'employer', $2, $3, $4)`, [p, `Org ${i}`, `https://example.org/flow/${i}`, i !== 3]);
      }
      steps.push(String((await q(`select id from network_person_findings where network_connection_id = $1`, [p])).length));
      const first = (await q(`select id from network_person_findings where network_connection_id = $1 order by created_at, id limit 1`, [p]))[0].id as string;
      steps.push(String((await q(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1 and status = 'included' returning id`, [first, A1])).length));
      steps.push(String((await q(`update network_person_findings set status = 'struck', struck_by = $2, struck_at = now() where id = $1 and status = 'included' returning id`, [first, A1])).length));
      steps.push(String((await q(`update network_person_findings set status = 'included', struck_by = null, struck_at = null, restored_by = $2, restored_at = now() where id = $1 and status = 'struck' returning id`, [first, A1])).length));
      return steps;
    });
    ok("a human confirms, three findings are written (one unsupported), one is struck, striking it again matches no row, and it is restored", JSON.stringify(out) === JSON.stringify(["1", "3", "1", "0", "1"]), JSON.stringify(out));
    ok("the unsupported finding is stored, not dropped", Number((await q(`select count(*)::int as c from network_person_findings where network_connection_id = $1 and supported = false`, [p]))[0].c) === 1);
    await as(A1, () => q(`update network_connections set city = 'Dallas' where id = $1`, [p]));
    ok("then editing the city voids the confirmation and every finding with it", (await conn(p)).identity_status === "unconfirmed" && (await findCount(p)) === 0);
    const cand2 = await candidate(A_ORG, p, 1);
    await db.query(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [p, cand2, A1]);
    ok("confirming again starts with no findings, and the same finding can be written again (no unique clash with a deleted one)", (await findCount(p)) === 0 && (await tryInsert(p, { organization_named: "Org 1", source_url: "https://example.org/flow/1" })) === "");
  }

  // --- 13. additive ---------------------------------------------------------------------------

  section("the migration is additive (ruling 0020)");
  {
    const raw = readFileSync(join(root, "supabase/migrations/0085_network_person_findings.sql"), "utf8");
    const sql = raw
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n")
      .toLowerCase();
    ok("no drop of anything, no rename, no create or replace of an existing object", !/\bdrop\b/.test(sql) && !/rename/.test(sql) && !/create or replace/.test(sql));
    ok("the only table altered is network_person_findings (the new one); network_connections gains a trigger, not a column", [...sql.matchAll(/alter table (\w+)/g)].every((m) => m[1] === "network_person_findings") && /create trigger network_connections_clear_findings\s+after update on network_connections/.test(sql));
    ok("five functions: every one is security definer with search_path pinned, except the one that only guards an update", (sql.match(/create function/g) ?? []).length === 5 && (sql.match(/security definer set search_path = public/g) ?? []).length === 4);
    ok("five triggers, all new", (sql.match(/create trigger/g) ?? []).length === 5);
    ok("no existing migration is edited by this one: it names no earlier file's objects except to reference them", !/alter table network_connections/.test(sql) && !/alter table network_identity_candidates/.test(sql));
    const triggers = await q(`select tgname from pg_trigger where not tgisinternal and (tgrelid = 'network_person_findings'::regclass or tgname = 'network_connections_clear_findings')`);
    ok("the five triggers exist in the database", triggers.length === 5, triggers.map((t) => t.tgname).join());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
