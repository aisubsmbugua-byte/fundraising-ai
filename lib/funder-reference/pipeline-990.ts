// Item 116 (ruling 0047): the offline loader for grantmaking public charities and donor-advised fund
// sponsors, from Form 990 returns. A sibling of pipeline.ts, NOT a change to it: the Form 990-PF
// pipeline, the supervisor and the all-states command are untouched and behave as they did.
//
// WHAT IS SHARED, NOT REWRITTEN (ruling 0047 clause 5, and the note in docs/reviews/0034 that about
// 6% of index rows name an archive that does not hold the return):
//   * locateAll   finds each return's archive member, first where the index points and then in every
//                 archive, opening each archive once, listing only the members wanted;
//   * forEachArchive, scanMissingHeaders and the header cache (header-scan-cache.jsonl, the same file
//                 the foundation loader uses: an object id is one return, whatever kind it is).
//
// ONE INVARIANT, as in pipeline.ts: every index row the run considers ends in exactly one named outcome,
// and the outcomes add up to the rows considered (outcomes_sum_check).
//
//   out_of_scope_state   the header (or the whole return) says not the requested state; counted, NOT stored
//   status_unread        could not be found, decompressed or understood; a filing row with the reason
//   status_not_in_scope  read, in the state, and its funder is outside ruling 0047 clause 8; COUNTED, NOT
//                        STORED (about nine in ten Form 990 returns are not grantmaking charities; a row
//                        for each would be about a million rows and most of the time, for nothing)
//   status_loaded        in scope and standing
//   status_superseded    in scope, but a later return for the same EIN and period stands
//
// Scope is decided per FUNDER over every return read for it in the periods (charity-scope.ts), so one
// return that states $100,000 in grants brings the funder's other returns in with it, and a funder none
// of whose returns qualifies is out.
//
// RESUMABLE. A return already stored identically costs one comparison, and pass A is cached on disk
// (pass-a-990-cache.jsonl, each record naming the state it was made for). IDEMPOTENT. A filing is
// replaced whole through one database function; running twice cannot duplicate a row.
//
// NOT DONE HERE: nothing runs while the foundation load is running (the entry point refuses; ruling
// 0047 clause 7), people (Part VII) are not stored in this stage, and Form 990-EZ and 990-N are out.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CoverageRow, ExistingFiling } from "./sink";
import type { IndexRow, Provenance } from "./document";
import { archiveUrl, indexUrl, type ArchiveProvider } from "./sources";
import { loadScanCache, locateAll, forEachArchive, scanMissingHeaders, memLine, type Located } from "./pipeline";
import { FilingRejected, parseReturn990, type ParsedReturn990 } from "./parse-990";
import { CHARITY_LOADER_VERSION, loadedCharityDoc, sha256Hex, unreadCharityDoc, type CharityFilingDoc } from "./document-990";
import { CHARITY_RULE_TEXT, DEFAULT_CHARITY_THRESHOLD, factsOf, kindsForFunder, type CharityThreshold, type FunderKinds, type ReturnFacts } from "./charity-scope";
import type { CharitySink } from "./sink-990";
import { detach } from "./strings";

export const CHARITY_DEFAULT_MAX_RETURN_BYTES = 64_000_000;
export const CHARITY_DEFAULT_MAX_WRITE_BYTES = 16_000_000;

export interface CharityPipelineParams {
  periodYears: number[];
  state: string | null; // keep only filers whose US address is in this state; null = any
  threshold: CharityThreshold;
  workDir: string;
  /** Rows from the index CSVs, already filtered to return type 990 and the period years. */
  rows: IndexRow[];
  sources: unknown[];
  dryRun?: boolean;
  /** Write every in-scope return again even if it is already stored identically (needed after the threshold changes: the label is on the funder). */
  rewriteAll?: boolean;
  maxReturnBytes?: number;
  maxWriteBytes?: number;
}

