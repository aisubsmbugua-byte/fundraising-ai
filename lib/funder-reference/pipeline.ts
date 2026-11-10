// Item 110 (ruling 0045 clause 6): the offline loader's pipeline.
//
// ONE INVARIANT governs this file: every index row the run considers ends in
// exactly one named outcome, and the outcomes add up to the rows considered
// (`outcomes_sum_check` in the run record says whether they do).
//
//   out_of_scope_state       header (or full return) says not the requested state;
//                            counted, NOT stored -- the only outcome that stores nothing
//   status_unread            could not be found, decompressed, or understood; a
//                            filing row with the reason, and named in the run record
//                            (of which `unread_not_located` were not in any archive)
//   status_skipped_below_threshold   in the state, funder under the threshold;
//                            a filing row, nothing else
//   status_loaded            in scope and standing
//   status_superseded        in scope, but a later return for the same EIN and
//                            period stands (the earlier one is kept as a filing)
// Independently, each stored row was either written now or already identical
// (`rows_written`, `rows_unchanged`).
//
// ITEM 114 (ruling 0046): this pipeline now runs one STATE per process, many times over, on a
// small server. Four rules follow from that and are enforced by scripts/test-funder-reference-
// memory.ts and scripts/test-all-states.ts:
//   * MEMORY. Nothing kept for the whole run may refer into a return's text (a 13-character
//     substring points into the whole document; see strings.ts), the archives' directories are
//     listed only for the members wanted (zip.ts), and the index is read without building a
//     character-by-character string per field (sources.ts). A state peaks at about 1.3 GB.
//   * SHARED FILES. pass-a-cache.jsonl records name the state they were made for, so every
//     state's run can share one work directory; header-scan-cache.jsonl is the same for all.
//   * OTHER STATES' ROWS. A run replaces the coverage rows of the funders IT considered, not of
//     every funder in the index, and works a funder's coverage out from every row the index has
//     for it (this run's outcome for the rows it decided, the database's for the rest).
//   * OVERSIZE. A return over maxReturnBytes is not parsed, and a filing whose write document is
//     over maxWriteBytes is not written; each is recorded as unread with the reason.
//
// RESUMABLE. State lives in the database (a filing already stored identically
// costs one comparison) and in an append-only header cache on disk, so a killed
// run restarts without redoing finished work. IDEMPOTENT. A filing is replaced
// whole through one database function; running twice cannot duplicate a row.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOADER_VERSION, loadedDoc, skippedDoc, sha256Hex, unreadDoc, type FilingDoc, type IndexRow, type Provenance } from "./document";
import { assessThreshold, thresholdFromFigures, type Threshold, type ThresholdResult } from "./derive";
import { FilingRejected, parseFiling990PF, peekHeader, type ParsedFiling } from "./parse-990pf";
import type { ArchiveProvider } from "./sources";
import { archiveUrl, indexUrl } from "./sources";
import type { CoverageRow, ExistingFiling, Sink } from "./sink";
import { KEEP_NONE, type ZipArchive, type ZipEntry } from "./zip";
import { detach } from "./strings";

export interface PipelineParams {
  periodYears: number[];
  state: string | null; // keep only filers whose US address is in this state; null = any
  eins: string[] | null; // restrict to these EINs (the worked example); disables the state filter
  threshold: Threshold;
  workDir: string;
  /** Rows from the index CSVs, already filtered to the return type and period years. */
  rows: IndexRow[];
  sources: unknown[]; // the index files used: name, bytes, sha256
  dryRun?: boolean;
  /** Read this many of the returns the header ruled out, chosen repeatably at random, to check the header peek. */
  auditHeaderSample?: number;
  /**
   * Item 114. A return whose XML is larger than this is recorded as unread, not parsed (default 64 MB). One Washington
   * return was 279 MB with 363,675 listed grants; parsing it needs gigabytes, and the loader promises to run in about 1.5 GB.
   */
  maxReturnBytes?: number;
  /** A filing whose write document would exceed this many bytes is recorded as unread, not written (default 16 MB): one database call carries a whole filing. */
  maxWriteBytes?: number;
}
export const DEFAULT_MAX_RETURN_BYTES = 64_000_000;
export const DEFAULT_MAX_WRITE_BYTES = 16_000_000;

export interface Counts {
  index_rows_considered: number;
  out_of_scope_state: number;
  status_unread: number;
  unread_not_located: number;
  status_skipped_below_threshold: number;
  status_loaded: number;
  status_superseded: number;
  outcomes_sum_check: boolean;
  rows_written: number;
  rows_unchanged: number;
  full_reads: number;
  /** Of full_reads, how many were answered from the pass-A cache of an earlier run rather than read again. */
  pass_a_cache_hits: number;
  header_reads_used: number;
  foundations_in_scope: number;
  foundations_below_threshold: number;
  coverage_loaded: number;
  coverage_unread: number;
  coverage_no_filing_in_index: number;
  loaded_filings_with_unmapped_grant_fields: number;
  loaded_filings_whose_listed_grants_differ_from_stated_total: number;
  loaded_filings_with_stated_grants_and_no_listed_rows: number;
  /** Returns the header said were in the state but the whole return puts elsewhere (counted in out_of_scope_state). */
  header_said_in_state_but_return_disagrees: number;
  /** A repeatable random sample of the returns the header ruled OUT, read in full to check the header was right. */
  header_audit: HeaderAudit | null;
  /** What each size cutoff would have included, over every funder in the requested state that was read. */
  universe_sensitivity: Sensitivity | null;
}

