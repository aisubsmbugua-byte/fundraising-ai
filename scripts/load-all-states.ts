// Item 114, authorized by ruling 0046: load EVERY state's funders from the IRS
// filings, unattended, and keep them current.
//
// FOR THE OWNER. One command, run on the server (by the schedule or by hand). For each
// state, biggest first (New York, Texas, Florida, Pennsylvania, Illinois, then the rest
// by number of returns) it:
//   1. skips the state if it is already complete for the filings the IRS index lists
//      today (so running it again, or after a stop, repeats nothing);
//   2. otherwise loads the state in its own process (so the memory it used is given
//      back before the next state), trying again after a pause if that process
//      fails, up to 3 times, and carrying on with the other states if it never works;
//   3. then checks a repeatable sample of 150 of that state's funders (always the 10 with
//      the most grant rows and the 10 with the most people rows) against the IRS
//      filings themselves, with the independent checker;
//   4. a difference is "explained" only if a written, dated entry in
//      lib/funder-reference/verify-exceptions.json describes it; anything else
//      STOPS the whole run before the next state and is shown in the run record.
// It writes what it is doing to the database as it goes (the standing row in
// funder_reference_runs, and a note on each state's own run), so the last thing it did
// can be read without the server. It sends nothing to anyone and writes only the
// shared reference tables and their run records (ruling 0045).
//
// Exit codes: 0 every requested state is complete; 1 stopped on an unexplained
// difference or an unsound load (nothing after it was touched); 3 finished but at least
// one state failed to load after its retries; 2 bad command line or configuration;
// 4 another copy is already running.
//
// Usage (paths absolute; the project folder name has spaces, quote it):
//   npx tsx scripts/load-all-states.ts --work-dir <dir> --index-dir <dir> --archives-dir <dir> \
//     --target pglite:<dir>|supabase [--confirm-write-to-supabase] \
//     [--states CA,NY] [--years 2022,2023,2024] [--dry-run] \
//     [--sample 150] [--seed <text>] [--full-verify] [--max-attempts 3] [--stall-minutes 30] \
//     [--exceptions <file>] [--min-assets N] [--min-giving N] [--audit-header-sample 3000] \
//     [--allow-missing-archives]
//   --states     only these states (they still run in the usual order)
//   --dry-run    print what would be done for each state and why; run nothing, write nothing
//   --full-verify  check every funder of each state, not a sample
// With --target supabase the key is read from SUPABASE_SERVICE_ROLE_KEY in the
// environment (the server's service file supplies it) and is never printed or written.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_THRESHOLD } from "../lib/funder-reference/derive";
import { LOADER_VERSION } from "../lib/funder-reference/document";
import { streamScanCache } from "../lib/funder-reference/pipeline";
import { SUPERVISOR_RUN_ID, pgliteRunStore, supabaseRunStore } from "../lib/funder-reference/run-store";
import { IRS_ARCHIVES, readIndexEach } from "../lib/funder-reference/sources";
import {
  ALL_STATES_VERSION,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_SAMPLE_SEED,
  DEFAULT_SAMPLE_SIZE,
  orderStates,
  parseVerifierOutput,
  runAllStates,
  StateDigests,
  validateExceptions,
  type ChildResult,
  type Deps,
  type Manifest,
  type Store,
  type VerifierResult,
} from "../lib/funder-reference/supervisor";

const root = join(__dirname, "..");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
function die(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// child processes
// ---------------------------------------------------------------------------
let activeChild: ReturnType<typeof spawn> | null = null;

/** Runs one of this repo's scripts in its own process under the same loader (tsx) and memory settings as this one. */
function runScript(script: string, args: string[], opts: { logFile: string; stallMs: number }): Promise<{ code: number | null; signal: string | null; stalled: boolean; tail: string[] }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...process.execArgv, join(root, "scripts", script), ...args], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    const tail: string[] = [];
    let stalled = false;
    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        log(`${script}: no output for ${Math.round(opts.stallMs / 60000)} minute(s); stopping it`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
      }, opts.stallMs);
    };
    arm();
    const sink = (b: Buffer) => {
      arm();
      try {
        appendFileSync(opts.logFile, b);
      } catch {
        // a log must never be the reason a run stops
      }
      for (const l of b.toString("utf8").split("\n")) if (l.trim()) tail.push(l.slice(0, 300));
      while (tail.length > 12) tail.shift();
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, signal: null, stalled, tail: [...tail, `could not start: ${e.message}`] });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      activeChild = null;
      done({ code, signal, stalled, tail });
    });
  });
}

