// Item 110 (ruling 0045 clauses 1 and 6): where the loader writes.
//
// One interface, two implementations, so the loader has ONE code path:
//   * PgliteSink    -- an in-process PostgreSQL. Used by the tests and by the pilot
//                      load on this machine. Every statement runs as `service_role`
//                      (SET ROLE), so the privilege model is exercised, not bypassed.
//   * SupabaseSink  -- the real project, with the service-role key, server-side
//                      only (hard rule 5). NOT exercised against a live project in
//                      this item (no migration may be applied to production here);
//                      it is a thin wrapper over the same function and tables.
//
// Neither is importable from the web application: nothing under app/ or lib/
// (outside lib/funder-reference/) may reference this directory
// (scripts/test-funder-reference-migration.ts scans for that).

import type { FilingDoc } from "./document";

export interface ExistingFiling {
  object_id: string;
  status: string;
  status_note: string | null;
  xml_sha256: string | null;
  loader_version: string;
}

export interface CoverageRow {
  ein: string;
  period_year: number;
  status: "loaded" | "unread" | "no_filing_in_index";
  filing_object_id: string | null;
  note: string;
  run_id: string;
  checked_at: string;
}

export interface RunFinish {
  status: "completed" | "failed" | "interrupted";
  counts: Record<string, unknown>;
  rejected_filings: unknown[];
  sources: unknown[];
  notes?: string | null;
}

export interface Sink {
  readonly label: string;
  startRun(run: { id: string; loaderVersion: string; parameters: Record<string, unknown> }): Promise<void>;
  finishRun(id: string, finish: RunFinish): Promise<void>;
  existingFilings(objectIds: string[]): Promise<Map<string, ExistingFiling>>;
  applyFiling(doc: FilingDoc): Promise<string>;
  /** Replace coverage for every EIN in `eins` with `rows` (an EIN no longer in scope loses its rows). */
  replaceCoverage(eins: string[], rows: CoverageRow[]): Promise<void>;
}

// --- Supabase (service role) --------------------------------------------------

// Structural type so this file does not import the client at module load in tests.
interface SupabaseLike {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function supabaseSink(client: SupabaseLike, label = "supabase"): Sink {
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    label,
    async startRun(run) {
      const { error } = await client.from("funder_reference_runs").insert({
        id: run.id,
        loader_version: run.loaderVersion,
        status: "running",
        parameters: run.parameters,
      });
      fail("start run", error);
    },
    async finishRun(id, f) {
      const { error } = await client
        .from("funder_reference_runs")
        .update({ finished_at: new Date().toISOString(), status: f.status, counts: f.counts, rejected_filings: f.rejected_filings, sources: f.sources, notes: f.notes ?? null })
        .eq("id", id);
      fail("finish run", error);
    },
    async existingFilings(objectIds) {
      const out = new Map<string, ExistingFiling>();
      for (let i = 0; i < objectIds.length; i += 150) {
        const { data, error } = await client
          .from("funder_reference_filings")
          .select("object_id,status,status_note,xml_sha256,loader_version")
          .in("object_id", objectIds.slice(i, i + 150));
        fail("read existing filings", error);
        for (const r of data as ExistingFiling[]) out.set(r.object_id, r);
      }
      return out;
    },
    async applyFiling(doc) {
      const { data, error } = await client.rpc("funder_reference_apply_filing", { doc });
      fail(`apply filing ${(doc.filing as { object_id: string }).object_id}`, error);
      return String(data);
    },
    async replaceCoverage(eins, rows) {
      for (let i = 0; i < eins.length; i += 150) {
        const { error } = await client.from("funder_reference_period_coverage").delete().in("ein", eins.slice(i, i + 150));
        fail("clear coverage", error);
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await client.from("funder_reference_period_coverage").insert(rows.slice(i, i + 500));
        fail("write coverage", error);
      }
    },
  };
}

// --- PGlite (in-process Postgres) ------------------------------------------------

interface PgliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
}

export function pgliteSink(db: PgliteLike, label = "pglite"): Sink {
  // Every operation runs as service_role, the way the real loader's key does.
  async function asService<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec("set role service_role");
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  return {
    label,
    startRun: (run) =>
      asService(async () => {
        await db.query(`insert into funder_reference_runs (id, loader_version, status, parameters) values ($1, $2, 'running', $3)`, [
          run.id,
          run.loaderVersion,
          JSON.stringify(run.parameters),
        ]);
      }),
    finishRun: (id, f) =>
      asService(async () => {
        await db.query(
          `update funder_reference_runs set finished_at = now(), status = $2, counts = $3, rejected_filings = $4, sources = $5, notes = $6 where id = $1`,
          [id, f.status, JSON.stringify(f.counts), JSON.stringify(f.rejected_filings), JSON.stringify(f.sources), f.notes ?? null]
        );
      }),
    existingFilings: (objectIds) =>
      asService(async () => {
        const out = new Map<string, ExistingFiling>();
        if (objectIds.length === 0) return out;
        const r = await db.query(
          `select object_id, status, status_note, xml_sha256, loader_version from funder_reference_filings where object_id = any($1::text[])`,
          [objectIds]
        );
        for (const row of r.rows as ExistingFiling[]) out.set(row.object_id, row);
        return out;
      }),
    applyFiling: (doc) =>
      asService(async () => {
        const r = await db.query(`select funder_reference_apply_filing($1::jsonb) as result`, [JSON.stringify(doc)]);
        return String((r.rows[0] as { result: string }).result);
      }),
    replaceCoverage: (eins, rows) =>
      asService(async () => {
        await db.query(`delete from funder_reference_period_coverage where ein = any($1::text[])`, [eins]);
        for (const c of rows) {
          await db.query(
            `insert into funder_reference_period_coverage (ein, period_year, status, filing_object_id, note, run_id, checked_at)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [c.ein, c.period_year, c.status, c.filing_object_id, c.note, c.run_id, c.checked_at]
          );
        }
      }),
  };
}