export interface HeaderAudit {
  set: string;
  sample_requested: number;
  sampled: number;
  read_ok: number;
  unreadable: number;
  said_not_in_state_but_return_is_in_state: number;
  examples: Array<{ object_id: string; header_state: string | null; return_state: string | null }>;
}

export interface Sensitivity {
  set: string; // names the set the counts range over
  foundations_read: number;
  assets_not_stated_in_any_period: number;
  giving_not_stated_in_any_period: number;
  with_max_assets_at_least: Record<string, number>;
  with_max_giving_at_least: Record<string, number>;
  by_the_threshold_used: { either: number; assets_only: number; giving_only: number; both: number; neither: number };
}
const ASSET_STEPS = [0, 100_000, 250_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000];
const GIVING_STEPS = [0, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000];

export interface RunSummary {
  runId: string;
  counts: Counts;
  rejected: Array<{ object_id: string; ein: string; reason: string }>;
  coverage: CoverageRow[];
  seconds: number;
}

export type Located = { archive: string; entry: ZipEntry };
type XmlFacts = { sha256: string; bytes: number };
type Assessed = { row: IndexRow; loc: Located; xml: XmlFacts; head: Pick<ParsedFiling, "taxPeriodEnd" | "taxPeriodBegin" | "taxYr" | "returnVersion" | "returnTs">; a: ThresholdResult };

export interface ScanRecord {
  objectId: string;
  state: string | null;
  ein: string | null;
}

export const PEEK_BYTES = 12_000;

