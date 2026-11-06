// Mutation check for STATE item 107 slice A (ruling 0044): break each guard in
// turn and confirm a NAMED assertion fails. A guard whose removal changes no test
// result is a guard nobody is checking.
//
// How it works. For every mutation below this script: (1) confirms the text to
// change appears in the source file exactly once; (2) writes the mutated source;
// (3) runs the test file that should catch it (a child process: `npx tsx
// scripts/<test>.ts`); (4) reads the FAIL lines; (5) restores the original source
// byte for byte -- in a `finally`, and again on exit or interrupt -- and checks
// the restore. A mutation is CAUGHT when the run reports at least one FAIL whose
// label contains the expected text. A mutation that is not caught makes this
// script exit non-zero.
//
// It first runs both test files unmutated and refuses to continue unless they
// pass, so a "caught" always means the mutation, not a broken baseline.
//
// Usage: npx tsx scripts/mutation-check-network-identity.ts            (all)
//        npx tsx scripts/mutation-check-network-identity.ts M3 M5b     (some)

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
  test: "scripts/test-network-identity.ts" | "scripts/test-network-identity-migration.ts";
  // Each of these must appear inside a FAIL label for the mutation to count as caught.
  expectFail: string[];
};

const APP = "app/(dashboard)/network";
const MIGRATION = "supabase/migrations/0083_network_identity.sql";
const T = "scripts/test-network-identity.ts" as const;
const M = "scripts/test-network-identity-migration.ts" as const;

