// Item 110 (ruling 0045): the offline loader for the funder reference database.
//
// Reads IRS Form 990-PF e-file returns from the IRS's bulk downloads (index CSVs
// and monthly ZIP archives) and writes the shared reference tables. It runs
// outside the web application and is never called from a request. It is
// repeatable and resumable: a filing already stored identically is left alone,
// and a killed run picks up where the database and the header cache say it
// stopped.
//
// Where it writes (--target):
//   pglite:<dir>   a local PostgreSQL in <dir> with every project migration
//                  applied. This is how the pilot is loaded in this item: no
//                  migration is applied to production, so there is no production
//                  table to write to yet. Statements run as service_role.
//   supabase       the real project, with SUPABASE_SERVICE_ROLE_KEY (server-side
//                  only, read from the environment, never written to a file).
//                  Refused unless --confirm-write-to-supabase is given, and it
//                  will fail unless migration 0084 has been applied.
//
// Environment notes (learned loading California to production, 2026-11-09):
//   * The service key must be the NEW secret key (it starts sb_secret_). A legacy
//     JWT key (it starts eyJ) is rejected by a project whose legacy keys are
//     disabled ("Legacy API keys are disabled"); the loader warns when it sees one.
//   * Node's default heap is about 4 GB and the full California header scan has
//     needed about 5 GB. Run with NODE_OPTIONS=--max-old-space-size=10240 and at
//     least that much free memory; the loader prints its heap limit and warns.
//   * In an environment that reaches the network through a proxy (a cloud
//     session), Node 22 needs NODE_USE_ENV_PROXY=1 or the proxy is bypassed.
//   * A run leaves <work-dir>/run-diary.log: every progress line and, on every exit,
//     the reason and exit code. If the LAST line of a previous run is not an exit
//     or finished line, that run was killed without notice (the out-of-memory killer,
//     SIGKILL or a container restart) and the next run says so and quotes its last
//     progress. Pass A (every in-state return read whole) is cached in
//     <work-dir>/pass-a-cache.jsonl as it goes, so a restart replays it instead of
//     reading tens of thousands of returns again.
//
// Usage (all paths absolute; the project folder name has spaces, quote it):
//   npx tsx scripts/load-funder-reference.ts \
//     --work-dir <dir> --index-dir <dir of index_YYYY.csv> \
//     [--archives-dir <dir of IRS zips>] [--remote] \
//     [--years 2022,2023,2024] [--state CA] [--ein 582218044[,..]] \
//     [--min-assets 1000000] [--min-giving 100000] [--audit-header-sample 3000] \
//     [--target pglite:<dir>|supabase] [--confirm-write-to-supabase] [--dry-run]
//
//   --ein      restrict to these EINs and ignore --state (the worked example)
//   --remote   read any archive not found in --archives-dir directly from the IRS
//              with HTTP range requests (only the bytes needed)
//   --audit-header-sample N   after the state check by header, read N random returns the
//              header ruled out in full and report any that are in the state after all
//   --min-assets / --min-giving   THE SIZE THRESHOLD. The owner has not set it;
//              these defaults are the decision doc's suggestion (see lib/
//              funder-reference/derive.ts). They are recorded on every run.

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { archiveProvider, readIndex } from "../lib/funder-reference/sources";
import { DEFAULT_THRESHOLD } from "../lib/funder-reference/derive";
import { runPipeline } from "../lib/funder-reference/pipeline";
import { pgliteSink, supabaseSink, type Sink } from "../lib/funder-reference/sink";
import type { IndexRow } from "../lib/funder-reference/document";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

// A line in the run diary, and the reason for every exit. A process that dies with no
// error and no summary is one of: killed from outside (nothing in-process can see
// SIGKILL), or exited by itself. The diary tells them apart: a kill leaves no exit line.
let diaryPath: string | null = null;
let lastProgress = "(nothing logged yet)";
let finished = false;
function note(event: string, text: string) {
  const line = `${new Date().toISOString()} pid=${process.pid} EVENT=${event} ${text}`;
  if (diaryPath) {
    try {
      appendFileSync(diaryPath, line + "\n");
    } catch {
      // the diary must never be the reason a run stops
    }
  }
}
function progress(s: string) {
  lastProgress = s;
  console.log(s);
  note("progress", s.replace(/\n/g, " "));
}
function startDiary(workDir: string) {
  diaryPath = join(workDir, "run-diary.log");
  if (existsSync(diaryPath)) {
    const lines = readFileSync(diaryPath, "utf8").split("\n").filter(Boolean);
    const last = lines[lines.length - 1] ?? "";
    if (last && !/EVENT=(exit|finished)\b/.test(last)) {
      console.warn(
        `WARNING: the previous run left no exit line, so it was killed without notice (the out-of-memory killer, SIGKILL or a container restart). Its last words were:\n  ${last}`
      );
    }
  }
  const heapGb = getHeapStatistics().heap_size_limit / 1073741824;
  note("start", `node ${process.version} heap limit ${heapGb.toFixed(1)} GB, machine memory ${(totalmem() / 1073741824).toFixed(1)} GB (${(freemem() / 1073741824).toFixed(1)} GB free)`);
  console.log(`memory: heap limit ${heapGb.toFixed(1)} GB; machine ${(totalmem() / 1073741824).toFixed(1)} GB, ${(freemem() / 1073741824).toFixed(1)} GB free`);
  if (heapGb < 8) {
    console.warn("WARNING: Node's heap limit is under 8 GB. A full California run has needed about 5 GB; set NODE_OPTIONS=--max-old-space-size=10240 and use a machine with that much free.");
  }
  process.on("exit", (code) => {
    if (finished) return;
    const m = process.memoryUsage();
    const msg = `the loader exited before it finished, with code ${code}. Last progress: ${lastProgress} [rss ${Math.round(m.rss / 1048576)} MB, heap ${Math.round(m.heapUsed / 1048576)} MB]`;
    note("exit", msg);
    console.error(msg);
  });
  for (const [sig, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]] as const) {
    process.on(sig, () => {
      note("signal", `received ${sig}`);
      console.error(`received ${sig}: stopping. Last progress: ${lastProgress}`);
      process.exit(128 + n);
    });
  }
  process.on("uncaughtException", (e) => {
    note("uncaughtException", String((e as Error)?.stack ?? e));
    console.error("uncaughtException:", e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    note("unhandledRejection", String((e as Error)?.stack ?? e));
    console.error("unhandledRejection:", e);
    process.exit(1);
  });
}