export async function runPipeline(sink: Sink, provider: ArchiveProvider, p: PipelineParams, log: (s: string) => void): Promise<RunSummary> {
  const t0 = Date.now();
  const runId = randomUUID();
  const loadedAt = new Date().toISOString();
  const counts: Counts = {
    index_rows_considered: p.rows.length,
    out_of_scope_state: 0,
    status_unread: 0,
    unread_not_located: 0,
    status_skipped_below_threshold: 0,
    status_loaded: 0,
    status_superseded: 0,
    outcomes_sum_check: false,
    rows_written: 0,
    rows_unchanged: 0,
    full_reads: 0,
    pass_a_cache_hits: 0,
    header_reads_used: 0,
    foundations_in_scope: 0,
    foundations_below_threshold: 0,
    coverage_loaded: 0,
    coverage_unread: 0,
    coverage_no_filing_in_index: 0,
    loaded_filings_with_unmapped_grant_fields: 0,
    loaded_filings_whose_listed_grants_differ_from_stated_total: 0,
    loaded_filings_with_stated_grants_and_no_listed_rows: 0,
    header_said_in_state_but_return_disagrees: 0,
    header_audit: null,
    universe_sensitivity: null,
  };
  const rejected: RunSummary["rejected"] = [];
  const maxReturnBytes = p.maxReturnBytes ?? DEFAULT_MAX_RETURN_BYTES;
  const maxWriteBytes = p.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  mkdirSync(p.workDir, { recursive: true });

  if (!p.dryRun) {
    await sink.startRun({
      id: runId,
      loaderVersion: LOADER_VERSION,
      parameters: {
        periodYears: p.periodYears,
        state: p.state,
        eins: p.eins,
        threshold: p.threshold,
        thresholdFigures: {
          assets: "total_assets_eoy_fmv_amt (fallback fmv_assets_eoy_amt)",
          giving: "contributions_paid_per_books_amt",
          rule: "in scope when ANY filing in the periods meets EITHER test",
        },
        returnType: "990PF",
        loaderVersion: LOADER_VERSION,
      },
    });
  }

  try {
    const byId = new Map(p.rows.map((r) => [r.objectId, r]));
    const prov = (r: IndexRow, loc: Located | undefined): Provenance => ({
      runId,
      loadedAt,
      loaderVersion: LOADER_VERSION,
      index: r,
      // A return found in no archive has no document location to give; the place it is
      // LISTED is the IRS index file, and the member says plainly that it was not found.
      archiveUrl: loc ? archiveUrl(loc.archive) : indexUrl(Number(/index_(\d{4})\.csv/.exec(r.indexFile)?.[1] ?? r.subYear ?? 0)),
      member: loc ? loc.entry.name : `(not found in any archive) ${r.objectId}_public.xml`,
    });
    const earlyDocs: FilingDoc[] = []; // unread and skipped filings, small
    const unread = (r: IndexRow, loc: Located | undefined, reasonIn: string, xml?: XmlFacts) => {
      // A reason is built from text cut out of a return; detached, it does not keep the return in memory.
      const reason = detach(reasonIn);
      counts.status_unread++;
      rejected.push({ object_id: r.objectId, ein: r.ein, reason });
      earlyDocs.push(unreadDoc(prov(r, loc), reason, xml));
    };

    // ---- 1. locate every row's member ----------------------------------------------------
    log(`locating ${p.rows.length} index row(s) in the IRS archives ...`);
    const located = await locateAll(p.rows, provider, log);
    log(`located ${located.size} of ${p.rows.length} ${memLine()}`);
    for (const r of p.rows) {
      if (located.has(r.objectId)) continue;
      counts.unread_not_located++;
      const tried = r.batchId ? `archive ${r.batchId}` : `the archives that can hold a return submitted in ${r.subYear ?? "an unknown year"}, then every archive`;
      unread(r, undefined, `not found: no member named ${r.objectId}_public.xml in ${tried}, or the archive could not be opened`);
    }

    // ---- 2. which located rows are in the requested state (header only) --------------------
    const useState = !!p.state && !p.eins;
    const scanCache = join(p.workDir, "header-scan-cache.jsonl");
    const scanned = loadScanCache(scanCache);
    log(`header cache loaded: ${scanned.size} ${memLine()}`);
    if (useState) await scanMissingHeaders(located, scanned, scanCache, provider, p.state, log);
    log(`headers read ${memLine()}`);
    const inStateIds: string[] = [];
    const headerOutIds: string[] = [];
    for (const id of located.keys()) {
      const s = scanned.get(id);
      if (useState && s && s.ein !== null) {
        counts.header_reads_used++;
        if (s.state !== p.state) {
          counts.out_of_scope_state++;
          headerOutIds.push(id);
          continue;
        }
      }
      inStateIds.push(id);
    }

    // ---- 2b. audit the header peek: read a repeatable random sample of the ruled-out returns whole ----
    if (useState && (p.auditHeaderSample ?? 0) > 0 && headerOutIds.length > 0) {
      const want = Math.min(p.auditHeaderSample!, headerOutIds.length);
      let seed = 123456789; // fixed seed: the same sample every run
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      const pool = [...headerOutIds];
      const sample: string[] = [];
      for (let i = 0; i < want; i++) sample.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      const audit: HeaderAudit = {
        set: `${want} of the ${headerOutIds.length} returns whose header put the filer outside ${p.state}, chosen by a seeded pseudo-random draw without replacement and then read in full`,
        sample_requested: p.auditHeaderSample!,
        sampled: want,
        read_ok: 0,
        unreadable: 0,
        said_not_in_state_but_return_is_in_state: 0,
        examples: [],
      };
      await forEachArchive(located, sample, provider, async (zip, ids) => {
        for (const id of ids) {
          try {
            const f = parseFiling990PF(Buffer.from(await zip.read(located.get(id)!.entry)).toString("utf8"));
            audit.read_ok++;
            const st = f.filer.address && f.filer.address.country === null ? f.filer.address.state : null;
            if (st === p.state) {
              audit.said_not_in_state_but_return_is_in_state++;
              if (audit.examples.length < 10) audit.examples.push({ object_id: id, header_state: scanned.get(id)?.state ?? null, return_state: st });
            }
          } catch {
            audit.unreadable++;
          }
        }
      });
      counts.header_audit = audit;
      log(`header audit: ${audit.read_ok} of ${want} sampled read in full; ${audit.said_not_in_state_but_return_is_in_state} disagreed with the header`);
    }

    // ---- 3. pass A: read each in-state return whole, check it, assess its size -------------
    log(`pass A: reading ${inStateIds.length} return(s) in full to assess size ...`);
    const assessed = new Map<string, Assessed>();
    // A restart must not redo tens of thousands of full reads: every outcome that came from
    // a successfully decompressed return is appended to this cache as it is reached, and a
    // later run replays it. The cache holds the FIGURES, not the verdict, so the current
    // threshold is applied afresh. It is valid only for this loader version and for an
    // archive member of the same size; bump LOADER_VERSION whenever the parser changes.
    const passACachePath = join(p.workDir, "pass-a-cache.jsonl");
    // A cached outcome ("in this state", "not in this state") is a statement about ONE state's run:
    // the same file is shared by every state's run in one work directory, so each record names the
    // state it was made for and is used only by a run for that state (item 114).
    const cacheState = useState ? p.state : null;
    const passACache = loadPassACache(passACachePath, cacheState);
    const rememberPassA = (rec: PassARecord) => appendFileSync(passACachePath, JSON.stringify(rec) + "\n");
    await forEachArchive(located, inStateIds, provider, async (zip, ids, archive) => {
      let done = 0;
      for (const id of ids) {
        const row = byId.get(id)!;
        const loc = located.get(id)!;
        counts.full_reads++;
        done++;
        if (done % 1000 === 0) log(`  pass A ${archive}: ${done} of ${ids.length} ${memLine()}`);

        const hit = passACache.get(id);
        if (hit && hit.xmlBytes === loc.entry.size) {
          counts.pass_a_cache_hits++;
          if (hit.outcome === "out_of_state") {
            counts.out_of_scope_state++;
            if (scanned.get(id)?.ein) counts.header_said_in_state_but_return_disagrees++;
          } else if (hit.outcome === "unread") {
            unread(row, loc, hit.reason ?? "unread (reason not cached)", hit.xml);
          } else if (hit.head) {
            assessed.set(id, { row, loc, xml: hit.xml!, head: hit.head, a: thresholdFromFigures(hit.assets ?? null, hit.giving ?? null, p.threshold) });
          }
          continue;
        }

        if (loc.entry.size > LARGE_RETURN_BYTES) log(`  large return ${id}: ${(loc.entry.size / 1e6).toFixed(1)} MB uncompressed ${memLine()}`);
        if (loc.entry.size > maxReturnBytes) {
          // not cached: the verdict depends on a limit that can be raised
          unread(row, loc, `the return is ${(loc.entry.size / 1e6).toFixed(1)} MB of XML, over the loader's ${(maxReturnBytes / 1e6).toFixed(0)} MB limit for reading one return (reading it would not fit the loader's memory); it was not parsed or stored`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await zip.read(loc.entry);
        } catch (e) {
          // not remembered: a failure to decompress may be this machine's, so it is tried again
          unread(row, loc, `archive member could not be decompressed: ${(e as Error).message}`);
          continue;
        }
        const xml = { sha256: sha256Hex(bytes), bytes: bytes.length };
        try {
          const f = parseFiling990PF(Buffer.from(bytes).toString("utf8"));
          checkAgainstIndex(f, row);
          if (useState) {
            const st = f.filer.address && f.filer.address.country === null ? f.filer.address.state : null;
            if (st !== p.state) {
              counts.out_of_scope_state++;
              if (scanned.get(id)?.ein) counts.header_said_in_state_but_return_disagrees++;
              rememberPassA({ v: PASS_A_CACHE_VERSION, loader: LOADER_VERSION, state: cacheState, objectId: id, xmlBytes: loc.entry.size, outcome: "out_of_state" });
              continue;
            }
          }
          // detached: a timestamp cut from the return would otherwise keep the whole return in memory for the rest of the run
          const head = { taxPeriodEnd: detach(f.taxPeriodEnd), taxPeriodBegin: detach(f.taxPeriodBegin), taxYr: detach(f.taxYr), returnVersion: detach(f.returnVersion), returnTs: detach(f.returnTs) };
          const a = assessThreshold(f, p.threshold);
          assessed.set(id, { row, loc, xml, head, a });
          rememberPassA({ v: PASS_A_CACHE_VERSION, loader: LOADER_VERSION, state: cacheState, objectId: id, xmlBytes: loc.entry.size, outcome: "assessed", xml, head, assets: a.assetsUsed, giving: a.givingUsed });
        } catch (e) {
          const reason = reasonOf(e);
          unread(row, loc, reason, xml);
          rememberPassA({ v: PASS_A_CACHE_VERSION, loader: LOADER_VERSION, state: cacheState, objectId: id, xmlBytes: loc.entry.size, outcome: "unread", xml, reason });
        }
      }
      log(`  pass A ${archive}: ${ids.length} ${memLine()}`);
    });
    if (counts.pass_a_cache_hits > 0) log(`pass A: ${counts.pass_a_cache_hits} of ${counts.full_reads} answered from the cache of an earlier run`);

    // ---- 4. decide scope per funder -------------------------------------------------------------
    const byEin = new Map<string, Assessed[]>();
    for (const x of assessed.values()) {
      const arr = byEin.get(x.row.ein) ?? [];
      arr.push(x);
      byEin.set(x.row.ein, arr);
    }
    // The distribution of the whole universe read, so a different cutoff can be judged afterwards
    // (below-threshold funders store no figures, by design). Counts only; per funder, the largest
    // value over its periods.
    {
      const sens: Sensitivity = {
        set: `every funder with at least one Form 990-PF read in full${p.state && !p.eins ? ` whose filer address is in ${p.state}` : ""}, for tax periods ending ${p.periodYears.join("/")}; each funder counted once, by the largest value over its periods`,
        foundations_read: byEin.size,
        assets_not_stated_in_any_period: 0,
        giving_not_stated_in_any_period: 0,
        with_max_assets_at_least: Object.fromEntries(ASSET_STEPS.map((x) => [String(x), 0])),
        with_max_giving_at_least: Object.fromEntries(GIVING_STEPS.map((x) => [String(x), 0])),
        by_the_threshold_used: { either: 0, assets_only: 0, giving_only: 0, both: 0, neither: 0 },
      };
      for (const list of byEin.values()) {
        const as = list.map((x) => x.a.assetsUsed).filter((v): v is number => v !== null);
        const gv = list.map((x) => x.a.givingUsed).filter((v): v is number => v !== null);
        if (as.length === 0) sens.assets_not_stated_in_any_period++;
        else for (const st of ASSET_STEPS) if (Math.max(...as) >= st) sens.with_max_assets_at_least[String(st)]++;
        if (gv.length === 0) sens.giving_not_stated_in_any_period++;
        else for (const st of GIVING_STEPS) if (Math.max(...gv) >= st) sens.with_max_giving_at_least[String(st)]++;
        const byA = list.some((x) => x.a.byAssets);
        const byG = list.some((x) => x.a.byGiving);
        if (byA && byG) sens.by_the_threshold_used.both++;
        else if (byA) sens.by_the_threshold_used.assets_only++;
        else if (byG) sens.by_the_threshold_used.giving_only++;
        else sens.by_the_threshold_used.neither++;
        if (byA || byG) sens.by_the_threshold_used.either++;
      }
      counts.universe_sensitivity = sens;
    }
    const inScopeEins = new Set<string>();
    const inScopeIds: string[] = [];
    for (const [ein, list] of byEin) {
      if (list.some((x) => x.a.meets)) {
        inScopeEins.add(ein);
        counts.foundations_in_scope++;
        for (const x of list) inScopeIds.push(x.row.objectId);
      } else {
        counts.foundations_below_threshold++;
        for (const x of list) {
          counts.status_skipped_below_threshold++;
          earlyDocs.push(
            skippedDoc(
              prov(x.row, x.loc),
              x.head,
              x.xml,
              `below the size threshold: assets ${x.a.assetsUsed ?? "not stated"} < ${p.threshold.minAssetsFmvAmt} and contributions paid per books ${x.a.givingUsed ?? "not stated"} < ${p.threshold.minContributionsPaidPerBooksAmt}, in every period held for this EIN`
            )
          );
        }
      }
    }

    // ---- 5. pass B: re-read in-scope returns, build full documents, write ------------------------
    const existing: Map<string, ExistingFiling> = p.dryRun
      ? new Map()
      : await sink.existingFilings([...earlyDocs.map((d) => String(d.filing.object_id)), ...inScopeIds]);
    const finalStatus = new Map<string, string>(); // object_id -> status after this run
    const dryLoaded: FilingDoc[] = [];
    const apply = async (doc: FilingDoc) => {
      const f = doc.filing;
      const id = String(f.object_id);
      const prev = existing.get(id);
      const sameStatus = prev && (prev.status === f.status || (f.status === "loaded" && prev.status === "superseded"));
      const same =
        sameStatus &&
        (f.status === "loaded" || (prev!.status_note ?? null) === (f.status_note ?? null)) &&
        (prev!.xml_sha256 ?? null) === (f.xml_sha256 ?? null) &&
        prev!.loader_version === f.loader_version;
      if (same) {
        counts.rows_unchanged++;
        finalStatus.set(id, prev!.status);
        return;
      }
      if (p.dryRun) {
        counts.rows_written++;
        finalStatus.set(id, String(f.status));
        // only the filing row is needed to work out which return stands; the figures, people and grants of a dry run are not kept
        // (detached: the timestamp is cut from the return and would keep the whole return in memory)
        if (f.status === "loaded") dryLoaded.push({ filing: { object_id: id, ein: f.ein, tax_period_end: f.tax_period_end, return_ts: detach(f.return_ts as string | null), status: "loaded" }, foundation: null, figures: null, people: [], grants: [], application: null });
        return;
      }
      const result = await sink.applyFiling(doc);
      counts.rows_written++;
      finalStatus.set(id, result);
    };

    log(`writing ${earlyDocs.length} unread/skipped filing record(s) ...`);
    // one database call per record: New York's 16,307 took 33 minutes (8 a second), which is longer than the
    // supervisor's 30 minutes of silence, so a healthy run was stopped on 2026-11-10; say how far it is
    let earlyDone = 0;
    for (const d of earlyDocs) {
      await apply(d);
      if (++earlyDone % 500 === 0) log(`  recorded ${earlyDone}/${earlyDocs.length} unread/skipped filing record(s)`);
    }

    log(`pass B: re-reading ${inScopeIds.length} in-scope return(s) and writing ...`);
    let applied = 0;
    await forEachArchive(located, inScopeIds, provider, async (zip, ids, archive) => {
      for (const id of ids) {
        const x = assessed.get(id)!;
        let bytes: Uint8Array;
        try {
          bytes = await zip.read(x.loc.entry);
        } catch (e) {
          unread(x.row, x.loc, `archive member could not be decompressed on the second read: ${(e as Error).message}`);
          await apply(earlyDocs[earlyDocs.length - 1]);
          continue;
        }
        const facts = { sha256: sha256Hex(bytes), bytes: bytes.length };
        if (facts.sha256 !== x.xml.sha256) {
          unread(x.row, x.loc, `the member's bytes changed between the two reads of one run (${x.xml.sha256} then ${facts.sha256})`, facts);
          await apply(earlyDocs[earlyDocs.length - 1]);
          continue;
        }
        const f = parseFiling990PF(Buffer.from(bytes).toString("utf8"));
        const stated = f.figures.grants_paid_stated_total_amt;
        const listedSum = f.grantsPaid.reduce((a, g) => a + (g.amountAmt ?? 0), 0);
        if (f.grantsPaid.concat(f.grantsApproved).some((g) => Object.keys(g.unmappedFields).length)) counts.loaded_filings_with_unmapped_grant_fields++;
        if (f.grantsPaid.length === 0 && stated !== null && stated > 0) counts.loaded_filings_with_stated_grants_and_no_listed_rows++;
        else if (f.grantsPaid.length > 0 && stated !== null && listedSum !== stated) counts.loaded_filings_whose_listed_grants_differ_from_stated_total++;
        const doc = loadedDoc(prov(x.row, x.loc), f, facts);
        const docBytes = JSON.stringify(doc).length;
        if (docBytes > maxWriteBytes) {
          // one database call carries a whole filing; a filing too big for one call is recorded as unread with the reason, never dropped silently
          unread(x.row, x.loc, `the filing lists ${f.grantsPaid.length + f.grantsApproved.length} grants and ${f.people.length} people; its write document is ${(docBytes / 1e6).toFixed(1)} MB, over the loader's ${(maxWriteBytes / 1e6).toFixed(0)} MB limit for one database call; it was not stored`, facts);
          await apply(earlyDocs[earlyDocs.length - 1]);
          continue;
        }
        await apply(doc);
        if (++applied % 500 === 0) log(`  written ${applied}/${inScopeIds.length}`);
      }
      log(`  pass B ${archive}: ${ids.length}`);
    });

    // A filing applied early can be demoted by a later return for the same EIN and period,
    // so the status each row ended with is read back from the database (authoritative),
    // or, in a dry run, worked out by the same rule the database function applies.
    if (!p.dryRun) {
      const after = await sink.existingFilings([...finalStatus.keys()]);
      for (const [id] of finalStatus) finalStatus.set(id, after.get(id)?.status ?? "missing");
    } else {
      const groups = new Map<string, FilingDoc[]>();
      for (const d of earlyDocs.concat(dryLoaded)) {
        if (d.filing.status !== "loaded") continue;
        const k = `${d.filing.ein}|${d.filing.tax_period_end}`;
        groups.set(k, [...(groups.get(k) ?? []), d]);
      }
      for (const g of groups.values()) {
        g.sort((a, b) => String(b.filing.return_ts ?? "").localeCompare(String(a.filing.return_ts ?? "")) || String(b.filing.object_id).localeCompare(String(a.filing.object_id)));
        g.forEach((d, i) => finalStatus.set(String(d.filing.object_id), i === 0 ? "loaded" : "superseded"));
      }
    }
    for (const st of finalStatus.values()) {
      if (st === "loaded") counts.status_loaded++;
      else if (st === "superseded") counts.status_superseded++;
    }
    // status_unread / status_skipped were counted as they arose; rows that fell to unread in pass B
    // were counted there. A row counted unread in pass B was first counted loaded-in-scope only
    // through finalStatus, which it never entered, so nothing is counted twice.
    counts.outcomes_sum_check =
      counts.index_rows_considered ===
      counts.out_of_scope_state + counts.status_unread + counts.status_skipped_below_threshold + counts.status_loaded + counts.status_superseded;

    // ---- 6. coverage: which periods are held and which are not, per funder ------------------------
    // A funder's rows can be split across states (it moved: its returns carry addresses in more
    // than one state), and each state is a separate run. So a funder's coverage is worked out from
    // every row the index has for it, with this run's outcome for the rows it decided and the
    // database's for the rest, and a run touches only the funders IT considered (item 114): an
    // earlier version replaced the coverage of every funder in the index, which would have erased
    // the coverage written by every other state's run. For a single-state database the result is
    // what it always was.
    const coverage: CoverageRow[] = [];
    const checkedAt = new Date().toISOString();
    const consideredEins = new Set<string>();
    for (const id of inStateIds) consideredEins.add(byId.get(id)!.ein);
    const rowsByEin = new Map<string, IndexRow[]>(); // only the funders this run considered
    for (const r of p.rows) {
      if (!consideredEins.has(r.ein)) continue;
      const a = rowsByEin.get(r.ein) ?? [];
      a.push(r);
      rowsByEin.set(r.ein, a);
    }
    const notDecidedHere: string[] = [];
    for (const ein of consideredEins) for (const r of rowsByEin.get(ein) ?? []) if (!finalStatus.has(r.objectId)) notDecidedHere.push(r.objectId);
    const heldElsewhere: Map<string, ExistingFiling> = p.dryRun ? new Map() : await sink.existingFilings(notDecidedHere);
    const statusOf = (id: string): string | undefined => finalStatus.get(id) ?? heldElsewhere.get(id)?.status;
    const coverageEins = [...consideredEins].filter((ein) => inScopeEins.has(ein) || (rowsByEin.get(ein) ?? []).some((r) => statusOf(r.objectId) === "loaded")).sort();
    const rejectedIds = new Set(rejected.map((r) => r.object_id));
    const indexFiles = [...new Set(p.rows.map((r) => r.indexFile))].sort().join(", ");
    for (const ein of coverageEins) {
      for (const year of p.periodYears) {
        const inYear = (rowsByEin.get(ein) ?? []).filter((r) => Number(r.taxPeriod.slice(0, 4)) === year);
        const standing = inYear.filter((r) => statusOf(r.objectId) === "loaded");
        const unreadRows = inYear.filter((r) => rejectedIds.has(r.objectId) || statusOf(r.objectId) === "unread");
        let row: CoverageRow;
        if (standing.length) {
          counts.coverage_loaded++;
          row = { ein, period_year: year, status: "loaded", filing_object_id: standing[0].objectId, note: `held: the return for the tax period ending in ${year} (index period ${standing[0].taxPeriod}) was read and stored`, run_id: runId, checked_at: checkedAt };
        } else if (unreadRows.length) {
          counts.coverage_unread++;
          row = { ein, period_year: year, status: "unread", filing_object_id: unreadRows[0].objectId, note: `the IRS index lists ${unreadRows.length} return(s) for a period ending in ${year} and none could be read; see funder_reference_filings`, run_id: runId, checked_at: checkedAt };
        } else if (inYear.some((r) => statusOf(r.objectId) === "skipped_below_threshold")) {
          // The index has a return for this year and another state's run held it below the threshold:
          // "not in the index" would be false, and the schema has no other status for it. No coverage
          // row is written; the filing row says what happened.
          continue;
        } else {
          counts.coverage_no_filing_in_index++;
          row = {
            ein,
            period_year: year,
            status: "no_filing_in_index",
            filing_object_id: null,
            note: `no Form 990-PF for a tax period ending in ${year} is in the IRS index files this run read (${indexFiles}); an absence in the data, not a statement that nothing was given`,
            run_id: runId,
            checked_at: checkedAt,
          };
        }
        coverage.push(row);
      }
    }
    // Every funder this run considered is replaced, so one that has dropped out of scope
    // (a raised threshold) does not keep coverage rows that claim periods are held.
    if (!p.dryRun) await sink.replaceCoverage([...consideredEins], coverage);

    if (!p.dryRun) {
      await sink.finishRun(runId, { status: "completed", counts: counts as unknown as Record<string, unknown>, rejected_filings: rejected, sources: p.sources });
    }
    return { runId, counts, rejected, coverage, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    if (!p.dryRun) {
      await sink
        .finishRun(runId, { status: "failed", counts: counts as unknown as Record<string, unknown>, rejected_filings: rejected, sources: p.sources, notes: (e as Error).message })
        .catch(() => undefined);
    }
    throw e;
  }
}

function reasonOf(e: unknown): string {
  return e instanceof FilingRejected ? e.reason : `parser error (a loader defect, not necessarily a bad filing): ${(e as Error).message}`;
}

/** The return and the IRS index must agree on whose return it is and which period. */
function checkAgainstIndex(f: ParsedFiling, row: IndexRow) {
  if (f.ein !== row.ein) throw new FilingRejected(`the return's EIN is ${f.ein}; the IRS index says ${row.ein}`);
  if (f.taxPeriodEnd.slice(0, 7).replace("-", "") !== row.taxPeriod)
    throw new FilingRejected(`the return's tax period end is ${f.taxPeriodEnd}; the IRS index says ${row.taxPeriod}`);
}

const PASS_A_CACHE_VERSION = 1;
const LARGE_RETURN_BYTES = 20_000_000;

interface PassARecord {
  v: number;
  loader: string;
  /** The state this record was made for (null: a run for named EINs, with no state test). */
  state: string | null;
  objectId: string;
  /** The archive member's uncompressed size; a different size means a different file, so the record is not used. */
  xmlBytes: number;
  outcome: "assessed" | "out_of_state" | "unread";
  xml?: XmlFacts;
  head?: Assessed["head"];
  assets?: number | null;
  giving?: number | null;
  reason?: string;
}

function loadPassACache(path: string, state: string | null): Map<string, PassARecord> {
  const m = new Map<string, PassARecord>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as PassARecord;
      if (r.v === PASS_A_CACHE_VERSION && r.loader === LOADER_VERSION && r.state === state) m.set(r.objectId, r);
    } catch {
      // a torn last line from a killed run; that return is simply read again
    }
  }
  return m;
}

