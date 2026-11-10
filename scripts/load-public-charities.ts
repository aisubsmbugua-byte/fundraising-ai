// Item 116 (ruling 0047): the offline loader for grantmaking public charities and donor-advised fund
// sponsors, ONE STATE PER RUN. A sibling of scripts/load-funder-reference.ts (Form 990-PF); it does not
// replace or change it. Reads Form 990 returns from the IRS index CSVs and monthly ZIP archives already
// on disk (no new download unless --remote is given, and ruling 0047 authorizes none) and writes the six
// charity_reference_* tables of migration 0089.
//
// RULING 0047 CLAUSE 6 and 7:
//   * California only for the first trial; the national run is a separate decision of the owner's.
//   * It REFUSES to write to the real project while any loader run is recorded as running (the
//     foundation load's own supervisor row stays 'running' for its whole run), and it refuses without
//     --confirm-write-to-supabase. Nothing here may be run against production until migration 0089 has
//     been applied on the owner's say.
//
// Where it writes (--target): pglite:<dir> (a local PostgreSQL with every migration applied; the
// default), supabase (the real project, service key from the environment, never printed), or none with
// --dry-run (no database at all).
//
// Usage (absolute paths; the project folder name has spaces, so quote it):
//   npx tsx scripts/load-public-charities.ts --work-dir <dir> --index-dir <dir of index_YYYY.csv> \
//     [--archives-dir <dir of IRS zips>] [--years 2022,2023,2024] --state CA \
//     [--min-org-grants 100000] [--just-under-from 50000] \
//     [--target pglite:<dir>|supabase|none] [--confirm-write-to-supabase] [--dry-run] [--rewrite-all] \
//     [--max-return-mb 64] [--max-write-mb 16] [--result-file <path>]
//
//   --rewrite-all   write every in-scope return again even if stored identically. Needed after the
//                   threshold changes: a funder's labels are computed from it and stored with it.

import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { archiveProvider, readIndex } from "../lib/funder-reference/sources";
import { DEFAULT_CHARITY_THRESHOLD } from "../lib/funder-reference/charity-scope";
import { runCharityPipeline } from "../lib/funder-reference/pipeline-990";
import { pgliteCharitySink, supabaseCharitySink, type CharitySink } from "../lib/funder-reference/sink-990";
import type { IndexRow } from "../lib/funder-reference/document";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const peakRssMb = () => Math.round(process.resourceUsage().maxRSS / 1024);

