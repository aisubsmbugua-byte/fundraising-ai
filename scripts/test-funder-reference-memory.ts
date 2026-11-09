// Item 114, authorized by ruling 0046 clause 1: tests for the loader's memory fix.
//
// FOR THE OWNER. The loader used to need about 5.8 GB to load California (and grew by
// roughly 100 KB for every return it read). It now needs about 1.7 GB with a local test
// database and less than that against the hosted one. This suite holds that line:
//   * the pieces of the fix do what they say and change no value (the CSV reader gives
//     the same fields as before on thousands of generated lines, the archive reader
//     lists only the members asked for and reads them identically, and a copied string
//     is the same characters);
//   * a synthetic load of 2,500 returns completes inside a 96 MB heap, which it cannot
//     do if the loader keeps even one small piece of each return alive (this is the
//     regression test for the cause, not just the symptom);
//   * the acceptance test: the loader, on a real state from the real IRS files, under
//     `node --max-old-space-size=1536`, against a real local PostgreSQL, finishes, with
//     its peak memory measured and asserted below 2 GB. It is skipped, and says so, on a
//     machine that does not hold the IRS files (set IRS_DATA_DIR; IRS_WORK_DIR lets it
//     reuse an existing header cache so it takes seconds, not many minutes).
//
// Usage: npx tsx scripts/test-funder-reference-memory.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_THRESHOLD } from "../lib/funder-reference/derive";
import { DEFAULT_MAX_RETURN_BYTES, DEFAULT_MAX_WRITE_BYTES, runPipeline } from "../lib/funder-reference/pipeline";
import { archiveProvider, parseCsvLine, readIndex, readIndexEach } from "../lib/funder-reference/sources";
import { detach } from "../lib/funder-reference/strings";
import { KEEP_NONE, fileSource, openZip } from "../lib/funder-reference/zip";
import type { Sink } from "../lib/funder-reference/sink";
import { makeZip } from "./funder-reference-test-support";

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

const root = join(__dirname, "..");
const FIX = join(__dirname, "fixtures/funder-reference");
const X23 = readFileSync(join(FIX, "202403209349107935_public.xml"), "utf8");

