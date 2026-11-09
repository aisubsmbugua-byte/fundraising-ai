// Item 110 (ruling 0045 clauses 2 and 6): the IRS sources, named, and how the
// loader reads them.
//
// SOURCE. The IRS "Form 990 series (e-file) XML" bulk downloads, listed at
// https://www.irs.gov/charities-non-profits/form-990-series-downloads and served
// from https://apps.irs.gov/pub/epostcard/990/xml/<year>/. Each year has an
// index CSV and monthly ZIP archives of the returns' XML. ProPublica's site is
// NOT read by the loader (ruling 0045 scope; a few API lookups are used only to
// cross-check, by hand, in the build report).
//
// WHAT THE INDEX DOES AND DOES NOT SAY (observed 2026-11-06):
//   * columns RETURN_ID, FILING_TYPE, EIN, TAX_PERIOD (yyyymm), SUB_DATE (the
//     year submitted), TAXPAYER_NAME, RETURN_TYPE, DLN, OBJECT_ID, and, from the
//     2024 index on, XML_BATCH_ID (which archive holds the return);
//   * the 2022 and 2023 indexes have NO batch column, and a return can sit in a
//     different month's archive than its submission suggests (a 2022-period
//     return submitted 2023-11-14 is in 2023_TEOS_XML_11A), so those are found by
//     reading the archives' directories;
//   * archive members are named <OBJECT_ID>_public.xml, with or without a folder.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import type { IndexRow } from "./document";
import { ZipArchive, fileSource, httpSource, openZip } from "./zip";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const IRS_BASE = "https://apps.irs.gov/pub/epostcard/990/xml";

/**
 * Archive names the IRS page listed on 2026-11-06 (it was last updated 2026-10-22), plus
 * 2022_TEOS_XML_02A, which that page did not list but which the IRS serves (HTTP 200,
 * 1,408,196,885 bytes, checked 2026-11-08 by HEAD). The first full California dry run could
 * not find 5,901 returns that were submitted in 2022 in any listed archive; this is the
 * archive added to look for them. Other 2022 names tried (03A to 12A, 01B, 05B, 11B, 11C)
 * are not served.
 */
export const IRS_ARCHIVES: Record<number, string[]> = {
  2022: ["2022_TEOS_XML_01A", "2022_TEOS_XML_02A"],
  2023: months(2023, 12),
  2024: months(2024, 12),
  2025: [...months(2025, 12), "2025_TEOS_XML_05B", "2025_TEOS_XML_11B", "2025_TEOS_XML_11C", "2025_TEOS_XML_11D"],
  2026: [...months(2026, 9), "2026_TEOS_XML_05B"],
};
function months(y: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${y}_TEOS_XML_${String(i + 1).padStart(2, "0")}A`);
}

// The 2024 index writes some batch ids with a lower-case month letter
// ("2024_TEOS_XML_05a") although the archive is named "2024_TEOS_XML_05A"
// (observed 2026-11-06: 04a, 05a and 06a, about 245,000 rows). Match case-insensitively
// against the archives the IRS lists; an id that matches none is kept as written.
const CANONICAL_ARCHIVE = new Map(Object.values(IRS_ARCHIVES).flat().map((n) => [n.toLowerCase(), n]));
export function canonicalArchiveName(name: string): string {
  return CANONICAL_ARCHIVE.get(name.toLowerCase()) ?? name;
}

export function archiveUrl(name: string): string {
  return `${IRS_BASE}/${name.slice(0, 4)}/${name}.zip`;
}
export function indexUrl(year: number): string {
  return `${IRS_BASE}/${year}/index_${year}.csv`;
}

export function parseCsvLine(line: string): string[] {
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

export interface IndexFilter {
  returnType: string; // '990PF'
  periodYears: number[]; // calendar years of the tax period end
  eins: string[] | null;
}

/** Streams one index CSV and yields the rows that pass the filter. */
export async function readIndex(path: string, filter: IndexFilter): Promise<{ rows: IndexRow[]; totalRows: number }> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let header: string[] | null = null;
  const col: Record<string, number> = {};
  const rows: IndexRow[] = [];
  let total = 0;
  const file = basename(path);
  const einSet = filter.eins ? new Set(filter.eins) : null;
  for await (const line of rl) {
    if (line === "") continue;
    const f = parseCsvLine(line);
    if (!header) {
      header = f.map((h) => h.trim().replace(/^﻿/, ""));
      header.forEach((h, i) => (col[h] = i));
      for (const need of ["EIN", "TAX_PERIOD", "RETURN_TYPE", "OBJECT_ID"]) if (!(need in col)) throw new Error(`${file}: index has no ${need} column (header: ${header.join(",")})`);
      continue;
    }
    total++;
    if (f[col.RETURN_TYPE] !== filter.returnType) continue;
    const taxPeriod = f[col.TAX_PERIOD];
    if (!/^\d{6}$/.test(taxPeriod) || !filter.periodYears.includes(Number(taxPeriod.slice(0, 4)))) continue;
    const ein = f[col.EIN].padStart(9, "0");
    if (einSet && !einSet.has(ein)) continue;
    const sub = col.SUB_DATE !== undefined ? Number(f[col.SUB_DATE]) : NaN;
    rows.push({
      returnId: col.RETURN_ID !== undefined ? f[col.RETURN_ID] || null : null,
      ein,
      taxPeriod,
      subYear: Number.isFinite(sub) ? sub : null,
      taxpayerName: f[col.TAXPAYER_NAME] ?? "",
      returnType: f[col.RETURN_TYPE],
      objectId: f[col.OBJECT_ID],
      batchId: col.XML_BATCH_ID !== undefined && f[col.XML_BATCH_ID] ? canonicalArchiveName(f[col.XML_BATCH_ID]) : null,
      indexFile: file,
    });
  }
  return { rows, totalRows: total };
}

// --- archive access --------------------------------------------------------------

export interface ArchiveProvider {
  /** Opens an archive by IRS name, or null when it is neither on disk nor allowed/able to be fetched. */
  open(name: string): Promise<ZipArchive | null>;
  /** Archive names that may hold a return submitted in `subYear` (all of them if unknown). */
  candidates(subYear: number | null): string[];
}

export function archiveProvider(opts: { dir: string | null; remote: boolean; userAgent: string }): ArchiveProvider {
  const all = Object.values(IRS_ARCHIVES).flat();
  // Reading a remote archive's directory costs megabytes; do it once per run.
  const remoteCache = new Map<string, ZipArchive | null>();
  return {
    candidates: (subYear) => (subYear && IRS_ARCHIVES[subYear] ? IRS_ARCHIVES[subYear] : all),
    async open(name) {
      if (opts.dir) {
        const p = join(opts.dir, `${name}.zip`);
        if (existsSync(p)) return openZip(await fileSource(p));
      }
      if (!opts.remote) return null;
      if (remoteCache.has(name)) return remoteCache.get(name)!;
      try {
        const z = await openZip(await httpSource(archiveUrl(name), opts.userAgent));
        remoteCache.set(name, z);
        return z;
      } catch (e) {
        // A name the IRS page lists but the server does not have is an absence to record, not a crash.
        if (/HTTP 404/.test((e as Error).message)) {
          remoteCache.set(name, null);
          return null;
        }
        throw e;
      }
    },
  };
}
