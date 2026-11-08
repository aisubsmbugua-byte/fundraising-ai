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

import { createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
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

async function main() {
  const workDir = arg("work-dir");
  const indexDir = arg("index-dir");
  if (!workDir || !indexDir) {
    console.error("usage: --work-dir <dir> --index-dir <dir> [options]; see the header of this file");
    process.exit(2);
  }
  mkdirSync(workDir, { recursive: true });
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

  const summary = await runPipeline(sink, provider, { periodYears, state, eins, threshold, workDir, rows, sources, dryRun, auditHeaderSample }, (s) => console.log(s));

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