export interface CharityCounts {
  index_rows_considered: number;
  out_of_scope_state: number;
  status_unread: number;
  unread_not_located: number;
  status_not_in_scope: number;
  status_loaded: number;
  status_superseded: number;
  outcomes_sum_check: boolean;
  rows_written: number;
  rows_unchanged: number;
  full_reads: number;
  pass_a_cache_hits: number;
  header_reads_used: number;
  funders_read: number;
  funders_in_scope: number;
  funders_public_charity: number;
  funders_daf_sponsor: number;
  funders_both_kinds: number;
  funders_not_in_scope: number;
  /** Not in scope, but the largest grants-to-organizations figure any return states is from `just_under_from_amt` up to the threshold. */
  funders_just_under_threshold: number;
  funders_with_no_part_ix_line_1_total_in_any_return: number;
  returns_stating_part_ix_line_1_total: number;
  returns_not_stating_part_ix_line_1_total: number;
  returns_with_schedule_i: number;
  returns_with_schedule_d: number;
  funders_with_daf_box_but_no_schedule_d_fund_count: number;
  loaded_filings_with_unmapped_schedule_i_fields: number;
  coverage_loaded: number;
  coverage_unread: number;
  coverage_no_filing_in_index: number;
  set: string;
  threshold: { min_org_grants_amt: number; just_under_from_amt: number; rule: string };
}

export interface CharityRunSummary {
  runId: string;
  counts: CharityCounts;
  rejected: Array<{ object_id: string; ein: string; reason: string }>;
  coverage: CoverageRow[];
  seconds: number;
}

type XmlFacts = { sha256: string; bytes: number };
type Head = { taxPeriodEnd: string; taxPeriodBegin: string | null; taxYr: string | null; returnVersion: string | null; returnTs: string | null };
type Assessed = { row: IndexRow; loc: Located; xml: XmlFacts; head: Head; facts: ReturnFacts; hasScheduleI: boolean; hasScheduleD: boolean };

const PASS_A_CACHE_VERSION = 1;
const LARGE_RETURN_BYTES = 20_000_000;

interface PassARecord {
  v: number;
  loader: string;
  state: string | null;
  objectId: string;
  xmlBytes: number;
  outcome: "assessed" | "out_of_state" | "unread";
  xml?: XmlFacts;
  head?: Head;
  facts?: ReturnFacts;
  hasScheduleI?: boolean;
  hasScheduleD?: boolean;
  reason?: string;
}

function loadPassACache(path: string, state: string | null): Map<string, PassARecord> {
  const m = new Map<string, PassARecord>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as PassARecord;
      if (r.v === PASS_A_CACHE_VERSION && r.loader === CHARITY_LOADER_VERSION && r.state === state) m.set(r.objectId, r);
    } catch {
      // a torn last line from a killed run; that return is simply read again
    }
  }
  return m;
}

function reasonOf(e: unknown): string {
  return e instanceof FilingRejected ? e.reason : `parser error (a loader defect, not necessarily a bad filing): ${(e as Error).message}`;
}

function checkAgainstIndex(f: ParsedReturn990, row: IndexRow) {
  if (f.ein !== row.ein) throw new FilingRejected(`the return's EIN is ${f.ein}; the IRS index says ${row.ein}`);
  if (f.taxPeriodEnd.slice(0, 7).replace("-", "") !== row.taxPeriod) throw new FilingRejected(`the return's tax period end is ${f.taxPeriodEnd}; the IRS index says ${row.taxPeriod}`);
}

const stateOf = (f: ParsedReturn990): string | null => (f.filer.address && f.filer.address.country === null ? f.filer.address.state : null);