// ---------------------------------------------------------------------------
async function main() {
  const workDir = arg("work-dir") ? resolve(arg("work-dir")!) : undefined;
  const indexDir = arg("index-dir") ? resolve(arg("index-dir")!) : undefined;
  const archivesDir = arg("archives-dir") ? resolve(arg("archives-dir")!) : undefined;
  const target = arg("target");
  if (!workDir || !indexDir || !archivesDir || !target) die(2, "usage: --work-dir <dir> --index-dir <dir> --archives-dir <dir> --target pglite:<dir>|supabase  (see the header of scripts/load-all-states.ts)");
  const dryRun = flag("dry-run");
  const years = (arg("years") ?? "2022,2023,2024").split(",").map(Number);
  const threshold = { minAssetsFmvAmt: Number(arg("min-assets") ?? DEFAULT_THRESHOLD.minAssetsFmvAmt), minContributionsPaidPerBooksAmt: Number(arg("min-giving") ?? DEFAULT_THRESHOLD.minContributionsPaidPerBooksAmt) };
  const sampleSize = Number(arg("sample") ?? DEFAULT_SAMPLE_SIZE);
  const seed = arg("seed") ?? DEFAULT_SAMPLE_SEED;
  const maxAttempts = Number(arg("max-attempts") ?? DEFAULT_MAX_ATTEMPTS);
  const stallMs = Number(arg("stall-minutes") ?? 30) * 60_000;
  const auditSample = Number(arg("audit-header-sample") ?? 3000);
  if (![sampleSize, maxAttempts, stallMs, auditSample].every((n) => Number.isFinite(n) && n >= 0) || maxAttempts < 1 || years.some((y) => !Number.isInteger(y))) die(2, "a numeric option is not a number");

  // ---- the exception list: malformed means refuse (an unreadable list must not read as "everything is explained") ----
  const exceptionsPath = resolve(arg("exceptions") ?? join(root, "lib/funder-reference/verify-exceptions.json"));
  let exceptionsText: string;
  try {
    exceptionsText = readFileSync(exceptionsPath, "utf8");
  } catch {
    return die(2, `cannot read the exception list ${exceptionsPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(exceptionsText);
  } catch (e) {
    return die(2, `the exception list is not valid JSON: ${(e as Error).message}`);
  }
  const ex = validateExceptions(parsed);
  if (!ex.ok) return die(2, `the exception list is not valid:\n  ${ex.problems.join("\n  ")}`);
  const exceptionsSha = createHash("sha256").update(exceptionsText).digest("hex");

  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(workDir, "logs"), { recursive: true });
  mkdirSync(join(workDir, "results"), { recursive: true });

  // ---- one copy at a time ----
  const lock = join(workDir, "all-states.lock");
  if (!dryRun) {
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8").trim());
      let alive = false;
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        alive = false;
      }
      if (alive && pid !== process.pid) return die(4, `another copy of this command is running (process ${pid}); not starting a second`);
    }
    writeFileSync(lock, String(process.pid));
    const unlock = () => {
      try {
        if (readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock);
      } catch {
        // already gone
      }
    };
    process.on("exit", unlock);
  }

  // ---- the target ----
  let store: Store;
  const childTargetArgs: string[] = ["--target", target!];
  if (target === "supabase") {
    if (!flag("confirm-write-to-supabase")) die(2, "refusing: --target supabase writes to the real project; pass --confirm-write-to-supabase");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) die(2, "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
    if (!key!.startsWith("sb_secret_")) die(2, "SUPABASE_SERVICE_ROLE_KEY is not a new-style secret key (it must start sb_secret_).");
    const { createClient } = await import("@supabase/supabase-js");
    store = supabaseRunStore(createClient(url!, key!, { auth: { persistSession: false } }) as never);
    childTargetArgs.push("--confirm-write-to-supabase");
  } else if (target!.startsWith("pglite:")) {
    const dir = resolve(target!.slice(7));
    const { openReferenceDb } = await import("./funder-reference-support");
    store = pgliteRunStore(async () => (await openReferenceDb(dir)).db as never, target);
    childTargetArgs[1] = `pglite:${dir}`;
  } else {
    return die(2, `unknown --target ${target}`);
  }

  // ---- which states exist, and what each one's input is: from the index and the header cache ----
  const loaderCommon = ["--work-dir", workDir, "--index-dir", indexDir, "--archives-dir", archivesDir, "--years", years.join(","), "--min-assets", String(threshold.minAssetsFmvAmt), "--min-giving", String(threshold.minContributionsPaidPerBooksAmt)];
  const indexFiles = readdirSync(indexDir).filter((f) => /^index_\d{4}\.csv$/.test(f)).sort();
  if (!indexFiles.length) return die(2, `no index_YYYY.csv files in ${indexDir}`);

  // One light map from the header cache (object id -> state; "" a foreign address; "?" a header that could not be read),
  // then the index is streamed through it. Nothing is kept per return beyond that map, because this process lives for the
  // whole run and the loader's own memory is given back after every state.
  const scanCache = join(workDir, "header-scan-cache.jsonl");
  const readStates = (): Map<string, string> => {
    const m = new Map<string, string>();
    streamScanCache(scanCache, (r) => m.set(r.objectId, r.ein === null ? "?" : (r.state ?? "")));
    return m;
  };
  async function walkIndex(each: (objectId: string, batchId: string | null) => void): Promise<number> {
    let n = 0;
    for (const f of indexFiles)
      await readIndexEach(join(indexDir!, f), { returnType: "990PF", periodYears: years, eins: null }, (r) => {
        n++;
        each(r.objectId, r.batchId);
      });
    return n;
  }
  let stateOf = readStates();
  const batches = new Set<string>();
  let unscanned = 0;
  const total = await walkIndex((id, batch) => {
    if (batch) batches.add(batch);
    if (!stateOf.has(id)) unscanned++;
  });
  log(`the IRS index lists ${total} Form 990-PF return(s) with a period ending in ${years.join("/")}`);

  // every archive the index points at must be on this disk, or the run would record real returns as "not found"
  const known = new Set(Object.values(IRS_ARCHIVES).flat());
  const missing = [...batches].filter((b) => known.has(b) && !existsSync(join(archivesDir!, `${b}.zip`))).sort();
  if (missing.length && !flag("allow-missing-archives")) {
    return die(2, `${missing.length} IRS archive(s) the index points at are not in ${archivesDir}: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}. Download them first (scripts/fetch-funder-reference-sources.ts), or pass --allow-missing-archives.`);
  }

  if (unscanned > 0) {
    if (dryRun) {
      log(`dry run: ${unscanned} return(s) have no header record yet; a real run would read them first (a few minutes per 100,000)`);
    } else {
      log(`reading the first bytes of ${unscanned} return(s) to learn which state each is in ...`);
      const r = await runScript("load-funder-reference.ts", ["--scan-headers-only", ...loaderCommon], { logFile: join(workDir, "logs", "header-scan.log"), stallMs });
      if (r.code !== 0) return die(1, `the header scan failed (exit ${r.code}${r.signal ? ", " + r.signal : ""}); last lines:\n  ${r.tail.join("\n  ")}`);
      stateOf = readStates();
      let still = 0;
      await walkIndex((id) => void (stateOf.has(id) || still++));
      // an index row whose return is in no archive has no header to read; the loader records it as unread
      if (still > 0) log(`${still} return(s) are in no archive on this disk and have no header record; the loader records each as unread`);
    }
  }
  const digester = new StateDigests();
  await walkIndex((id) => {
    const v = stateOf.get(id);
    digester.add(id, v === undefined || v === "?" || v === "" ? null : v, v !== undefined && v !== "?");
  });
  const digests = digester.result();
  const returnsByState = Object.fromEntries(Object.entries(digests).map(([s, d]) => [s, d.rows]));
  // the header records are no longer needed: give the memory back before the long run
  stateOf = new Map();
  let states = orderStates(returnsByState);
  const wanted = arg("states")?.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted) {
    const unknown = wanted.filter((s) => !states.includes(s));
    if (unknown.length) return die(2, `no returns in the IRS index for: ${unknown.join(", ")}`);
    states = states.filter((s) => wanted.includes(s));
  }
  log(`${states.length} state(s) to consider, in this order: ${states.join(" ")}`);

  // ---- the manifest: a note in the work directory of how far each state got ----
  const manifestPath = join(workDir, "all-states-manifest.json");
  const readManifest = (): Manifest => {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest & { target?: string };
      return m.target === target ? m : { states: {} };
    } catch {
      return { states: {} };
    }
  };
  const writeManifest = (m: Manifest) => writeFileSync(manifestPath, JSON.stringify({ ...m, target, command: ALL_STATES_VERSION }, null, 1));

  let lastSnapshot: { counts: Record<string, unknown>; notes: string; parameters: Record<string, unknown> } | null = null;
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, async () => {
      console.error(`received ${sig}: stopping; the next start resumes where this stopped`);
      activeChild?.kill("SIGTERM");
      try {
        if (lastSnapshot && !dryRun) await store.writeSupervisor({ status: "interrupted", ...lastSnapshot, notes: `stopped by ${sig}; the next start resumes (${lastSnapshot.notes})` });
      } catch {
        // the stop must not hang on the database
      }
      process.exit(sig === "SIGTERM" ? 143 : 130);
    });

  const deps: Deps = {
    store,
    onPublish: (snap) => void (lastSnapshot = snap),
    readManifest,
    writeManifest,
    now: () => new Date(),
    log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async runChild(state, attempt): Promise<ChildResult> {
      const resultFile = join(workDir, "results", `${state}-${attempt}.json`);
      rmSync(resultFile, { force: true });
      log(`${state}: loading (attempt ${attempt} of ${maxAttempts}) ...`);
      const r = await runScript(
        "load-funder-reference.ts",
        ["--state", state, ...loaderCommon, "--audit-header-sample", String(auditSample), ...childTargetArgs, "--result-file", resultFile],
        { logFile: join(workDir, "logs", `${state}-${attempt}.log`), stallMs }
      );
      let res: { ok?: boolean; run_id?: string; peak_rss_mb?: number; seconds?: number; error?: string } | null = null;
      try {
        res = JSON.parse(readFileSync(resultFile, "utf8"));
      } catch {
        res = null;
      }
      // exit code 1 with a result file is a run that finished but whose outcome counts did not add up: the run is
      // recorded, and the supervisor judges it (and stops) rather than retrying a defect
      if ((r.code === 0 || r.code === 1) && res?.ok && res.run_id) {
        log(`${state}: loaded in ${Math.round(res.seconds ?? 0)} s, peak memory ${res.peak_rss_mb} MB`);
        return { ok: true, runId: res.run_id, peakRssMb: res.peak_rss_mb, seconds: res.seconds };
      }
      const why = r.stalled ? "no output for too long" : r.signal ? `killed by ${r.signal}${r.signal === "SIGKILL" ? " (probably out of memory)" : ""}` : `exit code ${r.code}`;
      const last = res?.error ? `; ${res.error}` : r.tail.length ? `; last output: ${r.tail[r.tail.length - 1]}` : "";
      log(`${state}: attempt ${attempt} failed (${why})`);
      return { ok: false, error: `${why}${last}`.slice(0, 600) };
    },
    async runVerifier(eins, state): Promise<VerifierResult> {
      log(`${state}: checking ${eins.length} funder(s) against the IRS filings ...`);
      let compared = 0;
      const lines: string[] = [];
      const label = createHash("sha1").update(eins.join(",")).digest("hex").slice(0, 8);
      const logFile = join(workDir!, "logs", `verify-${label}.log`);
      for (let i = 0; i < eins.length; i += 400) {
        // the verifier takes its funders on the command line; a long list goes in several runs
        rmSync(logFile, { force: true });
        const r = await runScript("verify-funder-reference-example.ts", ["--db", target!, "--ein", eins.slice(i, i + 400).join(","), "--archives-dir", archivesDir!], { logFile, stallMs });
        let text = "";
        try {
          text = readFileSync(logFile, "utf8");
        } catch {
          // no output at all: treated as not completed below
        }
        const p = parseVerifierOutput(text, r.code);
        if (!p.completed) return { completed: false, compared, lines, error: `the verifier ended without a result (exit ${r.code}${r.signal ? ", " + r.signal : ""})${r.stalled ? ", stalled" : ""}; last output: ${r.tail[r.tail.length - 1] ?? "none"}` };
        compared += p.compared;
        lines.push(...p.lines);
      }
      rmSync(logFile, { force: true });
      return { completed: true, compared, lines };
    },
  };

  const outcome = await runAllStates(deps, {
    states,
    digests,
    loaderVersion: LOADER_VERSION,
    years,
    threshold,
    sampleSize,
    seed,
    forceFull: flag("full-verify"),
    maxAttempts,
    exceptions: ex.entries,
    exceptionsSha256: exceptionsSha,
    dryRun,
    parameters: { states, years, threshold, sampleSize, seed, maxAttempts, auditSample, full_verify: flag("full-verify"), standing_run_id: SUPERVISOR_RUN_ID },
  });
  await store.release();

  // ---- what was decided, and how it ended ----
  if (dryRun) {
    console.log("\nDRY RUN: nothing was loaded, checked or written. What would happen:");
    for (const p of outcome.plan) console.log(`  ${p.state.padEnd(3)} ${p.action.padEnd(6)} ${p.why}`);
    return;
  }
  console.log("\nstate  status            note");
  for (const s of states) console.log(`${s.padEnd(6)} ${outcome.states[s].status.padEnd(17)} ${outcome.states[s].note ?? ""}`);
  if (outcome.halted) {
    console.error(`\nSTOPPED at ${outcome.halted.state}: ${outcome.halted.reason}\nNothing after it was touched. The state's rows are in place but recorded as NOT VERIFIED on its run.`);
  }
  process.exitCode = outcome.exitCode;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
