// Item 116 (ruling 0047 clause 6): is a state's public-charity / donor-advised-fund load COMPLETE?
// Ruling 0047 clause 6 asks for the same four things ruling 0046 clause 3 asks of a foundation state:
//   (1) the run finished,
//   (2) its outcome counts add up to the index rows it considered,
//   (3) a header audit finds no return in the state that the header had put elsewhere,
//   (4) a seeded sample of the stored funders, re-checked against the IRS returns themselves, has no
//       UNEXPLAINED mismatch.
// This script does all four, READ-ONLY against the database, and adds two audits the foundation side
// does not need but this one does:
//   * the scope audit: a return the loader counted as "not in scope" and did NOT store is the one kind
//     of loader mistake a check of stored funders can never see (a charity wrongly dropped is simply
//     absent). It reads a seeded sample of those returns, plus the ones nearest the threshold, and
//     applies ruling 0047 clause 8 to them itself;
//   * the unread audit: a return recorded as unread must really be one the verifier also cannot read
//     (a loader defect hides there as "parser error").
// What is independent of the loader, and what is not, is written at the top of
// lib/funder-reference/verify-990.ts. This file is the I/O around it: database, archives, index, caches.
//
// It never writes to the IRS data, never writes a funder row, and by default writes nothing at all to
// the database. --annotate-run adds the verdict to the charity run's counts (under "verification",
// the way the all-states command adds "supervisor" to a foundation run's counts); that is a counts
// update on an existing column, no schema change, and is off unless asked for.
//
// Usage (the project folder name has spaces; quote paths):
//   npx tsx scripts/verify-public-charities.ts --target supabase|pglite:<dir> --state CA \
//     --archives-dir <dir of IRS zips> --index-dir <dir of index_YYYY.csv> --work-dir <the loader's work dir> \
//     [--years 2022,2023,2024] [--sample-size 150] [--seed charity-reference-sample/1] [--full] \
//     [--header-audit 300] [--scope-audit 150] [--unread-audit 100] [--threshold 100000] \
//     [--exceptions <file>] [--result-file <path>] [--annotate-run]
// The service key (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) is read from the environment
// and never printed. Exit: 0 verified (exactly, or within the margin of error); 1 not verified because of sample-value differences only; 4 not verified because of a
// structural failure (outcomes, header or scope audit, a missing input); 2 usage; 3 crashed.
//
// MEMORY. The sample is checked in batches of 100 funders (their XML is held only for the batch);
// the index is streamed, not held. Expect well under 2 GB for 150 funders, and about 1.5 GB for a
// full California pass; the largest single return the loader accepts is 64 MB.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { archiveProvider, readIndexEach, type ArchiveProvider } from "../lib/funder-reference/sources";
import type { IndexRow } from "../lib/funder-reference/document";
import { locateAll, forEachArchive } from "../lib/funder-reference/pipeline";
import { chooseSample, classifyMismatches, validateExceptions, type ExceptionEntry } from "../lib/funder-reference/supervisor";
import { Checker, VERIFIER_VERSION, independentRejectReason, TOLERANCE, applyTolerance, crossStateReplacements, outcomeCountProblems, readReturn, stateOfReturn, storedTotalsProblems, verifyFunder, type Row, type StoredFunder, type VerifyContext } from "../lib/funder-reference/verify-990";
import { DEFAULT_CHARITY_THRESHOLD } from "../lib/funder-reference/charity-scope";
import { CHARITY_LOADER_VERSION } from "../lib/funder-reference/document-990";

const TABLE = { filings: "charity_reference_filings", organizations: "charity_reference_organizations", figures: "charity_reference_figures", daf: "charity_reference_daf_figures", grants: "charity_reference_grants", coverage: "charity_reference_period_coverage" } as const;
type Kind = keyof typeof TABLE;
const ORDER: Record<Kind, string[]> = { filings: ["object_id"], organizations: ["ein"], figures: ["ein", "tax_period_end"], daf: ["filing_object_id"], grants: ["filing_object_id", "ordinal"], coverage: ["ein", "period_year"] };
const CHARITY_RUN_KIND = "public_charity_and_daf_sponsor";
const DEFAULT_SEED = "charity-reference-sample/1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const rank = (seed: string, kind: string, key: string) => createHash("sha256").update(`${seed}|${kind}|${key}`).digest("hex");
const peakRssMb = () => Math.round(process.resourceUsage().maxRSS / 1024);

