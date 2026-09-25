// STATE item 75 -- Nurture v1. The selection is pure, so the boundary cases run
// offline with no DB and no API key; the source scans pin that the page reuses
// the shared derivation, suggestNextStep and isClosedToWork rather than
// restating them.
//
// Usage: npx tsx scripts/test-nurture.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectNurtureQueue, NURTURE_QUIET_DAYS, NURTURE_STAGES } from "../lib/nurture";
import { buildOutcomeIndex } from "../lib/prospect-outcomes";
import type { Prospect } from "../lib/prospects";
import type { Interaction } from "../lib/interactions";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${good ? "PASS" : "FAIL"}: ${label}${good ? "" : `\n      got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  good ? pass++ : fail++;
}
function ok(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}`);
  condition ? pass++ : fail++;
}

const NOW = new Date("2026-09-24T15:30:00Z");
const DAY = 86400000;
function daysAgo(n: number): string {
  return new Date(Date.UTC(2026, 8, 24) - n * DAY).toISOString().slice(0, 10);
}
function prospect(id: string, stage: string, name = id): Prospect {
  return { id, name, stage } as unknown as Prospect;
}
function touch(prospectId: string, ago: number, over: Partial<Interaction> = {}): Interaction {
  return {
    id: `i-${prospectId}-${ago}`,
    prospect_id: prospectId,
    kind: "email",
    summary: `touch ${ago}d ago`,
    occurred_at: daysAgo(ago),
    created_by: "u1",
    created_at: `${daysAgo(ago)}T09:00:00Z`,
    ...over,
  };
}
function outcomes(prospectId: string, disposition: "never" | "revisit_on" | "undecided") {
  return buildOutcomeIndex(
    [{ id: "o1", prospect_id: prospectId, outcome: "declined", reason: "r", occurred_on: "2026-08-01", recorded_by: "u", recorded_at: "2026-08-01T00:00:00Z" }],
    disposition === "undecided"
      ? []
      : [{ id: "d1", prospect_outcome_id: "o1", disposition, revisit_on: disposition === "revisit_on" ? "2027-01-01" : null, reason: null, decided_by: "u", decided_at: "2026-08-02T00:00:00Z" }],
    [],
  );
}
const none = new Map();
const ids = (rows: { prospect: Prospect }[]) => rows.map((r) => r.prospect.id);

// Constants
check("NURTURE_QUIET_DAYS is 30", NURTURE_QUIET_DAYS, 30);
check("stages are awarding and stewardship", [...NURTURE_STAGES], ["awarding", "stewardship"]);

// Boundary: strictly older than 30 days is quiet
check("29 days: not quiet", ids(selectNurtureQueue([prospect("a", "awarding")], { a: [touch("a", 29)] }, none, NOW)), []);
check("exactly 30 days: not yet quiet (strict boundary)", ids(selectNurtureQueue([prospect("a", "awarding")], { a: [touch("a", 30)] }, none, NOW)), []);
check("31 days: quiet", ids(selectNurtureQueue([prospect("a", "awarding")], { a: [touch("a", 31)] }, none, NOW)), ["a"]);
check("0 days (today): not quiet", ids(selectNurtureQueue([prospect("a", "stewardship")], { a: [touch("a", 0)] }, none, NOW)), []);
check("time of day does not move the boundary", ids(selectNurtureQueue([prospect("a", "awarding")], { a: [touch("a", 30)] }, none, new Date("2026-09-24T23:59:59Z"))), []);

// Row content
const r31 = selectNurtureQueue([prospect("a", "awarding")], { a: [touch("a", 31, { kind: "call", summary: "Thanked them" })] }, none, NOW)[0];
check("row carries days since last touch", r31.daysSinceLastTouch, 31);
check("row carries last kind", r31.lastInteractionKind, "call");
check("row carries last summary", r31.lastInteractionSummary, "Thanked them");
check("row carries the prospect", r31.prospect.id, "a");

// Most recent interaction decides, regardless of input order
check("a recent touch among old ones keeps it out", ids(selectNurtureQueue([prospect("a", "awarding")], { a: [touch("a", 90), touch("a", 5), touch("a", 60)] }, none, NOW)), []);
check("latest is chosen from unsorted input", selectNurtureQueue([prospect("a", "awarding")], { a: [touch("a", 40), touch("a", 90), touch("a", 60)] }, none, NOW)[0].daysSinceLastTouch, 40);

// No interactions
const never = selectNurtureQueue([prospect("a", "stewardship")], {}, none, NOW);
check("no interactions: included", ids(never), ["a"]);
check("no interactions: days is null, not 0", never[0].daysSinceLastTouch, null);
check("no interactions: kind and summary null", [never[0].lastInteractionKind, never[0].lastInteractionSummary], [null, null]);
check("empty interaction list behaves like none", ids(selectNurtureQueue([prospect("a", "awarding")], { a: [] }, none, NOW)), ["a"]);

