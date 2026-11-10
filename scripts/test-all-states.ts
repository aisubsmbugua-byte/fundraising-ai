// Item 114, authorized by ruling 0046: tests for the all-states command.
//
// FOR THE OWNER. Proves, without touching a real database or the IRS, that the
// command: puts New York, Texas, Florida, Pennsylvania and Illinois first and the rest
// by number of returns; skips a state that is already complete and does nothing the
// second time; retries a failed state a bounded number of times and carries on; stops
// before the next state when a sample difference is not on the written exception list
// and carries on when it is; and writes its progress to the run table. Section E runs
// the real command, with real child processes and a real local PostgreSQL, over a small
// set of real-shaped IRS returns in three states.
//
// Usage: npx tsx scripts/test-all-states.ts

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_THRESHOLD } from "../lib/funder-reference/derive";
import { SUPERVISOR_RUN_ID, pgliteRunStore, supabaseRunStore } from "../lib/funder-reference/run-store";
import {
  ALL_STATES_VERSION,
  PRIORITY_STATES,
  annotationOf,
  backoffSeconds,
  chooseSample,
  classifyMismatches,
  decideState,
  evaluateLoad,
  orderStates,
  parseVerifierOutput,
  runAllStates,
  stateInputDigests,
  validateExceptions,
  verificationMode,
  type Annotation,
  type Deps,
  type ExceptionEntry,
  type FunderCount,
  type Manifest,
  type Options,
  type RunRow,
  type Store,
  type VerificationRecord,
  type Wanted,
} from "../lib/funder-reference/supervisor";
import { openReferenceDb } from "./funder-reference-support";
import { makeZip } from "./funder-reference-test-support";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

const root = join(__dirname, "..");
const LV = "funder-reference-loader/1.0.0";
const YEARS = [2022, 2023, 2024];

// ---------------------------------------------------------------------------
// helpers: a run row that is sound, and a fake store
// ---------------------------------------------------------------------------
let seq = 0;
function sound(state: string, over: Partial<RunRow> = {}, counts: Record<string, unknown> = {}): RunRow {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    started_at: new Date(2026, 10, 9, 12, 0, seq).toISOString(),
    finished_at: new Date(2026, 10, 9, 12, 5, seq).toISOString(),
    loader_version: LV,
    status: "completed",
    parameters: { state, periodYears: YEARS, threshold: DEFAULT_THRESHOLD, eins: null },
    counts: {
      index_rows_considered: 100,
      out_of_scope_state: 80,
      status_unread: 1,
      status_skipped_below_threshold: 9,
      status_loaded: 9,
      status_superseded: 1,
      outcomes_sum_check: true,
      header_audit: { sampled: 50, said_not_in_state_but_return_is_in_state: 0 },
      ...counts,
    },
    notes: null,
    ...over,
  };
}
const want = (state: string, over: Partial<Wanted> = {}): Wanted => ({ loaderVersion: LV, years: YEARS, threshold: DEFAULT_THRESHOLD, state, digest: `digest-${state}`, verification: { mode: "sample", size: 150, seed: "seed" }, ...over });
function verified(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return { verified: true, mode: "sample", seed: "seed", size_requested: 150, funders_in_state: 300, funders_checked: 150, must_include: { most_grant_rows: [], most_people_rows: [] }, compared: 1000, mismatches: 0, explained: [], unexplained: 0, unexplained_examples: [], exceptions_sha256: "x", verified_at: "2026-11-09T00:00:00Z", ...over };
}
function annotated(state: string, ann: Partial<Annotation> = {}, over: Partial<RunRow> = {}): RunRow {
  const a: Annotation = { command: ALL_STATES_VERSION, input_digest: `digest-${state}`, input_rows: 100, loader_version: LV, years: YEARS, threshold: DEFAULT_THRESHOLD, state, verification: verified(), complete: true, problems: [], updated_at: "x", ...ann };
  return sound(state, over, { supervisor: a });
}

