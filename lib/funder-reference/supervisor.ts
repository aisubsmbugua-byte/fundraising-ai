// Item 114 (ruling 0046): the decisions and the loop of the all-states command.
//
// FOR THE OWNER. This is the part that decides, for each state in turn, whether it
// is already done, needs only its check re-run, or needs loading; loads it in a
// separate process so memory is given back between states; checks a repeatable
// sample of the funders it stored against the IRS filings themselves; and stops,
// loudly, if any difference cannot be explained by a written, dated exception. It
// writes what it is doing to the database as it goes, so the last thing it did can
// be read without logging into the server.
//
// EVERYTHING that decides lives here as a plain function with no I/O, so it can be
// tested and mutation-checked (scripts/test-all-states.ts, scripts/mutation-check-
// all-states.ts). The I/O (processes, database, files) is handed in as `Deps`.
//
// WHAT "COMPLETE" MEANS (ruling 0046 clause 3). A state is complete only when four
// things are recorded on its run: (1) the run finished; (2) the outcome counts add
// up to the returns the run considered; (3) the header audit found no return in the
// state that the header had put elsewhere; (4) a verified sample has no UNEXPLAINED
// mismatch. Beyond the four, a "complete" verdict is only ever about THIS input: the
// same loader version, years, size threshold, state and the same index rows. New IRS
// filings for the state, or a new loader version, make the earlier verdict stale.

import { createHash } from "node:crypto";
import type { Threshold } from "./derive";

export const ALL_STATES_VERSION = "all-states/1.0.0";

/** States loaded first, in this order, because they hold the most funders after California (owner's list). */
export const PRIORITY_STATES = ["NY", "TX", "FL", "PA", "IL"];

/** How many funders per state the sample covers unless the operator says otherwise. */
export const DEFAULT_SAMPLE_SIZE = 150;
/** Funders always included because a paging or size fault reaches them first: the N with most grant rows, the N with most people rows. */
export const MUST_INCLUDE_EACH = 10;
export const DEFAULT_SAMPLE_SEED = "funder-reference-sample/1";
export const DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------
export interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  loader_version: string;
  status: string;
  parameters: Record<string, unknown>;
  counts: Record<string, unknown>;
  notes: string | null;
}

export interface Wanted {
  loaderVersion: string;
  years: number[];
  threshold: Threshold;
  state: string;
  /** Digest of the index rows that belong to this state (see stateInputDigests). */
  digest: string;
  verification: { mode: "sample" | "full"; size: number; seed: string };
}

export interface ExceptionEntry {
  id: string;
  cause: string;
  /** A regular expression, as source text, tested against the verifier's mismatch line. */
  pattern: string;
  evidence: string;
  /** Date the exception was written, YYYY-MM-DD. */
  date: string;
}

export interface VerificationRecord {
  verified: boolean;
  mode: "sample" | "full";
  seed: string;
  size_requested: number;
  funders_in_state: number;
  funders_checked: number;
  must_include: { most_grant_rows: string[]; most_people_rows: string[] };
  compared: number;
  mismatches: number;
  explained: Array<{ exception_id: string; count: number; examples: string[] }>;
  unexplained: number;
  unexplained_examples: string[];
  exceptions_sha256: string;
  verified_at: string;
  /** Set when the check could not be completed (the verifier crashed): not a mismatch, and not verified. */
  error?: string;
}

/** What this command writes onto a state's run, under counts.supervisor. */
export interface Annotation {
  command: string;
  input_digest: string;
  input_rows: number;
  loader_version: string;
  years: number[];
  threshold: Threshold;
  state: string;
  attempt?: number;
  peak_rss_mb?: number;
  child_seconds?: number;
  verification: VerificationRecord | null;
  complete: boolean;
  /** Why the state is not complete, when it is not (empty when it is). */
  problems: string[];
  updated_at: string;
}

export type StateStatus =
  | "pending"
  | "skipped_complete"
  | "loading"
  | "retrying"
  | "loaded"
  | "verifying"
  | "complete"
  | "failed"
  | "not_verified"
  | "not_reached";

