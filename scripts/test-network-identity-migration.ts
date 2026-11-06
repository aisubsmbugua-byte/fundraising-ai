// STATE item 107, slice A (ruling 0044): migration 0083 run on a REAL Postgres.
//
// Everything in scripts/test-network.ts about migration 0077 is a static read of
// the SQL text. This is the other half: it applies the project's actual
// migrations, 0001 through the highest-numbered file (0083 included), to an
// in-process PostgreSQL (@electric-sql/pglite, a devDependency) and then runs
// assertions against the live constraints, triggers, cascades and row-level
// security -- as the `authenticated` role, not as the superuser.
//
// WHAT THE SHIM IS. Supabase provides a few things that plain Postgres does not,
// and the migrations lean on them: the `auth` schema (users, uid(), jwt()), the
// roles anon / authenticated / service_role, a `storage` schema, and default
// privileges that let `authenticated` use new public tables. The shim below
// creates the smallest versions of those; every migration file is then applied
// UNCHANGED, in order. If a migration needs something the shim lacks, applying it
// fails here and the test says which file.
//
// WHAT THIS CANNOT PROVE (named so nobody over-reads a green run): it is
// PGlite's Postgres, not the Supabase platform. It does not run PostgREST, so it
// does not prove what the HTTP API accepts; and it does not model Supabase's
// auth.uid() beyond reading the `request.jwt.claim.sub` setting the way Supabase
// does. The live isolation suite (scripts/test-tenant-isolation.ts, which needs
// a real project) remains the check against the deployed database.
//
// Usage: npx tsx scripts/test-network-identity-migration.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PEOPLE_DATA_BROKER_HOSTS, SOCIAL_NETWORK_HOSTS } from "../lib/network-identity";

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

