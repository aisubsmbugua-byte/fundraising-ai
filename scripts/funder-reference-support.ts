// Item 110: an in-process PostgreSQL (PGlite) with the project's migrations
// applied unchanged, for the funder-reference tests and for loading the pilot
// on a developer machine. Same approach as scripts/test-network-identity-
// migration.ts, with one deliberate difference, explained below.
//
// DEFAULT PRIVILEGES. Supabase gives anon, authenticated and service_role
// privileges on every new public table and function at the moment it is created.
// The older migration test grants them AFTER all migrations ran, which would
// silently undo any REVOKE a migration performs -- fine for tenant tables, wrong
// for 0084, whose whole point is that authenticated holds no write privilege. So
// this shim sets default privileges BEFORE the migrations, the way the platform
// does, and 0084's explicit revokes then really take effect.
//
// WHAT THIS CANNOT PROVE: it is PGlite's Postgres, not the Supabase platform. It
// does not run PostgREST (what the HTTP API accepts) and models auth.uid() only
// through the `request.jwt.claim.sub` setting.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(__dirname, "..");

export const SHIM = `
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
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(join(root, "supabase/migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

export interface MigrationResult {
  applied: string[];
  failures: string[];
}

/** Boots the shim and applies every migration file in order, unchanged. */
export async function bootDatabase(db: PGlite): Promise<MigrationResult> {
  await db.exec(SHIM);
  const applied: string[] = [];
  const failures: string[] = [];
  for (const f of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
      applied.push(f);
    } catch (e) {
      failures.push(`${f}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { applied, failures };
}

/** Opens (creating if needed) a persistent database directory with migrations applied. */
export async function openReferenceDb(dataDir?: string): Promise<{ db: PGlite; fresh: boolean; result: MigrationResult | null }> {
  const db = new PGlite(dataDir);
  await db.waitReady;
  const has = await db.query(`select to_regclass('public.funder_reference_filings') as t`).catch(() => ({ rows: [{ t: null }] }));
  if ((has.rows[0] as { t: string | null }).t) return { db, fresh: false, result: null };
  const result = await bootDatabase(db);
  if (result.failures.length) throw new Error(`migrations failed on the local database: ${result.failures.join("; ")}`);
  return { db, fresh: true, result };
}