export interface StateReport {
  status: StateStatus;
  run_id?: string | null;
  attempt?: number;
  note?: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------
/**
 * The order states are loaded in: the owner's priority states first (in the owner's
 * order), then every other state by how many returns it has, most first; ties by
 * name so the order never depends on the order a map happened to list them in.
 */
export function orderStates(returnsByState: Record<string, number>, priority: string[] = PRIORITY_STATES): string[] {
  const present = Object.keys(returnsByState).filter((s) => returnsByState[s] > 0);
  const first = priority.filter((s) => present.includes(s));
  const rest = present.filter((s) => !first.includes(s)).sort((a, b) => returnsByState[b] - returnsByState[a] || a.localeCompare(b));
  return [...first, ...rest];
}

// ---------------------------------------------------------------------------
// the input a state's run was made from
// ---------------------------------------------------------------------------
/**
 * One digest per state over the IRS index rows that belong to it: how many, and an
 * order-independent sum of a hash of each object id. It changes when (and only when)
 * a return is added to or removed from the state in the index, so a month's new
 * archives re-open the states that gained returns and no others. A row whose header
 * could not be read (state unknown) is counted into every state, because every
 * state's run reads it in full to decide.
 */
export class StateDigests {
  private static readonly MOD = 1n << 128n;
  private acc = new Map<string, { n: number; sum: bigint }>();
  private unknown = { n: 0, sum: 0n };
  /** One index row: its object id, the state its header gives (null: a foreign address), and whether the header could be read at all. */
  add(objectId: string, state: string | null | undefined, headerRead: boolean): void {
    const MOD = StateDigests.MOD;
    const h = BigInt("0x" + createHash("sha256").update(objectId).digest("hex").slice(0, 32));
    if (!headerRead) {
      this.unknown = { n: this.unknown.n + 1, sum: (this.unknown.sum + h) % MOD };
      return;
    }
    if (!state) return; // a filer with a foreign address: in no state's run
    const a = this.acc.get(state) ?? { n: 0, sum: 0n };
    this.acc.set(state, { n: a.n + 1, sum: (a.sum + h) % MOD });
  }
  result(): Record<string, { rows: number; digest: string }> {
    const out: Record<string, { rows: number; digest: string }> = {};
    for (const [s, a] of this.acc) {
      const n = a.n + this.unknown.n;
      const sum = (a.sum + this.unknown.sum) % StateDigests.MOD;
      out[s] = { rows: n, digest: createHash("sha256").update(`${n}:${sum.toString(16)}`).digest("hex") };
    }
    return out;
  }
}
export function stateInputDigests(rows: Iterable<{ objectId: string; state: string | null | undefined; headerRead: boolean }>): Record<string, { rows: number; digest: string }> {
  const d = new StateDigests();
  for (const r of rows) d.add(r.objectId, r.state, r.headerRead);
  return d.result();
}

// ---------------------------------------------------------------------------
// completeness
// ---------------------------------------------------------------------------
// Compared with keys sorted: a database that stores JSON may list an object's keys in another order.
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * Clause 3, items 1 to 3, read off a finished run, plus the check that the run was
 * made for THIS state, years, threshold and loader version. Item 4 (the sample) is
 * judged by isComplete(). Returns the problems found; none means the load is sound.
 */
export function evaluateLoad(run: RunRow | null, want: Wanted): string[] {
  const problems: string[] = [];
  if (!run) return ["no run is recorded for this state"];
  // 1. the run finished
  if (run.status !== "completed") problems.push(`the run did not finish (status ${run.status})`);
  // 2. the outcome counts sum to the returns considered. Recomputed here, not read from the run's own flag.
  const c = run.counts as Record<string, number | undefined>;
  const parts = [c.out_of_scope_state, c.status_unread, c.status_skipped_below_threshold, c.status_loaded, c.status_superseded];
  if (typeof c.index_rows_considered !== "number" || parts.some((x) => typeof x !== "number")) problems.push("the run's outcome counts are missing");
  else {
    const total = parts.reduce<number>((acc, x) => acc + (x as number), 0);
    if (total !== c.index_rows_considered) problems.push(`the outcome counts add up to ${total} but the run considered ${c.index_rows_considered} returns`);
  }
  // 3. the header audit found nothing the header had put elsewhere
  const audit = (run.counts as { header_audit?: { sampled?: number; said_not_in_state_but_return_is_in_state?: number } | null }).header_audit;
  if (!audit || typeof audit.sampled !== "number" || audit.sampled <= 0) problems.push("the header audit was not run (it must read a sample of the returns the header ruled out)");
  else if (audit.said_not_in_state_but_return_is_in_state !== 0) problems.push(`the header audit found ${audit.said_not_in_state_but_return_is_in_state} return(s) in ${want.state} that the header had put elsewhere`);
  // the run was made for this input
  if (run.loader_version !== want.loaderVersion) problems.push(`the run was made by loader ${run.loader_version}, not ${want.loaderVersion}`);
  const p = run.parameters as { state?: unknown; periodYears?: unknown; threshold?: unknown };
  if (p.state !== want.state) problems.push(`the run was for state ${String(p.state)}, not ${want.state}`);
  if (!sameJson(p.periodYears, want.years)) problems.push("the run covered different tax years");
  if (!sameJson(p.threshold, want.threshold)) problems.push("the run used a different size threshold");
  return problems;
}

export function annotationOf(run: RunRow | null): Annotation | null {
  const a = (run?.counts as { supervisor?: Annotation } | undefined)?.supervisor;
  return a && typeof a === "object" ? a : null;
}

/** Clause 3, item 4, for a run that is otherwise sound: a verified sample, no unexplained mismatch, of this input and at least the wanted size. */
export function verificationProblems(ann: Annotation | null, want: Wanted): string[] {
  if (!ann) return ["this command has not checked this run"];
  const out: string[] = [];
  if (ann.input_digest !== want.digest) out.push("the IRS index rows for this state have changed since the run");
  const v = ann.verification;
  if (!v) return [...out, "no sample has been verified"];
  if (v.error) out.push(`the sample check did not complete: ${v.error}`);
  if (!v.verified) out.push("the sample is recorded as not verified");
  if (v.unexplained > 0) out.push(`${v.unexplained} unexplained mismatch(es) in the sample`);
  if (want.verification.mode === "full" && v.mode !== "full") out.push("a full verification is required and only a sample was done");
  else if (want.verification.mode === "sample" && v.mode === "sample" && v.size_requested < want.verification.size) out.push(`the sample covered ${v.size_requested} funders; ${want.verification.size} are required`);
  return out;
}

export type Decision =
  | { action: "skip"; run: RunRow; why: string }
  | { action: "verify"; run: RunRow; why: string }
  | { action: "load"; why: string };

/**
 * What to do for a state, given the runs recorded for it (newest first):
 *   skip    the newest finished run is sound for this input and its sample is verified
 *   verify  the newest finished run is sound for this input but its sample is not
 *           verified (never done, killed before it, or since changed): check it again,
 *           load nothing
 *   load    anything else: no run, a failed run, a run for other input
 */
export function decideState(runs: RunRow[], want: Wanted, manifestRunId: string | null = null): Decision {
  const finished = runs.filter((r) => r.status === "completed");
  const newest = finished[0] ?? null;
  if (!newest) return { action: "load", why: runs.length ? "no run for this state has finished" : "no run is recorded for this state" };
  const load = evaluateLoad(newest, want);
  if (load.length) return { action: "load", why: `the newest finished run is not sound: ${load.join("; ")}` };
  let ann = annotationOf(newest);
  // A run this command finished loading but was stopped before it could write its note: the work directory's manifest remembers it.
  if (!ann && manifestRunId === newest.id) return { action: "verify", run: newest, why: "loaded, but the earlier check was interrupted before it was recorded" };
  if (!ann) return { action: "load", why: "the newest finished run was not made by this command, so its input is unknown" };
  if (ann.input_digest !== want.digest) return { action: "load", why: "the IRS index has gained or lost returns for this state since the newest run" };
  const vp = verificationProblems(ann, want);
  if (vp.length === 0) return { action: "skip", run: newest, why: "complete: finished, outcome counts add up, header audit clean, sample verified" };
  return { action: "verify", run: newest, why: vp.join("; ") };
}

/** The mode a state's verification must be done in: full when the loader version changed since the state was last verified complete (clause 4). */
export function verificationMode(runs: RunRow[], loaderVersion: string, forceFull: boolean): "sample" | "full" {
  if (forceFull) return "full";
  const everVerifiedUnder = runs.some((r) => {
    const a = annotationOf(r);
    return r.status === "completed" && r.loader_version === loaderVersion && a?.complete === true;
  });
  const anyEarlierComplete = runs.some((r) => annotationOf(r)?.complete === true);
  // First load under a new loader version, for a state that was verified complete under an older one: full.
  return anyEarlierComplete && !everVerifiedUnder ? "full" : "sample";
}

// ---------------------------------------------------------------------------
// the sample
// ---------------------------------------------------------------------------
export interface FunderCount {
  ein: string;
  grants: number;
  people: number;
}

/**
 * The funders to check for a state: always the MUST_INCLUDE_EACH with the most grant
 * rows and the same number with the most people rows (a paging or size fault reaches
 * the biggest first), then the rest drawn by a fixed pseudo-random rule: funders
 * ranked by SHA-256 of "seed|state|ein", smallest first. The same seed and the same
 * funders always give the same sample. Everyone is checked when the state has no more
 * funders than the size.
 */
export function chooseSample(funders: FunderCount[], size: number, seed: string, state: string, mustEach = MUST_INCLUDE_EACH): { eins: string[]; mostGrantRows: string[]; mostPeopleRows: string[] } {
  const byGrants = [...funders].sort((a, b) => b.grants - a.grants || a.ein.localeCompare(b.ein)).slice(0, mustEach).filter((f) => f.grants > 0);
  const byPeople = [...funders].sort((a, b) => b.people - a.people || a.ein.localeCompare(b.ein)).slice(0, mustEach).filter((f) => f.people > 0);
  const chosen = new Set<string>([...byGrants, ...byPeople].map((f) => f.ein));
  const rank = (ein: string) => createHash("sha256").update(`${seed}|${state}|${ein}`).digest("hex");
  const rest = funders.filter((f) => !chosen.has(f.ein)).sort((a, b) => rank(a.ein).localeCompare(rank(b.ein)));
  for (const f of rest) {
    if (chosen.size >= size) break;
    chosen.add(f.ein);
  }
  return { eins: [...chosen].sort(), mostGrantRows: byGrants.map((f) => f.ein), mostPeopleRows: byPeople.map((f) => f.ein) };
}

// ---------------------------------------------------------------------------
// mismatches and the exception list
// ---------------------------------------------------------------------------
export function validateExceptions(raw: unknown): { ok: true; entries: ExceptionEntry[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const list = (raw as { exceptions?: unknown })?.exceptions;
  if (!Array.isArray(list)) return { ok: false, problems: ['the exception file has no "exceptions" list'] };
  const seen = new Set<string>();
  const entries: ExceptionEntry[] = [];
  list.forEach((e: Partial<ExceptionEntry>, i) => {
    const where = `exceptions[${i}]${e && typeof e.id === "string" ? ` (${e.id})` : ""}`;
    for (const k of ["id", "cause", "pattern", "evidence", "date"] as const) if (typeof e?.[k] !== "string" || !String(e[k]).trim()) problems.push(`${where}: "${k}" is required`);
    if (typeof e?.date === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) problems.push(`${where}: "date" must be YYYY-MM-DD`);
    if (typeof e?.id === "string") {
      if (seen.has(e.id)) problems.push(`${where}: duplicate id`);
      seen.add(e.id);
    }
    if (typeof e?.pattern === "string") {
      try {
        const re = new RegExp(e.pattern);
        // A pattern that matches everything would turn the exception list into a way of ignoring the verifier.
        const a = '[000000000] foundation.city: stored "A" but the filing gives "B"';
        const b = "[999999999] [100000000000000001 2023-12-31] grants[1].amount_amt: stored NULL but the filing gives \"5\"";
        if (re.test("") || (re.test(a) && re.test(b))) problems.push(`${where}: "pattern" matches unrelated mismatch lines; it must name what it explains`);
      } catch {
        problems.push(`${where}: "pattern" is not a valid regular expression`);
      }
    }
    if (!problems.some((p) => p.startsWith(where))) entries.push({ id: e.id!, cause: e.cause!, pattern: e.pattern!, evidence: e.evidence!, date: e.date! });
  });
  return problems.length ? { ok: false, problems } : { ok: true, entries };
}

export interface Classified {
  explained: Array<{ exception_id: string; count: number; examples: string[] }>;
  unexplained: string[];
}

/** A mismatch is explained only if a written exception's pattern matches its line; anything else is unexplained. */
export function classifyMismatches(lines: string[], exceptions: ExceptionEntry[]): Classified {
  const res = exceptions.map((e) => ({ e, re: new RegExp(e.pattern) }));
  const explained = new Map<string, { exception_id: string; count: number; examples: string[] }>();
  const unexplained: string[] = [];
  for (const line of lines) {
    const hit = res.find((x) => x.re.test(line));
    if (!hit) {
      unexplained.push(line);
      continue;
    }
    const g = explained.get(hit.e.id) ?? { exception_id: hit.e.id, count: 0, examples: [] };
    g.count++;
    if (g.examples.length < 5) g.examples.push(line);
    explained.set(hit.e.id, g);
  }
  return { explained: [...explained.values()], unexplained };
}

/** The verifier's output: the mismatch lines, the compared count, and whether it ran to the end. */
export function parseVerifierOutput(stdout: string, exitCode: number | null): { completed: boolean; compared: number; reportedMismatches: number; lines: string[] } {
  const lines = stdout
    .split("\n")
    .filter((l) => /^\s*MISMATCH /.test(l))
    .map((l) => l.replace(/^\s*MISMATCH /, "").trim());
  const m = /compared (\d+) stored values\/properties with the filing\(s\) of \d+ funder\(s\); (\d+) mismatch\(es\)/.exec(stdout);
  const ranToEnd = !!m && (exitCode === 0 || exitCode === 1) && /RESULT: (PASS|FAIL)/.test(stdout);
  return { completed: ranToEnd && Number(m![2]) === lines.length, compared: m ? Number(m[1]) : 0, reportedMismatches: m ? Number(m[2]) : 0, lines };
}

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------
/** Seconds to wait before attempt `attempt + 1` after attempt `attempt` failed: 30, 120, 480 ... capped at 15 minutes. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 4 ** (attempt - 1), 900);
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------
export interface ChildResult {
  ok: boolean;
  runId?: string;
  error?: string;
  peakRssMb?: number;
  seconds?: number;
}
export interface VerifierResult {
  completed: boolean;
  compared: number;
  lines: string[];
  error?: string;
}
export interface Store {
  readonly label: string;
  runsForState(state: string): Promise<RunRow[]>;
  getRun(id: string): Promise<RunRow | null>;
  annotate(id: string, patch: Record<string, unknown>): Promise<void>;
  markInterrupted(ids: string[], note: string): Promise<void>;
  funderCounts(state: string): Promise<FunderCount[]>;
  writeSupervisor(row: { status: "running" | "completed" | "failed" | "interrupted"; counts: Record<string, unknown>; notes: string; parameters: Record<string, unknown>; begin?: boolean }): Promise<void>;
  /** Close any connection that would block another process from opening the same database (a local database only). */
  release(): Promise<void>;
}
export interface Manifest {
  states: Record<string, { phase: string; run_id?: string; digest?: string; updated_at: string }>;
}
export interface Deps {
  store: Store;
  runChild(state: string, attempt: number): Promise<ChildResult>;
  runVerifier(eins: string[], state: string): Promise<VerifierResult>;
  readManifest(): Manifest;
  writeManifest(m: Manifest): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
  /** Called with everything just written to the standing row, so a stop signal can write the same thing marked interrupted. */
  onPublish?(snapshot: { counts: Record<string, unknown>; notes: string; parameters: Record<string, unknown> }): void;
}
export interface Options {
  states: string[];
  digests: Record<string, { rows: number; digest: string }>;
  loaderVersion: string;
  years: number[];
  threshold: Threshold;
  sampleSize: number;
  seed: string;
  forceFull: boolean;
  maxAttempts: number;
  exceptions: ExceptionEntry[];
  exceptionsSha256: string;
  dryRun: boolean;
  parameters: Record<string, unknown>;
}
export interface Outcome {
  exitCode: 0 | 1 | 3;
  states: Record<string, StateReport>;
  plan: Array<{ state: string; action: string; why: string }>;
  halted: { state: string; reason: string } | null;
}

export async function runAllStates(d: Deps, o: Options): Promise<Outcome> {
  const report: Record<string, StateReport> = {};
  const stamp = () => d.now().toISOString();
  for (const s of o.states) report[s] = { status: "pending", updated_at: stamp() };
  const plan: Outcome["plan"] = [];
  let halted: Outcome["halted"] = null;
  const manifest = d.readManifest();

  const publish = async (status: "running" | "completed" | "failed" | "interrupted", notes: string, begin = false) => {
    if (o.dryRun) return;
    const counts = { command: ALL_STATES_VERSION, states: JSON.parse(JSON.stringify(report)), halted, updated_at: stamp() };
    const parameters = { kind: "all_states_supervisor", ...o.parameters };
    d.onPublish?.({ counts, notes, parameters });
    await d.store.writeSupervisor({ status, counts, notes, parameters, begin });
  };
  const set = async (state: string, status: StateStatus, extra: Partial<StateReport> = {}) => {
    report[state] = { ...report[state], note: undefined, ...extra, status, updated_at: stamp() };
    await publish("running", `${state}: ${status}${extra.note ? " - " + extra.note : ""}`);
  };
  const phase = (state: string, ph: string, runId?: string) => {
    if (o.dryRun) return;
    manifest.states[state] = { phase: ph, run_id: runId ?? manifest.states[state]?.run_id, digest: o.digests[state]?.digest, updated_at: stamp() };
    d.writeManifest(manifest);
  };

  await publish("running", `starting: ${o.states.length} state(s)`, true);

  for (let i = 0; i < o.states.length; i++) {
    const state = o.states[i];
    const dg = o.digests[state];
    if (!dg) {
      await set(state, "failed", { note: "the IRS index has no returns for this state" });
      continue;
    }
    const runs = await d.store.runsForState(state);
    const want: Wanted = {
      loaderVersion: o.loaderVersion,
      years: o.years,
      threshold: o.threshold,
      state,
      digest: dg.digest,
      verification: { mode: verificationMode(runs, o.loaderVersion, o.forceFull), size: o.sampleSize, seed: o.seed },
    };
    const man = manifest.states[state];
    const decision = decideState(runs, want, man && man.digest === dg.digest ? (man.run_id ?? null) : null);
    plan.push({ state, action: decision.action, why: decision.why });
    if (o.dryRun) continue;

    // A run of this state that was started and never finished was killed: say so before doing anything else.
    const stale = runs.filter((r) => r.status === "running").map((r) => r.id);
    if (stale.length) await d.store.markInterrupted(stale, `found still running when ${ALL_STATES_VERSION} resumed this state; the process that started it did not finish`);

    if (decision.action === "skip") {
      await set(state, "skipped_complete", { run_id: decision.run.id, note: decision.why });
      continue;
    }

    let runId: string | undefined = decision.action === "verify" ? decision.run.id : undefined;
    let childMeta: { attempt?: number; peakRssMb?: number; seconds?: number } = {};

    if (decision.action === "load") {
      let loaded = false;
      let lastError = "";
      for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
        await set(state, attempt === 1 ? "loading" : "retrying", { attempt, note: attempt === 1 ? decision.why : `attempt ${attempt} of ${o.maxAttempts} after: ${lastError}` });
        phase(state, "loading");
        await d.store.release();
        const r = await d.runChild(state, attempt);
        if (r.ok && r.runId) {
          runId = r.runId;
          childMeta = { attempt, peakRssMb: r.peakRssMb, seconds: r.seconds };
          loaded = true;
          break;
        }
        lastError = r.error ?? "the child process failed";
        // whatever run the failed attempt began is still recorded as running: say it was interrupted
        const left = (await d.store.runsForState(state)).filter((x) => x.status === "running").map((x) => x.id);
        if (left.length) await d.store.markInterrupted(left, `attempt ${attempt} of ${o.maxAttempts} ended without finishing: ${lastError}`);
        if (attempt < o.maxAttempts) await d.sleep(backoffSeconds(attempt) * 1000);
      }
      if (!loaded) {
        await set(state, "failed", { attempt: o.maxAttempts, note: `failed ${o.maxAttempts} time(s); last error: ${lastError}` });
        phase(state, "failed");
        continue;
      }
      phase(state, "loaded", runId);
      await set(state, "loaded", { run_id: runId, attempt: childMeta.attempt });
    }

    // ---- the load must be sound before its sample means anything ----
    const run = await d.store.getRun(runId!);
    const loadProblems = evaluateLoad(run, want);
    if (loadProblems.length) {
      await d.store.annotate(runId!, { supervisor: baseAnnotation(o, state, dg, childMeta, null, false, loadProblems, stamp()) });
      await set(state, "not_verified", { run_id: runId, note: loadProblems.join("; ") });
      phase(state, "not_verified", runId);
      halted = { state, reason: `the load is not sound: ${loadProblems.join("; ")}` };
      break;
    }
    await d.store.annotate(runId!, { supervisor: baseAnnotation(o, state, dg, childMeta, null, false, ["the sample has not been verified yet"], stamp()) });

    // ---- the verified sample ----
    await set(state, "verifying", { run_id: runId });
    phase(state, "verifying", runId);
    await d.store.release();
    const funders = await d.store.funderCounts(state);
    const full = want.verification.mode === "full";
    const pick = full
      ? { eins: funders.map((f) => f.ein).sort(), mostGrantRows: chooseSample(funders, 0, o.seed, state).mostGrantRows, mostPeopleRows: chooseSample(funders, 0, o.seed, state).mostPeopleRows }
      : chooseSample(funders, o.sampleSize, o.seed, state);
    await d.store.release();
    const vr = await d.runVerifier(pick.eins, state);
    const cls = classifyMismatches(vr.lines, o.exceptions);
    const record: VerificationRecord = {
      verified: vr.completed && cls.unexplained.length === 0,
      mode: want.verification.mode,
      seed: o.seed,
      size_requested: full ? funders.length : o.sampleSize,
      funders_in_state: funders.length,
      funders_checked: pick.eins.length,
      must_include: { most_grant_rows: pick.mostGrantRows, most_people_rows: pick.mostPeopleRows },
      compared: vr.compared,
      mismatches: vr.lines.length,
      explained: cls.explained,
      unexplained: cls.unexplained.length,
      unexplained_examples: cls.unexplained.slice(0, 20),
      exceptions_sha256: o.exceptionsSha256,
      verified_at: stamp(),
      ...(vr.completed ? {} : { error: vr.error ?? "the verifier did not run to the end" }),
    };
    if (!record.verified) {
      const why = !vr.completed ? `the verifier did not complete: ${record.error}` : `${cls.unexplained.length} unexplained mismatch(es) in the sample; first: ${cls.unexplained[0]}`;
      await d.store.annotate(runId!, { supervisor: baseAnnotation(o, state, dg, childMeta, record, false, [why], stamp()) });
      await set(state, "not_verified", { run_id: runId, note: why });
      phase(state, "not_verified", runId);
      halted = { state, reason: why };
      break;
    }
    await d.store.annotate(runId!, { supervisor: baseAnnotation(o, state, dg, childMeta, record, true, [], stamp()) });
    await set(state, "complete", { run_id: runId, note: `${record.funders_checked} of ${record.funders_in_state} funders verified, ${record.compared} values compared, ${record.mismatches} mismatch(es), all explained` });
    phase(state, "complete", runId);
  }