// Stage
for (const stage of ["discovery", "outreach", "proposal", "decision"]) {
  check(`stage ${stage} excluded`, ids(selectNurtureQueue([prospect("a", stage)], {}, none, NOW)), []);
}
check("stage awarding included", ids(selectNurtureQueue([prospect("a", "awarding")], {}, none, NOW)), ["a"]);
check("stage stewardship included", ids(selectNurtureQueue([prospect("a", "stewardship")], {}, none, NOW)), ["a"]);

// Outcomes
check("effective never: excluded", ids(selectNurtureQueue([prospect("a", "awarding")], {}, outcomes("a", "never"), NOW)), []);
check("revisit_on (not closed): included", ids(selectNurtureQueue([prospect("a", "awarding")], {}, outcomes("a", "revisit_on"), NOW)), ["a"]);
check("undecided (not closed): included", ids(selectNurtureQueue([prospect("a", "awarding")], {}, outcomes("a", "undecided"), NOW)), ["a"]);
check(
  "retracted never no longer closes",
  ids(
    selectNurtureQueue(
      [prospect("a", "awarding")],
      {},
      buildOutcomeIndex(
        [{ id: "o1", prospect_id: "a", outcome: "declined", reason: "r", occurred_on: "2026-08-01", recorded_by: "u", recorded_at: "2026-08-01T00:00:00Z" }],
        [{ id: "d1", prospect_outcome_id: "o1", disposition: "never", revisit_on: null, reason: null, decided_by: "u", decided_at: "2026-08-02T00:00:00Z" }],
        [{ id: "r1", prospect_outcome_id: "o1", note: null, retracted_by: "u", retracted_at: "2026-08-03T00:00:00Z" }],
      ),
      NOW,
    ),
  ),
  ["a"],
);

// Ordering: never-touched first, then stalest first, ties by name then id
const mixed = selectNurtureQueue(
  [
    prospect("p40", "awarding", "Zeta"),
    prospect("p90", "awarding", "Yankee"),
    prospect("pn2", "stewardship", "Bravo"),
    prospect("p60b", "awarding", "Beta"),
    prospect("pn1", "awarding", "Alpha"),
    prospect("p60a", "awarding", "Alpha"),
  ],
  { p40: [touch("p40", 40)], p90: [touch("p90", 90)], p60a: [touch("p60a", 60)], p60b: [touch("p60b", 60)] },
  none,
  NOW,
);
check("never-touched first (by name), then stalest first, ties by name", ids(mixed), ["pn1", "pn2", "p90", "p60a", "p60b", "p40"]);

// Empty input
check("no prospects", selectNurtureQueue([], {}, none, NOW), []);

// Source scans
const page = readFileSync(join(root, "app/(dashboard)/revisit/page.tsx"), "utf8");
const workspace = readFileSync(join(root, "app/(dashboard)/revisit/followup-workspace.tsx"), "utf8");
const nurtureLib = readFileSync(join(root, "lib/nurture.ts"), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/[^\n]*/gm, " ");

ok("the page calls the shared selectNurtureQueue", /selectNurtureQueue\(/.test(page) && page.includes('from "@/lib/nurture"'));
ok("the page does not restate the quiet window", !/\b30\b/.test(strip(page)) && !strip(page).includes("NURTURE_QUIET_DAYS"));
ok("the page still consults isClosedToWork", page.includes("isClosedToWork"));
ok("the derivation reuses isClosedToWork", strip(nurtureLib).includes("isClosedToWork(") && !/disposition\s*[=!]==?\s*["']never["']/.test(strip(nurtureLib)));
ok("the derivation reads no database or clock", !/supabase|Date\.now\(|new Date\(\)/.test(strip(nurtureLib)));
ok("the workspace reuses suggestNextStep from ./actions", /suggestNextStep[\s\S]*from "\.\/actions"/.test(workspace) && !/name:\s*["']submit_next_step/.test(workspace));
ok("nurture rows share the one ProspectDetail (one suggest control)", (workspace.match(/suggestNextStep\(/g) ?? []).length === 1);
ok("Compose email links into the prospect's Strategy tab", workspace.includes("?tab=strategy") && workspace.includes("Compose email"));
ok(
  "the honest v1 line is on the page",
  workspace.includes(
    "Nurture v1: this queue shows who has gone quiet. AI-drafted nurture notes are a later version — for now, use Suggest next step for ideas and Compose to write the note yourself; every email still needs your approval before it can be sent.",
  ),
);
ok("nothing here adds an ai_runs operation or draft kind", !/beginRun|draft_kind|operation:\s*["']nurture|from\("drafts"\)/.test(strip(nurtureLib + workspace)));
ok("zero-row empty state exists", workspace.includes("Nobody has gone quiet"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
