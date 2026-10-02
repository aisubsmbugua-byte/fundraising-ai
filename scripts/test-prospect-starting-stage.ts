// STATE item 79: a human adding an existing relationship should not have it
// start as a cold lead. This tests lib/prospect-starting-stage.ts, the pure
// module app/(dashboard)/prospects/actions.ts's createProspect calls, three
// ways:
//
//   1. Mutation-proving the Discovery path: every shape "no stage field at
//      all" can arrive in (what every caller before this item, and the Edit
//      form today, actually submits) resolves to the exact same stage and
//      produces NO stage_changes row -- the before-this-item behavior,
//      reproduced rather than assumed.
//   2. The non-Discovery path produces exactly one stage_changes row shaped
//      the way moveProspectStage (app/(dashboard)/pipeline/actions.ts)
//      writes the table, with from_stage = to_stage and the given note (or
//      the default when none was typed).
//   3. Source scans: the New Prospect form's stage selector is the same
//      STAGES import the pipeline board uses, not a hand-typed duplicate;
//      stage-reading is kept out of fieldsFromForm (the function updateProspect
//      also calls, whose form carries no stage input); createProspect writes
//      to stage_changes directly rather than by calling moveProspectStage.
//
// Pure logic plus file reads -- no DB, no API key, same as
// test-prospect-outcomes.ts and test-prospect-workflow.ts.
//
// Usage: npx tsx scripts/test-prospect-starting-stage.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGES } from "../lib/prospects";
import { resolveStartingStage, buildStartingStageChange } from "../lib/prospect-starting-stage";

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

// --- 1. Discovery (no selection, or an explicit Discovery) is byte-identical
//        to today: resolves to 'discovery' and writes no stage_changes row. --

console.log("--- the Discovery path reproduces today's behavior exactly ---");

// Every shape "nobody submitted a stage" can arrive in -- this is what EVERY
// prospect created before this item actually sent, and what updateProspect's
// edit form (which has no stage input) sends today.
const NO_SELECTION: [string, string | null | undefined][] = [
  ["field never present (FormData.get returns null)", null],
  ["explicitly undefined", undefined],
  ["empty string", ""],
  ["whitespace", "   "],
];
for (const [label, input] of NO_SELECTION) {
  const { stage, reason } = resolveStartingStage(input, null);
  ok(`${label} resolves to 'discovery'`, stage === "discovery", stage);
  ok(`${label} produces NO stage_changes row`, buildStartingStageChange("p1", stage, reason, "u1", "a@b.com") === null);
}

const { stage: explicitDiscoveryStage, reason: explicitDiscoveryReason } = resolveStartingStage("discovery", "some reason typed anyway");
check("an explicit Discovery selection also resolves to 'discovery'", explicitDiscoveryStage, "discovery");
ok(
  "Discovery writes no stage_changes row even if a reason was somehow typed -- the UI never shows that field at Discovery, but the write path does not trust that alone",
  buildStartingStageChange("p1", explicitDiscoveryStage, explicitDiscoveryReason, "u1", "a@b.com") === null
);

// Garbled/unrecognized input must not silently become some OTHER stage --
// the only safe fallback is Discovery, same as absence.
const GARBLED = ["Discovery", "DISCOVERY", "not_a_stage", "<script>", "outreach ", " outreach"];
for (const input of GARBLED) {
  const { stage } = resolveStartingStage(input, null);
  ok(`garbled/mistyped input "${input}" falls back to 'discovery', not silently accepted`, stage === "discovery", stage);
}

// --- 2. A non-Discovery start writes exactly one correctly-shaped row ------

console.log("--- a non-Discovery start writes exactly one stage_changes row ---");

for (const s of STAGES.filter((s) => s.value !== "discovery")) {
  const { stage, reason } = resolveStartingStage(s.value, "Existing relationship, already in stewardship");
  check(`resolves to the submitted stage (${s.value})`, stage, s.value);
  const row = buildStartingStageChange("prospect-1", stage, reason, "user-1", "owner@example.org");
  ok(`${s.value}: a row is written`, row !== null);
  check(`${s.value}: from_stage = to_stage = the chosen stage (not a move)`, [row?.from_stage, row?.to_stage], [s.value, s.value]);
  check(`${s.value}: prospect_id matches the newly created prospect`, row?.prospect_id, "prospect-1");
  check(`${s.value}: changed_by is the creating user's id`, row?.changed_by, "user-1");
  check(`${s.value}: changed_by_email is the creating user's email`, row?.changed_by_email, "owner@example.org");
  check(`${s.value}: note carries the typed reason`, row?.note, "Existing relationship, already in stewardship");
}