/** Memory, in one short phrase for the progress log: the loader's own footprint and what is left on the machine. */
export function memLine(): string {
  const m = process.memoryUsage();
  const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
  return `[rss ${mb(m.rss)}, heap ${mb(m.heapUsed)}, machine free ${mb(freemem())}]`;
}

/** The header records one at a time, for a caller that wants a lighter structure than a Map of objects (item 114). */
export function streamScanCache(path: string, onRecord: (r: ScanRecord) => void): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      onRecord(JSON.parse(line) as ScanRecord);
    } catch {
      // a torn last line from a killed run; that row is simply scanned again
    }
  }
}
export function loadScanCache(path: string): Map<string, ScanRecord> {
  const m = new Map<string, ScanRecord>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as ScanRecord;
      m.set(r.objectId, r);
    } catch {
      // a torn last line from a killed run; that row is simply scanned again
    }
  }
  return m;
}

/**
 * Reads the first bytes of every located return that has no header record yet and appends
 * one record each to the cache file (state and EIN as the header states them). Records
 * are written as they are made, so a killed scan resumes where it stopped.
 */
export async function scanMissingHeaders(
  located: Map<string, Located>,
  scanned: Map<string, ScanRecord>,
  scanCache: string,
  provider: ArchiveProvider,
  state: string | null,
  log: (s: string) => void
) {
  const toScan = [...located.keys()].filter((id) => !scanned.has(id));
  log(`reading ${toScan.length} header(s) (${located.size - toScan.length} already cached) to find ${state ?? "every state's"} filers ...`);
  await forEachArchive(located, toScan, provider, async (zip, ids, archive) => {
    for (const id of ids) {
      let rec: ScanRecord = { objectId: id, state: null, ein: null };
      try {
        const bytes = await zip.readPrefix(located.get(id)!.entry, PEEK_BYTES);
        const peek = peekHeader(Buffer.from(bytes).toString("utf8"));
        if (peek && peek.ein) rec = { objectId: id, state: peek.foreign ? null : detach(peek.state), ein: detach(peek.ein) };
      } catch {
        // a header that cannot be peeked is read in full below and judged there
      }
      scanned.set(id, rec);
      appendFileSync(scanCache, JSON.stringify(rec) + "\n");
    }
    log(`  headers ${archive}: ${ids.length}`);
  });
}

