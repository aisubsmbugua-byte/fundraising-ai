// Item 114 (ruling 0046): mutation check for the all-states command and the memory fix.
// Break each key decision in turn and confirm a NAMED assertion fails. A decision whose
// removal changes no test result is a decision nobody is checking.
//
// FOR THE OWNER. The all-states command makes decisions that must not quietly go wrong:
// which states come first, when a state counts as complete, when to skip it, when to
// stop, how many times to retry, which funders the check always includes, and that the
// loader keeps no whole return in memory. This script breaks each one on purpose and
// shows that the tests notice.
//
// How it works (same as scripts/mutation-check-network-identity.ts). For every mutation
// below: (1) confirms the text to change appears in the source file exactly once;
// (2) writes the mutated source; (3) runs the test that should catch it; (4) reads the
// FAIL lines; (5) restores the original byte for byte, in a `finally` and again on exit
// or interrupt. A mutation is CAUGHT when the run reports a FAIL whose label contains
// the expected text. A mutation that is not caught makes this script exit non-zero.
// It first runs the tests unmutated and refuses to continue unless they pass.
//
// Usage: npx tsx scripts/mutation-check-all-states.ts          (all)
//        npx tsx scripts/mutation-check-all-states.ts M3 M10   (some)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(__dirname, "..");

type Test = "unit" | "e2e" | "memory";
type Mutation = { id: string; guard: string; file: string; find: string; replace: string; test: Test; expectFail: string[] };

const S = "lib/funder-reference/supervisor.ts";
const P = "lib/funder-reference/pipeline.ts";
const R = "lib/funder-reference/run-store.ts";
const Z = "lib/funder-reference/zip.ts";