// The reader as it was before the fix, kept here as the oracle the fast path must agree with on every line.
function parseCsvLineOriginal(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function main() {
  // =========================================================================
  section("1. detach(): a small string that does not hold a whole document alive");
  {
    ok("it returns the same characters", detach("2023-05-04T12:34:56-05:00") === "2023-05-04T12:34:56-05:00" && detach("short") === "short" && detach(null) === null);
    ok("it preserves a lone surrogate (a numeric character reference can produce one), unlike a round trip through bytes", detach("\ud800abcdefghijklmnop") === "\ud800abcdefghijklmnop");
    ok("it preserves non-Latin text", detach("Fundación Ñandú — 基金会 foundation") === "Fundación Ñandú — 基金会 foundation");
    // measured in a child process with the collector exposed: 2,000 slices of a 40 MB string, the string dropped
    const heap = (useDetach: boolean) => {
      // built inside a function so no stale local still points at the 40 MB string when the collector runs
      const code = `
        const { detach } = require(${JSON.stringify(join(root, "lib/funder-reference/strings.ts"))});
        function make() {
          const big = "x".repeat(40_000_000);
          const kept = [];
          for (let i = 0; i < 2000; i++) kept.push(${useDetach ? "detach(big.slice(i, i + 25))" : "big.slice(i, i + 25)"});
          return kept;
        }
        const kept = make(); global.gc(); global.gc();
        console.log(Math.round(process.memoryUsage().heapUsed / 1048576), kept.length);`;
      const r = spawnSync(process.execPath, ["--expose-gc", ...process.execArgv, "-e", code], { encoding: "utf8" });
      return Number(String(r.stdout).trim().split("\n").pop()!.split(" ")[0]);
    };
    const kept = heap(false);
    const detached = heap(true);
    ok(`kept slices hold the 40 MB source alive (measured ${kept} MB), detached copies do not (measured ${detached} MB)`, kept > 35 && detached < 15, `sliced ${kept} MB, detached ${detached} MB`);
  }

  // =========================================================================
  section("2. the CSV reader: the faster path gives exactly the fields the old one gave");
  {
    let seed = 20261109;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = ['a', 'B', ' ', ',', '"', '"', 'x', '1', '9', '-', "'", ",", "é"];
    let same = 0;
    let withQuote = 0;
    const bad: string[] = [];
    for (let n = 0; n < 6000; n++) {
      let line = "";
      const len = Math.floor(rnd() * 40);
      for (let i = 0; i < len; i++) line += alphabet[Math.floor(rnd() * alphabet.length)];
      if (line.includes('"')) withQuote++;
      if (JSON.stringify(parseCsvLine(line)) === JSON.stringify(parseCsvLineOriginal(line))) same++;
      else if (bad.length < 3) bad.push(JSON.stringify(line));
    }
    ok(`6,000 generated lines (${withQuote} with quotes) give identical fields`, same === 6000, bad.join(" | "));
    const real = `13,EFILE,582218044,202412,2025,"SERVANT'S HEART FOUNDATION, INC ""THE""",990PF,93491012441234,202543159349101244,2025_TEOS_XML_11B`;
    ok("a quoted comma and a doubled quote still come out as before", parseCsvLine(real)[5] === `SERVANT'S HEART FOUNDATION, INC "THE"` && parseCsvLine(real).length === 10);
    ok("a plain line is cut at its commas, an empty field kept", parseCsvLine("a,,c,").join("|") === "a||c|");

    const dir = mkdtempSync(join(tmpdir(), "fr-mem-"));
    const csv = join(dir, "index_2024.csv");
    writeFileSync(csv, ["RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID", `1,EFILE,5,202312,2024,A FUND,990PF,d,202400000000000001,2024_TEOS_XML_05a`, `2,EFILE,6,202312,2024,B FUND,990T,d,202400000000000002,2024_TEOS_XML_05A`].join("\n") + "\n");
    const a = await readIndex(csv, { returnType: "990PF", periodYears: [2023], eins: null });
    const each: unknown[] = [];
    const b = await readIndexEach(csv, { returnType: "990PF", periodYears: [2023], eins: null }, (r) => void each.push(r));
    ok("readIndexEach hands over exactly the rows readIndex returns", JSON.stringify(a.rows) === JSON.stringify(each) && a.totalRows === b.totalRows && each.length === 1);
    ok("the values are unchanged (padded EIN, canonical archive name)", (each[0] as { ein: string; batchId: string }).ein === "000000005" && (each[0] as { batchId: string }).batchId === "2024_TEOS_XML_05A");
    rmSync(dir, { recursive: true, force: true });
  }

  // =========================================================================
  section("3. the archive reader: list only the members asked for, read them exactly as before");
  {
    const dir = mkdtempSync(join(tmpdir(), "fr-mem-zip-"));
    const items = Array.from({ length: 12 }, (_, i) => ({ name: `2024_TEOS_XML_11A/2024000000000000${String(10 + i)}_public.xml`, data: Buffer.from(`<Return>${i}-${"x".repeat(50 * i)}</Return>`) }));
    for (const [label, opts] of [["plain", {}], ["ZIP64 with bytes before the archive", { zip64: true, prefixBytes: 76 }]] as const) {
      const path = join(dir, `${label.replace(/\W/g, "")}.zip`);
      writeFileSync(path, makeZip(items, opts));
      const full = await openZip(await fileSource(path));
      const part = await openZip(await fileSource(path), { keep: (n) => /\/2024000000000000(10|11|12|13)_public\.xml$/.test(n) });
      const none = await openZip(await fileSource(path), { keep: KEEP_NONE });
      ok(`${label}: an unfiltered open lists every member`, full.entries.length === 12);
      ok(`${label}: with keep, only the members asked for are listed`, part.entries.length === 4 && part.entries.every((e) => /(10|11|12|13)_public\.xml$/.test(e.name)), part.entries.map((e) => e.name).join());
      ok(`${label}: a kept member is identical to the one an unfiltered open gives (offsets, sizes, checksum)`, part.entries.every((e) => JSON.stringify(e) === JSON.stringify(full.find(e.name))));
      ok(`${label}: findObject answers for a kept member and not for one that was not kept`, !!part.findObject("202400000000000010") && !part.findObject("202400000000000015"));
      ok(`${label}: KEEP_NONE lists nothing`, none.entries.length === 0);
      const e = full.find(items[7].name)!;
      ok(`${label}: a member read through a keep-nothing archive, from the entry an earlier open gave, is the same bytes`, Buffer.from(await none.read(e)).equals(items[7].data));
      await full.close();
      await part.close();
      await none.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // =========================================================================
  section("4. the pass-A cache is per state: one state's verdict is never used for another");
  {
    const world = mkdtempSync(join(tmpdir(), "fr-mem-cache-"));
    const archives = join(world, "zips");
    mkdirSync(archives);
    // one return whose header the cheap look cannot read (so EVERY state reads it whole), in California
    const odd = X23.replace("<Filer>", "<Filer >").replace("</Filer>", "</Filer >");
    writeFileSync(join(archives, "2024_TEOS_XML_11A.zip"), makeZip([{ name: "2024_TEOS_XML_11A/202400000000000201_public.xml", data: Buffer.from(odd) }]));
    const row = { returnId: "1", ein: "582218044", taxPeriod: "202312", subYear: 2024, taxpayerName: "X", returnType: "990PF", objectId: "202400000000000201", batchId: "2024_TEOS_XML_11A", indexFile: "index_2024.csv" };
    const provider = archiveProvider({ dir: archives, remote: false, userAgent: "t" });
    const nothing = {} as Sink; // a dry run never touches the sink
    const run = (state: string) => runPipeline(nothing, provider, { periodYears: [2022, 2023, 2024], state, eins: null, threshold: DEFAULT_THRESHOLD, workDir: join(world, "work"), rows: [row], sources: [], dryRun: true }, () => undefined);
    const ca1 = await run("CA");
    ok("California reads it whole and finds it in California", ca1.counts.pass_a_cache_hits === 0 && ca1.counts.out_of_scope_state === 0 && ca1.counts.foundations_in_scope === 1, JSON.stringify(ca1.counts));
    const tx1 = await run("TX");
    ok("Texas, in the same work directory, does NOT take California's record: it reads the return itself and finds it out of state", tx1.counts.pass_a_cache_hits === 0 && tx1.counts.out_of_scope_state === 1 && tx1.counts.foundations_in_scope === 0, JSON.stringify({ hits: tx1.counts.pass_a_cache_hits, out: tx1.counts.out_of_scope_state, scope: tx1.counts.foundations_in_scope }));
    const ca2 = await run("CA");
    ok("a second California run replays its own record", ca2.counts.pass_a_cache_hits === 1 && ca2.counts.foundations_in_scope === 1);
    const tx2 = await run("TX");
    ok("a second Texas run replays Texas's own record", tx2.counts.pass_a_cache_hits === 1 && tx2.counts.out_of_scope_state === 1);
    const cache = readFileSync(join(world, "work", "pass-a-cache.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { state: string | null });
    ok("every cache record names the state it was made for", cache.length === 2 && cache.map((c) => c.state).sort().join() === "CA,TX");
    rmSync(world, { recursive: true, force: true });
  }

  // =========================================================================
  section("5. the cause, not just the symptom: 2,500 returns (134 MB of XML) load with a 96 MB old-space limit");
  {
    const world = mkdtempSync(join(tmpdir(), "fr-mem-heap-"));
    const archives = join(world, "zips");
    const index = join(world, "index");
    const work = join(world, "work");
    mkdirSync(archives);
    mkdirSync(index);
    const N = 2500;
    const items = Array.from({ length: N }, (_, i) => ({ name: `2024_TEOS_XML_11A/2024${String(i).padStart(14, "0")}_public.xml`, data: Buffer.from(X23) }));
    writeFileSync(join(archives, "2024_TEOS_XML_11A.zip"), makeZip(items));
    const H = "RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID";
    writeFileSync(join(index, "index_2024.csv"), [H, ...items.map((_, i) => `${i},EFILE,582218044,202312,2024,SERVANT'S HEART FOUNDATION INC,990PF,d${i},2024${String(i).padStart(14, "0")},2024_TEOS_XML_11A`)].join("\n") + "\n");
    const resultFile = join(world, "result.json");
    const t0 = Date.now();
    const r = spawnSync(
      process.execPath,
      [...process.execArgv, join(root, "scripts/load-funder-reference.ts"), "--work-dir", work, "--index-dir", index, "--archives-dir", archives, "--state", "CA", "--years", "2022,2023,2024", "--target", "none", "--dry-run", "--result-file", resultFile],
      { encoding: "utf8", cwd: root, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=96" }, maxBuffer: 64 * 1024 * 1024 }
    );
    const data = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as { ok: boolean; counts: { full_reads: number; foundations_in_scope: number }; peak_rss_mb: number; heap_limit_mb: number }) : null;
    ok(`the loader reads ${N} returns (${Math.round((N * X23.length) / 1e6)} MB of XML) inside a 96 MB old-space limit and finishes (${Math.round((Date.now() - t0) / 1000)} s)`, r.status === 0 && !!data && data.ok && data.counts.full_reads === N && data.counts.foundations_in_scope === 1, `${r.status} ${String(r.stderr).slice(-400)}`);
    ok("the heap limit that test ran under was a few hundred MB at most, not the default 4 GB", !!data && data.heap_limit_mb >= 90 && data.heap_limit_mb <= 400, String(data?.heap_limit_mb));
    rmSync(world, { recursive: true, force: true });
  }

  // =========================================================================
  section("5b. a return too big to read in the loader's memory, or to write in one database call, is recorded as unread with the reason");
  {
    const world = mkdtempSync(join(tmpdir(), "fr-mem-big-"));
    const archives = join(world, "zips");
    mkdirSync(archives);
    writeFileSync(join(archives, "2024_TEOS_XML_11A.zip"), makeZip([{ name: "2024_TEOS_XML_11A/202400000000000301_public.xml", data: Buffer.from(X23) }]));
    const row = { returnId: "1", ein: "582218044", taxPeriod: "202312", subYear: 2024, taxpayerName: "X", returnType: "990PF", objectId: "202400000000000301", batchId: "2024_TEOS_XML_11A", indexFile: "index_2024.csv" };
    const provider = archiveProvider({ dir: archives, remote: false, userAgent: "t" });
    const run = (over: { maxReturnBytes?: number; maxWriteBytes?: number }) => runPipeline({} as Sink, provider, { periodYears: [2022, 2023, 2024], state: "CA", eins: null, threshold: DEFAULT_THRESHOLD, workDir: join(world, `work-${Math.random()}`), rows: [row], sources: [], dryRun: true, ...over }, () => undefined);
    const normal = await run({});
    ok("with the default limits a normal return (54 KB) is loaded", normal.counts.status_loaded === 1 && normal.counts.status_unread === 0 && DEFAULT_MAX_RETURN_BYTES === 64_000_000 && DEFAULT_MAX_WRITE_BYTES === 16_000_000, JSON.stringify(normal.counts));
    const bigRead = await run({ maxReturnBytes: 10_000 });
    ok("a return over the read limit is recorded as unread, not parsed, with its size and the limit in the reason", bigRead.counts.status_unread === 1 && bigRead.counts.status_loaded === 0 && /MB of XML, over the loader's \d+ MB limit for reading one return/.test(bigRead.rejected[0]?.reason ?? ""), JSON.stringify(bigRead.rejected));
    ok("its outcomes still add up to the returns considered", bigRead.counts.outcomes_sum_check === true);
    const bigWrite = await run({ maxWriteBytes: 5_000 });
    ok("a filing whose write document is over the write limit is recorded as unread, with the grant count, size and limit in the reason", bigWrite.counts.status_unread === 1 && bigWrite.counts.status_loaded === 0 && /lists \d+ grants and \d+ people; its write document is [\d.]+ MB, over the loader's \d+ MB limit for one database call/.test(bigWrite.rejected[0]?.reason ?? ""), JSON.stringify(bigWrite.rejected));
    ok("its outcomes add up, and the funder's coverage says the year is unread, not absent", bigWrite.counts.outcomes_sum_check === true && bigWrite.coverage.some((c) => c.status === "unread"), JSON.stringify(bigWrite.coverage.map((c) => c.status)));
    rmSync(world, { recursive: true, force: true });
  }

  // =========================================================================
  section("6. acceptance: a real state from the real IRS files, a real local PostgreSQL, a hard 1536 MB heap");
  {
    const data = process.env.IRS_DATA_DIR ?? join(homedir(), "irs-data");
    const state = (process.env.FUNDER_MEMORY_TEST_STATE ?? "MN").toUpperCase();
    const have = existsSync(join(data, "index", "index_2024.csv")) && existsSync(join(data, "zips", "2024_TEOS_XML_11A.zip"));
    if (!have) {
      skipped++;
      console.log(`SKIP: the real IRS files are not at ${data} (set IRS_DATA_DIR); the acceptance test did not run on this machine`);
    } else {
      const scratch = mkdtempSync(join(tmpdir(), "fr-mem-real-"));
      const cacheSrc = join(process.env.IRS_WORK_DIR ?? join(homedir(), "irs-work"), "header-scan-cache.jsonl");
      // Reuses an existing header cache (read only, copied) when one exists; otherwise the run scans every header itself, which is slow but correct.
      if (existsSync(cacheSrc)) copyFileSync(cacheSrc, join(scratch, "header-scan-cache.jsonl"));
      const resultFile = join(scratch, "result.json");
      const t0 = Date.now();
      const r = spawnSync(
        process.execPath,
        [...process.execArgv, join(root, "scripts/load-funder-reference.ts"), "--work-dir", scratch, "--index-dir", join(data, "index"), "--archives-dir", join(data, "zips"), "--state", state, "--years", "2022,2023,2024", "--audit-header-sample", "300", "--target", `pglite:${join(scratch, "db")}`, "--result-file", resultFile],
        { encoding: "utf8", cwd: root, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1536" }, maxBuffer: 256 * 1024 * 1024, timeout: 3_600_000 }
      );
      const res = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as { ok: boolean; outcomes_sum_check: boolean; peak_rss_mb: number; heap_limit_mb: number; counts: { index_rows_considered: number; foundations_in_scope: number; status_loaded: number; rows_written: number } }) : null;
      console.log(`      state ${state}: ${res?.counts.status_loaded ?? "?"} filings loaded for ${res?.counts.foundations_in_scope ?? "?"} funders in ${Math.round((Date.now() - t0) / 1000)} s; peak resident memory ${res?.peak_rss_mb ?? "?"} MB under a ${res?.heap_limit_mb ?? "?"} MB heap limit`);
      ok(`the loader finishes ${state} under node --max-old-space-size=1536 (exit ${r.status})`, r.status === 0 && !!res && res.ok, String(r.stderr).slice(-500));
      ok("its heap limit really was the 1536 MB set (Node reports the old-space limit plus its young generation)", !!res && res.heap_limit_mb >= 1500 && res.heap_limit_mb <= 1700, String(res?.heap_limit_mb));
      ok("the outcomes add up to the returns considered", !!res && res.outcomes_sum_check === true);
      ok(`its peak resident memory (${res?.peak_rss_mb} MB, with the local database's own ~0.9 GB included) stays under 2 GB`, !!res && res.peak_rss_mb < 2048, String(res?.peak_rss_mb));
      ok("it stored something (the state is not empty)", !!res && res.counts.rows_written > 0);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} section skipped (no real IRS files on this machine)` : ""}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(`FAIL: the test run crashed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  process.exit(1);
});