// ---------------------------------------------------------------------------
// reading the database (read-only)
// ---------------------------------------------------------------------------
interface ReadDb {
  label: string;
  /** Every run recorded for the charity loader, newest first. */
  charityRuns(): Promise<Row[]>;
  /** EINs of the stored funders whose latest filing's address is in the state. */
  orgEins(state: string): Promise<string[]>;
  /** Stored grant rows per funder (from the figures rows), so the sample can always include the biggest. */
  grantRowCounts(eins: string[]): Promise<Map<string, number>>;
  funders(eins: string[]): Promise<Map<string, StoredFunder>>;
  unreadFilings(): Promise<Row[]>;
  /** Every object id in the filings table, any status. */
  allObjectIds(): Promise<Set<string>>;
  /** the given funders whose stored organization record is in this state (a funder that moved lives in the state of its latest return) */
  einsWithOrganization(eins: string[], state: string): Promise<Set<string>>;
  countByStatus(): Promise<Record<string, number>>;
  annotate(runId: string, patch: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

async function openDb(spec: string): Promise<ReadDb> {
  if (spec.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(resolve(spec.slice(7)));
    await db.waitReady;
    const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];
    const j = async (kind: Kind, where: string, params: unknown[]) => (await rows(`select to_jsonb(t) as r from ${TABLE[kind]} t where ${where} order by ${ORDER[kind].join(", ")}`, params)).map((x) => x.r as Row);
    return {
      label: spec,
      charityRuns: async () => (await rows(`select to_jsonb(r) as r from funder_reference_runs r where parameters->>'kind' = '${CHARITY_RUN_KIND}' order by started_at desc`)).map((x) => x.r as Row),
      orgEins: async (state) => (await rows(`select ein from charity_reference_organizations where state = $1 order by ein`, [state])).map((r) => String(r.ein)),
      grantRowCounts: async (eins) => new Map((await rows(`select ein, sum(schedule_i_rows_listed_count)::int as n from charity_reference_figures where ein = any($1::text[]) group by ein`, [eins])).map((r) => [String(r.ein), Number(r.n)])),
      funders: async (eins) => {
        const out = new Map<string, StoredFunder>();
        for (const ein of eins) out.set(ein, { ein, filings: [], organizations: [], figures: [], daf: [], grants: [], coverage: [] });
        for (const kind of Object.keys(TABLE) as Kind[]) for (const r of await j(kind, "ein = any($1::text[])", [eins])) out.get(String(r.ein))![kind].push(r);
        return out;
      },
      unreadFilings: async () => (await j("filings", "status = 'unread'", [])),
      allObjectIds: async () => new Set((await rows(`select object_id from charity_reference_filings`)).map((r) => String(r.object_id))),
      einsWithOrganization: async (eins, state) => new Set((await rows(`select ein from charity_reference_organizations where ein = any($1::text[]) and state = $2`, [eins, state])).map((r) => String(r.ein))),
      countByStatus: async () => Object.fromEntries((await rows(`select status, count(*)::int as n from charity_reference_filings group by status`)).map((r) => [String(r.status), Number(r.n)])),
      annotate: async (id, patch) => void (await db.query(`update funder_reference_runs set counts = counts || $2::jsonb where id = $1`, [id, JSON.stringify(patch)])),
      close: () => db.close(),
    };
  }
  if (spec === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment");
    const { createClient } = await import("@supabase/supabase-js");
    const c = createClient(url, key, { auth: { persistSession: false } });
    // A live project caps every response (1000 rows by default): page explicitly, in primary-key order.
    async function page(table: string, order: string[], apply: (q: any) => any): Promise<Row[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const out: Row[] = [];
      for (let from = 0; ; from += 1000) {
        let q = apply(c.from(table).select("*"));
        for (const col of order) q = q.order(col, { ascending: true });
        const { data, error } = await q.range(from, from + 999);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...(data as Row[]));
        if (data.length < 1000) break;
      }
      return out;
    }
    const pageCols = async (table: string, cols: string, order: string[], apply: (q: any) => any): Promise<Row[]> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const out: Row[] = [];
      for (let from = 0; ; from += 1000) {
        let q = apply(c.from(table).select(cols));
        for (const col of order) q = q.order(col, { ascending: true });
        const { data, error } = await q.range(from, from + 999);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...(data as unknown as Row[]));
        if (data.length < 1000) break;
      }
      return out;
    };
    return {
      label: "supabase",
      charityRuns: async () => {
        const { data, error } = await c.from("funder_reference_runs").select("*").eq("parameters->>kind", CHARITY_RUN_KIND).order("started_at", { ascending: false });
        if (error) throw new Error(`runs: ${error.message}`);
        return data as Row[];
      },
      orgEins: async (state) => (await pageCols(TABLE.organizations, "ein", ["ein"], (q) => q.eq("state", state))).map((r) => String(r.ein)),
      grantRowCounts: async (eins) => {
        const m = new Map<string, number>();
        for (let i = 0; i < eins.length; i += 150) for (const r of await pageCols(TABLE.figures, "ein,schedule_i_rows_listed_count", ["ein", "tax_period_end"], (q) => q.in("ein", eins.slice(i, i + 150)))) m.set(String(r.ein), (m.get(String(r.ein)) ?? 0) + Number(r.schedule_i_rows_listed_count ?? 0));
        return m;
      },
      funders: async (eins) => {
        const out = new Map<string, StoredFunder>();
        for (const ein of eins) out.set(ein, { ein, filings: [], organizations: [], figures: [], daf: [], grants: [], coverage: [] });
        for (let i = 0; i < eins.length; i += 50) {
          const chunk = eins.slice(i, i + 50);
          for (const kind of Object.keys(TABLE) as Kind[]) {
            if (kind === "grants") continue;
            for (const r of await page(TABLE[kind], ORDER[kind], (q) => q.in("ein", chunk))) out.get(String(r.ein))![kind].push(r);
          }
          // Recipient rows are by far the largest table (hundreds of thousands, tens of thousands for one return), and
          // one sorted query over fifty funders timed out on a live project. Read them one filing at a time, in
          // primary-key order, each page starting after the last ordinal read (a bounded index range, however deep).
          for (const ein of chunk) {
            for (const f of [...out.get(ein)!.filings].sort((a, b) => String(a.object_id) < String(b.object_id) ? -1 : 1)) {
              for (let after = -1; ;) {
                const { data, error } = await c.from(TABLE.grants).select("*").eq("filing_object_id", String(f.object_id)).gt("ordinal", after).order("ordinal", { ascending: true }).limit(1000);
                if (error) throw new Error(`${TABLE.grants}: ${error.message}`);
                const rows = data as Row[];
                out.get(ein)!.grants.push(...rows);
                if (rows.length < 1000) break;
                after = Number(rows[rows.length - 1].ordinal);
              }
            }
          }
        }
        return out;
      },
      unreadFilings: async () => page(TABLE.filings, ORDER.filings, (q) => q.eq("status", "unread")),
      allObjectIds: async () => new Set((await pageCols(TABLE.filings, "object_id", ["object_id"], (q) => q)).map((r) => String(r.object_id))),
      einsWithOrganization: async (eins, state) => {
        const s = new Set<string>();
        for (let i = 0; i < eins.length; i += 150) for (const r of await pageCols(TABLE.organizations, "ein", ["ein"], (q) => q.in("ein", eins.slice(i, i + 150)).eq("state", state))) s.add(String(r.ein));
        return s;
      },
      countByStatus: async () => {
        const out: Record<string, number> = {};
        for (const st of ["loaded", "superseded", "unread"]) {
          const { count, error } = await c.from(TABLE.filings).select("object_id", { count: "exact", head: true }).eq("status", st);
          if (error) throw new Error(`count ${st}: ${error.message}`);
          out[st] = count ?? 0;
        }
        return out;
      },
      annotate: async (id, patch) => {
        const { data, error } = await c.from("funder_reference_runs").select("counts").eq("id", id).limit(1);
        if (error || !data?.length) throw new Error(`annotate: run ${id} not found (${error?.message ?? ""})`);
        const { error: e2 } = await c.from("funder_reference_runs").update({ counts: { ...(data[0].counts as Row), ...patch } }).eq("id", id);
        if (e2) throw new Error(`annotate run: ${e2.message}`);
      },
      close: async () => undefined,
    };
  }
  throw new Error(`unknown --target ${spec}`);
}

