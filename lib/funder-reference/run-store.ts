// Item 114 (ruling 0046 clause 5): where the all-states command reads and writes the
// run table, so the last thing the loader did can be read from the database without
// logging into the server.
//
// FOR THE OWNER. Nothing here adds a table. The existing table funder_reference_runs
// already has a status, a finish time, a free-form parameters document, a counts
// document and a notes column. This command uses them in two ways:
//   * each state's own run (written by the loader) gets a "supervisor" entry added to
//     its counts: the input it was made from, the verified sample and the verdict;
//   * one standing row, with a fixed id, records the command itself: running or not,
//     the status of every state, and where it stopped. It is updated in place, so a
//     second invocation that finds everything done writes no new row at all.
// The service key writes these rows; the application cannot (ruling 0045 clause 1).
//
// Two stores: a local PostgreSQL (development and tests; opened only while it is
// being used, because a local database allows one process at a time and a child
// process is about to need it) and the hosted database (a client built by the
// caller; this library reads no environment variable).

import { createHash } from "node:crypto";
import type { FunderCount, RunRow, Store } from "./supervisor";

/** The standing row for the command itself: a fixed id derived from a fixed name. */
export const SUPERVISOR_RUN_ID = (() => {
  const h = createHash("sha1").update("funder-reference/all-states-supervisor").digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5 layout
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
})();

const SUPERVISOR_LOADER_VERSION = "all-states/1.0.0";

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
function toRun(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    started_at: iso(r.started_at)!,
    finished_at: iso(r.finished_at),
    loader_version: String(r.loader_version),
    status: String(r.status),
    parameters: (typeof r.parameters === "string" ? JSON.parse(r.parameters) : r.parameters) as Record<string, unknown>,
    counts: (typeof r.counts === "string" ? JSON.parse(r.counts) : r.counts) as Record<string, unknown>,
    notes: (r.notes as string | null) ?? null,
  };
}

// --- a local PostgreSQL -------------------------------------------------------------

interface LocalDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

export function pgliteRunStore(open: () => Promise<LocalDb>, label = "pglite"): Store {
  let db: LocalDb | null = null;
  const get = async () => (db ??= await open());
  // every statement as service_role, the way the real key writes
  async function svc<T>(fn: (d: LocalDb) => Promise<T>): Promise<T> {
    const d = await get();
    await d.exec("set role service_role");
    try {
      return await fn(d);
    } finally {
      await d.exec("reset role");
    }
  }
  const columns = "id, started_at, finished_at, loader_version, status, parameters, counts, notes";
  return {
    label,
    runsForState: (state) => svc(async (d) => (await d.query(`select ${columns} from funder_reference_runs where parameters->>'state' = $1 order by started_at desc, id limit 10`, [state])).rows.map((r) => toRun(r as Record<string, unknown>))),
    getRun: (id) =>
      svc(async (d) => {
        const r = (await d.query(`select ${columns} from funder_reference_runs where id = $1`, [id])).rows[0];
        return r ? toRun(r as Record<string, unknown>) : null;
      }),
    annotate: (id, patch) => svc(async (d) => void (await d.query(`update funder_reference_runs set counts = counts || $2::jsonb where id = $1`, [id, JSON.stringify(patch)]))),
    markInterrupted: (ids, note) =>
      svc(async (d) => {
        if (ids.length)
          await d.query(
            `update funder_reference_runs set status = 'interrupted', finished_at = now(), notes = coalesce(notes || E'\\n', '') || $2 where id = any($1::uuid[]) and status = 'running'`,
            [ids, note]
          );
      }),
    funderCounts: (state) =>
      svc(async (d) => {
        const r = await d.query(
          `select f.ein, coalesce(g.n, 0)::int as grants, coalesce(p.n, 0)::int as people
             from funder_reference_foundations f
             left join (select ein, count(*) n from funder_reference_grants group by ein) g on g.ein = f.ein
             left join (select ein, count(*) n from funder_reference_people group by ein) p on p.ein = f.ein
            where f.state = $1 order by f.ein`,
          [state]
        );
        return (r.rows as FunderCount[]).map((x) => ({ ein: String(x.ein), grants: Number(x.grants), people: Number(x.people) }));
      }),
    writeSupervisor: (row) =>
      svc(async (d) => {
        await d.query(
          `insert into funder_reference_runs (id, loader_version, status, parameters, counts, notes, started_at, finished_at)
           values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now(), case when $3 = 'running' then null else now() end)
           on conflict (id) do update set
             status = $3, parameters = $4::jsonb, counts = $5::jsonb, notes = $6, loader_version = $2,
             started_at = case when $7 then now() else funder_reference_runs.started_at end,
             finished_at = case when $3 = 'running' then null else now() end`,
          [SUPERVISOR_RUN_ID, SUPERVISOR_LOADER_VERSION, row.status, JSON.stringify(row.parameters), JSON.stringify(row.counts), row.notes, !!row.begin]
        );
      }),
    release: async () => {
      if (db) {
        const d = db;
        db = null;
        await d.close();
      }
    },
  };
}