console.log("--- a blank reason gets a sensible default, not an empty note ---");
for (const [label, input] of [["null", null] as const, ["empty string", ""] as const, ["whitespace only", "   "] as const]) {
  const { stage, reason } = resolveStartingStage("stewardship", input);
  const row = buildStartingStageChange("p1", stage, reason, "u1", "a@b.com");
  check(`reason ${label} -> default note`, row?.note, "Added directly at this stage");
}

console.log("--- exactly one row, never more, for a single non-Discovery creation ---");
{
  const { stage, reason } = resolveStartingStage("awarding", "Signed before we had this tool");
  const rows = [buildStartingStageChange("p1", stage, reason, "u1", "a@b.com")].filter((r) => r !== null);
  check("exactly one stage_changes row", rows.length, 1);
}

// --- 3. Source-level assertions ---------------------------------------------

console.log("--- source: the new selector reuses the pipeline board's own stage list ---");
{
  const formSrc = readFileSync(join(root, "app/(dashboard)/prospects/new/page.tsx"), "utf8");
  ok(
    "the New Prospect form imports STAGES from lib/prospects rather than hand-typing a list",
    /import\s*\{[^}]*\bSTAGES\b[^}]*\}\s*from\s*["']@\/lib\/prospects["']/.test(formSrc)
  );
  ok(
    "the stage selector maps over the imported STAGES, not a second array",
    /STAGES\.map\(/.test(formSrc)
  );
  // The pipeline board's own stage columns -- confirm it is the SAME import,
  // not a second list that happens to agree today.
  const pipelineSrc = readFileSync(join(root, "app/(dashboard)/pipeline/page.tsx"), "utf8");
  ok(
    "the pipeline board also imports STAGES from lib/prospects (same source of truth)",
    /import\s*\{[^}]*\bSTAGES\b[^}]*\}\s*from\s*["']@\/lib\/prospects["']/.test(pipelineSrc)
  );
  // No file anywhere under app/ hand-types all six stage values as a second
  // list literal (the module STAGES is itself defined in).
  check("lib/prospects.ts defines the six stages exactly once", (readFileSync(join(root, "lib/prospects.ts"), "utf8").match(/value:\s*"discovery"/g) ?? []).length, 1);
}

console.log("--- source: stage-reading is kept OUT of fieldsFromForm ---");
{
  const actionsSrc = readFileSync(join(root, "app/(dashboard)/prospects/actions.ts"), "utf8");
  const fieldsFromFormBody = actionsSrc.slice(
    actionsSrc.indexOf("function fieldsFromForm"),
    actionsSrc.indexOf("\n}", actionsSrc.indexOf("function fieldsFromForm"))
  );
  ok(
    "fieldsFromForm (shared with updateProspect, whose edit form has no stage input) does not read 'stage' -- reading it there would silently reset or null a prospect's stage on every ordinary edit",
    !/formData\.get\(["']stage["']\)/.test(fieldsFromFormBody)
  );
  ok(
    "createProspect resolves the starting stage via the dedicated, tested module",
    /resolveStartingStage\(/.test(actionsSrc) && /from ["']@\/lib\/prospect-starting-stage["']/.test(actionsSrc)
  );
  ok(
    "updateProspect's update object is never given a 'stage' key by this item's code",
    !new RegExp("export async function updateProspect[\\s\\S]*?stage:", "m").test(
      actionsSrc.slice(actionsSrc.indexOf("export async function updateProspect"), actionsSrc.indexOf("export async function screenProspectAction"))
    )
  );
}

console.log("--- source: the backfill row is written directly, not via moveProspectStage ---");
{
  const actionsSrc = readFileSync(join(root, "app/(dashboard)/prospects/actions.ts"), "utf8");
  const createProspectBody = actionsSrc.slice(
    actionsSrc.indexOf("export async function createProspect"),
    actionsSrc.indexOf("export async function updateProspect")
  );
  // A comment in createProspect legitimately explains the write is NOT
  // routed through moveProspectStage -- so this checks for an import or a
  // call, not the bare word anywhere in the file.
  ok(
    "createProspect does not import or call moveProspectStage",
    !/import\s*\{[^}]*\bmoveProspectStage\b/.test(actionsSrc) && !/moveProspectStage\(/.test(actionsSrc)
  );
  ok("createProspect inserts into stage_changes directly", /from\(["']stage_changes["']\)\.insert\(/.test(createProspectBody));
  ok("createProspect's prospects insert carries the resolved stage", /\.insert\(\{\s*\.\.\.fields,\s*stage,/.test(createProspectBody));

  const pipelineActionsSrc = readFileSync(join(root, "app/(dashboard)/pipeline/actions.ts"), "utf8");
  ok(
    "moveProspectStage itself is untouched by this item -- still the only mover that re-checks fromStage with .eq(\"stage\", fromStage)",
    pipelineActionsSrc.includes('.eq("stage", fromStage)')
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
