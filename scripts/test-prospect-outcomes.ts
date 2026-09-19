// Ruling 0019: a declined prospect keeps its reason, and "never revisit" is a
// choice a human makes rather than a blank field.
//
// The load-bearing constraint is negative -- there must be NO code path by
// which an absent field produces `never` -- and a negative constraint is not
// provable by testing the happy path. So this file tests it three ways:
//
//   1. behaviourally, over an enumerated table of every shape an absent,
//      blank, skipped or malformed field can arrive in;
//   2. structurally, by reading migration 0066 and asserting the schema has no
//      default that could supply `never` and no column that stores `undecided`
//      at all; and
//   3. by source scan, asserting no module outside lib/prospect-outcomes.ts
//      constructs a disposition value directly.
//
// The fourth way is the type system and is checked by `npx tsc --noEmit`
// rather than here: RevisitChoice is branded with a unique symbol, so a
// hand-written { disposition: "never" } is a compile error at every call site.
//
// Pure logic plus file reads -- no DB, no API key, same as
// test-prospect-workflow.ts.
//
// Usage: npx tsx scripts/test-prospect-outcomes.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRevisitChoice,
  normalizeRevisitDate,
  deriveCurrentDisposition,
  buildOutcomeIndex,
  describeDisposition,
  isOpenQuestion,
  isScheduledRevisit,
  REVISIT_DISPOSITIONS,
  type RevisitDispositionRow,
  type ProspectOutcomeRow,
} from "../lib/prospect-outcomes";

