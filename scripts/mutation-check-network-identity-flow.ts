// Mutation check for STATE item 109 (the shorter route through person identity,
// ruling 0044 clauses 2 and 9): break each new guard in turn and confirm a NAMED
// assertion in scripts/test-network-identity-flow.ts fails. A guard whose removal
// changes no test result is a guard nobody is checking.
//
// How it works. For every mutation below this script: (1) confirms the text to
// change appears in the source file exactly once; (2) writes the mutated source;
// (3) runs the test file (a child process: `npx tsx scripts/<test>.ts`); (4) reads
// the FAIL lines; (5) restores the original source byte for byte -- in a
// `finally`, and again on exit or interrupt -- and checks the restore. A mutation
// is CAUGHT when the run reports at least one FAIL whose label contains the
// expected text. A mutation that is not caught makes this script exit non-zero.
//
// It first runs the test file unmutated and refuses to continue unless it passes.
//
// Usage: npx tsx scripts/mutation-check-network-identity-flow.ts            (all)
//        npx tsx scripts/mutation-check-network-identity-flow.ts F1 F5 (some)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(__dirname, "..");

type Mutation = {
  id: string;
  guard: string;
  file: string;
  find: string;
  replace: string;
  test: string;
  // Each of these must appear inside a FAIL label for the mutation to count as caught.
  expectFail: string[];
};

const APP = "app/(dashboard)/network";
const FLOW = "lib/network-identity-flow.ts";
const T = "scripts/test-network-identity-flow.ts";