// --- the hosted database --------------------------------------------------------------

interface SupabaseLike {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const PAGE = 1000;

export function supabaseRunStore(client: SupabaseLike, label = "supabase"): Store {
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  const columns = "id,started_at,finished_at,loader_version,status,parameters,counts,notes";
  /** Every row of a query, a page at a time (a hosted project caps a response at 1000 rows). */
  async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build(from, from + PAGE - 1);
      fail(what, error);
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }
  const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
  return {
    label,
    async runsForState(state) {
      const { data, error } = await client.from("funder_reference_runs").select(columns).eq("parameters->>state", state).order("started_at", { ascending: false }).limit(10);
      fail("read runs", error);
      return (data as Array<Record<string, unknown>>).map(toRun);
    },
    async getRun(id) {
      const { data, error } = await client.from("funder_reference_runs").select(columns).eq("id", id).limit(1);
      fail("read run", error);
      return data && data.length ? toRun(data[0] as Record<string, unknown>) : null;
    },
    async annotate(id, patch) {
      const cur = await this.getRun(id);
      if (!cur) throw new Error(`annotate: run ${id} not found`);
      const { error } = await client.from("funder_reference_runs").update({ counts: { ...cur.counts, ...patch } }).eq("id", id);
      fail("annotate run", error);
    },
    async markInterrupted(ids, note) {
      if (!ids.length) return;
      const { error } = await client
        .from("funder_reference_runs")
        .update({ status: "interrupted", finished_at: new Date().toISOString(), notes: note })
        .in("id", ids)
        .eq("status", "running");
      fail("mark interrupted", error);
    },
    async funderCounts(state) {
      const funders = await all<{ ein: string }>((a, b) => client.from("funder_reference_foundations").select("ein").eq("state", state).order("ein").range(a, b), "read funders");
      const eins = funders.map((f) => f.ein);
      const grants = new Map<string, number>();
      const people = new Map<string, number>();
      for (const part of chunks(eins, 100)) {
        // grant rows = the listed paid grants counted on each standing filing's figures row, plus the rows approved for future payment
        const figs = await all<{ ein: string; grants_listed_count: number | null }>((a, b) => client.from("funder_reference_figures").select("ein,grants_listed_count").in("ein", part).order("ein").order("tax_period_end").range(a, b), "read figures");
        for (const f of figs) grants.set(f.ein, (grants.get(f.ein) ?? 0) + (f.grants_listed_count ?? 0));
        const fut = await all<{ ein: string }>((a, b) => client.from("funder_reference_grants").select("ein").in("ein", part).eq("kind", "approved_for_future_payment").order("filing_object_id").order("ordinal").range(a, b), "read approved grants");
        for (const f of fut) grants.set(f.ein, (grants.get(f.ein) ?? 0) + 1);
        const ppl = await all<{ ein: string }>((a, b) => client.from("funder_reference_people").select("ein").in("ein", part).order("filing_object_id").order("listed_in").order("ordinal").range(a, b), "read people");
        for (const f of ppl) people.set(f.ein, (people.get(f.ein) ?? 0) + 1);
      }
      return eins.map((ein) => ({ ein, grants: grants.get(ein) ?? 0, people: people.get(ein) ?? 0 }));
    },
    async writeSupervisor(row) {
      const base = { loader_version: SUPERVISOR_LOADER_VERSION, status: row.status, parameters: row.parameters, counts: row.counts, notes: row.notes, finished_at: row.status === "running" ? null : new Date().toISOString() };
      const existing = await this.getRun(SUPERVISOR_RUN_ID);
      if (!existing) {
        const { error } = await client.from("funder_reference_runs").insert({ id: SUPERVISOR_RUN_ID, ...base });
        fail("write supervisor row", error);
      } else {
        const { error } = await client
          .from("funder_reference_runs")
          .update({ ...base, ...(row.begin ? { started_at: new Date().toISOString() } : {}) })
          .eq("id", SUPERVISOR_RUN_ID);
        fail("update supervisor row", error);
      }
    },
    release: async () => undefined,
  };
}