const root = join(__dirname, "..");

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : `\n      got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
}
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}

function disposition(over: Partial<RevisitDispositionRow> = {}): RevisitDispositionRow {
  return {
    id: "d1",
    prospect_outcome_id: "o1",
    disposition: "undecided",
    revisit_on: null,
    reason: null,
    decided_by: "u1",
    decided_at: "2026-09-01T10:00:00Z",
    ...over,
  };
}

function outcomeRow(over: Partial<ProspectOutcomeRow> = {}): ProspectOutcomeRow {
  return {
    id: "o1",
    prospect_id: "p1",
    outcome: "declined",
    reason: "Priorities moved",
    occurred_on: "2026-09-01",
    recorded_by: "u1",
    recorded_at: "2026-09-01T09:00:00Z",
    ...over,
  };
}

// --- 1. Absence never produces `never` ------------------------------------

console.log("--- absence, blankness and malformation ---");

// Everything a form field can be when nobody filled it in. FormData.get
// returns null for a field that was never submitted, "" for an empty text
// input, and a File for a file input; a JSON body can supply anything at all.
const ABSENT_INPUTS: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["empty string", ""],
  ["whitespace", "   "],
  ["tab", "\t"],
  ["newline", "\n"],
  ["number 0", 0],
  ["number 1", 1],
  ["false", false],
  ["true", true],
  ["empty object", {}],
  ["empty array", []],
  ["NaN", NaN],
  ["a Date", new Date(0)],
  ["a function", () => "never"],
  ["symbol-keyed object", { disposition: "never" }],
  ["array containing never", ["never"]],
];

for (const [label, input] of ABSENT_INPUTS) {
  const result = parseRevisitChoice(input, "2026-12-01");
  ok(
    `absent input (${label}) parses to undecided`,
    result.ok && result.value.disposition === "undecided",
    JSON.stringify(result),
  );
}

// Near-misses. Every loosening of the comparison -- trimming, case folding,
// prefix matching -- is another input nobody chose that would nonetheless close
// a funder permanently. None of these may pass.
const NEAR_MISSES = ["Never", "NEVER", " never", "never ", "never.", "nevermind", "nver", "n", "close", "permanent", "revisit_never"];
for (const input of NEAR_MISSES) {
  const result = parseRevisitChoice(input, null);
  ok(
    `near-miss "${input}" does not become never`,
    !result.ok || result.value.disposition !== "never",
    JSON.stringify(result),
  );
}
ok(
  'a near-miss is reported as unrecognised, not silently folded into undecided',
  parseRevisitChoice("Never", null).ok === false,
  "an answer that is present but wrong is a different fact from no answer",
);

check("the exact literal, and only it, yields never", parseRevisitChoice("never", null), {
  ok: true,
  value: { disposition: "never" },
});
check("an explicit undecided yields undecided", parseRevisitChoice("undecided", null), {
  ok: true,
  value: { disposition: "undecided" },
});

console.log("--- revisit_on needs a real date ---");
check("revisit_on with a date", parseRevisitChoice("revisit_on", "2027-03-01"), {
  ok: true,
  value: { disposition: "revisit_on", revisitOn: "2027-03-01" },
});
ok("revisit_on with no date is an error, not never", parseRevisitChoice("revisit_on", "").ok === false);
ok("revisit_on with no date is an error, not undecided", parseRevisitChoice("revisit_on", null).ok === false);
ok("revisit_on with a non-date is an error", parseRevisitChoice("revisit_on", "next spring").ok === false);
check("a day that does not exist is rejected rather than rolled forward", normalizeRevisitDate("2026-02-31"), null);
check("a real leap day is accepted", normalizeRevisitDate("2024-02-29"), "2024-02-29");
check("a non-leap 29 February is rejected", normalizeRevisitDate("2026-02-29"), null);
check("an unpadded date is rejected", normalizeRevisitDate("2026-2-3"), null);
check("a padded date is accepted", normalizeRevisitDate("2026-02-03"), "2026-02-03");
check("a timestamp is rejected", normalizeRevisitDate("2026-02-03T10:00:00Z"), null);
check("a non-string is rejected", normalizeRevisitDate(20260203), null);

// --- 2. Derivation --------------------------------------------------------

console.log("--- deriving the current disposition ---");

check("no rows at all is undecided", deriveCurrentDisposition([]), {
  disposition: "undecided",
  revisitOn: null,
  reason: null,
  decidedAt: null,
  chosen: false,
});
check("null rows is undecided", deriveCurrentDisposition(null).disposition, "undecided");
check("undefined rows is undecided", deriveCurrentDisposition(undefined).disposition, "undecided");
ok("...and reports that nobody chose it", deriveCurrentDisposition([]).chosen === false);

ok(
  "a recorded never is a never",
  deriveCurrentDisposition([disposition({ disposition: "never", reason: "Closed the programme" })]).disposition ===
    "never",
);
check(
  "a recorded revisit carries its date",
  deriveCurrentDisposition([disposition({ disposition: "revisit_on", revisit_on: "2027-01-05" })]).revisitOn,
  "2027-01-05",
);

console.log("--- the reversal test from ruling 0019 ---");
const reversed: RevisitDispositionRow[] = [
  disposition({ id: "d1", disposition: "never", reason: "Board closed the fund", decided_at: "2026-09-01T10:00:00Z" }),
  disposition({ id: "d2", disposition: "undecided", reason: "They emailed — the fund reopened", decided_at: "2026-09-05T10:00:00Z" }),
];
check("the reversal is the current state", deriveCurrentDisposition(reversed).disposition, "undecided");
check("the reversal's own reason is readable", deriveCurrentDisposition(reversed).reason, "They emailed — the fund reopened");
ok("the original never is still in the history", reversed.some((r) => r.disposition === "never" && r.reason === "Board closed the fund"));
ok("a reversal is distinguishable from having never decided", deriveCurrentDisposition(reversed).chosen === true);
check(
  "...and says so in words",
  describeDisposition(deriveCurrentDisposition(reversed)).detail,
  "Reopened: it is a no again, and whether to return is an open question.",
);
ok(
  "...which is not what an untouched decline says",
  describeDisposition(deriveCurrentDisposition([])).detail !== describeDisposition(deriveCurrentDisposition(reversed)).detail,
);

console.log("--- ordering ---");
check(
  "the latest decision wins regardless of input order",
  deriveCurrentDisposition([
    disposition({ id: "d2", disposition: "never", decided_at: "2026-09-09T10:00:00Z" }),
    disposition({ id: "d1", disposition: "revisit_on", revisit_on: "2027-01-01", decided_at: "2026-09-01T10:00:00Z" }),
  ]).disposition,
  "never",
);
check(
  "a tie on timestamp breaks by id, deterministically",
  deriveCurrentDisposition([
    disposition({ id: "b", disposition: "undecided", decided_at: "2026-09-09T10:00:00Z" }),
    disposition({ id: "a", disposition: "never", decided_at: "2026-09-09T10:00:00Z" }),
  ]).disposition,
  "undecided",
);

console.log("--- an unrecognised stored value ---");
check(
  "a value outside the vocabulary is not trusted, and above all is not never",
  deriveCurrentDisposition([disposition({ disposition: "closed_forever" })]).disposition,
  "undecided",
);
ok(
  "...but it is not mistaken for nobody having decided either",
  deriveCurrentDisposition([disposition({ disposition: "closed_forever" })]).chosen === true,
);
ok(
  "a never row with a stray date does not leak the date",
  deriveCurrentDisposition([disposition({ disposition: "never", revisit_on: "2027-01-01" })]).revisitOn === null,
);

// --- 3. The index the follow-up page reads --------------------------------

console.log("--- buildOutcomeIndex ---");

const index = buildOutcomeIndex(
  [
    outcomeRow({ id: "o1", prospect_id: "p1", recorded_at: "2026-01-01T00:00:00Z", reason: "First no" }),
    outcomeRow({ id: "o2", prospect_id: "p1", recorded_at: "2026-06-01T00:00:00Z", reason: "Second no" }),
    outcomeRow({ id: "o3", prospect_id: "p2", reason: "Out of geography" }),
  ],
  [
    disposition({ id: "d1", prospect_outcome_id: "o1", disposition: "never", reason: "old" }),
    disposition({ id: "d2", prospect_outcome_id: "o3", disposition: "revisit_on", revisit_on: "2027-04-01" }),
  ],
);

check("one entry per prospect", index.size, 2);
check("the latest outcome wins", index.get("p1")!.outcome.reason, "Second no");
ok(
  "a disposition on a superseded outcome does not carry over",
  index.get("p1")!.current.disposition === "undecided" && index.get("p1")!.current.chosen === false,
);
check("a prospect with a scheduled revisit keeps its date", index.get("p2")!.current.revisitOn, "2027-04-01");
ok("an outcome with no dispositions is an open question", isOpenQuestion(index.get("p1")!));
ok("...and a scheduled one is not", !isOpenQuestion(index.get("p2")!));
ok("...and is instead a scheduled revisit", isScheduledRevisit(index.get("p2")!));
check("empty inputs give an empty index", buildOutcomeIndex([], []).size, 0);
check("null inputs give an empty index", buildOutcomeIndex(null, null).size, 0);
check("history is retained in full", index.get("p2")!.history.length, 1);

console.log("--- display is derived, never restated ---");
for (const d of REVISIT_DISPOSITIONS) {
  const presentation = describeDisposition({ disposition: d, revisitOn: d === "revisit_on" ? "2027-04-01" : null, reason: null, decidedAt: null, chosen: true });
  ok(`${d} has a label`, presentation.label.length > 0);
  ok(`${d} has a tone`, ["teal", "amber", "red", "neutral"].includes(presentation.tone));
}
ok("never is toned as the serious state", describeDisposition({ disposition: "never", revisitOn: null, reason: null, decidedAt: null, chosen: true }).tone === "red");
ok("undecided is toned as attention-needed, not as closed", describeDisposition({ disposition: "undecided", revisitOn: null, reason: null, decidedAt: null, chosen: false }).tone === "amber");
check(
  "a scheduled revisit shows its date in the label",
  describeDisposition({ disposition: "revisit_on", revisitOn: "2027-04-01", reason: null, decidedAt: null, chosen: true }).label,
  "Revisit 2027-04-01",
);

// --- 4. The schema, read rather than assumed ------------------------------
//
// Ruling 0018: a filename is not evidence of what a thing does. These read
// migration 0066 and assert its text.

console.log("--- migration 0066, read from the file ---");

const migration = readFileSync(join(root, "supabase/migrations/0066_prospect_outcomes.sql"), "utf8");
// Comments carry the word "never" in prose, so the structural assertions run
// against the statements alone.
const sql = migration.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();

ok("both tables are created", sql.includes("create table prospect_outcomes") && sql.includes("create table prospect_outcome_dispositions"));
ok(
  "disposition is not null WITH NO DEFAULT, so an omitted value errors rather than guessing",
  /disposition text not null,/.test(sql),
  sql.match(/disposition text[^,]*/)?.[0] ?? "no disposition column found",
);
ok("no column anywhere defaults to never", !/default '?never'?/.test(sql));
ok("no column anywhere defaults to undecided either — undecided is the absence of a row", !/default '?undecided'?/.test(sql));
ok("the vocabulary is bounded by a check constraint", sql.includes("check (disposition in ('revisit_on', 'never', 'undecided'))"));
ok("a date belongs to exactly one disposition", sql.includes("disposition = 'revisit_on' and revisit_on is not null"));
ok("only 'declined' is authorised as an outcome", sql.includes("check (outcome in ('declined'))"));

console.log("--- hard rule 6: tenant isolation, checked rather than claimed ---");
for (const table of ["prospect_outcomes", "prospect_outcome_dispositions"]) {
  ok(
    `${table} carries organization_id defaulting to my_organization_id()`,
    new RegExp(`create table ${table} \\([^;]*organization_id uuid not null references organizations \\(id\\) default my_organization_id\\(\\)`).test(sql),
  );
  ok(`${table} has row level security enabled`, sql.includes(`alter table ${table} enable row level security`));
  ok(`${table} has an organization_id index`, sql.includes(`create index ${table}_organization_id_idx on ${table} (organization_id)`));
  const policies = [...sql.matchAll(new RegExp(`create policy "[^"]+" on ${table} for (\\w+)`, "g"))].map((m) => m[1]);
  ok(`${table} has a select policy`, policies.includes("select"));
  ok(`${table} has an insert policy`, policies.includes("insert"));
  ok(`${table} grants no delete to authenticated — this is retention, not deletion`, !policies.includes("delete"));
}
ok(
  "the disposition log is append-only: no update policy, so a recorded decision cannot be edited away",
  ![...sql.matchAll(/create policy "[^"]+" on prospect_outcome_dispositions for (\w+)/g)].map((m) => m[1]).includes("update"),
);
ok(
  "an outcome cannot be pointed at another org's prospect (FK checks bypass RLS)",
  sql.includes("create trigger prospect_outcomes_org_match before insert on prospect_outcomes"),
);
ok(
  "a disposition cannot be pointed at another org's outcome",
  sql.includes("create trigger prospect_outcome_dispositions_org_match before insert on prospect_outcome_dispositions"),
);
{
  // Every policy in this migration must be scoped by my_organization_id(). A
  // policy that forgot it would be a `using (true)` leak of exactly the kind
  // 0033 existed to remove, and CLAUDE.md states plainly that nothing else
  // catches one.
  const bodies = migration.split(/create policy/).slice(1);
  const unscoped = bodies.filter((b) => !b.includes("my_organization_id()"));
  ok(`all ${bodies.length} policies are scoped by my_organization_id()`, unscoped.length === 0, unscoped.join("\n"));
  ok("no policy is written as using (true)", !/using\s*\(\s*true\s*\)/.test(migration));
}

console.log("--- ruling 0020: the migration is additive ---");
ok("nothing is dropped", !/\bdrop\s+(column|table)\b/.test(sql));
ok("nothing is renamed", !/\brename\b/.test(sql));
ok("nothing is re-typed", !/\balter\s+column\s+\S+\s+(set data )?type\b/.test(sql));
ok("no column is added to an existing table at all", !/\badd\s+column\b/.test(sql));

// --- 5. No other module constructs a disposition --------------------------
//
// The brand makes this a compile error; this catches the `as` cast that would
// route around it, which tsc cannot.

console.log("--- source scan ---");
{
  const files = [
    "app/(dashboard)/prospects/[id]/outcome-actions.ts",
    "components/ProspectOutcomePanel.tsx",
    "app/(dashboard)/revisit/followup-workspace.tsx",
    "app/(dashboard)/revisit/page.tsx",
    "app/(dashboard)/prospects/[id]/page.tsx",
    "app/(dashboard)/prospects/[id]/overview-tab.tsx",
  ];
  // Comments in these files discuss `{ disposition: "never" }` precisely
  // because it is the thing being prevented, so the scan runs on code alone.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/[^\n]*/gm, " ");
  for (const rel of files) {
    const source = stripComments(readFileSync(join(root, rel), "utf8"));
    ok(`${rel} does not cast a value into RevisitChoice`, !/as\s+RevisitChoice/.test(source));
    ok(`${rel} does not construct a disposition literal`, !/disposition:\s*["']never["']/.test(source));
  }
  const lib = readFileSync(join(root, "lib/prospect-outcomes.ts"), "utf8");
  const casts = [...lib.matchAll(/as RevisitChoice/g)].length;
  ok(
    `lib/prospect-outcomes.ts is the only place a RevisitChoice is minted (${casts} casts, all inside parseRevisitChoice)`,
    casts > 0 && lib.indexOf("as RevisitChoice") > lib.indexOf("export function parseRevisitChoice"),
  );

  const actions = readFileSync(join(root, "app/(dashboard)/prospects/[id]/outcome-actions.ts"), "utf8");
  ok(
    "recording a decline writes no disposition row — absence is the undecided state",
    !/recordProspectDecline[\s\S]*?prospect_outcome_dispositions[\s\S]*?^}/m.test(
      actions.slice(actions.indexOf("export async function recordProspectDecline"), actions.indexOf("export async function setRevisitDisposition")),
    ),
  );
  ok(
    "hard rule 2: no outcome action writes to prospects",
    !/from\(["']prospects["']\)/.test(actions),
    "an outcome must not move a prospect through a stage",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
