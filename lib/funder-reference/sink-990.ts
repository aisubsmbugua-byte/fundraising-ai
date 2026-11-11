// Item 116 (ruling 0047): where the Form 990 loader writes. The same two implementations as sink.ts,
// over the six charity_reference_* tables of migration 0089, with the run record shared with the
// foundation loader (funder_reference_runs says which kind a run was in its parameters).
//
// Neither is importable from the web application; scripts/test-public-charities.ts scans for that.

import type { CharityFilingDoc } from "./document-990";
import { pgliteSink, supabaseSink, type CoverageRow, type ExistingFiling, type Sink } from "./sink";

export interface CharitySink {
  readonly label: string;
  startRun: Sink["startRun"];
  finishRun: Sink["finishRun"];
  existingFilings(objectIds: string[]): Promise<Map<string, ExistingFiling>>;
  /**
   * Store one filing. A filing whose document is over pieceBytes is written in pieces (everything but the
   * recipient rows first, then the recipient rows a piece at a time); if any piece fails the filing is
   * left recorded as unread with the reason, never as loaded with recipients missing.
   */
  applyFiling(doc: CharityFilingDoc, pieceBytes?: number): Promise<string>;
  replaceCoverage(eins: string[], rows: CoverageRow[]): Promise<void>;
  /** Ruling 0047 clause 7: is any loader run (this kind or the foundation kind) recorded as still running? */
  runsInProgress(): Promise<number>;
}

interface SupabaseLike {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function supabaseCharitySink(client: SupabaseLike, label = "supabase"): CharitySink {
  const base = supabaseSink(client, label);
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    label,
    startRun: base.startRun,
    finishRun: base.finishRun,
    async existingFilings(objectIds) {
      const out = new Map<string, ExistingFiling>();
      for (let i = 0; i < objectIds.length; i += 150) {
        const { data, error } = await client
          .from("charity_reference_filings")
          .select("object_id,status,status_note,xml_sha256,loader_version")
          .in("object_id", objectIds.slice(i, i + 150));
        fail("read existing charity filings", error);
        for (const r of data as ExistingFiling[]) out.set(r.object_id, r);
      }
      return out;
    },
    async applyFiling(doc, pieceBytes) {
      const id = (doc.filing as { object_id: string }).object_id;
      const head = async (d: CharityFilingDoc) => {
        const { data, error } = await client.rpc("charity_reference_apply_filing", { doc: d });
        fail(`apply charity filing ${id}`, error);
        return String(data);
      };
      if (!pieceBytes || (JSON.stringify(doc).length <= pieceBytes && doc.grants.length <= MAX_ROWS_PER_PIECE)) return head(doc);
      return applyInPieces(doc, pieceBytes, {
        head,
        async append(rows) {
          const { error } = await client.rpc("charity_reference_append_grants", { grants: rows });
          fail(`append recipient rows of charity filing ${id}`, error);
        },
      });
    },
    async replaceCoverage(eins, rows) {
      for (let i = 0; i < eins.length; i += 150) {
        const { error } = await client.from("charity_reference_period_coverage").delete().in("ein", eins.slice(i, i + 150));
        fail("clear charity coverage", error);
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await client.from("charity_reference_period_coverage").insert(rows.slice(i, i + 500));
        fail("write charity coverage", error);
      }
    },
    async runsInProgress() {
      const { data, error } = await client.from("funder_reference_runs").select("parameters, counts").eq("status", "running");
      fail("read runs in progress", error);
      return (data ?? []).filter((r) => !isReadOnlyVerification(r)).length;
    },
  };
}

/**
 * The most recipient rows one piece may hold. The real project cancels a statement that runs too long
 * (found on the first piece-written return: a piece of about 9,000 rows timed out), so a piece is bounded
 * by row count as well as by size.
 */
export const MAX_ROWS_PER_PIECE = 1000;