const MUTATIONS: Mutation[] = [
  { id: "M1", guard: "priority states come first", file: S, find: "return [...first, ...rest];", replace: "return [...rest, ...first];", test: "unit", expectFail: ["come first, in the owner's order"] },
  { id: "M2", guard: "the rest are ordered by return count, most first", file: S, find: "returnsByState[b] - returnsByState[a] ||", replace: "returnsByState[a] - returnsByState[b] ||", test: "unit", expectFail: ["the rest follow by number of returns"] },
  { id: "M3", guard: "completeness 1: the run finished", file: S, find: 'if (run.status !== "completed") problems.push', replace: 'if (false) problems.push', test: "unit", expectFail: ["1. a run that did not finish is not sound"] },
  { id: "M4", guard: "completeness 2: the outcome counts add up", file: S, find: "if (total !== c.index_rows_considered)", replace: "if (false)", test: "unit", expectFail: ["2. counts that do not sum"] },
  { id: "M5", guard: "completeness 3: the header audit found nothing elsewhere", file: S, find: "else if (audit.said_not_in_state_but_return_is_in_state !== 0)", replace: "else if (false)", test: "unit", expectFail: ["3. a header audit that found a return"] },
  { id: "M6", guard: "completeness 3: the header audit must have read something", file: S, find: "audit.sampled <= 0)", replace: "audit.sampled < 0)", test: "unit", expectFail: ["an audit that read nothing is not sound"] },
  { id: "M7", guard: "completeness 4: an unexplained mismatch on the record keeps a state from being complete", file: S, find: 'if (v.unexplained > 0) out.push(`${v.unexplained} unexplained mismatch(es) in the sample`);', replace: "", test: "unit", expectFail: ["still carries an unexplained mismatch"] },
  { id: "M8", guard: "completeness 4: the sample must be verified", file: S, find: 'if (!v.verified) out.push("the sample is recorded as not verified");', replace: "", test: "unit", expectFail: ["verified:false is not complete"] },
  { id: "M9", guard: "a state whose input changed is reloaded", file: S, find: 'if (ann.input_digest !== want.digest) return { action: "load"', replace: 'if (false) return { action: "load"', test: "unit", expectFail: ["the index gained returns for the state"] },
  { id: "M10", guard: "a complete state is skipped", file: S, find: 'if (vp.length === 0) return { action: "skip"', replace: 'if (false) return { action: "skip"', test: "unit", expectFail: ["= SKIP", "run twice"] },
  { id: "M11", guard: "the skip is acted on", file: S, find: 'if (decision.action === "skip") {', replace: "if (false) {", test: "unit", expectFail: ["run twice", "the test run crashed"] },
  { id: "M12", guard: "an unexplained mismatch halts before the next state", file: S, find: 'phase(state, "not_verified", runId);\n      halted = { state, reason: why };\n      break;', replace: 'phase(state, "not_verified", runId);\n      halted = { state, reason: why };', test: "unit", expectFail: ["STOPS before the next state"] },
  { id: "M13", guard: "an unsound load halts before its sample", file: S, find: 'phase(state, "not_verified", runId);\n      halted = { state, reason: `the load is not sound: ${loadProblems.join("; ")}` };\n      break;', replace: 'phase(state, "not_verified", runId);\n      halted = { state, reason: `the load is not sound: ${loadProblems.join("; ")}` };', test: "unit", expectFail: ["outcome counts that do not sum stop the run"] },
  { id: "M14", guard: "a mismatch with a written exception is explained", file: S, find: "const hit = res.find((x) => x.re.test(line));", replace: "const hit = undefined as (typeof res)[number] | undefined;", test: "unit", expectFail: ["matching a written entry is explained"] },
  { id: "M15", guard: "a mismatch with no exception is unexplained", file: S, find: "      unexplained.push(line);\n      continue;", replace: "      continue;", test: "unit", expectFail: ["matching no entry is unexplained"] },
  { id: "M16", guard: "a verifier that crashed is not 'verified'", file: S, find: "verified: vr.completed && cls.unexplained.length === 0,", replace: "verified: cls.unexplained.length === 0,", test: "unit", expectFail: ["a verifier that does not complete leaves the state not verified"] },
  { id: "M17", guard: "the retry is bounded", file: S, find: "attempt <= o.maxAttempts; attempt++", replace: "attempt <= o.maxAttempts + 1; attempt++", test: "unit", expectFail: ["never a fourth"] },
  { id: "M18", guard: "the pause between attempts grows", file: S, find: "30 * 4 ** (attempt - 1)", replace: "30 * 1 ** (attempt - 1)", test: "unit", expectFail: ["the pause before the next attempt grows"] },
  { id: "M19", guard: "a failed state does not stop the others", file: S, find: '        phase(state, "failed");\n        continue;', replace: '        phase(state, "failed");\n        break;', test: "unit", expectFail: ["keeps going across states", "carries on"] },
  { id: "M20", guard: "the sample always includes the funders with the most grant rows and people", file: S, find: "const chosen = new Set<string>([...byGrants, ...byPeople].map((f) => f.ein));", replace: "const chosen = new Set<string>();", test: "unit", expectFail: ["with the most grant rows is always in"] },
  { id: "M21", guard: "the sample is seeded", file: S, find: 'createHash("sha256").update(`${seed}|${state}|${ein}`)', replace: 'createHash("sha256").update(`${ein}`)', test: "unit", expectFail: ["a different seed gives a different sample"] },
  { id: "M22", guard: "the sample has the stated size", file: S, find: "if (chosen.size >= size) break;", replace: "if (chosen.size > size) break;", test: "unit", expectFail: ["the sample has the stated size"] },
  { id: "M23", guard: "a return whose header cannot be read counts into every state's input", file: S, find: "if (!headerRead) {", replace: "if (false) {", test: "unit", expectFail: ["an unreadable header counted into every state"] },
  { id: "M24", guard: "full verification after the loader's code changed", file: S, find: 'return anyEarlierComplete && !everVerifiedUnder ? "full" : "sample";', replace: 'return "sample";', test: "unit", expectFail: ["verified in FULL"] },
  { id: "M25", guard: "an exception pattern that matches everything is refused", file: S, find: 'if (re.test("") || (re.test(a) && re.test(b)))', replace: "if (false)", test: "unit", expectFail: ["a pattern that matches the empty line is refused"] },
  { id: "M26", guard: "a run found still 'running' is marked interrupted", file: S, find: "if (stale.length) await d.store.markInterrupted(", replace: "if (false) await d.store.markInterrupted(", test: "unit", expectFail: ["resuming after a kill"] },
  { id: "M27", guard: "the sample result is written onto the state's run", file: S, find: "await d.store.annotate(runId!, { supervisor: baseAnnotation(o, state, dg, childMeta, record, true, [], stamp()) });", replace: "", test: "unit", expectFail: ["each state's run carries the note"] },
  { id: "M28", guard: "the standing row is one row for ever (a second invocation writes no new row)", file: R, find: 'createHash("sha1").update("funder-reference/all-states-supervisor")', replace: 'createHash("sha1").update(String(Math.random()))', test: "e2e", expectFail: ["writes ZERO new rows in the run table"] },
  { id: "M29", guard: "a state's run touches only its own funders' coverage", file: P, find: "await sink.replaceCoverage([...consideredEins], coverage);", replace: "await sink.replaceCoverage(p.rows.map((r) => r.ein), coverage);", test: "e2e", expectFail: ["does not erase an earlier state's coverage"] },
  { id: "M30", guard: "the pass-A cache is per state", file: P, find: "r.loader === LOADER_VERSION && r.state === state)", replace: "r.loader === LOADER_VERSION)", test: "memory", expectFail: ["does NOT take California's record"] },
  { id: "M31", guard: "pass A keeps no whole return alive (the memory fix)", file: P, find: "returnTs: detach(f.returnTs) };", replace: "returnTs: f.returnTs };", test: "memory", expectFail: ["inside a 96 MB old-space limit"] },
  { id: "M32", guard: "the archive reader lists only the members asked for", file: Z, find: "if (keep && !keep(name)) {", replace: "if (false) {", test: "memory", expectFail: ["with keep, only the members asked for are listed"] },
  { id: "M33", guard: "a copied string refers to nothing else", file: "lib/funder-reference/strings.ts", find: 'return (" " + s).slice(1);', replace: "return s;", test: "memory", expectFail: ["detached copies do not"] },
  { id: "M34", guard: "a filer's own EIN in the signing officer's SSN field is not a leak (found on the first real multi-state run)", file: "scripts/verify-funder-reference-example.ts", find: 'if (ssn.replace(/\\D/g, "") === (txt(header, "Filer/EIN") ?? "")) ssnFieldHoldsEin.push(tag);', replace: "if (false) ssnFieldHoldsEin.push(tag);", test: "e2e", expectFail: ["typed its own EIN into the signing officer's SSN field"] },
  { id: "M35", guard: "a return over the read limit is not parsed", file: P, find: "if (loc.entry.size > maxReturnBytes) {", replace: "if (false) {", test: "memory", expectFail: ["a return over the read limit is recorded as unread"] },
  { id: "M36", guard: "a filing over the write limit is not written", file: P, find: "if (docBytes > maxWriteBytes) {", replace: "if (false) {", test: "memory", expectFail: ["write document is over the write limit"] },
];