// ---------------------------------------------------------------------------
// reading the IRS returns: where the database says, else where the loader's own locator finds them
// ---------------------------------------------------------------------------
class XmlSource {
  private cache = new Map<string, Uint8Array | { error: string }>();
  /** Lines to report beside the funder mismatches (a stored location that does not hold the member). */
  notes: string[] = [];
  constructor(private provider: ArchiveProvider) {}

  async prefetch(filings: Row[]): Promise<void> {
    this.cache.clear();
    const groups = new Map<string, Row[]>();
    for (const f of filings) {
      const name = basename(String(f.document_archive_url)).replace(/\.zip$/, "");
      groups.set(name, [...(groups.get(name) ?? []), f]);
    }
    const missing: Row[] = [];
    for (const [name, list] of groups) {
      const wanted = new Set(list.map((f) => String(f.document_member)));
      let zip = null;
      try {
        zip = await this.provider.open(name, { keep: (m) => wanted.has(m) });
      } catch (e) {
        for (const f of list) this.cache.set(String(f.object_id), { error: `could not open ${name}: ${(e as Error).message}` });
        continue;
      }
      if (!zip) {
        missing.push(...list);
        continue;
      }
      try {
        for (const f of list) {
          const entry = zip.find(String(f.document_member));
          if (!entry) {
            missing.push(f);
            continue;
          }
          try {
            this.cache.set(String(f.object_id), await zip.read(entry));
          } catch (e) {
            this.cache.set(String(f.object_id), { error: `archive member could not be read: ${(e as Error).message}` });
          }
        }
      } finally {
        await zip.close();
      }
    }
    if (missing.length) await this.locate(missing);
  }