export async function runCharityPipeline(sink: CharitySink, provider: ArchiveProvider, p: CharityPipelineParams, log: (s: string) => void): Promise<CharityRunSummary> {
  const t0 = Date.now();
  const runId = randomUUID();
  const loadedAt = new Date().toISOString();
  const th = p.threshold ?? DEFAULT_CHARITY_THRESHOLD;
  const counts: CharityCounts = {
    index_rows_considered: p.rows.length,
    out_of_scope_state: 0,
    status_unread: 0,
    unread_not_located: 0,
    status_not_in_scope: 0,
    status_loaded: 0,
    status_superseded: 0,
    outcomes_sum_check: false,
    rows_written: 0,
    rows_unchanged: 0,
    full_reads: 0,
    pass_a_cache_hits: 0,
    header_reads_used: 0,
    funders_read: 0,
    funders_in_scope: 0,
    funders_public_charity: 0,
    funders_daf_sponsor: 0,
    funders_both_kinds: 0,
    funders_not_in_scope: 0,
    funders_just_under_threshold: 0,
    funders_with_no_part_ix_line_1_total_in_any_return: 0,
    returns_stating_part_ix_line_1_total: 0,
    returns_not_stating_part_ix_line_1_total: 0,
    returns_with_schedule_i: 0,
    returns_with_schedule_d: 0,
    funders_with_daf_box_but_no_schedule_d_fund_count: 0,
    loaded_filings_with_unmapped_schedule_i_fields: 0,
    coverage_loaded: 0,
    coverage_unread: 0,
    coverage_no_filing_in_index: 0,
    set: `Form 990 returns with a tax period ending in ${p.periodYears.join("/")}${p.state ? ` whose filer address is in ${p.state}` : ""}; each funder counted once, over every such return read for it`,
    threshold: { min_org_grants_amt: th.minOrgGrantsAmt, just_under_from_amt: th.justUnderFromAmt, rule: CHARITY_RULE_TEXT },
  };
  const rejected: CharityRunSummary["rejected"] = [];
  const maxReturnBytes = p.maxReturnBytes ?? CHARITY_DEFAULT_MAX_RETURN_BYTES;
  const maxWriteBytes = p.maxWriteBytes ?? CHARITY_DEFAULT_MAX_WRITE_BYTES;
  mkdirSync(p.workDir, { recursive: true });

  if (!p.dryRun) {
    await sink.startRun({
      id: runId,
      loaderVersion: CHARITY_LOADER_VERSION,
      parameters: {
        kind: "public_charity_and_daf_sponsor",
        returnType: "990",
        periodYears: p.periodYears,
        state: p.state,
        threshold: { minOrgGrantsAmt: th.minOrgGrantsAmt, justUnderFromAmt: th.justUnderFromAmt },
        rule: CHARITY_RULE_TEXT,
        formsNotCovered: ["990-EZ", "990-N"],
        loaderVersion: CHARITY_LOADER_VERSION,
      },
    });
  }

  try {
    const byId = new Map(p.rows.map((r) => [r.objectId, r]));
    const prov = (r: IndexRow, loc: Located | undefined): Provenance => ({
      runId,
      loadedAt,
      loaderVersion: CHARITY_LOADER_VERSION,
      index: r,
      archiveUrl: loc ? archiveUrl(loc.archive) : indexUrl(Number(/index_(\d{4})\.csv/.exec(r.indexFile)?.[1] ?? r.subYear ?? 0)),
      member: loc ? loc.entry.name : `(not found in any archive) ${r.objectId}_public.xml`,
    });
    const earlyDocs: CharityFilingDoc[] = []; // unread filings, small
    const unread = (r: IndexRow, loc: Located | undefined, reasonIn: string, xml?: XmlFacts) => {
      const reason = detach(reasonIn);
      counts.status_unread++;
      rejected.push({ object_id: r.objectId, ein: r.ein, reason });
      earlyDocs.push(unreadCharityDoc(prov(r, loc), reason, xml));
    };

    // ---- 1. locate every row's member (shared with the foundation loader) ----------------------
    log(`locating ${p.rows.length} index row(s) in the IRS archives ...`);
    const located = await locateAll(p.rows, provider, log);
    log(`located ${located.size} of ${p.rows.length} ${memLine()}`);
    for (const r of p.rows) {
      if (located.has(r.objectId)) continue;
      counts.unread_not_located++;
      const tried = r.batchId ? `archive ${r.batchId}, then every archive` : `the archives that can hold a return submitted in ${r.subYear ?? "an unknown year"}, then every archive`;
      unread(r, undefined, `not found: no member named ${r.objectId}_public.xml in ${tried}, or the archive could not be opened`);
    }

    // ---- 2. which located rows are in the requested state (header only) -----------------------
    const useState = !!p.state;
    const scanCache = join(p.workDir, "header-scan-cache.jsonl");
    const scanned = loadScanCache(scanCache);
    if (useState) await scanMissingHeaders(located, scanned, scanCache, provider, p.state, log);
    const inStateIds: string[] = [];
    for (const id of located.keys()) {
      const s = scanned.get(id);
      if (useState && s && s.ein !== null) {
        counts.header_reads_used++;
        if (s.state !== p.state) {
          counts.out_of_scope_state++;
          continue;
        }
      }
      inStateIds.push(id);
    }

    // ---- 3. pass A: read each in-state return whole, check it, keep the facts the rule needs -----
    log(`pass A: reading ${inStateIds.length} return(s) in full ...`);
    const assessed = new Map<string, Assessed>();
    const passACachePath = join(p.workDir, "pass-a-990-cache.jsonl");
    const cacheState = useState ? p.state : null;
    const passACache = loadPassACache(passACachePath, cacheState);
    const remember = (rec: PassARecord) => appendFileSync(passACachePath, JSON.stringify(rec) + "\n");
    await forEachArchive(located, inStateIds, provider, async (zip, ids, archive) => {
      let done = 0;
      for (const id of ids) {
        const row = byId.get(id)!;
        const loc = located.get(id)!;
        counts.full_reads++;
        if (++done % 1000 === 0) log(`  pass A ${archive}: ${done} of ${ids.length} ${memLine()}`);

        const hit = passACache.get(id);
        if (hit && hit.xmlBytes === loc.entry.size) {
          counts.pass_a_cache_hits++;
          if (hit.outcome === "out_of_state") counts.out_of_scope_state++;
          else if (hit.outcome === "unread") unread(row, loc, hit.reason ?? "unread (reason not cached)", hit.xml);
          else if (hit.head && hit.facts) assessed.set(id, { row, loc, xml: hit.xml!, head: hit.head, facts: hit.facts, hasScheduleI: !!hit.hasScheduleI, hasScheduleD: !!hit.hasScheduleD });
          continue;
        }
        if (loc.entry.size > LARGE_RETURN_BYTES) log(`  large return ${id}: ${(loc.entry.size / 1e6).toFixed(1)} MB uncompressed ${memLine()}`);
        if (loc.entry.size > maxReturnBytes) {
          unread(row, loc, `the return is ${(loc.entry.size / 1e6).toFixed(1)} MB of XML, over the loader's ${(maxReturnBytes / 1e6).toFixed(0)} MB limit for reading one return; it was not parsed or stored`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await zip.read(loc.entry);
        } catch (e) {
          unread(row, loc, `archive member could not be decompressed: ${(e as Error).message}`);
          continue;
        }
        const xml = { sha256: sha256Hex(bytes), bytes: bytes.length };
        try {
          const f = parseReturn990(Buffer.from(bytes).toString("utf8"));
          checkAgainstIndex(f, row);
          if (useState && stateOf(f) !== p.state) {
            counts.out_of_scope_state++;
            remember({ v: PASS_A_CACHE_VERSION, loader: CHARITY_LOADER_VERSION, state: cacheState, objectId: id, xmlBytes: loc.entry.size, outcome: "out_of_state" });
            continue;
          }
          const head: Head = { taxPeriodEnd: detach(f.taxPeriodEnd), taxPeriodBegin: detach(f.taxPeriodBegin), taxYr: detach(f.taxYr), returnVersion: detach(f.returnVersion), returnTs: detach(f.returnTs) };
          const facts = factsOf(f);
          assessed.set(id, { row, loc, xml, head, facts, hasScheduleI: f.hasScheduleI, hasScheduleD: f.hasScheduleD });
          remember({ v: PASS_A_CACHE_VERSION, loader: CHARITY_LOADER_VERSION, state: cacheState, objectId: id, xmlBytes: loc.entry.size, outcome: "assessed", xml, head, facts, hasScheduleI: f.hasScheduleI, hasScheduleD: f.hasScheduleD });
        } catch (e) {
          const reason = reasonOf(e);
          unread(row, loc, reason, xml);
          remember({ v: PASS_A_CACHE_VERSION, loader: CHARITY_LOADER_VERSION, state: cacheState, objectId: id, xmlBytes: loc.entry.size, outcome: "unread", xml, reason });
        }
      }
      log(`  pass A ${archive}: ${ids.length} ${memLine()}`);
    });

    // ---- 4. decide scope per funder (ruling 0047 clause 8) -------------------------------------------
    const byEin = new Map<string, Assessed[]>();
    for (const x of assessed.values()) {
      const arr = byEin.get(x.row.ein) ?? [];
      arr.push(x);
      byEin.set(x.row.ein, arr);
      if (x.facts.orgGrantsAmt === null) counts.returns_not_stating_part_ix_line_1_total++;
      else counts.returns_stating_part_ix_line_1_total++;
      if (x.hasScheduleI) counts.returns_with_schedule_i++;
      if (x.hasScheduleD) counts.returns_with_schedule_d++;
    }
    counts.funders_read = byEin.size;
    const kindsByEin = new Map<string, FunderKinds>();
    const inScopeIds: string[] = [];
    const inScopeEins = new Set<string>();
    for (const [ein, list] of byEin) {
      const kinds = kindsForFunder(list.map((x) => ({ ...x.facts, taxPeriodEnd: x.head.taxPeriodEnd })), th);
      kindsByEin.set(ein, kinds);
      if (kinds.maxOrgGrantsAmt === null) counts.funders_with_no_part_ix_line_1_total_in_any_return++;
      if (kinds.dafBoxWithoutScheduleDCount) counts.funders_with_daf_box_but_no_schedule_d_fund_count++;
      if (kinds.inScope) {
        inScopeEins.add(ein);
        counts.funders_in_scope++;
        if (kinds.isGrantmakingPublicCharity) counts.funders_public_charity++;
        if (kinds.isDafSponsor) counts.funders_daf_sponsor++;
        if (kinds.isGrantmakingPublicCharity && kinds.isDafSponsor) counts.funders_both_kinds++;
        for (const x of list) inScopeIds.push(x.row.objectId);
      } else {
        counts.funders_not_in_scope++;
        if (kinds.justUnder) counts.funders_just_under_threshold++;
        counts.status_not_in_scope += list.length; // counted, not stored
      }
    }

    // ---- 5. pass B: re-read in-scope returns, build full documents, write ------------------------------
    const existing: Map<string, ExistingFiling> = p.dryRun ? new Map() : await sink.existingFilings([...earlyDocs.map((d) => String(d.filing.object_id)), ...inScopeIds]);
    const finalStatus = new Map<string, string>();
    const dryLoaded: CharityFilingDoc[] = [];
    const apply = async (doc: CharityFilingDoc) => {
      const f = doc.filing;
      const id = String(f.object_id);
      const prev = existing.get(id);
      const sameStatus = prev && (prev.status === f.status || (f.status === "loaded" && prev.status === "superseded"));
      const same =
        !p.rewriteAll &&
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
        if (f.status === "loaded") dryLoaded.push({ filing: { object_id: id, ein: f.ein, tax_period_end: f.tax_period_end, return_ts: detach(f.return_ts as string | null), status: "loaded" }, charity: null, figures: null, daf: null, grants: [] });
        return;
      }
      const result = await sink.applyFiling(doc);
      counts.rows_written++;
      finalStatus.set(id, result);
    };

    log(`writing ${earlyDocs.length} unread filing record(s) ...`);
    let earlyDone = 0;
    for (const d of earlyDocs) {
      await apply(d);
      if (++earlyDone % 500 === 0) log(`  recorded ${earlyDone}/${earlyDocs.length} unread filing record(s)`);
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
        const f = parseReturn990(Buffer.from(bytes).toString("utf8"));
        if (f.rows.some((r) => Object.keys(r.unmappedFields).length)) counts.loaded_filings_with_unmapped_schedule_i_fields++;
        const doc = loadedCharityDoc(prov(x.row, x.loc), f, facts, kindsByEin.get(x.row.ein)!, th);
        const docBytes = JSON.stringify(doc).length;
        if (docBytes > maxWriteBytes) {
          unread(x.row, x.loc, `the filing lists ${f.rows.length} recipients; its write document is ${(docBytes / 1e6).toFixed(1)} MB, over the loader's ${(maxWriteBytes / 1e6).toFixed(0)} MB limit for one database call; it was not stored`, facts);
          await apply(earlyDocs[earlyDocs.length - 1]);
          continue;
        }
        await apply(doc);
        if (++applied % 500 === 0) log(`  written ${applied}/${inScopeIds.length}`);
      }
      log(`  pass B ${archive}: ${ids.length}`);
    });

    // The status each row ended with is read back from the database (authoritative), or, in a dry run,
    // worked out by the rule the database function applies.
    if (!p.dryRun) {
      const after = await sink.existingFilings([...finalStatus.keys()]);
      for (const [id] of finalStatus) finalStatus.set(id, after.get(id)?.status ?? "missing");
    } else {
      const groups = new Map<string, CharityFilingDoc[]>();
      for (const d of dryLoaded) groups.set(`${d.filing.ein}|${d.filing.tax_period_end}`, [...(groups.get(`${d.filing.ein}|${d.filing.tax_period_end}`) ?? []), d]);
      for (const g of groups.values()) {
        g.sort((a, b) => String(b.filing.return_ts ?? "").localeCompare(String(a.filing.return_ts ?? "")) || String(b.filing.object_id).localeCompare(String(a.filing.object_id)));
        g.forEach((d, i) => finalStatus.set(String(d.filing.object_id), i === 0 ? "loaded" : "superseded"));
      }
    }
    for (const st of finalStatus.values()) {
      if (st === "loaded") counts.status_loaded++;
      else if (st === "superseded") counts.status_superseded++;
    }
    counts.outcomes_sum_check =
      counts.index_rows_considered === counts.out_of_scope_state + counts.status_unread + counts.status_not_in_scope + counts.status_loaded + counts.status_superseded;

    // ---- 6. coverage, for the funders stored: which periods are held and which are not ---------------
    // Only a year for which this run can say what happened is written. A year whose index row was left
    // to another state's run (it is not decided here and not yet stored) gets NO row: "no filing in the
    // index" would be false, and nothing else is true yet.
    const coverage: CoverageRow[] = [];
    const checkedAt = new Date().toISOString();
    const rowsByEin = new Map<string, IndexRow[]>();
    for (const r of p.rows) {
      if (!inScopeEins.has(r.ein)) continue;
      const a = rowsByEin.get(r.ein) ?? [];
      a.push(r);
      rowsByEin.set(r.ein, a);
    }
    const notDecidedHere: string[] = [];
    for (const rs of rowsByEin.values()) for (const r of rs) if (!finalStatus.has(r.objectId)) notDecidedHere.push(r.objectId);
    const heldElsewhere: Map<string, ExistingFiling> = p.dryRun ? new Map() : await sink.existingFilings(notDecidedHere);
    const statusOf = (id: string): string | undefined => finalStatus.get(id) ?? heldElsewhere.get(id)?.status;
    const rejectedIds = new Set(rejected.map((r) => r.object_id));
    const indexFiles = [...new Set(p.rows.map((r) => r.indexFile))].sort().join(", ");
    for (const ein of [...inScopeEins].sort()) {
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
          row = { ein, period_year: year, status: "unread", filing_object_id: unreadRows[0].objectId, note: `the IRS index lists ${unreadRows.length} return(s) for a period ending in ${year} and none could be read; see charity_reference_filings`, run_id: runId, checked_at: checkedAt };
        } else if (inYear.length > 0) {
          continue; // in the index, decided by another state's run and not stored yet: no claim either way
        } else {
          counts.coverage_no_filing_in_index++;
          row = {
            ein,
            period_year: year,
            status: "no_filing_in_index",
            filing_object_id: null,
            note: `no Form 990 for a tax period ending in ${year} is in the IRS index files this run read (${indexFiles}); an absence in the data, not a statement that nothing was given`,
            run_id: runId,
            checked_at: checkedAt,
          };
        }
        coverage.push(row);
      }
    }
    // every funder this run read is replaced, so one that has dropped out of scope does not keep coverage rows that claim periods are held
    if (!p.dryRun) await sink.replaceCoverage([...byEin.keys()], coverage);

    if (!p.dryRun) await sink.finishRun(runId, { status: "completed", counts: counts as unknown as Record<string, unknown>, rejected_filings: rejected, sources: p.sources });
    return { runId, counts, rejected, coverage, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    if (!p.dryRun) {
      await sink.finishRun(runId, { status: "failed", counts: counts as unknown as Record<string, unknown>, rejected_filings: rejected, sources: p.sources, notes: (e as Error).message }).catch(() => undefined);
    }
    throw e;
  }
}