  if (halted) for (const s of o.states) if (report[s].status === "pending") report[s] = { status: "not_reached", note: `stopped before this state: ${halted.state} is not verified`, updated_at: stamp() };
  const failed = o.states.filter((s) => report[s].status === "failed");
  const exitCode: Outcome["exitCode"] = halted ? 1 : failed.length ? 3 : 0;
  await publish(
    exitCode === 0 ? "completed" : "failed",
    halted ? `HALTED at ${halted.state}: ${halted.reason}` : failed.length ? `finished with ${failed.length} failed state(s): ${failed.join(", ")}` : `finished: ${o.states.length} state(s) complete`
  );
  return { exitCode, states: report, plan, halted };
}

function baseAnnotation(o: Options, state: string, dg: { rows: number; digest: string }, c: { attempt?: number; peakRssMb?: number; seconds?: number }, v: VerificationRecord | null, complete: boolean, problems: string[], at: string): Annotation {
  return {
    command: ALL_STATES_VERSION,
    input_digest: dg.digest,
    input_rows: dg.rows,
    loader_version: o.loaderVersion,
    years: o.years,
    threshold: o.threshold,
    state,
    attempt: c.attempt,
    peak_rss_mb: c.peakRssMb,
    child_seconds: c.seconds,
    verification: v,
    complete,
    problems,
    updated_at: at,
  };
}