/**
 * Item 114: only the header scan, for the all-states command. Locates every row in the
 * archives and reads the header of each return not yet in <workDir>/header-scan-cache.jsonl.
 * Touches no database. Returns how many rows were located and how many headers were scanned
 * by this call.
 */
export async function scanHeadersOnly(rows: IndexRow[], provider: ArchiveProvider, workDir: string, log: (s: string) => void): Promise<{ rows: number; located: number; scannedNow: number }> {
  mkdirSync(workDir, { recursive: true });
  const located = await locateAll(rows, provider, log);
  const scanCache = join(workDir, "header-scan-cache.jsonl");
  const scanned = loadScanCache(scanCache);
  const before = scanned.size;
  await scanMissingHeaders(located, scanned, scanCache, provider, null, log);
  return { rows: rows.length, located: located.size, scannedNow: scanned.size - before };
}

/**
 * Finds each row's archive member. A row with a batch id is looked for in that
 * archive; one without, in the archives that can hold its submission year, and,
 * failing that, in every archive. Each archive is opened at most once.
 */
export async function locateAll(rows: IndexRow[], provider: ArchiveProvider, log: (s: string) => void): Promise<Map<string, Located>> {
  const found = new Map<string, Located>();
  const pending = new Map(rows.map((r) => [r.objectId, r]));
  const tried = new Set<string>();
  const all = provider.candidates(null);

  // A member is named <OBJECT_ID>_public.xml, in a folder or not. Only the members that
  // are still wanted are listed from each archive (item 114: listing every member of an
  // archive that holds several hundred thousand was the loader's largest use of memory).
  const idOf = (member: string): string | null => {
    const base = member.slice(member.lastIndexOf("/") + 1);
    return base.endsWith("_public.xml") ? base.slice(0, base.length - "_public.xml".length) : null;
  };

  async function resolveIn(name: string) {
    tried.add(name);
    let zip: ZipArchive | null = null;
    try {
      zip = await provider.open(name, {
        keep: (member) => {
          const id = idOf(member);
          return id !== null && pending.has(id);
        },
      });
    } catch (e) {
      log(`  could not open ${name}: ${(e as Error).message}`);
      return;
    }
    if (!zip) {
      log(`  ${name}: not available`);
      return;
    }
    let n = 0;
    try {
      // Two members with one file name (in different folders): the last listed wins, as findObject did.
      const byId = new Map<string, ZipEntry>();
      for (const entry of zip.entries) byId.set(idOf(entry.name)!, entry);
      for (const [id, entry] of byId) {
        found.set(id, { archive: name, entry });
        pending.delete(id);
        n++;
      }
    } finally {
      await zip.close();
    }
    log(`  ${name}: ${n} located (${pending.size} still pending)`);
  }

  // pass 1: where the metadata points; pass 2: anywhere not yet tried
  for (const wide of [false, true]) {
    for (;;) {
      const demand = new Map<string, number>();
      for (const r of pending.values()) {
        const cands = wide ? all : r.batchId ? [r.batchId] : provider.candidates(r.subYear);
        for (const a of cands) if (!tried.has(a)) demand.set(a, (demand.get(a) ?? 0) + 1);
      }
      if (demand.size === 0) break;
      const [name] = [...demand.entries()].sort((a, b) => b[1] - a[1])[0];
      await resolveIn(name);
    }
    if (pending.size === 0) break;
  }
  return found;
}

/** Runs fn once per archive over the ids located in it, opening each archive once. */
export async function forEachArchive(
  located: Map<string, Located>,
  ids: string[],
  provider: ArchiveProvider,
  fn: (zip: ZipArchive, ids: string[], archive: string) => Promise<void>
) {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const a = located.get(id)!.archive;
    const g = groups.get(a) ?? [];
    g.push(id);
    groups.set(a, g);
  }
  for (const [archive, list] of groups) {
    const zip = await provider.open(archive, { keep: KEEP_NONE });
    if (!zip) throw new Error(`archive ${archive} was located earlier and is no longer available`);
    try {
      list.sort((a, b) => located.get(a)!.entry.localHeaderOffset - located.get(b)!.entry.localHeaderOffset);
      await fn(zip, list, archive);
    } finally {
      await zip.close();
    }
  }
}
