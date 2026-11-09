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
//     [--years 2022,2023,2024,2025,2026] [--index-only] [--parallel 2] [--list]
//   --list   print what would be fetched with sizes, download nothing
//
// The archive names come from lib/funder-reference/sources.ts (the IRS page as
// read on 2026-11-06). A name the IRS does not serve (HTTP 404) is reported, not
// fatal.

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
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

async function remoteSize(url: string): Promise<number | null> {
  const r = await fetch(url, { method: "HEAD", headers: { "user-agent": UA } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Number(r.headers.get("content-length"));
}

async function fetchOne(url: string, dest: string, size: number): Promise<"skipped" | "downloaded" | "resumed"> {
  const have = existsSync(dest) ? statSync(dest).size : 0;
  if (have === size) return "skipped";
  if (have > size) throw new Error(`${dest} is larger (${have}) than the server's file (${size}); remove it and retry`);
  const res = await fetch(url, { headers: { "user-agent": UA, ...(have > 0 ? { range: `bytes=${have}-` } : {}) } });
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
    console.error("usage: --out <dir> [--years ...] [--index-only] [--parallel n] [--list]");
    process.exit(2);
  }
  const years = (arg("years") ?? "2022,2023,2024,2025,2026").split(",").map(Number);
  const parallel = Number(arg("parallel") ?? 2);
  const indexDir = join(out, "index");
  const zipDir = join(out, "zips");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(zipDir, { recursive: true });

  const jobs: Array<{ url: string; dest: string; label: string }> = years.map((y) => ({ url: indexUrl(y), dest: join(indexDir, `index_${y}.csv`), label: `index_${y}.csv` }));
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