function writeResult(obj: Record<string, unknown>) {
  const path = arg("result-file");
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify({ ...obj, peak_rss_mb: peakRssMb(), pid: process.pid, at: new Date().toISOString() }, null, 2));
  } catch {
    // the result file must never be the reason a run fails
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function main() {
  const workDir = arg("work-dir");
  const indexDir = arg("index-dir");
  const state = arg("state")?.toUpperCase();
  if (!workDir || !indexDir || !state) {
    console.error("usage: --work-dir <dir> --index-dir <dir> --state <XX> [options]; see the header of this file");
    process.exit(2);
  }
  mkdirSync(workDir, { recursive: true });
  const periodYears = (arg("years") ?? "2022,2023,2024").split(",").map(Number);
  const threshold = {
    minOrgGrantsAmt: Number(arg("min-org-grants") ?? DEFAULT_CHARITY_THRESHOLD.minOrgGrantsAmt),
    justUnderFromAmt: Number(arg("just-under-from") ?? DEFAULT_CHARITY_THRESHOLD.justUnderFromAmt),
  };
  const dryRun = flag("dry-run");
  const maxReturnBytes = arg("max-return-mb") ? Number(arg("max-return-mb")) * 1_000_000 : undefined;
  const maxWriteBytes = arg("max-write-mb") ? Number(arg("max-write-mb")) * 1_000_000 : undefined;

  const targetArg = arg("target") ?? `pglite:${join(workDir, "db-charities")}`;
  let sink: CharitySink;
  let closeDb: (() => Promise<void>) | null = null;
  if (targetArg === "none") {
    if (!dryRun) {
      console.error("refusing: --target none holds no database, so it is only valid with --dry-run");
      process.exit(2);
    }
    const nothing = () => Promise.reject(new Error("--target none: nothing may be written"));
    sink = { label: "none", startRun: nothing, finishRun: nothing, existingFilings: () => Promise.resolve(new Map()), applyFiling: nothing, replaceCoverage: nothing, runsInProgress: () => Promise.resolve(0) };
  } else if (targetArg === "supabase") {
    if (!flag("confirm-write-to-supabase")) {
      console.error("refusing: --target supabase writes to the real project; pass --confirm-write-to-supabase after migration 0089 has been applied on the owner's say (ruling 0047 clause 7)");
      process.exit(2);
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
      process.exit(2);
    }
    const { createClient } = await import("@supabase/supabase-js");
    sink = supabaseCharitySink(createClient(url, key, { auth: { persistSession: false } }) as never, "supabase");
  } else if (targetArg.startsWith("pglite:")) {
    const { openReferenceDb } = await import("./funder-reference-support");
    const { db, fresh } = await openReferenceDb(resolve(targetArg.slice("pglite:".length)));
    console.log(`target: local PostgreSQL at ${targetArg.slice(7)} (${fresh ? "created, all migrations applied" : "existing"})`);
    sink = pgliteCharitySink(db);
    closeDb = () => db.close();
  } else {
    console.error(`unknown --target ${targetArg}`);
    process.exit(2);
  }

  // Ruling 0047 clause 7: not while the foundation load is running.
  if (!dryRun && targetArg !== "none") {
    const running = await sink.runsInProgress();
    if (running > 0) {
      console.error(`refusing: ${running} loader run(s) are recorded as running. Ruling 0047 clause 7: no stage begins while the item-114 national load is running. Nothing was written.`);
      process.exit(3);
    }
  }

  const files = readdirSync(indexDir).filter((f) => /^index_\d{4}\.csv$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no index_YYYY.csv files in ${indexDir}`);
  const rows: IndexRow[] = [];
  const sources: unknown[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = join(indexDir, f);
    const { rows: got, totalRows } = await readIndex(path, { returnType: "990", periodYears, eins: null });
    let added = 0;
    for (const r of got) {
      if (seen.has(r.objectId)) continue;
      seen.add(r.objectId);
      rows.push(r);
      added++;
    }
    sources.push({ kind: "irs_index", file: f, bytes: statSync(path).size, sha256: await sha256File(path), total_rows: totalRows, rows_selected: added });
    console.log(`index ${f}: ${totalRows} rows, ${added} Form 990 return(s) with a period ending in ${periodYears.join("/")}`);
  }
  const provider = archiveProvider({
    dir: arg("archives-dir") ?? null,
    remote: flag("remote"),
    userAgent: "FundraisingAI-funder-reference-loader/1.0 (offline loader for public IRS returns)",
  });

  const summary = await runCharityPipeline(sink, provider, { periodYears, state, threshold, workDir, rows, sources, dryRun, rewriteAll: flag("rewrite-all"), maxReturnBytes, maxWriteBytes }, (s) => console.log(s));

  console.log("\n=== run summary ===");
  console.log(`run ${summary.runId}${dryRun ? " (DRY RUN, nothing written)" : ""} in ${summary.seconds.toFixed(1)}s; peak resident memory ${peakRssMb()} MB`);
  console.log(JSON.stringify(summary.counts, null, 2));
  console.log(`rejected (unread) filings: ${summary.rejected.length}`);
  for (const r of summary.rejected.slice(0, 50)) console.log(`  ${r.object_id} EIN ${r.ein}: ${r.reason}`);
  if (!summary.counts.outcomes_sum_check) {
    console.error("OUTCOMES DO NOT ADD UP to the rows considered -- this is a loader defect; do not trust the counts");
    process.exitCode = 1;
  }
  if (closeDb) await closeDb();
  writeResult({ ok: true, outcomes_sum_check: summary.counts.outcomes_sum_check, run_id: summary.runId, state, seconds: summary.seconds, counts: summary.counts, rejected: summary.rejected.length });
}

main().catch((e) => {
  console.error(e);
  writeResult({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 2000) });
  process.exit(1);
});