/** The recipient rows of one filing, grouped so that no group's JSON is over pieceBytes or holds more than maxRows rows (a single row over the size goes alone). */
export function splitGrantRows(grants: Array<Record<string, unknown>>, pieceBytes: number, maxRows = MAX_ROWS_PER_PIECE): Array<Array<Record<string, unknown>>> {
  const pieces: Array<Array<Record<string, unknown>>> = [];
  let cur: Array<Record<string, unknown>> = [];
  let size = 0;
  for (const g of grants) {
    const b = JSON.stringify(g).length + 1;
    if (cur.length && (size + b > pieceBytes || cur.length >= maxRows)) {
      pieces.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(g);
    size += b;
  }
  if (cur.length) pieces.push(cur);
  return pieces;
}

/**
 * Writes a filing in pieces through three calls the sink supplies. The head call stores everything but the
 * recipient rows and says what the database made of the filing ('loaded', 'superseded', 'unread'); only a
 * 'loaded' filing has recipient rows to add. A failed piece rewrites the filing as unread, which clears
 * what was stored, so the table never holds a half-written return as complete.
 */
export async function applyInPieces(
  doc: CharityFilingDoc,
  pieceBytes: number,
  calls: { head(d: CharityFilingDoc): Promise<string>; append(rows: Array<Record<string, unknown>>): Promise<void> }
): Promise<string> {
  const head = await calls.head({ ...doc, grants: [] });
  if (head !== "loaded") return head;
  const pieces = splitGrantRows(doc.grants, pieceBytes);
  try {
    for (const rows of pieces) await calls.append(rows);
    return head;
  } catch (e) {
    const reason = `the filing's ${doc.grants.length} recipient rows are written in ${pieces.length} pieces and a piece failed (${(e as Error).message}); the filing was cleared and recorded unread`;
    return calls.head({
      filing: { ...doc.filing, status: "unread", status_note: reason, superseded_by_object_id: null },
      charity: null,
      figures: null,
      daf: null,
      grants: [],
    });
  }
}

/**
 * Ruling 0047 clause 7 stops a charity stage while the national foundation LOAD is running. A run that
 * has finished loading and is only re-reading filings to compare them (a full-database verification:
 * full_verify set, and every state it covers in the "verifying" phase) writes nothing and does not
 * count. Any other running row, including one whose state is not plainly "verifying", still blocks.
 */
export function isReadOnlyVerification(row: { parameters?: unknown; counts?: unknown }): boolean {
  const params = row.parameters as { full_verify?: unknown } | null | undefined;
  const states = (row.counts as { states?: Record<string, { status?: unknown }> } | null | undefined)?.states;
  if (params?.full_verify !== true || !states || typeof states !== "object") return false;
  const list = Object.values(states);
  return list.length > 0 && list.every((s) => s?.status === "verifying");
}

interface PgliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
}

export function pgliteCharitySink(db: PgliteLike, label = "pglite"): CharitySink {
  const base = pgliteSink(db, label);
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
    startRun: base.startRun,
    finishRun: base.finishRun,
    existingFilings: (objectIds) =>
      asService(async () => {
        const out = new Map<string, ExistingFiling>();
        if (objectIds.length === 0) return out;
        const r = await db.query(`select object_id, status, status_note, xml_sha256, loader_version from charity_reference_filings where object_id = any($1::text[])`, [objectIds]);
        for (const row of r.rows as ExistingFiling[]) out.set(row.object_id, row);
        return out;
      }),
    applyFiling: (doc, pieceBytes) =>
      asService(async () => {
        const head = async (d: CharityFilingDoc) => String(((await db.query(`select charity_reference_apply_filing($1::jsonb) as result`, [JSON.stringify(d)])).rows[0] as { result: string }).result);
        if (!pieceBytes || (JSON.stringify(doc).length <= pieceBytes && doc.grants.length <= MAX_ROWS_PER_PIECE)) return head(doc);
        return applyInPieces(doc, pieceBytes, {
          head,
          async append(rows) {
            await db.query(`select charity_reference_append_grants($1::jsonb)`, [JSON.stringify(rows)]);
          },
        });
      }),
    replaceCoverage: (eins, rows) =>
      asService(async () => {
        await db.query(`delete from charity_reference_period_coverage where ein = any($1::text[])`, [eins]);
        for (const c of rows) {
          await db.query(
            `insert into charity_reference_period_coverage (ein, period_year, status, filing_object_id, note, run_id, checked_at) values ($1, $2, $3, $4, $5, $6, $7)`,
            [c.ein, c.period_year, c.status, c.filing_object_id, c.note, c.run_id, c.checked_at]
          );
        }
      }),
    runsInProgress: () =>
      asService(async () => {
        const rows = (await db.query(`select parameters, counts from funder_reference_runs where status = 'running'`)).rows as { parameters: unknown; counts: unknown }[];
        return rows.filter((r) => !isReadOnlyVerification(r)).length;
      }),
  };
}
