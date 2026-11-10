// Item 110 (ruling 0045): download the IRS bulk files the loader reads.
//
// Offline, resumable and polite: it fetches the IRS Form 990 e-file index CSVs
// and the monthly return archives into a directory you name, skips a file that
// is already complete (same size as the server reports), resumes a partial one
// with a Range request, and checks the final size. It never writes inside the
// repository unless you point it there, and it reads no credential.
//
// Usage:
//   npx tsx scripts/fetch-funder-reference-sources.ts --out <dir> \
//     [--years 2022,2023,2024,2025,2026] [--index-only | --zips-only] [--parallel 2] [--list]
//   --index-only  fetch only the index CSVs; --zips-only  fetch only the archives (used when the
//                 index files were just replaced whole, so they are not compared again)
//   --list   print what would be fetched with sizes, download nothing
//
// The archive names come from lib/funder-reference/sources.ts (the IRS page as
// read on 2026-11-06). A name the IRS does not serve (HTTP 404) is reported, not
// fatal.

import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { IRS_ARCHIVES, archiveUrl, indexUrl } from "../lib/funder-reference/sources";

const UA = "FundraisingAI-funder-reference-fetch/1.0 (public IRS bulk data)";
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

// Ask for the file as stored, never compressed in transit: with a compressed answer a server can
// report the size of the compressed form for a HEAD request while a GET delivers the real file.
const PLAIN = { "user-agent": UA, "accept-encoding": "identity" };

async function remoteSize(url: string): Promise<number | null> {
  const r = await fetch(url, { method: "HEAD", headers: PLAIN });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Number(r.headers.get("content-length"));
}

// An index CSV is replaced whole every time and is NOT checked against the size a HEAD request
// reports. On 2026-11-09 the IRS reported 21,699,229 bytes for a file of 72,228,246 (and 17,021,004
// for one of 58,906,208) while the first download of the same files had agreed, and a strict size
// comparison then rejected a complete, correct file for ever. A downloaded index file is accepted if it
// is at least 1 MB and ends at the end of a line; the loader checks every row it reads. Archives are
// zip files (they do not compress), so their size stays strictly checked and they resume.
async function fetchIndex(url: string, dest: string): Promise<"downloaded"> {
  if (existsSync(dest)) unlinkSync(dest);
  const res = await fetch(url, { headers: PLAIN });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest, { flags: "w" }));
  const now = statSync(dest).size;
  if (now < 1_000_000) throw new Error(`${dest}: only ${now} bytes arrived`);
  const fd = openSync(dest, "r");
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, now - 1);
  closeSync(fd);
  if (last[0] !== 0x0a) throw new Error(`${dest}: the file does not end at the end of a line (${now} bytes); it was cut short`);
  return "downloaded";
}

async function fetchOne(url: string, dest: string, size: number): Promise<"skipped" | "downloaded" | "resumed"> {
  if (dest.endsWith(".csv")) return fetchIndex(url, dest);
  const have = existsSync(dest) ? statSync(dest).size : 0;
  if (have === size) return "skipped";
  if (have > size) throw new Error(`${dest} is larger (${have}) than the server's file (${size}); remove it and retry`);
  const res = await fetch(url, { headers: { ...PLAIN, ...(have > 0 ? { range: `bytes=${have}-` } : {}) } });
  if (have > 0 && res.status !== 206) throw new Error(`${url}: asked to resume at ${have}, server answered ${res.status}`);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest, { flags: have > 0 ? "a" : "w" }));
  const now = statSync(dest).size;
  if (now !== size) throw new Error(`${dest}: finished at ${now} bytes, expected ${size}`);
  return have > 0 ? "resumed" : "downloaded";
}

async function main() {
  const out = arg("out");
  if (!out) {
    console.error("usage: --out <dir> [--years ...] [--index-only | --zips-only] [--parallel n] [--list]");
    process.exit(2);
  }
  const years = (arg("years") ?? "2022,2023,2024,2025,2026").split(",").map(Number);
  const parallel = Number(arg("parallel") ?? 2);
  const indexDir = join(out, "index");
  const zipDir = join(out, "zips");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(zipDir, { recursive: true });

  if (flag("index-only") && flag("zips-only")) {
    console.error("--index-only and --zips-only cannot be used together");
    process.exit(2);
  }
  const jobs: Array<{ url: string; dest: string; label: string }> = flag("zips-only") ? [] : years.map((y) => ({ url: indexUrl(y), dest: join(indexDir, `index_${y}.csv`), label: `index_${y}.csv` }));
  if (!flag("index-only")) for (const y of years) for (const n of IRS_ARCHIVES[y] ?? []) jobs.push({ url: archiveUrl(n), dest: join(zipDir, `${n}.zip`), label: `${n}.zip` });

  let total = 0;
  const sized: Array<(typeof jobs)[number] & { size: number | null }> = [];
  for (const j of jobs) {
    const size = await remoteSize(j.url);
    sized.push({ ...j, size });
    total += size ?? 0;
  }
  console.log(`${sized.length} file(s), ${(total / 1e9).toFixed(2)} GB in total; ${sized.filter((s) => s.size === null).length} not served (404)`);
  if (flag("list")) {
    for (const s of sized) console.log(`  ${s.label}  ${s.size === null ? "404" : (s.size / 1e6).toFixed(1) + " MB"}`);
    return;
  }
  const queue = sized.filter((s) => s.size !== null);
  let done = 0;
  const t0 = Date.now();
  async function worker() {
    for (;;) {
      const j = queue.shift();
      if (!j) return;
      let how: Awaited<ReturnType<typeof fetchOne>> | null = null;
      // The IRS server sometimes stalls a stream; a stalled or dropped download resumes
      // from the bytes already on disk, so retrying costs only the time lost.
      for (let attempt = 1; how === null; attempt++) {
        try {
          how = await fetchOne(j.url, j.dest, j.size!);
        } catch (e) {
          if (attempt >= 8) throw e;
          console.log(`  ${j.label}: attempt ${attempt} failed (${(e as Error).message}${(e as { cause?: { code?: string } }).cause?.code ? ", " + (e as { cause: { code: string } }).cause.code : ""}); resuming`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      console.log(`  [${++done}/${sized.length}] ${j.label}: ${how} (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  for (const s of sized.filter((s) => s.size === null)) console.log(`  not served by the IRS: ${s.label}`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