  /** The stored location did not hold the member: look everywhere, as the loader does, and say so. */
  private async locate(missing: Row[]) {
    const rows: IndexRow[] = missing.map((f) => ({ returnId: null, ein: String(f.ein), taxPeriod: String(f.index_tax_period), subYear: typeof f.index_sub_year === "number" ? f.index_sub_year : null, taxpayerName: "", returnType: "990", objectId: String(f.object_id), batchId: null, indexFile: String(f.index_file) }));
    const located = await locateAll(rows, this.provider, () => undefined);
    for (const f of missing) {
      if (!located.has(String(f.object_id))) this.cache.set(String(f.object_id), { error: `the member ${String(f.document_member)} is not in ${String(f.document_archive_url)} and was not found in any other archive on disk` });
    }
    await forEachArchive(located, [...located.keys()], this.provider, async (zip, ids, archive) => {
      for (const id of ids) {
        const f = missing.find((m) => String(m.object_id) === id)!;
        try {
          this.cache.set(id, await zip.read(located.get(id)!.entry));
          this.notes.push(`[${String(f.ein)}] [${id}] document_archive_url: stored ${JSON.stringify(String(f.document_archive_url))} but the member is in ${archive} (the stored location does not hold the return)`);
        } catch (e) {
          this.cache.set(id, { error: `archive member could not be read: ${(e as Error).message}` });
        }
      }
    });
  }

  get(f: Row): Uint8Array | { error: string } {
    return this.cache.get(String(f.object_id)) ?? { error: "this filing was not fetched" };
  }
}