class FakeStore implements Store {
  readonly label = "fake";
  runs: RunRow[] = [];
  supervisorWrites: Array<{ status: string; counts: Record<string, unknown>; notes: string; begin?: boolean }> = [];
  insertedRuns = 0; // rows created by anything but the standing supervisor row
  supervisorRowCreated = 0;
  standingExists = false;
  interrupted: string[] = [];
  releases = 0;
  funders: Record<string, FunderCount[]> = {};
  async runsForState(state: string) {
    return this.runs.filter((r) => (r.parameters as { state?: string }).state === state).sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  async getRun(id: string) {
    return this.runs.find((r) => r.id === id) ?? null;
  }
  async annotate(id: string, patch: Record<string, unknown>) {
    const r = this.runs.find((x) => x.id === id)!;
    r.counts = { ...r.counts, ...patch };
  }
  async markInterrupted(ids: string[]) {
    for (const r of this.runs) if (ids.includes(r.id) && r.status === "running") r.status = "interrupted";
    this.interrupted.push(...ids);
  }
  async funderCounts(state: string) {
    return this.funders[state] ?? [{ ein: "111111111", grants: 5, people: 2 }];
  }
  async writeSupervisor(row: { status: "running" | "completed" | "failed" | "interrupted"; counts: Record<string, unknown>; notes: string; begin?: boolean }) {
    if (!this.standingExists) this.supervisorRowCreated++;
    this.standingExists = true;
    this.supervisorWrites.push(row);
  }
  async release() {
    this.releases++;
  }
}

interface Script {
  /** per state: the outcome of each attempt, in order; true = loads fine, string = fails with that error */
  attempts?: Record<string, Array<true | string>>;
  /** per state: lines the verifier prints as mismatches */
  mismatches?: Record<string, string[]>;
  verifierCrashFor?: string[];
  /** per state: counts to override on the run the child "creates" */
  runCounts?: Record<string, Record<string, unknown>>;
}
function makeDeps(store: FakeStore, script: Script = {}) {
  const calls = { children: [] as Array<[string, number]>, verifier: [] as string[][], sleeps: [] as number[], manifestWrites: 0 };
  let manifest: Manifest = { states: {} };
  let t = 0;
  let lastState = "";
  const deps: Deps = {
    store,
    readManifest: () => manifest,
    writeManifest: (m) => {
      manifest = m;
      calls.manifestWrites++;
    },
    now: () => new Date(Date.UTC(2026, 10, 9, 12, 0, t++)),
    log: () => undefined,
    sleep: async (ms) => void calls.sleeps.push(ms),
    async runChild(state, attempt) {
      calls.children.push([state, attempt]);
      lastState = state;
      const plan = script.attempts?.[state]?.[attempt - 1] ?? true;
      if (plan !== true) {
        // a failed attempt leaves its run recorded as running, as a killed process does
        store.runs.push(sound(state, { status: "running", finished_at: null }, {}));
        return { ok: false, error: plan };
      }
      const r = sound(state, {}, script.runCounts?.[state] ?? {});
      store.runs.push(r);
      store.insertedRuns++;
      return { ok: true, runId: r.id, peakRssMb: 700, seconds: 12 };
    },
    async runVerifier(eins, state) {
      calls.verifier.push(eins);
      lastState = state;
      if (script.verifierCrashFor?.includes(lastState)) return { completed: false, compared: 0, lines: [], error: "exit 137" };
      return { completed: true, compared: 100 * eins.length, lines: script.mismatches?.[lastState] ?? [] };
    },
  };
  return { deps, calls, manifest: () => manifest };
}
function opts(states: string[], over: Partial<Options> = {}): Options {
  return {
    states,
    digests: Object.fromEntries(states.map((s) => [s, { rows: 100, digest: `digest-${s}` }])),
    loaderVersion: LV,
    years: YEARS,
    threshold: DEFAULT_THRESHOLD,
    sampleSize: 150,
    seed: "seed",
    forceFull: false,
    maxAttempts: 3,
    exceptions: [],
    exceptionsSha256: "x",
    dryRun: false,
    parameters: { test: true },
    ...over,
  };
}
const EX_CITY: ExceptionEntry = { id: "city-case", cause: "a known harmless difference in letter case of city names", pattern: "^\\[\\d{9}\\] foundation\\.city: stored", evidence: "EIN 582218044, 2026-11-09, example only", date: "2026-11-09" };

async function main() {
  // =========================================================================
  section("A. the order states are loaded in");
  {
    const counts: Record<string, number> = { CA: 36627, NY: 36388, TX: 32359, FL: 27100, PA: 22679, IL: 18281, OH: 13780, MA: 11983, DC: 1783, AK: 412, WY: 1234, VT: 1020, ZZ: 0 };
    const o = orderStates(counts);
    ok("New York, Texas, Florida, Pennsylvania and Illinois come first, in the owner's order", o.slice(0, 5).join() === "NY,TX,FL,PA,IL", o.join());
    ok("the rest follow by number of returns, most first (California, with the most, is first of the rest)", o.slice(5).join() === "CA,OH,MA,DC,WY,VT,AK", o.join());
    ok("a state with no returns is not listed", !o.includes("ZZ"));
    ok("the priority states are exactly the owner's five", PRIORITY_STATES.join() === "NY,TX,FL,PA,IL");
    ok("a priority state absent from the data is simply left out", orderStates({ TX: 5, OH: 9 }).join() === "TX,OH");
    ok("equal counts are ordered by name, so the order never depends on map order", orderStates({ B: 3, A: 3, C: 3 }).join() === "A,B,C");
  }

  // =========================================================================
  section("B. the input a state's run was made from (what makes an earlier 'complete' stale)");
  {
    const rows = [
      { objectId: "100000000000000001", state: "NY", headerRead: true },
      { objectId: "100000000000000002", state: "NY", headerRead: true },
      { objectId: "100000000000000003", state: "TX", headerRead: true },
      { objectId: "100000000000000004", state: null, headerRead: true }, // foreign address: in no state
      { objectId: "100000000000000005", state: null, headerRead: false }, // header unreadable: every state reads it
    ];
    const d = stateInputDigests(rows);
    ok("a count per state, an unreadable header counted into every state, a foreign filer into none", d.NY.rows === 3 && d.TX.rows === 2 && Object.keys(d).join() === "NY,TX", JSON.stringify(d));
    ok("the digest does not depend on the order rows are listed in", stateInputDigests([...rows].reverse()).NY.digest === d.NY.digest);
    const more = stateInputDigests([...rows, { objectId: "100000000000000006", state: "NY", headerRead: true }]);
    ok("a new return in a state changes that state's digest and not another state's", more.NY.digest !== d.NY.digest && more.TX.digest === d.TX.digest);
    const swapped = stateInputDigests(rows.map((r) => (r.objectId.endsWith("2") ? { ...r, objectId: "100000000000000099" } : r)));
    ok("a different return with the same count changes the digest", swapped.NY.digest !== d.NY.digest);
  }

  // =========================================================================
  section("C. a state is complete only when four things are recorded (ruling 0046 clause 3)");
  {
    ok("a sound run has no problems", evaluateLoad(sound("NY"), want("NY")).length === 0);
    ok("1. a run that did not finish is not sound", evaluateLoad(sound("NY", { status: "running" }), want("NY")).some((p) => /did not finish/.test(p)));
    ok("1. a failed run is not sound", evaluateLoad(sound("NY", { status: "failed" }), want("NY")).length > 0);
    ok("2. counts that do not sum to the returns considered are not sound (recomputed, not trusted from the run's own flag)", evaluateLoad(sound("NY", {}, { status_loaded: 8, outcomes_sum_check: true }), want("NY")).some((p) => /add up to 99/.test(p)));
    ok("2. missing counts are not sound", evaluateLoad(sound("NY", {}, { status_loaded: undefined }), want("NY")).length > 0);
    ok("3. a header audit that found a return the header had put elsewhere is not sound", evaluateLoad(sound("NY", {}, { header_audit: { sampled: 50, said_not_in_state_but_return_is_in_state: 1 } }), want("NY")).some((p) => /1 return/.test(p)));
    ok("3. a run with no header audit is not sound", evaluateLoad(sound("NY", {}, { header_audit: null }), want("NY")).some((p) => /audit was not run/.test(p)));
    ok("3. an audit that read nothing is not sound", evaluateLoad(sound("NY", {}, { header_audit: { sampled: 0, said_not_in_state_but_return_is_in_state: 0 } }), want("NY")).length > 0);
    ok("a run by another loader version is not sound", evaluateLoad(sound("NY", { loader_version: "funder-reference-loader/0.9" }), want("NY")).length > 0);
    ok("a run for another state is not sound", evaluateLoad(sound("TX"), want("NY")).length > 0);
    ok("a run over other years is not sound", evaluateLoad(sound("NY", { parameters: { state: "NY", periodYears: [2021, 2022], threshold: DEFAULT_THRESHOLD } }), want("NY")).length > 0);
    ok("the threshold is compared whatever order the database lists its keys in", evaluateLoad(sound("NY", { parameters: { state: "NY", periodYears: YEARS, threshold: { minContributionsPaidPerBooksAmt: DEFAULT_THRESHOLD.minContributionsPaidPerBooksAmt, minAssetsFmvAmt: DEFAULT_THRESHOLD.minAssetsFmvAmt } } }), want("NY")).length === 0);
    ok("a run with another size threshold is not sound", evaluateLoad(sound("NY", { parameters: { state: "NY", periodYears: YEARS, threshold: { minAssetsFmvAmt: 5, minContributionsPaidPerBooksAmt: 5 } } }), want("NY")).length > 0);
    ok("no run at all is not sound", evaluateLoad(null, want("NY")).length > 0);

    const done = annotated("NY");
    ok("sound + same input + verified sample with nothing unexplained = SKIP", decideState([done], want("NY")).action === "skip");
    ok("a run this command never checked is not skipped: it is loaded (its input is unknown)", decideState([sound("NY")], want("NY")).action === "load");
    ok("sound but the sample was never verified = VERIFY only, no reload", decideState([annotated("NY", { verification: null, complete: false })], want("NY")).action === "verify");
    ok("a sample recorded as not verified = VERIFY again", decideState([annotated("NY", { verification: verified({ verified: false, unexplained: 2 }), complete: false })], want("NY")).action === "verify");
    ok("a verified record that still carries an unexplained mismatch is not complete", decideState([annotated("NY", { verification: verified({ verified: true, unexplained: 1 }) })], want("NY")).action === "verify");
    ok("a record that says verified:false is not complete even with no count or error beside it", decideState([annotated("NY", { verification: verified({ verified: false, unexplained: 0 }), complete: false })], want("NY")).action === "verify");
    ok("a verification that errored is not complete", decideState([annotated("NY", { verification: verified({ error: "exit 137" }) })], want("NY")).action === "verify");
    ok("the index gained returns for the state = LOAD", decideState([annotated("NY", { input_digest: "older" })], want("NY")).action === "load");
    ok("a smaller sample than now required = VERIFY again", decideState([annotated("NY", { verification: verified({ size_requested: 50 }) })], want("NY")).action === "verify");
    ok("a larger sample than required still counts", decideState([annotated("NY", { verification: verified({ size_requested: 400 }) })], want("NY")).action === "skip");
    ok("a full verification demanded and only a sample done = VERIFY again", decideState([done], want("NY", { verification: { mode: "full", size: 150, seed: "seed" } })).action === "verify");
    ok("a full verification satisfies a sample requirement", decideState([annotated("NY", { verification: verified({ mode: "full", size_requested: 300 }) })], want("NY")).action === "skip");
    ok("an unsound newest finished run = LOAD even if an older run was complete", decideState([sound("NY", {}, { status_loaded: 1 }), done], want("NY")).action === "load");
    ok("a failed attempt that came after a complete run does not undo it (same input, same code)", decideState([sound("NY", { status: "failed" }), done], want("NY")).action === "skip");
    ok("the newest FINISHED run decides, a later run still marked running is ignored", decideState([sound("NY", { status: "running", finished_at: null }), done], want("NY")).action === "skip");
    ok("no run = LOAD", decideState([], want("NY")).action === "load");
    const orphan = sound("NY");
    ok("a run whose note was never written but the manifest remembers = VERIFY (no reload)", decideState([orphan], want("NY"), orphan.id).action === "verify");
    ok("the manifest of another run does not count", decideState([orphan], want("NY"), "other").action === "load");
    ok("annotationOf reads counts.supervisor", annotationOf(done)?.state === "NY" && annotationOf(sound("NY")) === null);

    ok("first verification of a state is a sample", verificationMode([], LV, false) === "sample");
    ok("--full-verify makes it full", verificationMode([], LV, true) === "full");
    const oldVer = annotated("NY", {}, { loader_version: "funder-reference-loader/0.9" });
    ok("the first load after the loader's code changed, for a state verified under the old code, is verified in FULL (clause 4)", verificationMode([oldVer], LV, false) === "full");
    ok("once verified complete under the current code, a sample is enough", verificationMode([done], LV, false) === "sample");
  }

  // =========================================================================
  section("D. the sample, the exception list, the verifier's output, the retry pause");
  {
    const funders: FunderCount[] = Array.from({ length: 400 }, (_, i) => ({ ein: String(100000000 + i), grants: (i * 37) % 211, people: (i * 53) % 97 }));
    funders.push({ ein: "999999991", grants: 5000, people: 1 }, { ein: "999999992", grants: 1, people: 900 });
    const a = chooseSample(funders, 150, "seed", "NY");
    const b = chooseSample([...funders].reverse(), 150, "seed", "NY");
    ok("the sample has the stated size", a.eins.length === 150, String(a.eins.length));
    ok("the same seed and funders give the same sample, whatever order they arrive in", a.eins.join() === b.eins.join());
    ok("a different seed gives a different sample", chooseSample(funders, 150, "other", "NY").eins.join() !== a.eins.join());
    ok("a different state gives a different draw", chooseSample(funders, 150, "seed", "TX").eins.join() !== a.eins.join());
    ok("the funder with the most grant rows is always in", a.eins.includes("999999991") && a.mostGrantRows[0] === "999999991");
    ok("the funder with the most people rows is always in", a.eins.includes("999999992") && a.mostPeopleRows[0] === "999999992");
    ok("the ten with most grants and the ten with most people are all in", a.mostGrantRows.length === 10 && a.mostPeopleRows.length === 10 && [...a.mostGrantRows, ...a.mostPeopleRows].every((e) => a.eins.includes(e)));
    const sorted = [...funders].sort((x, y) => y.grants - x.grants).slice(0, 10).map((f) => f.ein);
    ok("those ten really are the ten highest by grant rows", a.mostGrantRows.join() === sorted.join());
    ok("a small state is checked whole", chooseSample(funders.slice(0, 30), 150, "seed", "VT").eins.length === 30);
    ok("a size smaller than the must-include set still includes them", chooseSample(funders, 5, "seed", "NY").eins.includes("999999991"));
    ok("a funder with no grant rows is not 'most grant rows'", chooseSample([{ ein: "1", grants: 0, people: 0 }, { ein: "2", grants: 0, people: 0 }], 1, "s", "VT").mostGrantRows.length === 0);

    // Successor of "the shipped exception list is valid and EMPTY": on 2026-11-09 the owner
    // accepted one named, narrow cause (funders with returns in more than one state; item 115
    // is the proper fix). The list may hold exactly that entry and nothing else.
    ok("the shipped exception list is valid and holds exactly the one entry the owner accepted (funder-in-two-states)", (() => { const t = JSON.parse(readFileSync(join(root, "lib/funder-reference/verify-exceptions.json"), "utf8")); const v = validateExceptions(t); return v.ok && v.entries.length === 1 && v.entries[0].id === "funder-in-two-states"; })());
    ok("that entry explains the funder-in-two-states line and nothing else", (() => { const t = JSON.parse(readFileSync(join(root, "lib/funder-reference/verify-exceptions.json"), "utf8")); const v = validateExceptions(t); if (!v.ok) return false; const c = classifyMismatches(["[462502407] no filing for this EIN is skipped below the threshold (a funder in scope has none): 202300000000000000:skipped_below_threshold", "[462502407] [202300000000000000 2023-12-31] foundation.city: stored \"A\" but the filing gives \"B\""], v.entries); return c.unexplained.length === 1 && /foundation\.city/.test(c.unexplained[0]); })());
    const good = { exceptions: [{ id: "x", cause: "c", pattern: "^\\[\\d+\\] foundation\\.city", evidence: "e", date: "2026-11-09" }] };
    ok("a complete entry is accepted", validateExceptions(good).ok);
    ok("an entry missing its evidence is refused", !validateExceptions({ exceptions: [{ ...good.exceptions[0], evidence: "" }] }).ok);
    ok("an entry missing its cause is refused", !validateExceptions({ exceptions: [{ ...good.exceptions[0], cause: undefined }] }).ok);
    ok("a date that is not YYYY-MM-DD is refused", !validateExceptions({ exceptions: [{ ...good.exceptions[0], date: "9 Nov" }] }).ok);
    ok("two entries with one id are refused", !validateExceptions({ exceptions: [good.exceptions[0], good.exceptions[0]] }).ok);
    ok("a pattern that is not a regular expression is refused", !validateExceptions({ exceptions: [{ ...good.exceptions[0], pattern: "(" }] }).ok);
    ok("a pattern that matches everything is refused", !validateExceptions({ exceptions: [{ ...good.exceptions[0], pattern: ".*" }] }).ok);
    ok("a pattern that matches the empty line is refused", !validateExceptions({ exceptions: [{ ...good.exceptions[0], pattern: "x*" }] }).ok);
    ok("a file with no exceptions list is refused", !validateExceptions({}).ok);

    const lines = ['[582218044] foundation.city: stored "Newport Beach" but the filing gives "NEWPORT BEACH"', '[582218044] [202343189349103439 2023-12-31] figures.total_assets_eoy_fmv_amt: stored 5 but the filing gives "6"'];
    const c = classifyMismatches(lines, [EX_CITY]);
    ok("a mismatch matching a written entry is explained, and counted under its id", c.explained.length === 1 && c.explained[0].exception_id === "city-case" && c.explained[0].count === 1);
    ok("a mismatch matching no entry is unexplained", c.unexplained.length === 1 && /total_assets/.test(c.unexplained[0]));
    ok("with an empty list every mismatch is unexplained", classifyMismatches(lines, []).unexplained.length === 2);
    ok("with no mismatches nothing is explained or unexplained", classifyMismatches([], [EX_CITY]).unexplained.length === 0);

    const out = "database: pglite:x; verifying 2 funder(s)\n\ncompared 120 stored values/properties with the filing(s) of 2 funder(s); 2 mismatch(es)\n  MISMATCH [1] a: stored 1 but the filing gives 2\n  MISMATCH [2] b: stored NULL but the filing gives \"x\"\n\nRESULT: FAIL\n";
    const p = parseVerifierOutput(out, 1);
    ok("the verifier's mismatch lines and counts are read", p.completed && p.compared === 120 && p.lines.length === 2 && /^\[1\] a:/.test(p.lines[0]));
    ok("a clean run is completed with no lines", parseVerifierOutput("compared 10 stored values/properties with the filing(s) of 1 funder(s); 0 mismatch(es)\n\nRESULT: PASS -- every stored value equals the filing\n", 0).completed);
    ok("output cut off before the result is NOT completed", !parseVerifierOutput("database: x\n", 1).completed);
    ok("a crash (exit 137) is NOT completed even if a summary line is there", !parseVerifierOutput(out, 137).completed);
    ok("a summary that reports more mismatches than were printed is NOT completed", !parseVerifierOutput(out.replace("  MISMATCH [2] b: stored NULL but the filing gives \"x\"\n", ""), 1).completed);

    ok("the pause before the next attempt grows: 30 s, then 120 s, then 480 s", backoffSeconds(1) === 30 && backoffSeconds(2) === 120 && backoffSeconds(3) === 480);
    ok("and is capped at 15 minutes", backoffSeconds(9) === 900);
  }

  // =========================================================================
  section("E. the loop, with the processes and the database faked");
  {
    // happy path: three states, in order, each loaded once, verified, annotated, recorded
    const st = new FakeStore();
    const { deps, calls, manifest } = makeDeps(st);
    const o = await runAllStates(deps, opts(["NY", "TX", "CA"]));
    ok("every state is loaded in the order given, once", calls.children.map((c) => c[0]).join() === "NY,TX,CA" && calls.children.every((c) => c[1] === 1));
    ok("every state ends complete and the command exits 0", Object.values(o.states).every((s) => s.status === "complete") && o.exitCode === 0, JSON.stringify(o.states));
    ok("the verifier was given a sample of the state's funders after each load", calls.verifier.length === 3 && calls.verifier.every((v) => v.length === 1));
    const ann = annotationOf(st.runs[0]);
    ok("each state's run carries the note: input digest, verified sample, complete", !!ann && ann.complete && ann.input_digest === "digest-NY" && ann.verification?.verified === true && ann.verification.funders_checked === 1);
    ok("the note records the memory the child used", ann?.peak_rss_mb === 700);
    ok("the standing row was written as it went, starting with 'running' and ending 'completed'", st.supervisorWrites[0].status === "running" && st.supervisorWrites[0].begin === true && st.supervisorWrites[st.supervisorWrites.length - 1].status === "completed");
    ok("it was written at every step (more than a start and an end)", st.supervisorWrites.length >= 12, String(st.supervisorWrites.length));
    ok("the final standing row names every state's status", (() => { const c = st.supervisorWrites[st.supervisorWrites.length - 1].counts as { states: Record<string, { status: string }> }; return c.states.NY.status === "complete" && c.states.CA.status === "complete"; })());
    ok("the work directory's manifest says each state is complete", manifest().states.NY?.phase === "complete" && manifest().states.CA?.phase === "complete");
    ok("the database was released before every child and every check", st.releases >= 6, String(st.releases));

    // idempotence: a second invocation does nothing
    const before = st.runs.length;
    const run2 = makeDeps(st);
    run2.deps.writeManifest(manifest());
    st.supervisorWrites = [];
    const o2 = await runAllStates(run2.deps, opts(["NY", "TX", "CA"]));
    ok("run twice: the second invocation loads nothing", run2.calls.children.length === 0, JSON.stringify(run2.calls.children));
    ok("run twice: the second invocation checks nothing", run2.calls.verifier.length === 0);
    ok("run twice: no new run row is created", st.runs.length === before && st.insertedRuns === 3);
    ok("run twice: every state is reported as skipped (complete)", Object.values(o2.states).every((s) => s.status === "skipped_complete") && o2.exitCode === 0);
    ok("run twice: the standing row is only updated (no second creation)", st.supervisorRowCreated === 1);

    // new IRS filings for one state: only that state reruns
    const run3 = makeDeps(st);
    const o3 = await runAllStates(run3.deps, opts(["NY", "TX", "CA"], { digests: { NY: { rows: 100, digest: "digest-NY" }, TX: { rows: 101, digest: "changed" }, CA: { rows: 100, digest: "digest-CA" } } }));
    ok("a month's new filings for Texas reload Texas only", run3.calls.children.map((c) => c[0]).join() === "TX" && o3.states.NY.status === "skipped_complete" && o3.states.TX.status === "complete");

    // dry run
    const stD = new FakeStore();
    const dr = makeDeps(stD);
    const od = await runAllStates(dr.deps, opts(["NY", "TX"], { dryRun: true }));
    ok("--dry-run starts no child, no verifier, and writes nothing anywhere", dr.calls.children.length === 0 && dr.calls.verifier.length === 0 && stD.supervisorWrites.length === 0 && dr.calls.manifestWrites === 0 && stD.runs.length === 0);
    ok("--dry-run still says what it would do, per state, with the reason", od.plan.length === 2 && od.plan.every((p) => p.action === "load" && p.why.length > 5));

    // a state complete before, in the middle: skipped, others loaded
    const stS = new FakeStore();
    stS.runs.push(annotated("TX"));
    const sk = makeDeps(stS);
    const os = await runAllStates(sk.deps, opts(["NY", "TX", "CA"]));
    ok("a state already complete is skipped while the others load", sk.calls.children.map((c) => c[0]).join() === "NY,CA" && os.states.TX.status === "skipped_complete");

    // a killed process left a run 'running' and no note
    const stK = new FakeStore();
    stK.runs.push(sound("NY", { status: "running", finished_at: null }));
    const k = makeDeps(stK);
    await runAllStates(k.deps, opts(["NY"]));
    ok("resuming after a kill: the run found still 'running' is marked interrupted, then the state loads again", stK.interrupted.length === 1 && k.calls.children.length === 1 && stK.runs.find((r) => r.status === "interrupted") !== undefined);

    // killed after the load finished but before its check: the manifest lets it verify without reloading
    const stM = new FakeStore();
    const loadedRun = sound("NY");
    stM.runs.push(loadedRun);
    const m = makeDeps(stM);
    m.deps.writeManifest({ states: { NY: { phase: "loaded", run_id: loadedRun.id, digest: "digest-NY", updated_at: "x" } } });
    const om = await runAllStates(m.deps, opts(["NY"]));
    ok("resuming after a kill between load and check: verifies the run that was loaded, loads nothing again", m.calls.children.length === 0 && m.calls.verifier.length === 1 && om.states.NY.status === "complete");
  }

  section("F. retry, backoff, failure and carrying on");
  {
    const st = new FakeStore();
    const { deps, calls } = makeDeps(st, { attempts: { NY: ["exit code 137 (probably out of memory)", true] } });
    const o = await runAllStates(deps, opts(["NY", "TX"]));
    ok("a failed attempt is tried again", calls.children.filter((c) => c[0] === "NY").map((c) => c[1]).join() === "1,2");
    ok("after waiting 30 seconds", calls.sleeps.join() === "30000", calls.sleeps.join());
    ok("the state then completes, and the run goes on to the next state", o.states.NY.status === "complete" && o.states.TX.status === "complete" && o.exitCode === 0);
    ok("the run left running by the failed attempt was marked interrupted", st.interrupted.length === 1);
    ok("the retry is announced on the state's status while it happens", st.supervisorWrites.some((w) => (w.counts as { states: Record<string, { status: string; attempt?: number }> }).states.NY.status === "retrying" && (w.counts as { states: Record<string, { attempt?: number }> }).states.NY.attempt === 2));

    const st2 = new FakeStore();
    const f = makeDeps(st2, { attempts: { NY: ["boom", "boom", "boom", true], TX: [true] } });
    const o2 = await runAllStates(f.deps, opts(["NY", "TX", "CA"]));
    ok("the number of attempts is bounded (3), never a fourth", f.calls.children.filter((c) => c[0] === "NY").length === 3);
    ok("with pauses of 30 s then 120 s between them, and none after the last", f.calls.sleeps.join() === "30000,120000", f.calls.sleeps.join());
    ok("a state that never loads is FAILED, with the last error recorded", o2.states.NY.status === "failed" && /boom/.test(o2.states.NY.note ?? ""));
    ok("the run keeps going across states after a failure", o2.states.TX.status === "complete" && o2.states.CA.status === "complete");
    ok("and exits 3 (finished, but a state failed), not 0 and not 1", o2.exitCode === 3 && o2.halted === null);
    ok("the final standing row is 'failed' and names the state", (() => { const w = st2.supervisorWrites[st2.supervisorWrites.length - 1]; return w.status === "failed" && /NY/.test(w.notes); })());

    const st3 = new FakeStore();
    const f3 = makeDeps(st3, { attempts: { NY: ["x", "x"] } });
    await runAllStates(f3.deps, opts(["NY"], { maxAttempts: 2 }));
    ok("--max-attempts is honoured", f3.calls.children.length === 2);
  }

  section("G. an unexplained mismatch stops everything; an explained one does not (ruling 0046 clause 3)");
  {
    const bad = ['[582218044] foundation.city: stored "A" but the filing gives "B"'];
    const st = new FakeStore();
    const { deps, calls } = makeDeps(st, { mismatches: { TX: bad } });
    const o = await runAllStates(deps, opts(["NY", "TX", "CA", "OH"]));
    ok("the state with an unexplained mismatch is marked NOT VERIFIED", o.states.TX.status === "not_verified");
    ok("its rows stay in place: nothing is deleted or rolled back", st.runs.some((r) => (r.parameters as { state: string }).state === "TX"));
    ok("the run STOPS before the next state: CA and OH are never loaded", !calls.children.some((c) => c[0] === "CA" || c[0] === "OH") && o.states.CA.status === "not_reached" && o.states.OH.status === "not_reached");
    ok("the earlier state is untouched and stays complete", o.states.NY.status === "complete");
    ok("it exits 1 and names the state and the reason", o.exitCode === 1 && o.halted?.state === "TX" && /unexplained/.test(o.halted.reason) && o.halted.reason.includes(bad[0]));
    const txRun = annotationOf(st.runs.find((r) => (r.parameters as { state: string }).state === "TX")!);
    ok("the state's run records verified:false, complete:false, the mismatch and its count", txRun?.verification?.verified === false && txRun.complete === false && txRun.verification.unexplained === 1 && txRun.verification.unexplained_examples[0] === bad[0]);
    ok("the standing row shows the stop, as failed", st.supervisorWrites[st.supervisorWrites.length - 1].status === "failed" && /HALTED at TX/.test(st.supervisorWrites[st.supervisorWrites.length - 1].notes));

    // next invocation: the state is not skipped, it is checked again; the unexplained difference still halts
    const again = makeDeps(st, { mismatches: { TX: bad } });
    const o2 = await runAllStates(again.deps, opts(["NY", "TX", "CA"]));
    ok("the next invocation does NOT call the not-verified state complete: it checks it again, loading nothing", again.calls.children.length === 0 && again.calls.verifier.length === 1 && o2.states.TX.status === "not_verified" && o2.exitCode === 1);

    // the same difference, now written down: explained, continues
    const again2 = makeDeps(st, { mismatches: { TX: bad } });
    const o3 = await runAllStates(again2.deps, opts(["NY", "TX", "CA"], { exceptions: [EX_CITY] }));
    ok("with the cause written down, the same difference is explained and the run continues past it", o3.states.TX.status === "complete" && o3.states.CA.status === "complete" && o3.exitCode === 0);
    const v = annotationOf(st.runs.find((r) => (r.parameters as { state: string }).state === "TX")!)?.verification;
    ok("the exception that explained it is listed on the run, with its count and an example", v?.verified === true && v.explained.length === 1 && v.explained[0].exception_id === "city-case" && v.explained[0].count === 1 && v.explained[0].examples[0] === bad[0] && v.unexplained === 0);
    ok("a mismatch is not 'zero required': explained and recorded is enough", v?.mismatches === 1 && v.verified === true);

    // one explained and one not: halts
    const st4 = new FakeStore();
    const m4 = makeDeps(st4, { mismatches: { NY: [bad[0], '[1] figures.x: stored 1 but the filing gives "2"'] } });
    const o4 = await runAllStates(m4.deps, opts(["NY", "TX"], { exceptions: [EX_CITY] }));
    ok("one explained and one unexplained mismatch together still halt", o4.states.NY.status === "not_verified" && o4.exitCode === 1 && !m4.calls.children.some((c) => c[0] === "TX"));

    // the verifier crashing is not a mismatch and is not verified
    const st5 = new FakeStore();
    const m5 = makeDeps(st5, { verifierCrashFor: ["NY"] });
    const o5 = await runAllStates(m5.deps, opts(["NY", "TX"]));
    ok("a verifier that does not complete leaves the state not verified and stops the run", o5.states.NY.status === "not_verified" && o5.exitCode === 1 && /did not complete/.test(o5.halted?.reason ?? ""));
    ok("and the run record says the check errored", annotationOf(st5.runs[0])?.verification?.error === "exit 137");

    // a load whose counts do not add up is a defect, not a retry
    const st6 = new FakeStore();
    const m6 = makeDeps(st6, { runCounts: { NY: { status_loaded: 1 } } });
    const o6 = await runAllStates(m6.deps, opts(["NY", "TX"]));
    ok("outcome counts that do not sum stop the run before the sample (the load is not sound)", o6.exitCode === 1 && o6.states.NY.status === "not_verified" && m6.calls.verifier.length === 0 && /add up/.test(o6.halted?.reason ?? ""));
    const m7 = makeDeps(new FakeStore(), { runCounts: { NY: { header_audit: { sampled: 50, said_not_in_state_but_return_is_in_state: 2 } } } });
    const o7 = await runAllStates(m7.deps, opts(["NY", "TX"]));
    ok("a header audit that found strays stops the run", o7.exitCode === 1 && /header audit found 2/.test(o7.halted?.reason ?? ""));

    // full verification
    const st8 = new FakeStore();
    st8.funders.NY = Array.from({ length: 400 }, (_, i) => ({ ein: String(100000000 + i), grants: i, people: i }));
    const m8 = makeDeps(st8);
    await runAllStates(m8.deps, opts(["NY"], { forceFull: true }));
    ok("--full-verify checks every funder of the state", m8.calls.verifier[0].length === 400);
    const st9 = new FakeStore();
    st9.funders.NY = st8.funders.NY;
    const m10 = makeDeps(st9);
    await runAllStates(m10.deps, opts(["NY"]));
    ok("the default checks a sample of 150, not every funder", m10.calls.verifier[0].length === 150, String(m10.calls.verifier[0].length));
  }

  // =========================================================================
  section("H. the run table: the local store and the hosted store write the same things");
  {
    const dir = mkdtempSync(join(tmpdir(), "fr-store-"));
    const store = pgliteRunStore(async () => (await openReferenceDb(join(dir, "db"))).db as never, "t");
    await store.writeSupervisor({ status: "running", counts: { states: { NY: { status: "loading" } } }, notes: "start", parameters: { kind: "all_states_supervisor" }, begin: true });
    await store.writeSupervisor({ status: "running", counts: { states: { NY: { status: "complete" } } }, notes: "mid", parameters: { kind: "all_states_supervisor" } });
    await store.writeSupervisor({ status: "completed", counts: { states: { NY: { status: "complete" } } }, notes: "end", parameters: { kind: "all_states_supervisor" } });
    let q = await (await openReferenceDb(join(dir, "db"))).db.query(`select id, status, notes, finished_at, loader_version, (select count(*) from funder_reference_runs)::int n from funder_reference_runs`);
    let row = q.rows[0] as { id: string; status: string; notes: string; finished_at: unknown; n: number; loader_version: string };
    ok("the standing row is one row, updated in place across three writes", row.n === 1 && row.id === SUPERVISOR_RUN_ID && row.notes === "end");
    ok("it ends 'completed' with a finish time", row.status === "completed" && !!row.finished_at);
    await store.release();
    const db = (await openReferenceDb(join(dir, "db"))).db;
    // a state's run, as the loader writes it, then annotated
    const rid = "11111111-1111-4111-8111-111111111111";
    await db.exec("set role service_role");
    await db.query(`insert into funder_reference_runs (id, loader_version, status, parameters, counts) values ($1, $2, 'running', $3, '{"a":1}')`, [rid, LV, JSON.stringify({ state: "NY", periodYears: YEARS, threshold: DEFAULT_THRESHOLD })]);
    await db.exec("reset role");
    await db.close();
    const s2 = pgliteRunStore(async () => (await openReferenceDb(join(dir, "db"))).db as never, "t");
    const runs = await s2.runsForState("NY");
    ok("runsForState finds a state's runs by its parameters, and not the standing row", runs.length === 1 && runs[0].id === rid && runs[0].status === "running");
    await s2.markInterrupted([rid], "was running when resumed");
    ok("markInterrupted records the truth: interrupted, finished, with the reason", (await s2.getRun(rid))?.status === "interrupted" && (await s2.getRun(rid))?.finished_at !== null && /resumed/.test((await s2.getRun(rid))?.notes ?? ""));
    await s2.annotate(rid, { supervisor: { complete: true } });
    const got = await s2.getRun(rid);
    ok("annotate merges into counts and keeps what the loader wrote", (got?.counts as { a?: number }).a === 1 && (got?.counts as { supervisor?: { complete: boolean } }).supervisor?.complete === true);
    await s2.release();

    // funderCounts on a real small load: done in section I (needs rows)

    // the hosted store against a fake client that stores rows in memory and answers the calls the store makes
    const table: Record<string, Array<Record<string, unknown>>> = { funder_reference_runs: [], funder_reference_foundations: [], funder_reference_figures: [], funder_reference_people: [], funder_reference_grants: [] };
    for (let i = 0; i < 2500; i++) table.funder_reference_foundations.push({ ein: String(100000000 + i), state: i % 5 === 0 ? "NY" : "TX" });
    table.funder_reference_foundations.sort((a, b) => String(a.ein).localeCompare(String(b.ein)));
    for (const f of table.funder_reference_foundations.filter((f) => f.state === "NY")) {
      table.funder_reference_figures.push({ ein: f.ein, tax_period_end: "2023-12-31", grants_listed_count: Number(String(f.ein).slice(-2)) });
      table.funder_reference_figures.push({ ein: f.ein, tax_period_end: "2022-12-31", grants_listed_count: 1 });
      for (let p = 0; p < (Number(String(f.ein).slice(-1)) % 3) + 1; p++) table.funder_reference_people.push({ ein: f.ein, filing_object_id: "x" + f.ein, listed_in: "a", ordinal: p + 1 });
    }
    table.funder_reference_grants.push({ ein: "100000000", kind: "approved_for_future_payment", filing_object_id: "x", ordinal: 1 });
    const requests: string[] = [];
    const fake = {
      from(name: string) {
        const q = { rows: () => table[name] ?? [], filters: [] as Array<(r: Record<string, unknown>) => boolean>, cols: "", from: 0, to: 999999, head: false, upd: null as Record<string, unknown> | null, ins: null as Record<string, unknown> | null, ord: [] as string[], lim: 0 };
        const exec = () => {
          requests.push(name);
          let rows = q.rows().filter((r) => q.filters.every((f) => f(r)));
          if (q.upd) {
            for (const r of rows) Object.assign(r, q.upd);
            return { data: null, error: null };
          }
          if (q.ins) {
            table[name].push({ ...q.ins });
            return { data: null, error: null };
          }
          for (const o of [...q.ord].reverse()) rows = [...rows].sort((a, b) => String(a[o]).localeCompare(String(b[o])));
          const cut = Math.min(q.to + 1, q.from + 1000); // a hosted project returns at most 1000 rows
          rows = rows.slice(q.from, q.lim ? Math.min(cut, q.from + q.lim) : cut);
          return { data: rows.map((r) => (q.cols && q.cols !== "*" && !q.cols.includes("parameters") ? Object.fromEntries(q.cols.split(",").map((c) => [c, r[c]])) : r)), error: null };
        };
        const b: Record<string, unknown> = {
          select: (c: string) => ((q.cols = c), b),
          eq: (c: string, v: unknown) => (q.filters.push((r) => (c === "parameters->>state" ? (r.parameters as { state?: string })?.state === v : r[c] === v)), b),
          in: (c: string, vs: unknown[]) => (q.filters.push((r) => vs.includes(r[c])), b),
          order: (c: string) => (q.ord.push(c), b),
          limit: (n: number) => ((q.lim = n), b),
          range: (a: number, z: number) => ((q.from = a), (q.to = z), b),
          update: (v: Record<string, unknown>) => ((q.upd = v), b),
          insert: (v: Record<string, unknown>) => ((q.ins = v), b),
          then: (res: (v: unknown) => unknown) => res(exec()),
        };
        return b;
      },
    };
    const hs = supabaseRunStore(fake as never, "fake-hosted");
    await hs.writeSupervisor({ status: "running", counts: { a: 1 }, notes: "n1", parameters: {}, begin: true });
    await hs.writeSupervisor({ status: "completed", counts: { a: 2 }, notes: "n2", parameters: {} });
    ok("hosted store: the standing row is created once and then updated in place", table.funder_reference_runs.length === 1 && table.funder_reference_runs[0].id === SUPERVISOR_RUN_ID && table.funder_reference_runs[0].status === "completed" && table.funder_reference_runs[0].notes === "n2");
    table.funder_reference_runs.push({ id: "r1", started_at: "2026-11-09T00:00:00Z", finished_at: null, loader_version: LV, status: "running", parameters: { state: "NY" }, counts: { a: 1 }, notes: null });
    ok("hosted store: runsForState filters by the state in the run's parameters", (await hs.runsForState("NY")).length === 1 && (await hs.runsForState("TX")).length === 0);
    await hs.markInterrupted(["r1"], "n");
    ok("hosted store: markInterrupted touches only a run still running", table.funder_reference_runs.find((r) => r.id === "r1")?.status === "interrupted");
    await hs.annotate("r1", { supervisor: { complete: true } });
    ok("hosted store: annotate merges into counts", JSON.stringify((table.funder_reference_runs.find((r) => r.id === "r1")!.counts as Record<string, unknown>)) === JSON.stringify({ a: 1, supervisor: { complete: true } }));
    const fc = await hs.funderCounts("NY");
    ok("hosted store: funderCounts lists exactly the state's funders (500, paged past the 1000-row cap)", fc.length === 500 && fc.every((f) => f.ein.length === 9));
    const first = fc.find((f) => f.ein === "100000000")!;
    ok("hosted store: grant rows = listed grants on each standing filing plus rows approved for future payment", first.grants === 0 + 1 + 1, JSON.stringify(first));
    ok("hosted store: people rows are counted per funder", first.people === 1 && fc.find((f) => f.ein === "100000005")!.people === 3, JSON.stringify(fc.find((f) => f.ein === "100000005")));
    rmSync(dir, { recursive: true, force: true });
  }

  // =========================================================================
  section("I. the real command: real child processes, a real local PostgreSQL, real-shaped IRS returns");
  if (process.env.ALL_STATES_SKIP_E2E === "1") console.log("SKIP: this section is skipped when ALL_STATES_SKIP_E2E=1 (the mutation check sets it for mutants the faster sections catch)");
  else {
    const FIX = join(__dirname, "fixtures/funder-reference");
    const X23 = readFileSync(join(FIX, "202403209349107935_public.xml"), "utf8");
    const ws = mkdtempSync(join(tmpdir(), "fr-allstates-"));
    const archives = join(ws, "zips");
    const index = join(ws, "index");
    const work = join(ws, "work");
    mkdirSync(archives);
    mkdirSync(index);
    const variant = (o: { ein: string; name: string; state: string; assets?: number; paid?: number; end?: string; begin?: string }) => {
      let x = X23.replace(/<EIN>582218044<\/EIN>/g, `<EIN>${o.ein}</EIN>`).split("SERVANT'S HEART FOUNDATION INC").join(o.name);
      x = x.replace(/<Filer>[\s\S]*?<\/Filer>/, (f) => f.replace("<StateAbbreviationCd>CA</StateAbbreviationCd>", `<StateAbbreviationCd>${o.state}</StateAbbreviationCd>`));
      if (o.end) x = x.replace(/<TaxPeriodEndDt>[^<]*<\/TaxPeriodEndDt>/, `<TaxPeriodEndDt>${o.end}</TaxPeriodEndDt>`);
      if (o.begin) x = x.replace(/<TaxPeriodBeginDt>[^<]*<\/TaxPeriodBeginDt>/, `<TaxPeriodBeginDt>${o.begin}</TaxPeriodBeginDt>`);
      if (o.assets !== undefined) x = x.replace(/<(FMVAssetsEOYAmt|TotalAssetsEOYFMVAmt|TotalAssetsEOYAmt)>\d+</g, `<$1>${o.assets}<`);
      if (o.paid !== undefined) x = x.replace(/<ContriPaidRevAndExpnssAmt>\d+</, `<ContriPaidRevAndExpnssAmt>${o.paid}<`);
      return x;
    };
    // [object id, EIN, name, state, assets, paid, period]
    const R: Array<[string, string, string, string, number | undefined, number | undefined, string]> = [
      ["202400000000000101", "582218044", "SERVANT'S HEART FOUNDATION INC", "CA", undefined, undefined, "202312"],
      ["202400000000000102", "111111111", "CALIFORNIA SMALL FUND", "CA", 200000, 20000, "202312"],
      ["202400000000000103", "222222222", "TEXAS BIG FOUNDATION", "TX", undefined, undefined, "202312"],
      ["202400000000000104", "333333333", "TEXAS SMALL FUND", "TX", 10000, 1000, "202312"],
      ["202400000000000105", "444444444", "NEW YORK BIG FOUNDATION", "NY", undefined, undefined, "202312"],
      // a funder that moved: small in California in 2022, big in Texas in 2023
      ["202400000000000106", "555555555", "MOVER FOUNDATION", "CA", 10000, 1000, "202212"],
      ["202400000000000107", "555555555", "MOVER FOUNDATION", "TX", undefined, undefined, "202312"],
    ];
    // Texas Big's filer typed its own EIN into the signing officer's SSN field (seen on real data: EIN 112001717). That is a
    // public number, not a leak, and must not stop a run.
    const withEinAsSsn = (xml: string, ein: string) => xml.replace("</ReturnHeader>", `<SigningOfficerGrp><PersonFullName><PersonFirstNm>A</PersonFirstNm><PersonLastNm>B</PersonLastNm></PersonFullName><SSN>${ein}</SSN></SigningOfficerGrp></ReturnHeader>`);
    const members = R.map(([id, ein, name, state, assets, paid, per]) => {
      const xml = variant({ ein, name, state, assets, paid, ...(per === "202212" ? { end: "2022-12-31", begin: "2022-01-01" } : {}) });
      return { name: `2024_TEOS_XML_11A/${id}_public.xml`, data: Buffer.from(ein === "222222222" ? withEinAsSsn(xml, ein) : xml) };
    });
    writeFileSync(join(archives, "2024_TEOS_XML_11A.zip"), makeZip(members));
    const H = "RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID";
    writeFileSync(join(index, "index_2024.csv"), [H, ...R.map(([id, ein, name, , , , per], i) => `${i + 1},EFILE,${ein},${per},2024,${name},990PF,d${i},${id},2024_TEOS_XML_11A`)].join("\n") + "\n");
    const exFile = join(ws, "exceptions.json");
    writeFileSync(exFile, JSON.stringify({ exceptions: [] }));

    const tsx = [...process.execArgv];
    const cli = (args: string[], env: Record<string, string> = {}) => {
      const r = spawnSync(process.execPath, [...tsx, join(root, "scripts/load-all-states.ts"), "--work-dir", work, "--index-dir", index, "--archives-dir", archives, "--target", `pglite:${join(ws, "db")}`, "--exceptions", exFile, "--stall-minutes", "10", ...args], { encoding: "utf8", cwd: root, env: { ...process.env, ...env }, timeout: 900_000 });
      return { code: r.status, out: String(r.stdout) + String(r.stderr) };
    };
    const rowsIn = async (sql: string) => {
      const { db } = await openReferenceDb(join(ws, "db"));
      try {
        return (await db.query(sql)).rows as Array<Record<string, unknown>>;
      } finally {
        await db.close();
      }
    };

    const dry = cli(["--dry-run"]);
    ok("e2e dry run: reads the index, reports the states and what it would do, exits 0", dry.code === 0 && /DRY RUN/.test(dry.out), dry.out.slice(-600));
    ok("e2e dry run: nothing was loaded (no run exists)", (await rowsIn(`select count(*)::int n from funder_reference_runs`))[0].n === 0);

    const first = cli([]);
    ok("e2e first run: exits 0 with every state complete", first.code === 0 && /TX\s+complete/.test(first.out) && /CA\s+complete/.test(first.out) && /NY\s+complete/.test(first.out), first.out.slice(-900));
    ok("e2e first run: New York and Texas load before California (the owner's order)", first.out.indexOf("NY: loading") < first.out.indexOf("CA: loading") && first.out.indexOf("TX: loading") < first.out.indexOf("CA: loading"), first.out.slice(0, 600));
    {
      const v = spawnSync(process.execPath, [...tsx, join(root, "scripts/verify-funder-reference-example.ts"), "--db", `pglite:${join(ws, "db")}`, "--ein", "222222222", "--archives-dir", archives], { encoding: "utf8", cwd: root });
      ok("e2e: a filer that typed its own EIN into the signing officer's SSN field passes the checker, with a note saying so", v.status === 0 && /NOTE: 1 return\(s\) carry the filer's own EIN/.test(String(v.stdout)) && /RESULT: PASS/.test(String(v.stdout)), String(v.stdout).slice(-500));
    }
    const runs1 = await rowsIn(`select id, status, parameters->>'state' st, counts->'supervisor'->>'complete' complete, counts->'supervisor'->'verification'->>'verified' verified, (counts->>'index_rows_considered')::int considered from funder_reference_runs order by started_at`);
    const stateRuns = runs1.filter((r) => r.st);
    ok("e2e: one finished run per state, each carrying the supervisor's note: complete and verified", stateRuns.length === 3 && stateRuns.every((r) => r.status === "completed" && r.complete === "true" && r.verified === "true"), JSON.stringify(runs1));
    ok("e2e: the standing row exists, completed, and names every state", await (async () => { const r = (await rowsIn(`select status, counts->'states' s from funder_reference_runs where id = '${SUPERVISOR_RUN_ID}'`))[0]; const s = r?.s as Record<string, { status: string }> | undefined; return r?.status === "completed" && !!s && s.CA?.status === "complete" && s.TX?.status === "complete" && s.NY?.status === "complete"; })());
    ok("e2e: the funders of all three states are stored", (await rowsIn(`select state, count(*)::int n from funder_reference_foundations group by state order by state`)).map((r) => `${r.state}:${r.n}`).join() === "CA:1,NY:1,TX:2", JSON.stringify(await rowsIn(`select state, count(*)::int n from funder_reference_foundations group by state order by state`)));
    const cov = await rowsIn(`select ein, period_year, status from funder_reference_period_coverage order by ein, period_year`);
    ok("e2e: a later state's run does not erase an earlier state's coverage (all three states' funders have coverage)", ["582218044", "222222222", "444444444"].every((e) => cov.some((c) => c.ein === e && c.status === "loaded")), JSON.stringify(cov));
    const mover = cov.filter((c) => c.ein === "555555555");
    ok("e2e: a funder that moved states is covered for the year held in Texas and not mis-stated for the year held below the threshold in California", mover.some((c) => c.period_year === 2023 && c.status === "loaded") && !mover.some((c) => c.period_year === 2022), JSON.stringify(mover));
    ok("e2e: the unread/skipped CA return of the mover is recorded as skipped, not lost", (await rowsIn(`select status from funder_reference_filings where object_id = '202400000000000106'`))[0]?.status === "skipped_below_threshold");

    const nRuns = (await rowsIn(`select count(*)::int n from funder_reference_runs`))[0].n as number;
    const digestBefore = JSON.stringify(await rowsIn(`select (select count(*) from funder_reference_filings) f, (select count(*) from funder_reference_grants) g, (select count(*) from funder_reference_people) p, (select count(*) from funder_reference_period_coverage) c`));
    const second = cli([]);
    ok("e2e second run, back to back: exits 0 and skips every state", second.code === 0 && /NY\s+skipped_complete/.test(second.out) && /TX\s+skipped_complete/.test(second.out) && /CA\s+skipped_complete/.test(second.out), second.out.slice(-700));
    ok("e2e second run: starts no loader process (no 'loading' line)", !/: loading \(attempt/.test(second.out));
    ok("e2e second run: writes ZERO new rows in the run table", (await rowsIn(`select count(*)::int n from funder_reference_runs`))[0].n === nRuns);
    ok("e2e second run: writes zero new rows in any reference table", JSON.stringify(await rowsIn(`select (select count(*) from funder_reference_filings) f, (select count(*) from funder_reference_grants) g, (select count(*) from funder_reference_people) p, (select count(*) from funder_reference_period_coverage) c`)) === digestBefore);

    // tamper with one stored value, forget that the state was verified, and run again
    {
      const { db } = await openReferenceDb(join(ws, "db"));
      await db.exec(`update funder_reference_foundations set city = 'TAMPERED' where ein = '444444444'`);
      await db.exec(`update funder_reference_runs set counts = counts - 'supervisor' where parameters->>'state' = 'NY'`);
      await db.close();
    }
    const third = cli(["--states", "NY,TX"]);
    ok("e2e unexplained mismatch: the command stops with exit 1 and says which state and why", third.code === 1 && /STOPPED at NY/.test(third.out) && /foundation\.city/.test(third.out), third.out.slice(-800));
    ok("e2e unexplained mismatch: the state's run records verified:false and the mismatch", await (async () => { const r = (await rowsIn(`select counts->'supervisor'->'verification'->>'verified' v, counts->'supervisor'->'verification'->>'unexplained' u, counts->'supervisor'->>'complete' c from funder_reference_runs where parameters->>'state' = 'NY' order by started_at desc limit 1`))[0]; return r.v === "false" && Number(r.u) >= 1 && r.c === "false"; })());
    ok("e2e unexplained mismatch: the standing row says failed and where it halted", await (async () => { const r = (await rowsIn(`select status, notes from funder_reference_runs where id = '${SUPERVISOR_RUN_ID}'`))[0]; return r.status === "failed" && /HALTED at NY/.test(String(r.notes)); })());
    writeFileSync(exFile, JSON.stringify({ exceptions: [{ id: "tampered-city-test", cause: "this test changed the stored city of EIN 444444444 on purpose", pattern: "^\\[444444444\\] foundation\\.city: stored \"TAMPERED\"", evidence: "scripts/test-all-states.ts section I", date: "2026-11-09" }] }));
    const fourth = cli(["--states", "NY,TX"]);
    ok("e2e explained mismatch: with a written exception the same difference no longer stops the run (exit 0)", fourth.code === 0 && /NY\s+complete/.test(fourth.out), fourth.out.slice(-800));
    ok("e2e explained mismatch: the exception is listed on the run with its id", await (async () => { const r = (await rowsIn(`select counts->'supervisor'->'verification'->'explained'->0->>'exception_id' id from funder_reference_runs where parameters->>'state' = 'NY' order by started_at desc limit 1`))[0]; return r.id === "tampered-city-test"; })());
    writeFileSync(exFile, "{ not json");
    const fifth = cli(["--dry-run"]);
    ok("a malformed exception list is refused (exit 2); it never reads as 'everything is explained'", fifth.code === 2 && /exception list/.test(fifth.out), fifth.out.slice(-300));
    ok("the command refuses --target supabase without the explicit confirm flag", (() => { const r = spawnSync(process.execPath, [...tsx, join(root, "scripts/load-all-states.ts"), "--work-dir", work, "--index-dir", index, "--archives-dir", archives, "--target", "supabase", "--dry-run"], { encoding: "utf8", cwd: root, env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: "", NEXT_PUBLIC_SUPABASE_URL: "" } }); return r.status === 2 && /confirm-write-to-supabase/.test(String(r.stderr)); })());
    const noKey = spawnSync(process.execPath, [...tsx, join(root, "scripts/load-all-states.ts"), "--work-dir", work, "--index-dir", index, "--archives-dir", archives, "--target", "supabase", "--confirm-write-to-supabase", "--dry-run"], { encoding: "utf8", cwd: root, env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy-looking-value", NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid" } });
    ok("a legacy-style key is refused and the refusal does not repeat the key", noKey.status === 2 && /sb_secret_/.test(String(noKey.stderr)) && !String(noKey.stderr + noKey.stdout).includes("eyJlegacy"));
    rmSync(ws, { recursive: true, force: true });
  }

  // =========================================================================
  section("J. nothing secret, nothing outside the loader");
  {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const n of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", ".claude", "docs", "supabase"].includes(n)) continue;
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|js|mjs|jsx|sh)$/.test(n)) out.push(p);
      }
      return out;
    };
    const files = walk(root);
    const keyReaders = files.filter((f) => /SUPABASE_SERVICE_ROLE_KEY/.test(readFileSync(f, "utf8")) && /funder-reference|all-states|funder-loader|run-california/.test(f) && !/test-/.test(f) && !/mutation-check/.test(f)).map((f) => f.slice(root.length + 1)).sort();
    ok("successor to the two-script rule (test-funder-reference-migration): within the funder-reference work, the files that name the service key are exactly the loader, the checker, the all-states command and its status reader, the server setup script and the two older shell scripts", keyReaders.filter((f) => !/setup-funder-loader/.test(f)).join() === "scripts/all-states-status.ts,scripts/load-all-states.ts,scripts/load-funder-reference.ts,scripts/run-california-checks.sh,scripts/run-california-load.sh,scripts/verify-funder-reference-example.ts", keyReaders.join());
    const lib = files.filter((f) => f.includes("lib/funder-reference/"));
    ok("the library reads no environment variable (the new files too)", lib.every((f) => !/process\.env/.test(readFileSync(f, "utf8"))), lib.filter((f) => /process\.env/.test(readFileSync(f, "utf8"))).join());
    ok("the library imports nothing from the web application", lib.every((f) => !/from ["'](next|react|@\/|\.\.\/\.\.\/app)/.test(readFileSync(f, "utf8"))));
    // Ruling 0048 (item 113) authorizes ONE read-only screen to read the reference tables through
// lib/funder-reference/{access,browse,read}.ts and nothing else; it must still import none of the loader.
const screenFile = (f: string) => f.startsWith(join(root, "app/(dashboard)/funders") + "/") || f === join(root, "app/(dashboard)/layout.tsx");
const loaderModule = /funder-reference\/(pipeline|sink|run-store|sources|parse-990pf|zip|inflate|document|derive|xml|strings|supervisor)\b|load-all-states/;
ok("nothing under app/ imports the loader library or its command (the ruling-0048 screen reads only through access, browse and read)", files.filter((f) => f.startsWith(join(root, "app")) || (f.startsWith(join(root, "lib")) && !f.includes("lib/funder-reference/"))).every((f) => (screenFile(f) ? !loaderModule.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")) : !/funder-reference|load-all-states/.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")))), "");
    const cmd = readFileSync(join(root, "scripts/load-all-states.ts"), "utf8");
    ok("the command never prints the key (no log or console call mentions the key variable)", !/(log|console\.\w+)\([^)]*(SERVICE_ROLE_KEY|\bkey\b)/.test(cmd.replace(/^\s*\/\/.*$/gm, "")));
    ok("the command has no way to send anything: no mail or messaging import", !/postmark|resend|nodemailer|sendgrid|fetch\(/i.test(cmd));
    ok("no migration was added by this item (the later ones are item 113's, ruling 0048: 0086 to 0088, and item 116's, ruling 0047: 0089)", !readdirSync(join(root, "supabase/migrations")).some((f) => /^008[5-9]|^009/.test(f) && /funder|state|supervis/i.test(f) && !/^(0086_funder_reference_directory|0087_funder_reference_search_pages_first|0088_funder_reference_directory_snapshot|0089_)/.test(f)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(`FAIL: the test run crashed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  process.exit(1);
});