const MUTATIONS: Mutation[] = [
  {
    id: "F1",
    guard: "the 50-per-click cap in the queue builder (the queue is no longer cut)",
    file: FLOW,
    find: "  const queue = todo.slice(0, cap);",
    replace: "  const queue = todo.slice();",
    test: T,
    expectFail: ["THE CAP: 212 people waiting"],
  },
  {
    id: "F1b",
    guard: "the hard ceiling of 50 (a caller can ask for more)",
    file: FLOW,
    find: "Math.min(Number.isFinite(opts.cap) ? Math.floor(opts.cap as number) : IDENTITY_CLICK_CAP, IDENTITY_CLICK_CAP)",
    replace: "(Number.isFinite(opts.cap) ? Math.floor(opts.cap as number) : IDENTITY_CLICK_CAP)",
    test: T,
    expectFail: ["THE CEILING"],
  },
  {
    id: "F1c",
    guard: "the cap inside the client loop itself",
    file: FLOW,
    find: "  const { queue } = buildLookupQueue(args.queue, { cap: args.cap });",
    replace: "  const queue = [...args.queue];",
    test: T,
    expectFail: ["THE LOOP'S CAP"],
  },
  {
    id: "F2",
    guard: "Stop: the loop ignores the stop request",
    file: FLOW,
    find: "    if (args.shouldStop()) {",
    replace: "    if (false as boolean) {",
    test: T,
    expectFail: ["STOP: after the 7th person"],
  },
  {
    id: "F3",
    guard: "the loop keeps spending after problems in a row",
    file: FLOW,
    find: "    if (inARow >= MAX_CONSECUTIVE_FAILURES) {",
    replace: "    if (false as boolean) {",
    test: T,
    expectFail: ["A BROKEN CONNECTION DOES NOT SPEND THE CLICK"],
  },
  {
    id: "F4",
    guard: "a name-only person is looked at automatically (the plan always says look)",
    file: FLOW,
    find: "  if (!refusal) return { look: true };",
    replace: "  return { look: true };",
    test: T,
    expectFail: ["NAME ONLY: no look"],
  },
  {
    id: "F4b",
    guard: "a do-not-research person is looked at automatically (the plan forgets the flag)",
    file: FLOW,
    find: "      do_not_research: person.do_not_research === true,",
    replace: "      do_not_research: false,",
    test: T,
    expectFail: ["DO NOT RESEARCH: no look"],
  },
  {
    id: "F5",
    guard: "NO AUTO-CONFIRMATION: the add flow confirms the person right after the look",
    file: `${APP}/network-workspace.tsx`,
    find: "    void lookFor(id, name);\n  };",
    replace: "    void lookFor(id, name).then(() => confirmIdentity(id, \"auto\"));\n  };",
    test: T,
    expectFail: ["NO ADD-PERSON OR IMPORT CODE CAN CONFIRM"],
  },
  {
    id: "F5b",
    guard: "NO AUTO-CONFIRMATION: the add flow records 'none of these' by itself when matches are read back",
    file: `${APP}/network-workspace.tsx`,
    find: "    await readMatches(id, name);\n  };",
    replace: "    await readMatches(id, name);\n    await markNoneOfThese(id);\n  };",
    test: T,
    expectFail: ["NO ADD-PERSON OR IMPORT CODE CAN CONFIRM"],
  },
  {
    id: "F5c",
    guard: "NO AUTO-CONFIRMATION: the person card confirms the chosen candidate from an effect, with no click",
    file: `${APP}/identity/person-card.tsx`,
    find: "  const submit = () =>",
    replace: "  require(\"react\").useEffect(() => { confirmChosen(); }, []);\n  const submit = () =>",
    test: T,
    expectFail: ["neither of them has an effect, a timer or a page-load hook"],
  },
  {
    id: "F6",
    guard: "AN IMPORT NEVER LOOKS: the import success path calls the look",
    file: `${APP}/import/import-workspace.tsx`,
    find: "          const queue = await loadLookupQueue();",
    replace: "          const queue = await loadLookupQueue();\n          await findIdentityCandidates(\"x\");",
    test: T,
    expectFail: ["AN IMPORT NEVER TRIGGERS A LOOK"],
  },
  {
    id: "F6b",
    guard: "AN IMPORT NEVER LOOKS: the import action file imports the look",
    file: `${APP}/import-actions.ts`,
    find: 'import { revalidatePath } from "next/cache";',
    replace: 'import { revalidatePath } from "next/cache";\nimport { findIdentityCandidates } from "./identity-actions";',
    test: T,
    expectFail: ["AN IMPORT NEVER TRIGGERS A LOOK", "the import action imports nothing from the identity actions"],
  },
  {
    id: "F7",
    guard: "'Confirm your network' posts people the human unticked or opened for a different choice",
    file: FLOW,
    find: "if (p.preselectedId === null || excluded.has(p.id)) continue;",
    replace: "if (p.preselectedId === null) continue;",
    test: T,
    expectFail: ["a person the human unticked or opened for a different choice is NOT in the pairs"],
  },
  {
    id: "F7b",
    guard: "the review screen posts every strong match, ignoring the ticks",
    file: `${APP}/identity/identity-workspace.tsx`,
    find: "const pairs = strongMatchPairs(strong, new Set([...excluded, ...choosing]));",
    replace: "const pairs = strongMatchPairs(strong);",
    test: T,
    expectFail: ["the review screen's one batch button posts only strongMatchPairs"],
  },
  {
    id: "F8",
    guard: "the lookup loop starts when the button appears, with no click",
    file: `${APP}/identity/lookup-runner.tsx`,
    find: "  // The ONLY place the loop is started: the click on the button.",
    replace: "  useEffect(() => { void start(); }, []);\n  // The ONLY place the loop is started: the click on the button.",
    test: T,
    expectFail: ["THE LOOKUP LOOP STARTS ONLY FROM A CLICK", "its one effect only STOPS the loop"],
  },
  {
    id: "F9",
    guard: "the lookup button calls the bulk server action instead of the single-person action",
    file: `${APP}/identity/lookup-runner.tsx`,
    find: "      look: (personId) => findIdentityCandidates(personId),",
    replace: "      look: () => findIdentityCandidatesForUnidentified() as never,",
    test: T,
    expectFail: ["THE OLD BULK BUTTON IS GONE FROM THE UI", "it calls the SINGLE-person action in the loop"],
  },
  {
    id: "F10",
    guard: "addConnection stops returning the new person's id (so the page cannot look for them)",
    file: `${APP}/actions.ts`,
    find: '    return { success: true, id: typeof created?.id === "string" ? created.id : null };',
    replace: "    return { success: true, id: null };",
    test: T,
    expectFail: ["addConnection returns the new person's id"],
  },
  {
    id: "F11",
    guard: "the cost statement is dropped from the click that spends",
    file: `${APP}/identity/lookup-runner.tsx`,
    find: "      : lookupCostStatement(eligible);",
    replace: '      : "";',
    test: T,
    expectFail: ["IDLE: one button 'Confirm your network'"],
  },
  {
    id: "F12",
    guard: "the server's refusal is removed: the client loop can reach a do-not-research, confirmed, none-of-these or name-only person",
    file: `${APP}/identity-actions.ts`,
    find: '  if (refusal) return { kind: "refused", refusal };',
    replace: "",
    test: T,
    expectFail: ["REFUSALS HOLD THROUGH THE CLIENT LOOP"],
  },
  {
    id: "F13",
    guard: "the add flow ignores the plan and looks at everyone it saves",
    file: `${APP}/network-workspace.tsx`,
    find: "    if (!plan.look) {",
    replace: "    if (false as boolean) {",
    test: T,
    expectFail: ["the add flow looks only after the save succeeded and only when the plan says so"],
  },
  {
    id: "F14",
    guard: "the add flow looks even when the save failed",
    file: `${APP}/network-workspace.tsx`,
    find: 'if ("success" in result) afterSave(result.id, input);\n          return result;',
    replace: "afterSave((result as { id?: string | null }).id ?? null, input);\n          return result;",
    test: T,
    expectFail: ["afterSave is called only on success"],
  },
  {
    id: "F15",
    guard: "the queue offers people the server would refuse (do-not-research, name-only) to the click",
    file: `${APP}/identity-actions.ts`,
    find: "ids: plan.eligible.slice(0, IDENTITY_CLICK_CAP).map((p) => p.id), eligible: plan.eligible.length,",
    replace: "ids: overview.people.slice(0, IDENTITY_CLICK_CAP).map((p) => p.id), eligible: overview.people.length,",
    test: T,
    expectFail: ["loadLookupQueue (a READ) names who is waiting"],
  },
  {
    id: "F16",
    guard: "the read that serves the in-place panel starts writing (a confirm hidden in a read)",
    file: `${APP}/identity-actions.ts`,
    find: "    const state = identityState(read.person, cands.length, false);",
    replace: '    await supabase.from("network_connections").update({ identity_status: "confirmed" }).eq("id", personId);\n    const state = identityState(read.person, cands.length, false);',
    test: T,
    expectFail: ["loadPersonCandidates and loadLookupQueue make no write", "AUTOMATIC LOOK, NO AUTOMATIC CONFIRMATION"],
  },
];