/** Reads the returns for index rows by the loader's locator (used by the audits, which have no stored location). */
async function readByIndex(provider: ArchiveProvider, rows: IndexRow[]): Promise<Map<string, Uint8Array | { error: string }>> {
  const out = new Map<string, Uint8Array | { error: string }>();
  const located = await locateAll(rows, provider, () => undefined);
  for (const r of rows) if (!located.has(r.objectId)) out.set(r.objectId, { error: "not found in any archive on disk" });
  await forEachArchive(located, [...located.keys()], provider, async (zip, ids) => {
    for (const id of ids) {
      try {
        out.set(id, await zip.read(located.get(id)!.entry));
      } catch (e) {
        out.set(id, { error: `archive member could not be read: ${(e as Error).message}` });
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// the caches the loader keeps in its work directory
// ---------------------------------------------------------------------------
function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line from a killed run
    }
  }
  return out;
}
interface ScanRec { objectId: string; state: string | null; ein: string | null }
interface PassARec { v: number; loader: string; state: string | null; objectId: string; outcome: string; facts?: { orgGrantsAmt: number | null; dafHeldCnt: number | null; dafBox: boolean | null }; head?: { taxPeriodEnd: string } }

// ---------------------------------------------------------------------------
async function main() {
  const dbSpec = arg("target");
  const state = arg("state")?.toUpperCase();
  if (!dbSpec || !state) {
    console.error("usage: --target supabase|pglite:<dir> --state <XX> [--archives-dir <dir>] [--index-dir <dir>] [--work-dir <dir>] [options]; see the header of this file");
    process.exit(2);
  }
  const years = (arg("years") ?? "2022,2023,2024").split(",").map(Number);
  const thresholdAmt = Number(arg("threshold") ?? DEFAULT_CHARITY_THRESHOLD.minOrgGrantsAmt);
  const justUnderFrom = DEFAULT_CHARITY_THRESHOLD.justUnderFromAmt;
  const sampleSize = Number(arg("sample-size") ?? 150);
  const seed = arg("seed") ?? DEFAULT_SEED;
  const full = flag("full");
  const archivesDir = arg("archives-dir");
  const indexDir = arg("index-dir");
  const workDir = arg("work-dir");
  const headerN = Number(arg("header-audit") ?? 300);
  const scopeN = Number(arg("scope-audit") ?? 150);
  const unreadN = Number(arg("unread-audit") ?? 100);
  const resultFile = arg("result-file");
  const exceptionsPath = arg("exceptions") ?? join(__dirname, "../lib/funder-reference/verify-exceptions-990.json");
  const t0 = Date.now();
  const problems: string[] = [];

  const rawEx = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  const exv = validateExceptions(rawEx);
  if (!exv.ok) {
    console.error(`the exception list ${exceptionsPath} is not valid:\n  ${exv.problems.join("\n  ")}`);
    process.exit(2);
  }
  const exceptions: ExceptionEntry[] = exv.entries;
  const exceptionsSha = createHash("sha256").update(readFileSync(exceptionsPath)).digest("hex");

  const db = await openDb(dbSpec);
  const provider = archivesDir ? archiveProvider({ dir: archivesDir, remote: false, userAgent: "FundraisingAI-charity-verifier/1.0" }) : null;
  console.log(`${VERIFIER_VERSION}; database: ${db.label}; state ${state}; seed ${JSON.stringify(seed)}`);

  // ---- (1) and (2): the run finished and its outcomes add up ----
  const runs = (await db.charityRuns()).filter((r) => (r.parameters as { state?: string } | null)?.state === state);
  const completed = runs.filter((r) => r.status === "completed");
  const run = completed[0] ?? runs[0] ?? null;
  const outcomeProblems = outcomeCountProblems(run as { status?: unknown; counts?: unknown } | null);
  const runCounts = ((run?.counts ?? {}) as Record<string, number>);
  const byStatus = await db.countByStatus();
  // The tables hold every state loaded so far, so the stored totals are compared with the sum, over every state,
  // of that state's latest completed run's own outcome counts (a state re-run later carries its full end state).
  const allRuns = await db.charityRuns();
  if (run && completed.length >= 1) outcomeProblems.push(...storedTotalsProblems(byStatus, allRuns));
  const movedByLaterState = crossStateReplacements(byStatus, allRuns);
  if (movedByLaterState > 0) console.log(`(note) ${movedByLaterState} filing(s) stored as standing by an earlier state's run were later replaced by another state's run (a filer that moved); loaded plus replaced still equals the runs' totals`);
  console.log(`(1)+(2) run ${run ? String(run.id) : "none"}: ${outcomeProblems.length ? "PROBLEMS: " + outcomeProblems.join("; ") : "finished, and the outcome counts add up"}`);
  problems.push(...outcomeProblems.map((p) => `run: ${p}`));
  if (run) {
    const rp = run.parameters as { threshold?: { minOrgGrantsAmt?: number } };
    if (rp.threshold?.minOrgGrantsAmt !== thresholdAmt) problems.push(`the run was made under a threshold of ${rp.threshold?.minOrgGrantsAmt}; this check uses ${thresholdAmt}`);
    if (run.loader_version !== CHARITY_LOADER_VERSION) problems.push(`the run's loader version is ${String(run.loader_version)}; this verifier was written for ${CHARITY_LOADER_VERSION}`);
  }

  // ---- the funders and the sample ----
  const eins = await db.orgEins(state);
  const grantCounts = await db.grantRowCounts(eins);
  const funderCounts = eins.map((ein) => ({ ein, grants: grantCounts.get(ein) ?? 0, people: 0 }));
  const sample = full ? { eins: [...eins].sort(), mostGrantRows: chooseSample(funderCounts, 0, seed, state).mostGrantRows } : chooseSample(funderCounts, sampleSize, seed, state);
  console.log(`${eins.length} stored funder(s) in ${state}; checking ${sample.eins.length}${full ? " (every funder)" : ` (the ${sample.mostGrantRows.length} with the most grant rows, then a seeded draw)`}`);
  const storedIds = await db.allObjectIds();

  // ---- the audits' candidates, chosen before the index is streamed ----
  const scanCache = workDir ? readJsonLines<ScanRec>(join(workDir, "header-scan-cache.jsonl")) : [];
  const passA = workDir ? readJsonLines<PassARec>(join(workDir, "pass-a-990-cache.jsonl")).filter((r) => r.state === state && r.loader === CHARITY_LOADER_VERSION && r.outcome === "assessed" && r.facts) : [];
  const headerPool = scanCache.filter((r) => r.ein !== null && r.state !== state).sort((a, b) => rank(seed, "header", a.objectId).localeCompare(rank(seed, "header", b.objectId))).slice(0, headerN * 4);
  const notStored = passA.filter((r) => !storedIds.has(r.objectId));
  const risk = [...notStored].filter((r) => (r.facts!.orgGrantsAmt ?? 0) >= justUnderFrom || r.facts!.dafBox === true).sort((a, b) => (b.facts!.orgGrantsAmt ?? 0) - (a.facts!.orgGrantsAmt ?? 0) || a.objectId.localeCompare(b.objectId)).slice(0, Math.ceil(scopeN / 2));
  const riskIds = new Set(risk.map((r) => r.objectId));
  const draw = [...notStored].filter((r) => !riskIds.has(r.objectId)).sort((a, b) => rank(seed, "scope", a.objectId).localeCompare(rank(seed, "scope", b.objectId))).slice(0, scopeN - risk.length);
  const scopeCandidates = [...risk, ...draw];

  // ---- the index: count it, and keep only what the checks need ----
  let indexRowsCounted: number | null = null;
  const wantedRows = new Map<string, IndexRow>();
  const wantedIds = new Set([...headerPool.map((r) => r.objectId), ...scopeCandidates.map((r) => r.objectId)]);
  const sampleSet = new Set(sample.eins);
  const einYears = new Map<string, Set<number>>();
  if (indexDir) {
    const seen = new Set<string>();
    for (const f of readdirSync(indexDir).filter((x) => /^index_\d{4}\.csv$/.test(x)).sort()) {
      await readIndexEach(join(indexDir, f), { returnType: "990", periodYears: years, eins: null }, (r) => {
        if (seen.has(r.objectId)) return;
        seen.add(r.objectId);
        if (wantedIds.has(r.objectId)) wantedRows.set(r.objectId, r);
        if (sampleSet.has(r.ein)) einYears.set(r.ein, (einYears.get(r.ein) ?? new Set()).add(Number(r.taxPeriod.slice(0, 4))));
      });
    }
    indexRowsCounted = seen.size;
    const ok = !run || indexRowsCounted === runCounts.index_rows_considered;
    console.log(`index: ${indexRowsCounted} distinct Form 990 return(s) with a period ending in ${years.join("/")}; the run considered ${runCounts.index_rows_considered ?? "(no run)"} ${ok ? "(equal)" : "(NOT EQUAL)"}`);
    if (!ok) problems.push(`the index lists ${indexRowsCounted} Form 990 return(s) in the run's years; the run considered ${runCounts.index_rows_considered}`);
  } else problems.push("the index was not given (--index-dir): the rows-considered count and the coverage claims were not checked");

  // ---- (4) the sample: every stored value against the return ----
  const ck = new Checker();
  let filingsChecked = 0;
  if (!provider) {
    problems.push("no --archives-dir: the sample could not be re-read from the IRS archives");
  } else {
    const src = new XmlSource(provider);
    const ctx: VerifyContext = {
      thresholdAmt,
      years,
      readXml: async (f) => src.get(f),
      indexYears: indexDir ? (ein) => einYears.get(ein) ?? new Set() : undefined,
    };
    for (let i = 0; i < sample.eins.length; i += 100) {
      const batch = sample.eins.slice(i, i + 100);
      const stored = await db.funders(batch);
      await src.prefetch([...stored.values()].flatMap((s) => s.filings.filter((f) => f.status !== "unread")));
      for (const ein of batch) {
        const r = await verifyFunder(stored.get(ein)!, ctx, ck);
        filingsChecked += r.filingsChecked;
      }
      for (const n of src.notes.splice(0)) {
        ck.compared++;
        ck.lines.push(n);
      }
      console.log(`  ${Math.min(i + 100, sample.eins.length)}/${sample.eins.length} funders, ${ck.compared} comparisons, ${ck.lines.length} mismatch(es) so far ${memLine()}`);
    }
  }

  // ---- the unread audit ----
  const audit = { unread: { stored: 0, sampled: 0, not_found_in_archive: 0, readable_by_verifier: 0 }, scope: { not_stored_in_pass_a_cache: notStored.length, sampled: 0, in_scope_but_not_stored: 0, other_disagreements: 0 }, header: { pool: scanCache.length, sampled: 0, said_not_in_state_but_return_is_in_state: 0, unreadable: 0 } };
  if (provider) {
    const unread = (await db.unreadFilings()).sort((a, b) => rank(seed, "unread", String(a.object_id)).localeCompare(rank(seed, "unread", String(b.object_id))));
    audit.unread.stored = unread.length;
    const pick = unread.filter((f) => !/^not found:/.test(String(f.status_note))).slice(0, unreadN);
    audit.unread.not_found_in_archive = unread.filter((f) => /^not found:/.test(String(f.status_note))).length;
    audit.unread.sampled = pick.length;
    const src = new XmlSource(provider);
    await src.prefetch(pick.filter((f) => f.document_member && !String(f.document_member).startsWith("(not found")));
    for (const f of pick) {
      ck.ein = String(f.ein);
      const got = src.get(f);
      ck.compared++;
      if ("error" in got) continue; // the archive no longer yields it: the loader's reason (could not be decompressed) stands
      const reason = independentRejectReason(got);
      if (reason === null && !/over the loader's|bytes changed between/.test(String(f.status_note))) {
        audit.unread.readable_by_verifier++;
        ck.lines.push(`[${String(f.ein)}] [${String(f.object_id)} ${String(f.index_tax_period)}] unread filing: stored as unread (${JSON.stringify(String(f.status_note).slice(0, 160))}) but the verifier reads it as a clean Form 990`);
      }
    }
  }

  // ---- the scope audit: returns the loader dropped ----
  if (provider && scopeCandidates.length) {
    const rows = scopeCandidates.map((r) => wantedRows.get(r.objectId)).filter((r): r is IndexRow => !!r);
    const bytes = await readByIndex(provider, rows);
    const hasOrg = await db.einsWithOrganization([...new Set(rows.map((r) => r.ein))], state);
    for (const r of rows) {
      const got = bytes.get(r.objectId);
      ck.ein = r.ein;
      audit.scope.sampled++;
      ck.compared++;
      if (!got || "error" in got) {
        audit.scope.other_disagreements++;
        ck.lines.push(`[${r.ein}] [${r.objectId} ${r.taxPeriod}] scope audit: the return the loader assessed cannot be re-read (${got && "error" in got ? got.error : "not located"})`);
        continue;
      }
      const rr = readReturn(got);
      if ("error" in rr || rr.rejectReasons.length) {
        audit.scope.other_disagreements++;
        ck.lines.push(`[${r.ein}] [${r.objectId} ${r.taxPeriod}] scope audit: the loader read this return and assessed it; the verifier finds it unreadable (${"error" in rr ? rr.error : rr.rejectReasons.join("; ")})`);
        continue;
      }
      const qualifies = (rr.orgGrants !== null && rr.orgGrants >= thresholdAmt) || (rr.dafHeld !== null && rr.dafHeld > 0);
      const tag = `[${r.ein}] [${r.objectId} ${rr.periodEnd}]`;
      if (qualifies) {
        audit.scope.in_scope_but_not_stored++;
        ck.lines.push(`${tag} scope audit: in scope by this return alone (grants to domestic organizations ${rr.orgGrants ?? "not stated"}, donor advised funds ${rr.dafHeld ?? "not stated"}) but no filing is stored for it`);
      } else if (hasOrg.has(r.ein)) {
        audit.scope.in_scope_but_not_stored++;
        ck.lines.push(`${tag} scope audit: the funder is stored as in scope but this return of its own was not stored`);
      }
    }
  }

  // ---- (3) the header audit ----
  if (provider && headerPool.length) {
    const rows = headerPool.map((r) => wantedRows.get(r.objectId)).filter((r): r is IndexRow => !!r).slice(0, headerN);
    const bytes = await readByIndex(provider, rows);
    for (const r of rows) {
      const got = bytes.get(r.objectId);
      audit.header.sampled++;
      ck.compared++;
      ck.ein = r.ein;
      if (!got || "error" in got) {
        audit.header.unreadable++;
        continue; // a return that cannot be read cannot be in the state; the loader counted it, too
      }
      const rr = readReturn(got);
      if ("error" in rr) {
        audit.header.unreadable++;
        continue;
      }
      const st = stateOfReturn(rr);
      if (st === state) {
        audit.header.said_not_in_state_but_return_is_in_state++;
        ck.lines.push(`[${r.ein}] [${r.objectId} ${rr.periodEnd}] header audit: the header scan put this return outside ${state}; the return's own address is in ${state}`);
      }
    }
  } else if (provider) {
    problems.push(indexDir && workDir ? "the header audit had no candidates (the header cache holds no return outside the state)" : "the header audit was not run (it needs --work-dir and --index-dir)");
  }
  if (audit.header.sampled === 0 && !problems.some((p) => p.startsWith("the header audit"))) problems.push("the header audit was not run (it must read a sample of the returns the header ruled out)");
  if (provider && !workDir) problems.push("the scope audit was not run (it needs --work-dir for the loader's pass-A cache)");

  // ---- classify, report, record ----
  const cls = classifyMismatches(ck.lines, exceptions);
  const completedRun = ck.compared > 0 && !!provider;
  if (!completedRun) problems.push("the sample comparison did not run");
  // The margin of error (decision 0013): see applyTolerance. Structural problems (outcomes, missing inputs, an audit over
  // its allowance) get no margin and stop the run; differences within the margin make the state "verified within tolerance".
  const tol = applyTolerance({ compared: ck.compared, fundersChecked: sample.eins.length, unexplained: cls.unexplained, headerSampled: audit.header.sampled, scopeSampled: audit.scope.sampled });
  problems.push(...tol.structural);
  const verified = completedRun && cls.unexplained.length === 0 && problems.length === 0; // exactly clean
  const passes = completedRun && problems.length === 0 && tol.status !== "not_verified";
  const verificationStatus = !completedRun || problems.length > 0 ? "not_verified" : tol.status;

  console.log(`\ncompared ${ck.compared} stored values/properties with the filing(s) of ${sample.eins.length} funder(s); ${ck.lines.length} mismatch(es)`);
  for (const x of ck.lines.slice(0, 500)) console.log(`  MISMATCH ${x}`);
  if (ck.lines.length > 500) console.log(`  ... and ${ck.lines.length - 500} more (all are in the result file)`);
  console.log(`\nunread audit: ${audit.unread.stored} stored, ${audit.unread.sampled} re-read, ${audit.unread.readable_by_verifier} the verifier reads cleanly (${audit.unread.not_found_in_archive} are 'not found in any archive', not re-readable)`);
  console.log(`scope audit: ${audit.scope.sampled} not-stored return(s) re-read (of ${audit.scope.not_stored_in_pass_a_cache} not stored); ${audit.scope.in_scope_but_not_stored} in scope but not stored; ${audit.scope.other_disagreements} other disagreement(s)`);
  console.log(`header audit: ${audit.header.sampled} return(s) the header put outside ${state} re-read; ${audit.header.said_not_in_state_but_return_is_in_state} are in ${state}`);
  for (const p of problems) console.log(`NOT VERIFIED BECAUSE: ${p}`);

  const record = {
    verifier: VERIFIER_VERSION,
    verified,
    verification_status: verificationStatus,
    tolerance: { rules: TOLERANCE, verdict: tol },
    state,
    run_id: run ? String(run.id) : null,
    loader_version: run ? String(run.loader_version) : null,
    mode: full ? "full" : "sample",
    seed,
    size_requested: full ? eins.length : sampleSize,
    funders_in_state: eins.length,
    funders_checked: sample.eins.length,
    filings_checked: filingsChecked,
    must_include: { most_grant_rows: sample.mostGrantRows },
    compared: ck.compared,
    mismatches: ck.lines.length,
    explained: cls.explained,
    unexplained: cls.unexplained.length,
    unexplained_examples: cls.unexplained.slice(0, 20),
    exceptions_sha256: exceptionsSha,
    threshold_org_grants_amt: thresholdAmt,
    outcome_counts: { problems: outcomeProblems, index_rows_counted: indexRowsCounted, stored_by_status: byStatus },
    audits: audit,
    problems,
    verified_at: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    peak_rss_mb: peakRssMb(),
    all_mismatches: ck.lines,
  };
  if (resultFile) writeFileSync(resultFile, JSON.stringify(record, null, 2));
  if (flag("annotate-run") && run) {
    const { all_mismatches: _all, ...small } = record;
    void _all;
    await db.annotate(String(run.id), { verification: small });
    console.log(`the verdict was added to run ${String(run.id)} under counts.verification`);
  }
  await db.close();
  console.log(`\npeak resident memory ${peakRssMb()} MB; ${record.seconds}s`);
  console.log(verified ? `\nRESULT: PASS -- ${state} is verified: every stored value in the sample equals the return, and the run, the headers and the scope audit are clean`
    : passes ? `\nRESULT: PASS WITHIN TOLERANCE -- ${state} is verified within the margin of error (decision 0013): ${cls.unexplained.length} unexplained difference(s), all inside the allowance; ${JSON.stringify(tol.counts)} against ${JSON.stringify(tol.allowed)}`
    : `\nRESULT: FAIL -- ${state} is NOT verified`);
  // Exit codes: 0 verified, or verified within the margin of error (the record's verification_status says which);
  // 1 sample-value differences beyond the margin (the run script records the state as not verified and goes on);
  // 4 a structural failure (the run's outcomes, an audit over its allowance, a missing input) that signals a
  // broken loader, which stops the run.
  process.exit(passes ? 0 : problems.length > 0 ? 4 : 1);
}

function memLine(): string {
  return `[rss ${Math.round(process.memoryUsage().rss / 1048576)} MB]`;
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