// What Supabase's default privileges give `authenticated` on every public
// object. Row-level security, not these grants, is what scopes the rows.
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
  ok("0083 is among the files applied", files.some((f) => f.startsWith("0083_network_identity")));
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
  async function person(org: string, by: string, over: Record<string, unknown> = {}): Promise<string> {
    n++;
    const cols: Record<string, unknown> = { organization_id: org, recorded_by: by, person_name: `Person ${n}`, strength: "warm", ...over };
    const keys = Object.keys(cols);
    const rows = await q(
      `insert into network_connections (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      keys.map((k) => cols[k])
    );
    return rows[0].id as string;
  }
  async function candidate(org: string, conn: string, rank: number, over: Record<string, unknown> = {}): Promise<string> {
    const cols: Record<string, unknown> = {
      organization_id: org,
      network_connection_id: conn,
      label: `Candidate ${rank}`,
      source_url: `https://example.org/people/${conn}/${rank}`,
      agreement: JSON.stringify({ facts: {} }),
      rank,
      ...over,
    };
    const keys = Object.keys(cols);
    const rows = await q(
      `insert into network_identity_candidates (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      keys.map((k) => cols[k])
    );
    return rows[0].id as string;
  }
  const conn = async (id: string): Promise<Row> => (await q(`select * from network_connections where id = $1`, [id]))[0];
  const candCount = async (id: string): Promise<number> => Number((await q(`select count(*)::int as c from network_identity_candidates where network_connection_id = $1`, [id]))[0].c);
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

  // --- 2. shape ------------------------------------------------------------

  section("network_connections: the new columns, their defaults, and no contact detail");
  const cols = await q(
    `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'network_connections' and table_schema = 'public'`
  );
  const col = (name: string) => cols.find((c) => c.column_name === name);
  ok("title, city, state are nullable text", ["title", "city", "state"].every((c) => col(c)?.data_type === "text" && col(c)?.is_nullable === "YES"));
  ok("do_not_research is boolean NOT NULL default false", col("do_not_research")?.data_type === "boolean" && col("do_not_research")?.is_nullable === "NO" && /false/.test(String(col("do_not_research")?.column_default)));
  ok("identity_status is text NOT NULL default 'unconfirmed'", col("identity_status")?.is_nullable === "NO" && /unconfirmed/.test(String(col("identity_status")?.column_default)));
  ok("identity_decided_by / identity_decided_at / identity_candidate_id are nullable", ["identity_decided_by", "identity_decided_at", "identity_candidate_id"].every((c) => col(c)?.is_nullable === "YES"));
  const allColumnNames = [
    ...cols.map((c) => String(c.column_name)),
    ...(await q(`select column_name from information_schema.columns where table_name = 'network_identity_candidates' and table_schema = 'public'`)).map((c) => String(c.column_name)),
  ];
  ok(
    "no email, phone, handle, address, social, linkedin, twitter, facebook, mobile, whatsapp or website column exists on either table",
    !allColumnNames.some((c) => /email|phone|handle|address|social|linkedin|twitter|facebook|contact|mobile|whatsapp|website/.test(c)),
    allColumnNames.join(", ")
  );
  ok("the only column with 'url' in its name is the candidate's captured source_url", allColumnNames.filter((c) => /url/.test(c)).join() === "source_url");

  {
    // A row written exactly as 0077's insert wrote it takes the defaults.
    const id = await person(A_ORG, A1);
    const r = await conn(id);
    ok("a person recorded without any new field takes the defaults: unconfirmed, not do-not-research, no title/city/state, no decision", r.identity_status === "unconfirmed" && r.do_not_research === false && r.title === null && r.city === null && r.state === null && r.identity_candidate_id === null && r.identity_decided_by === null && r.identity_decided_at === null);
  }

  section("the decision check ties the decision columns to the status (like network_path_suggestions_decision_check)");
  {
    const p = await person(A_ORG, A1);
    const c = await candidate(A_ORG, p, 1);
    ok("an unknown status is refused", /identity_(status|decision)_check/.test(await refused(`update network_connections set identity_status = 'maybe' where id = $1`, [p])));
    ok("'confirmed' with no candidate, decider or time is refused", /identity_decision_check/.test(await refused(`update network_connections set identity_status = 'confirmed' where id = $1`, [p])));
    ok("'confirmed' with a candidate and a decider but no time is refused", /identity_decision_check/.test(await refused(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3 where id = $1`, [p, c, A1])));
    ok("'confirmed' with a time and a decider but no candidate is refused", /identity_decision_check/.test(await refused(`update network_connections set identity_status = 'confirmed', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [p, A1])));
    ok("'unconfirmed' carrying a decider is refused", /identity_decision_check/.test(await refused(`update network_connections set identity_decided_by = $2 where id = $1`, [p, A1])));
    ok("'unconfirmed' carrying a candidate is refused", /identity_decision_check/.test(await refused(`update network_connections set identity_candidate_id = $2 where id = $1`, [p, c])));
    ok("'none_of_these' carrying a candidate is refused", /identity_decision_check/.test(await refused(`update network_connections set identity_status = 'none_of_these', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [p, c, A1])));
    ok("'none_of_these' with no decider is refused", /identity_decision_check/.test(await refused(`update network_connections set identity_status = 'none_of_these' where id = $1`, [p])));
    ok("'none_of_these' with a decider and a time and no candidate is accepted", (await refused(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [p, A1])) === "");
    await db.query(`update network_connections set identity_status = 'unconfirmed', identity_decided_by = null, identity_decided_at = null where id = $1`, [p]);
    // (going back to unconfirmed starts clean: the candidate is gone, so this one is new)
    const c2 = await candidate(A_ORG, p, 1);
    ok("'confirmed' with a candidate, a decider and a time is accepted", (await refused(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [p, c2, A1])) === "");
  }

  section("the fact columns are absent or real, never blank or unbounded");
  {
    const p = await person(A_ORG, A1);
    ok("a blank title is refused", /title_check/.test(await refused(`update network_connections set title = '   ' where id = $1`, [p])));
    ok("a blank city is refused", /city_check/.test(await refused(`update network_connections set city = '' where id = $1`, [p])));
    ok("a blank state is refused", /state_check/.test(await refused(`update network_connections set state = ' ' where id = $1`, [p])));
    ok("an over-long title (301) is refused; 300 is accepted", /title_check/.test(await refused(`update network_connections set title = $2 where id = $1`, [p, "t".repeat(301)])) && (await refused(`update network_connections set title = $2 where id = $1`, [p, "t".repeat(300)])) === "");
    ok("a title, city and state are stored as written", (await refused(`update network_connections set title = 'Treasurer', city = 'Austin', state = 'TX' where id = $1`, [p])) === "" && (await conn(p)).city === "Austin");
  }

  // --- 3. the candidates table --------------------------------------------

  section("network_identity_candidates: shape, at most three per person, closed and bounded");
  {
    const p = await person(A_ORG, A1);
    const c1 = await candidate(A_ORG, p, 1);
    ok("a candidate is stored with the captured source and an agreement object", !!c1);
    ok("rank 4 is refused (the database holds at most three per person)", /rank_check/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'X', 'https://example.org/x', '{}', 4)`, [A_ORG, p])));
    ok("rank 0 is refused", /rank_check/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'X', 'https://example.org/x', '{}', 0)`, [A_ORG, p])));
    ok("a second candidate with the same rank for the same person is refused", /unique_rank/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'Y', 'https://example.org/y', '{}', 1)`, [A_ORG, p])));
    ok("the same source and label twice for one person is refused (unique connection + source_url + label)", /unique_candidate/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'Candidate 1', $3, '{}', 2)`, [A_ORG, p, `https://example.org/people/${p}/1`])));
    ok("an agreement that is not a JSON object is refused", /agreement_check/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'Z', 'https://example.org/z', '[1]', 2)`, [A_ORG, p])));
    ok("a blank label is refused", /label_check/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, '  ', 'https://example.org/z', '{}', 2)`, [A_ORG, p])));
    ok("a passage over 4000 characters is refused", /text_length_check/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, source_passage, agreement, rank) values ($1, $2, 'Z', 'https://example.org/z', $3, '{}', 2)`, [A_ORG, p, "p".repeat(4001)])));
    ok("a null source_url is refused", /null value|not-null|violates/i.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'Z', null, '{}', 2)`, [A_ORG, p])));
  }

  section("a candidate's source is an http(s) page and never a social network or people-data broker (ruling 0044 clause 4)");
  {
    const p = await person(A_ORG, A1);
    const insertUrl = (url: string, rank = 1) =>
      refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, $3, $4, '{}', $5)`, [A_ORG, p, `L ${url}`, url, rank]);
    const all = [...SOCIAL_NETWORK_HOSTS, ...PEOPLE_DATA_BROKER_HOSTS];
    const accepted: string[] = [];
    for (const host of all) {
      if ((await insertUrl(`https://${host}/in/jane`)) === "") accepted.push(host);
      await db.query(`delete from network_identity_candidates where network_connection_id = $1`, [p]);
    }
    ok(`every one of the ${all.length} hosts the code refuses is refused by the database too (no drift)`, accepted.length === 0, `accepted: ${accepted.join(", ")}`);
    const subAccepted: string[] = [];
    for (const host of all) {
      for (const url of [`https://www.${host}/x`, `http://sub.deep.${host}:8080/x?y=1`, `https://${host.toUpperCase()}/X`, `https://user:pw@${host}/x`, `https://${host}.`.replace(/\.$/, "") + "#frag"]) {
        if ((await insertUrl(url)) === "") subAccepted.push(url);
        await db.query(`delete from network_identity_candidates where network_connection_id = $1`, [p]);
      }
    }
    ok("subdomains, ports, upper case, user-info and fragments of those hosts are refused too", subAccepted.length === 0, subAccepted.slice(0, 5).join(", "));
    ok("a host that merely contains a refused name is accepted (notlinkedin.com, linkedin.com.example.org, mylinkedin.com)", (await insertUrl("https://notlinkedin.com/a", 1)) === "" && (await insertUrl("https://linkedin.com.example.org/b", 2)) === "" && (await insertUrl("https://mylinkedin.com/c", 3)) === "" && (await candCount(p)) === 3);
    await db.query(`delete from network_identity_candidates where network_connection_id = $1`, [p]);
    const bad: string[] = [];
    for (const url of ["ftp://example.org/a", "javascript:alert(1)", "example.org/a", "https://", "data:text/html,x", " https://example.org/a"]) if ((await insertUrl(url)) === "") bad.push(url);
    ok("a non-http(s) or hostless source is refused", bad.length === 0, bad.join(", "));
    ok("an ordinary https page is accepted", (await insertUrl("https://www.gracechurch.org/staff/jane-whitcombe")) === "");
    // The migration's own list, read back from the catalog, is exactly the code's list.
    const def = String((await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'network_identity_candidates_source_url_check'`))[0].d);
    const alt = def.match(/\(\^\|\\\.\)\(([^)]*)\)\$/);
    const inDb = alt ? alt[1].split("|").map((h) => h.replace(/\\\./g, ".")).sort() : [];
    ok("the host list in the migration is exactly SOCIAL_NETWORK_HOSTS + PEOPLE_DATA_BROKER_HOSTS from lib/network-identity.ts", JSON.stringify(inDb) === JSON.stringify([...all].sort()), `db: ${inDb.length}, code: ${all.length}`);
  }

  // --- 4. org match on every cross-table reference -------------------------

  section("org-match triggers: every cross-table reference (hard rule 6)");
  {
    const connA = await person(A_ORG, A1);
    const connB = await person(B_ORG, B1);
    ok("a candidate for Org B's person cannot be written as Org A's row", /organization_id must match the referenced network connection/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'X', 'https://example.org/x', '{}', 1)`, [A_ORG, connB])));
    const asA = await as(A1, () => refused(`insert into network_identity_candidates (network_connection_id, label, source_url, agreement, rank) values ($1, 'X', 'https://example.org/x', '{}', 1)`, [connB]));
    ok("... and as a signed-in Org A user (organization_id from the column default) it is refused too", asA !== "", asA);
    ok("a candidate cannot be repointed at another organization's person", /organization_id must match the referenced network connection/.test(await refused(`update network_identity_candidates set network_connection_id = $2 where id = $1`, [await candidate(A_ORG, connA, 1), connB])));
    const runA = (await q(`insert into ai_runs (organization_id, operation) values ($1, 'network_identity') returning id`, [A_ORG]))[0].id as string;
    const runB = (await q(`insert into ai_runs (organization_id, operation) values ($1, 'network_identity') returning id`, [B_ORG]))[0].id as string;
    ok("a candidate may cite its own organization's run", (await refused(`insert into network_identity_candidates (organization_id, network_connection_id, ai_run_id, label, source_url, agreement, rank) values ($1, $2, $3, 'R', 'https://example.org/r', '{}', 2)`, [A_ORG, connA, runA])) === "");
    ok("a candidate citing another organization's run is refused", /ai run's organization_id/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, ai_run_id, label, source_url, agreement, rank) values ($1, $2, $3, 'R2', 'https://example.org/r2', '{}', 3)`, [A_ORG, connA, runB])));
    // chosen candidate
    const connA2 = await person(A_ORG, A1);
    const candOfA2 = await candidate(A_ORG, connA2, 1);
    const candOfB = await candidate(B_ORG, connB, 1);
    ok("a person cannot confirm another organization's candidate", /identity candidate's organization_id/.test(await refused(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [connA, candOfB, A1])));
    ok("a person cannot confirm a candidate that belongs to a different person of the same organization", /one of this person's own candidates/.test(await refused(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [connA, candOfA2, A1])));
    // decider
    const own = await candidate(A_ORG, connA2, 2);
    ok("a decision cannot name a decider from another organization", /same organization/.test(await refused(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [connA2, own, B1])));
    const forged = await as(A1, () => refused(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [connA2, own, A2]));
    ok("a signed-in user cannot record a decision as a different teammate", /recorded as the person who made it/.test(forged), forged);
    const mine = await as(A1, () => refused(`update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1`, [connA2, own, A1]));
    ok("... but they can record it as themselves", mine === "", mine);
    ok("the org-match functions are all security definer with search_path pinned", Number((await q(`select count(*)::int as c from pg_proc where proname in ('enforce_network_candidate_connection_org_match','enforce_network_candidate_run_org_match','enforce_network_connection_candidate_match','enforce_network_connection_decider') and prosecdef and proconfig::text like '%search_path=public%'`))[0].c) === 4);
  }

  section("a candidate can be born only for an unconfirmed person who is not do-not-research");
  {
    const dnr = await person(A_ORG, A1, { do_not_research: true });
    ok("a do-not-research person cannot be given a candidate, by any path", /marked do not research/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'X', 'https://example.org/x', '{}', 1)`, [A_ORG, dnr])));
    const c = await confirmedPerson(A_ORG, A1, 1);
    ok("a confirmed person cannot be given a further candidate", /only for a person whose identity is unconfirmed/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'X', 'https://example.org/x', '{}', 2)`, [A_ORG, c.id])));
    const none = await person(A_ORG, A1);
    await db.query(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [none, A1]);
    ok("a 'none of these' person cannot be given a candidate until a human resets them", /only for a person whose identity is unconfirmed/.test(await refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'X', 'https://example.org/x', '{}', 1)`, [A_ORG, none])));
  }

  // --- 5. row-level security ----------------------------------------------

  section("row-level security: organization-scoped, and a candidate is never edited");
  {
    const pA = await person(A_ORG, A1);
    const cA = await candidate(A_ORG, pA, 1);
    const pB = await person(B_ORG, B1);
    const cB = await candidate(B_ORG, pB, 1);
    ok("RLS is enabled on network_identity_candidates", (await q(`select relrowsecurity as r from pg_class where relname = 'network_identity_candidates'`))[0].r === true);
    const aSees = await as(A1, async () => (await q(`select id from network_identity_candidates`)).map((r) => r.id));
    ok("Org A sees its own candidate and not Org B's", aSees.includes(cA) && !aSees.includes(cB));
    const bSees = await as(B1, async () => (await q(`select id from network_identity_candidates where id = $1`, [cA])).length);
    ok("Org B cannot SELECT Org A's candidate by id", bSees === 0);
    const bDel = await as(B1, async () => (await q(`delete from network_identity_candidates where id = $1 returning id`, [cA])).length);
    ok("Org B's DELETE of Org A's candidate removes 0 rows", bDel === 0 && (await candCount(pA)) === 1);
    const aUpd = await as(A1, async () => (await q(`update network_identity_candidates set label = 'edited' where id = $1 returning id`, [cA])).length);
    ok("even Org A cannot UPDATE its own candidate: there is no update policy (0 rows changed)", aUpd === 0 && (await q(`select label from network_identity_candidates where id = $1`, [cA]))[0].label === "Candidate 1");
    const bIns = await as(B1, () => refused(`insert into network_identity_candidates (organization_id, network_connection_id, label, source_url, agreement, rank) values ($1, $2, 'X', 'https://example.org/x', '{}', 2)`, [A_ORG, pA]));
    ok("Org B cannot INSERT a candidate into Org A", bIns !== "", bIns);
    const aIns = await as(A1, () => refused(`insert into network_identity_candidates (network_connection_id, label, source_url, agreement, rank) values ($1, 'Own', 'https://example.org/own', '{}', 2)`, [pA]));
    ok("Org A can INSERT a candidate for its own person (organization_id from my_organization_id())", aIns === "", aIns);
    const rows = await q(`select organization_id from network_identity_candidates where label = 'Own'`);
    ok("... and the column default filled Org A's id", rows.length === 1 && rows[0].organization_id === A_ORG);
    const aDelOwn = await as(A1, async () => (await q(`delete from network_identity_candidates where label = 'Own' returning id`)).length);
    ok("Org A can DELETE its own candidate (a fresh look replaces them)", aDelOwn === 1);
    const bUpdPerson = await as(B1, async () => (await q(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1 returning id`, [pA, B1])).length);
    ok("Org B cannot decide Org A's person (UPDATE removes 0 rows)", bUpdPerson === 0 && (await conn(pA)).identity_status === "unconfirmed");
  }

  // --- 6. editing a confirmed person resets the confirmation ---------------

  section("editing the identifying facts of a CONFIRMED person resets the confirmation and deletes their candidates");
  for (const [field, value] of [["person_name", "Renamed Person"], ["affiliation", "A New Employer"], ["title", "A New Title"], ["city", "New City"], ["state", "NS"]] as const) {
    const c = await confirmedPerson(A_ORG, A1, 3, { affiliation: "Old Employer", title: "Old Title", city: "Old City", state: "OS" });
    await db.query(`update network_connections set ${field} = $2 where id = $1`, [c.id, value]);
    const r = await conn(c.id);
    ok(
      `changing ${field}: back to unconfirmed, decision cleared, candidates deleted (${await candCount(c.id)} left)`,
      r.identity_status === "unconfirmed" && r.identity_candidate_id === null && r.identity_decided_by === null && r.identity_decided_at === null && (await candCount(c.id)) === 0
    );
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2, { affiliation: "Employer" });
    await db.query(`update network_connections set affiliation = null where id = $1`, [c.id]);
    ok("clearing a fact (set to null) also resets", (await conn(c.id)).identity_status === "unconfirmed" && (await candCount(c.id)) === 0);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2);
    await db.query(`update network_connections set notes = 'n', how_known = 'h', strength = 'close', updated_at = now() where id = $1`, [c.id]);
    ok("editing notes, how known, strength or updated_at does NOT reset a confirmation", (await conn(c.id)).identity_status === "confirmed" && (await candCount(c.id)) === 2);
    await db.query(`update network_connections set person_name = person_name, affiliation = affiliation, title = title, city = city, state = state where id = $1`, [c.id]);
    ok("re-saving the same facts (an edit form submitted unchanged) does not reset", (await conn(c.id)).identity_status === "confirmed" && (await candCount(c.id)) === 2);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2, { affiliation: "Employer" });
    const viaSession = await as(A1, async () => (await q(`update network_connections set affiliation = 'Other' where id = $1 returning identity_status`, [c.id])).map((r) => r.identity_status));
    ok("the same reset happens for a signed-in team member's edit under row-level security", viaSession[0] === "unconfirmed" && (await candCount(c.id)) === 0, JSON.stringify(viaSession));
  }
  {
    const p = await person(A_ORG, A1, { affiliation: "Employer" });
    await candidate(A_ORG, p, 1);
    await db.query(`update network_connections set affiliation = 'Other' where id = $1`, [p]);
    ok("editing an UNCONFIRMED person keeps their candidates (nothing was confirmed)", (await candCount(p)) === 1 && (await conn(p)).identity_status === "unconfirmed");
  }
  {
    const p = await person(A_ORG, A1, { affiliation: "Employer" });
    await candidate(A_ORG, p, 1);
    await db.query(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [p, A1]);
    await db.query(`update network_connections set affiliation = 'Other' where id = $1`, [p]);
    const r = await conn(p);
    ok("editing a 'none of these' person does NOT reset the recorded no (only a human resets it)", r.identity_status === "none_of_these" && r.identity_decided_by === A1 && (await candCount(p)) === 1);
  }

  section("a human reset (back to unconfirmed) starts clean; marking do-not-research deletes what was found");
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    await db.query(`update network_connections set identity_status = 'unconfirmed', identity_candidate_id = null, identity_decided_by = null, identity_decided_at = null where id = $1`, [c.id]);
    ok("resetting a confirmed person leaves unconfirmed and no candidates", (await conn(c.id)).identity_status === "unconfirmed" && (await candCount(c.id)) === 0);
    const p = await person(A_ORG, A1);
    await candidate(A_ORG, p, 1);
    await db.query(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [p, A1]);
    await db.query(`update network_connections set identity_status = 'unconfirmed', identity_decided_by = null, identity_decided_at = null where id = $1`, [p]);
    ok("resetting a 'none of these' person deletes the candidates that were rejected", (await candCount(p)) === 0 && (await conn(p)).identity_status === "unconfirmed");
  }
  {
    const withCands = await person(A_ORG, A1);
    await candidate(A_ORG, withCands, 1);
    await candidate(A_ORG, withCands, 2);
    await db.query(`update network_connections set do_not_research = true where id = $1`, [withCands]);
    ok("marking an unconfirmed person do-not-research deletes their candidates", (await candCount(withCands)) === 0 && (await conn(withCands)).do_not_research === true);
    const c = await confirmedPerson(A_ORG, A1, 2);
    await db.query(`update network_connections set do_not_research = true where id = $1`, [c.id]);
    const r = await conn(c.id);
    ok("marking a CONFIRMED person do-not-research voids the confirmation and deletes their candidates", r.identity_status === "unconfirmed" && r.identity_candidate_id === null && (await candCount(c.id)) === 0);
    const none = await person(A_ORG, A1);
    await db.query(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [none, A1]);
    await db.query(`update network_connections set do_not_research = true where id = $1`, [none]);
    ok("marking a 'none of these' person do-not-research keeps the recorded no", (await conn(none)).identity_status === "none_of_these");
    await db.query(`update network_connections set do_not_research = false where id = $1`, [withCands]);
    ok("clearing the flag changes nothing else (and does not bring the candidates back)", (await conn(withCands)).do_not_research === false && (await candCount(withCands)) === 0);
  }

  // --- 7. deleting a chosen candidate / erasing a person -------------------

  section("deleting the chosen candidate never leaves a dangling confirmation; erasing a person always works");
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    const msg = await refused(`delete from network_identity_candidates where id = $1`, [c.cands[0]]);
    const r = await conn(c.id);
    ok("deleting the chosen candidate is allowed (not RESTRICT) ...", msg === "", msg);
    ok("... and voids the confirmation: unconfirmed, no candidate, no decider, no time", r.identity_status === "unconfirmed" && r.identity_candidate_id === null && r.identity_decided_by === null && r.identity_decided_at === null);
    ok("... while the person's OTHER candidates survive for review", (await candCount(c.id)) === 2);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    await db.query(`delete from network_identity_candidates where id = $1`, [c.cands[1]]);
    ok("deleting a candidate that was NOT chosen leaves the confirmation intact", (await conn(c.id)).identity_status === "confirmed" && (await conn(c.id)).identity_candidate_id === c.cands[0] && (await candCount(c.id)) === 2);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    const msg = await refused(`delete from network_identity_candidates where network_connection_id = $1`, [c.id]);
    ok("deleting ALL of a confirmed person's candidates in one statement works and voids the confirmation", msg === "" && (await conn(c.id)).identity_status === "unconfirmed" && (await candCount(c.id)) === 0, msg);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 3);
    const msg = await refused(`delete from network_connections where id = $1`, [c.id]);
    ok("erasing a CONFIRMED person succeeds (the cascade is not blocked by the chosen-candidate reference)", msg === "", msg);
    ok("... and their candidates are gone with them", (await candCount(c.id)) === 0 && (await q(`select 1 from network_connections where id = $1`, [c.id])).length === 0);
  }
  {
    const many: string[] = [];
    for (let i = 0; i < 6; i++) many.push((await confirmedPerson(A_ORG, A1, 3)).id);
    const none = await person(A_ORG, A1);
    await candidate(A_ORG, none, 1);
    await db.query(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1`, [none, A1]);
    many.push(none);
    const msg = await refused(`delete from network_connections where id = any($1::uuid[])`, [many]);
    const left = Number((await q(`select count(*)::int as c from network_identity_candidates where network_connection_id = any($1::uuid[])`, [many]))[0].c);
    ok("a bulk delete of seven people (six confirmed, one 'none of these') succeeds and leaves no candidates", msg === "" && left === 0, msg);
  }
  {
    const c = await confirmedPerson(A_ORG, A1, 2);
    const asB = await as(B1, async () => (await q(`delete from network_connections where id = $1 returning id`, [c.id])).length);
    ok("Org B erasing Org A's confirmed person removes nothing", asB === 0 && (await conn(c.id)).identity_status === "confirmed");
    const asA = await as(A1, async () => (await q(`delete from network_connections where id = $1 returning id`, [c.id])).length);
    ok("a signed-in Org A user erasing their own confirmed person works under row-level security", asA === 1 && (await candCount(c.id)) === 0);
  }

  // --- 8. a human flow under RLS, end to end ------------------------------

  section("the flow as a signed-in team member: replace candidates, confirm, edit, reconfirm");
  {
    const p = await person(A_ORG, A1, { affiliation: "Grace Church", title: "Pastor", city: "Austin", state: "TX" });
    const flow = await as(A1, async () => {
      const out: string[] = [];
      // A look: replace (delete then insert) the person's candidates.
      await db.query(`delete from network_identity_candidates where network_connection_id = $1`, [p]);
      for (let r = 1; r <= 3; r++) {
        await db.query(`insert into network_identity_candidates (network_connection_id, label, source_url, agreement, rank) values ($1, $2, $3, '{}', $4)`, [p, `Cand ${r}`, `https://example.org/${p}/${r}`, r]);
      }
      // A second look replaces them without a unique-rank clash.
      await db.query(`delete from network_identity_candidates where network_connection_id = $1`, [p]);
      for (let r = 1; r <= 2; r++) {
        await db.query(`insert into network_identity_candidates (network_connection_id, label, source_url, agreement, rank) values ($1, $2, $3, '{}', $4)`, [p, `Again ${r}`, `https://example.org/again/${p}/${r}`, r]);
      }
      const cs = await q(`select id from network_identity_candidates where network_connection_id = $1 order by rank`, [p]);
      out.push(String(cs.length));
      const upd = await q(
        `update network_connections set identity_status = 'confirmed', identity_candidate_id = $2, identity_decided_by = $3, identity_decided_at = now() where id = $1 and identity_status = 'unconfirmed' returning id`,
        [p, cs[1].id, A1]
      );
      out.push(String(upd.length));
      const again = await q(`update network_connections set identity_status = 'none_of_these', identity_decided_by = $2, identity_decided_at = now() where id = $1 and identity_status = 'unconfirmed' returning id`, [p, A1]);
      out.push(String(again.length));
      return out;
    });
    ok("two looks in a row replace cleanly; a human confirms the second candidate; a second decision on a decided person matches no row", JSON.stringify(flow) === JSON.stringify(["2", "1", "0"]), JSON.stringify(flow));
    const r = await conn(p);
    ok("the confirmed row names the human who decided and when", r.identity_status === "confirmed" && r.identity_decided_by === A1 && r.identity_decided_at !== null);
    await as(A1, () => q(`update network_connections set city = 'Dallas' where id = $1`, [p]));
    ok("then editing the city voids it, and the person can be looked at again", (await conn(p)).identity_status === "unconfirmed" && (await candCount(p)) === 0);
  }

  section("the migration is additive (ruling 0020)");
  {
    const sql = readFileSync(join(root, "supabase/migrations/0083_network_identity.sql"), "utf8")
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n")
      .toLowerCase();
    ok("no drop of anything, no rename, no create or replace of an existing object", !/\bdrop\b/.test(sql) && !/rename/.test(sql) && !/create or replace/.test(sql));
    ok("the only table altered is network_connections", [...sql.matchAll(/alter table (\w+)/g)].every((m) => ["network_connections", "network_identity_candidates"].includes(m[1])));
    ok("every function is security definer with search_path pinned, except the one that only rewrites NEW", (sql.match(/create function/g) ?? []).length === 7 && (sql.match(/security definer set search_path = public/g) ?? []).length === 6);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