function run(test: string): { fails: string[]; passed: number; failed: number; raw: string } {
  const r = spawnSync("npx", ["tsx", test], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = raw.split("\n").filter((l) => l.startsWith("FAIL: ")).map((l) => l.slice(6));
  const m = raw.match(/(\d+) passed, (\d+) failed/);
  return { fails, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : -1, raw };
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
const baselines = new Map<string, ReturnType<typeof run>>();
for (const t of new Set(todo.map((m) => m.test))) {
  const b = run(t);
  baselines.set(t, b);
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
    rows.push({
      m,
      status: matched.length > 0 && r.fails.length > 0 ? "CAUGHT" : "NOT CAUGHT",
      failing: r.fails,
      detail: `${r.passed} passed, ${r.failed} failed; expected-label matches: ${matched.length}/${m.expectFail.length}`,
    });
  } finally {
    writeFileSync(path, original);
    if (readFileSync(path, "utf8") !== original) throw new Error(`could not restore ${m.file}`);
    originals.delete(m.file);
  }
}

console.log("\nMutation results:\n");
for (const r of rows) {
  console.log(`${r.m.id}  ${r.status}  --  ${r.m.guard}`);
  console.log(`      file: ${r.m.file}; run: ${r.m.test}; ${r.detail}`);
  for (const f of r.failing.slice(0, 4)) console.log(`      FAIL: ${f.length > 200 ? `${f.slice(0, 200)}...` : f}`);
  if (r.failing.length > 4) console.log(`      ... and ${r.failing.length - 4} more failing assertions`);
}
const bad = rows.filter((r) => r.status !== "CAUGHT");
console.log(`\n${rows.length - bad.length} of ${rows.length} mutations caught.${bad.length ? ` NOT CAUGHT / NOT APPLIED: ${bad.map((b) => b.m.id).join(", ")}` : ""}`);
process.exit(bad.length > 0 ? 1 : 0);