async function main() {
  const workDir = arg("work-dir");
  const indexDir = arg("index-dir");
  if (!workDir || !indexDir) {
    console.error("usage: --work-dir <dir> --index-dir <dir> [options]; see the header of this file");
    process.exit(2);
  }
  mkdirSync(workDir, { recursive: true });
  startDiary(workDir);
  const periodYears = (arg("years") ?? "2022,2023,2024").split(",").map(Number);
  const eins = arg("ein") ? arg("ein")!.split(",").map((e) => e.replace(/\D/g, "").padStart(9, "0")) : null;
  const state = eins ? null : (arg("state") ?? "CA").toUpperCase();
  const threshold = {
    minAssetsFmvAmt: Number(arg("min-assets") ?? DEFAULT_THRESHOLD.minAssetsFmvAmt),
    minContributionsPaidPerBooksAmt: Number(arg("min-giving") ?? DEFAULT_THRESHOLD.minContributionsPaidPerBooksAmt),
  };
  const dryRun = flag("dry-run");
  const auditHeaderSample = Number(arg("audit-header-sample") ?? 0);

  // --- the target ---
  const targetArg = arg("target") ?? `pglite:${join(workDir, "db")}`;
  let sink: Sink;
  let closeDb: (() => Promise<void>) | null = null;
  if (targetArg === "supabase") {
    if (!flag("confirm-write-to-supabase")) {
      console.error("refusing: --target supabase writes to the real project; pass --confirm-write-to-supabase after migration 0084 has been applied");
      process.exit(2);
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
      process.exit(2);
    }
    if (key.startsWith("eyJ")) {
      console.warn("WARNING: SUPABASE_SERVICE_ROLE_KEY looks like a legacy JWT key (it starts eyJ). A project with legacy API keys disabled rejects it with 'Legacy API keys are disabled'; use the new secret key (sb_secret_...).");
    }
    const { createClient } = await import("@supabase/supabase-js");
    sink = supabaseSink(createClient(url, key, { auth: { persistSession: false } }) as never, "supabase");
  } else if (targetArg.startsWith("pglite:")) {
    const { openReferenceDb } = await import("./funder-reference-support");
    const { db, fresh } = await openReferenceDb(resolve(targetArg.slice("pglite:".length)));
    console.log(`target: local PostgreSQL at ${targetArg.slice(7)} (${fresh ? "created, all migrations applied" : "existing"})`);
    sink = pgliteSink(db);
    closeDb = () => db.close();
  } else {
    console.error(`unknown --target ${targetArg}`);
    process.exit(2);
  }

  // --- the index ---
  const files = readdirSync(indexDir).filter((f) => /^index_\d{4}\.csv$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no index_YYYY.csv files in ${indexDir}`);
  const rows: IndexRow[] = [];
  const sources: unknown[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = join(indexDir, f);
    const { rows: got, totalRows } = await readIndex(path, { returnType: "990PF", periodYears, eins });
    let added = 0;
    for (const r of got) {
      if (seen.has(r.objectId)) continue; // an object appears in one index; guard anyway
      seen.add(r.objectId);
      rows.push(r);
      added++;
    }
    sources.push({ kind: "irs_index", file: f, bytes: statSync(path).size, sha256: await sha256File(path), total_rows: totalRows, rows_selected: added });
    console.log(`index ${f}: ${totalRows} rows, ${added} Form 990-PF return(s) with a period ending in ${periodYears.join("/")}${eins ? ` for ${eins.join(",")}` : ""}`);
  }

  const provider = archiveProvider({
    dir: arg("archives-dir") ?? null,
    remote: flag("remote"),
    userAgent: "FundraisingAI-funder-reference-loader/1.0 (offline loader for public IRS returns)",
  });

  const summary = await runPipeline(sink, provider, { periodYears, state, eins, threshold, workDir, rows, sources, dryRun, auditHeaderSample }, progress);

  console.log("\n=== run summary ===");
  console.log(`run ${summary.runId}${dryRun ? " (DRY RUN, nothing written)" : ""} in ${summary.seconds.toFixed(1)}s`);
  console.log(JSON.stringify(summary.counts, null, 2));
  console.log(`rejected (unread) filings: ${summary.rejected.length}`);
  for (const r of summary.rejected.slice(0, 50)) console.log(`  ${r.object_id} EIN ${r.ein}: ${r.reason}`);
  if (summary.rejected.length > 50) console.log(`  ... and ${summary.rejected.length - 50} more (all are in funder_reference_runs.rejected_filings)`);
  if (!summary.counts.outcomes_sum_check) {
    console.error("OUTCOMES DO NOT ADD UP to the rows considered -- this is a loader defect; do not trust the counts");
    process.exitCode = 1;
  }
  if (closeDb) await closeDb();
  finished = true;
  note("finished", `run ${summary.runId} completed in ${summary.seconds.toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  note("exit", `main failed: ${String((e as Error)?.stack ?? e)}`);
  finished = true;
  process.exit(1);
});