const TESTS: Record<Test, { cmd: string; env: Record<string, string> }> = {
  unit: { cmd: "scripts/test-all-states.ts", env: { ALL_STATES_SKIP_E2E: "1" } },
  e2e: { cmd: "scripts/test-all-states.ts", env: {} },
  memory: { cmd: "scripts/test-funder-reference-memory.ts", env: {} },
};

function run(t: Test): { fails: string[]; passed: number; failed: number } {
  const r = spawnSync("npx", ["tsx", TESTS[t].cmd], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...TESTS[t].env } });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = raw.split("\n").filter((l) => l.startsWith("FAIL: ")).map((l) => l.slice(6));
  const m = raw.match(/(\d+) passed, (\d+) failed/);
  // a crash that prints no summary counts as failed so that it can never look like a pass
  return { fails, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : -1 };
}

const originals = new Map<string, string>();
function restoreAll() {
  for (const [file, text] of originals) {
    try {
      writeFileSync(join(root, file), text);
    } catch {
      /* best effort on the way out */
    }
  }
}
process.on("exit", restoreAll);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

const wanted = process.argv.slice(2);
const todo = MUTATIONS.filter((m) => wanted.length === 0 || wanted.includes(m.id));

console.log("Baseline (nothing mutated):");
for (const t of new Set(todo.map((m) => m.test))) {
  const b = run(t);
  console.log(`  ${t}: ${b.passed} passed, ${b.failed} failed`);
  if (b.failed !== 0) {
    console.error("The baseline does not pass, so a mutation result would mean nothing. Stopping.");
    process.exit(2);
  }
}

type Row = { m: Mutation; status: "CAUGHT" | "NOT CAUGHT" | "NOT APPLIED"; failing: string[]; detail: string };
const rows: Row[] = [];
for (const m of todo) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");
  originals.set(m.file, original);
  const occurrences = original.split(m.find).length - 1;
  if (occurrences !== 1) {
    rows.push({ m, status: "NOT APPLIED", failing: [], detail: `the text to change appears ${occurrences} times (must be exactly once)` });
    continue;
  }
  try {
    writeFileSync(path, original.replace(m.find, () => m.replace));
    const r = run(m.test);
    const matched = m.expectFail.filter((e) => r.fails.some((f) => f.includes(e)));
    rows.push({ m, status: matched.length > 0 && r.fails.length > 0 ? "CAUGHT" : "NOT CAUGHT", failing: r.fails, detail: `${r.passed} passed, ${r.failed} failed; expected-label matches: ${matched.length}/${m.expectFail.length}` });
  } finally {
    writeFileSync(path, original);
    if (readFileSync(path, "utf8") !== original) throw new Error(`could not restore ${m.file}`);
    originals.delete(m.file);
  }
}

console.log("\nMutation results:\n");
for (const r of rows) {
  console.log(`${r.m.id}  ${r.status}  --  ${r.m.guard}`);
  console.log(`      file: ${r.m.file}; run: ${TESTS[r.m.test].cmd}; ${r.detail}`);
  for (const f of r.failing.slice(0, 3)) console.log(`      FAIL: ${f.length > 180 ? `${f.slice(0, 180)}...` : f}`);
  if (r.failing.length > 3) console.log(`      ... and ${r.failing.length - 3} more failing assertions`);
}
const bad = rows.filter((r) => r.status !== "CAUGHT");
console.log(`\n${rows.length - bad.length} of ${rows.length} mutations caught.${bad.length ? ` NOT CAUGHT / NOT APPLIED: ${bad.map((b) => b.m.id).join(", ")}` : ""}`);
process.exit(bad.length > 0 ? 1 : 0);