const MUTATIONS: Mutation[] = [
  {
    id: "M1",
    guard: "the do-not-research refusal (the rule)",
    file: "lib/network-identity.ts",
    find: '  if (person.do_not_research === true) {\n    return { code: "do_not_research"',
    replace: '  if (false as boolean) {\n    return { code: "do_not_research"',
    test: T,
    expectFail: ["a do-not-research person is refused"],
  },
  {
    id: "M1b",
    guard: "the do-not-research refusal (the action: it stops calling the refusal at all)",
    file: `${APP}/identity-actions.ts`,
    find: '  if (refusal) return { kind: "refused", refusal };',
    replace: "",
    test: T,
    expectFail: ["ZERO ledger runs, ZERO model calls"],
  },
  {
    id: "M2a",
    guard: "the social-network source refusal on a candidate",
    file: "lib/network-identity.ts",
    find: "    const refusedKind = refusedSourceKind(source.url);\n    if (refusedKind !== null) {",
    replace: "    const refusedKind = refusedSourceKind(source.url);\n    if ((false as boolean) && refusedKind !== null) {",
    test: T,
    expectFail: ["a candidate whose source is a social network"],
  },
  {
    id: "M2b",
    guard: "the social-network source refusal when the numbered source list is built",
    file: "lib/network-identity.ts",
    find: "    const kind = refusedSourceKind(url);\n    if (kind !== null) {",
    replace: "    const kind = refusedSourceKind(url);\n    if ((false as boolean) && kind !== null) {",
    test: T,
    expectFail: ["are NOT offered to the model"],
  },
  {
    id: "M2c",
    guard: "the social-network host list itself (LinkedIn et al. no longer recognised)",
    file: "lib/network-identity.ts",
    find: '  if (hostIsOrUnder(host, SOCIAL_NETWORK_HOSTS)) return "social_network";\n',
    replace: "",
    test: T,
    expectFail: ["refusedSourceKind refuses every social host"],
  },
  {
    id: "M3",
    guard: "capture, don't retype: a URL the model typed is let through",
    file: "lib/network-identity.ts",
    find: "      source_url: source.url,\n",
    replace: '      source_url: typeof item.source_url === "string" ? item.source_url : source.url,\n',
    test: T,
    expectFail: ["a URL, a title or a passage the model TYPED is never read"],
  },
  {
    id: "M4",
    guard: "no auto-confirmation: the look confirms the preselected candidate by itself",
    file: `${APP}/identity-actions.ts`,
    find: "      if (insertError) throw new Error(insertError.message);\n    }\n",
    replace:
      "      if (insertError) throw new Error(insertError.message);\n      const stored = await candidatesOf(supabase, person.id);\n      const pre = stored ? preselectedCandidate(stored, factsOf(person)) : null;\n      if (pre) await supabase.from(\"network_connections\").update({ identity_status: \"confirmed\", identity_candidate_id: pre.id, identity_decided_by: \"system\", identity_decided_at: new Date().toISOString() }).eq(\"id\", person.id);\n    }\n",
    test: T,
    expectFail: ["THE LOOK CONFIRMS NOTHING", "the finder never writes identity_status itself"],
  },
  {
    id: "M5",
    guard: "reset-on-edit in the server action",
    file: `${APP}/actions.ts`,
    find: "    const voidsConfirmation = wasConfirmed && (identityFactsChanged(before, after) || markingOff);",
    replace: "    const voidsConfirmation = false as boolean;",
    test: T,
    expectFail: ["changing the person_name of a CONFIRMED person resets them", "changing the affiliation of a CONFIRMED person resets them"],
  },
  {
    id: "M5b",
    guard: "reset-on-edit in the DATABASE (the trigger is never created)",
    file: MIGRATION,
    find: "create trigger network_connections_identity_reset\n  before update on network_connections\n  for each row execute function reset_network_identity_on_edit();\n",
    replace: "",
    test: M,
    expectFail: ["changing person_name: back to unconfirmed", "changing city: back to unconfirmed"],
  },
  {
    id: "M6",
    guard: "agent exclusion: the external agent's tool registry imports an identity action",
    file: "lib/agent/tools.ts",
    find: 'import { enforceAllowlist } from "@/lib/assistant/dispatch";\n',
    replace: 'import { confirmIdentity } from "@/app/(dashboard)/network/identity-actions";\nvoid confirmIdentity;\nimport { enforceAllowlist } from "@/lib/assistant/dispatch";\n',
    test: T,
    expectFail: ["names or imports any identity action"],
  },
  {
    id: "M6b",
    guard: "agent exclusion: the HTTP route the agent connects through (app/api/mcp/route.ts) imports an identity action",
    file: "app/api/mcp/route.ts",
    find: "export const maxDuration = 300;",
    replace: 'import { markNoneOfThese } from "@/app/(dashboard)/network/identity-actions";\nvoid markNoneOfThese;\nexport const maxDuration = 300;',
    test: T,
    expectFail: ["names or imports any identity action"],
  },
  {
    id: "M7",
    guard: "the batch confirm trusts the pair the client sent (no re-check that it is still the preselected match)",
    file: `${APP}/identity-actions.ts`,
    find: "      if (!pre || pre.id !== it.candidateId) {",
    replace: "      if (!pre && (false as boolean)) {",
    test: T,
    expectFail: ["the batch confirms exactly the two pairs"],
  },
  {
    id: "M8",
    guard: "the per-click cap on 'find matches for everyone'",
    file: `${APP}/identity-actions.ts`,
    find: "      if (attempted >= IDENTITY_BULK_CAP) {",
    replace: "      if ((false as boolean) && attempted >= IDENTITY_BULK_CAP) {",
    test: T,
    expectFail: ["the first click looks at 10 of the 14 eligible"],
  },
  {
    id: "M9",
    guard: "preselection only when EXACTLY ONE candidate qualifies",
    file: "lib/network-identity.ts",
    find: "  return qualifying.length === 1 ? qualifying[0] : null;",
    replace: "  return qualifying.length >= 1 ? qualifying[0] : null;",
    test: T,
    expectFail: ["TWO candidates that both qualify leave NOTHING preselected"],
  },
  {
    id: "M10",
    guard: "metering: the run is no longer born before the model call (the birth is moved after it)",
    file: `${APP}/identity-actions.ts`,
    find: '    aiRunId = await beginRun(supabase, { operation: "network_identity", sourceTable: "network_connections", sourceId: person.id });',
    replace: '    aiRunId = "unmetered";',
    test: T,
    expectFail: ["ONE ledger run is born for the whole look", "the run was BORN BEFORE the first model call"],
  },
  {
    id: "M11",
    guard: "the database refuses candidates for a do-not-research person",
    file: MIGRATION,
    find: "    if c.do_not_research then\n      raise exception 'candidates cannot be recorded for a person marked do not research';\n    end if;\n",
    replace: "",
    test: M,
    expectFail: ["a do-not-research person cannot be given a candidate"],
  },
  {
    id: "M12",
    guard: "the database refuses a social-network source URL",
    file: MIGRATION,
    find: "!~ '(^|\\.)(linkedin\\.com|",
    replace: "!~ '(^|\\.)(not-a-host\\.invalid|",
    test: M,
    expectFail: ["every one of the 37 hosts the code refuses is refused by the database too", "the host list in the migration is exactly"],
  },
  {
    id: "M13",
    guard: "the database: deleting the chosen candidate voids the confirmation (the trigger is never created)",
    file: MIGRATION,
    find: "create trigger network_identity_candidates_void_decision\n  before delete on network_identity_candidates\n  for each row execute function void_network_identity_when_candidate_deleted();\n",
    replace: "",
    test: M,
    expectFail: ["deleting the chosen candidate is allowed", "voids the confirmation"],
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
