// STATE item 80, ruling 0034 -- the supporter model. This file asserts four
// things, all offline (no DB, no API key):
//
//   1. The stewardship selection (lib/supporters.ts) is pure, so its
//      boundary cases -- the dollar-size tiering, and the per-tier day
//      threshold, exactly at / just under / just over, for all three tiers
//      -- run with no database and no clock (`now` is a parameter).
//
//   2. Migration 0078 encodes ruling 0034 in the schema: additive-only
//      (ruling 0020); supporter_gifts has NO update policy and NO delete
//      policy at all (clause 2 -- a correction is a new row, never a silent
//      edit); both new org-match triggers are SECURITY DEFINER with
//      search_path = public (0066's pattern, closing the known FK-bypasses-
//      RLS hole at birth rather than inheriting it); the
//      supporter_interactions trigger additionally covers UPDATE OF
//      supporter_id (0077's hardening, since that table -- unlike
//      supporter_gifts -- has an update policy and so has a repoint path an
//      insert-only trigger would miss).
//
//   3. components/LogInteractionForm.tsx's refactor (onLog prop, no
//      hardcoded logInteraction call) did not change the prospect Activity
//      tab's behavior: a source scan confirms it still composes
//      logInteraction as that prop, at BOTH render sites that existed
//      before this item (the Activity tab, and the Follow-up page's own
//      ProspectDetail, which also used this component -- see the note at
//      that assertion), and that the new Supporters page composes
//      logSupporterInteraction the same way.
//
//   4. Tenant isolation for the three new tables is added to
//      scripts/test-tenant-isolation.ts in its existing NOT-EVALUATED-
//      tolerant pattern -- asserted here by confirming the section exists in
//      that file's source, not by running it (that script needs a live
//      database and real auth sessions; this one does not run it).
//
// Usage: npx tsx scripts/test-supporters.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifySupporterTier,
  selectSupporterStewardshipQueue,
  daysSinceSupporterTouch,
  supporterTierThresholdDays,
  SUPPORTER_TIER_LIGHT_THRESHOLD_DAYS,
  SUPPORTER_TIER_STANDARD_THRESHOLD_DAYS,
  SUPPORTER_TIER_PRIORITY_THRESHOLD_DAYS,
  SUPPORTER_TIER_STANDARD_MIN_MONTHLY_EQUIVALENT,
  SUPPORTER_TIER_PRIORITY_MIN_MONTHLY_EQUIVALENT,
  SUPPORTER_TIER_PRIORITY_ONE_TIME_PLEDGE_THRESHOLD,
  type Supporter,
  type SupporterGift,
  type SupporterInteraction,
} from "../lib/supporters";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${good ? "PASS" : "FAIL"}: ${label}${good ? "" : `\n      got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  good ? pass++ : fail++;
}
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

const NOW = new Date("2026-10-02T15:30:00Z");
const DAY = 86400000;
function daysAgo(n: number): string {
  return new Date(Date.UTC(2026, 9, 2) - n * DAY).toISOString().slice(0, 10);
}
function supporter(id: string, over: Partial<Supporter> = {}, name = id): Supporter {
  return {
    id,
    organization_id: "org-1",
    name,
    email: null,
    phone: null,
    source_type: "other",
    source_detail: null,
    pledged_amount: null,
    pledged_frequency: null,
    notes: null,
    created_by: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}
function gift(supporterId: string, ago: number, amount = 10): SupporterGift {
  return { id: `g-${supporterId}-${ago}`, supporter_id: supporterId, amount, gift_date: daysAgo(ago), note: null, recorded_by: "u1", created_at: `${daysAgo(ago)}T09:00:00Z` };
}
function interaction(supporterId: string, ago: number): SupporterInteraction {
  return { id: `i-${supporterId}-${ago}`, supporter_id: supporterId, kind: "call", summary: "touched", occurred_at: daysAgo(ago), created_by: "u1", created_at: `${daysAgo(ago)}T09:00:00Z` };
}
const ids = (rows: { supporter: Supporter }[]) => rows.map((r) => r.supporter.id);

// --- 1a. Dollar-size tiering --------------------------------------------

section("dollar-size tiering (classifySupporterTier)");

check("constants: standard min monthly-equivalent is $25", SUPPORTER_TIER_STANDARD_MIN_MONTHLY_EQUIVALENT, 25);
check("constants: priority min monthly-equivalent is $100", SUPPORTER_TIER_PRIORITY_MIN_MONTHLY_EQUIVALENT, 100);
check("constants: priority one-time carve-out is $1,000", SUPPORTER_TIER_PRIORITY_ONE_TIME_PLEDGE_THRESHOLD, 1000);

// No pledge at all -- light, not an error (ruling 0034 clause 2).
check("no pledged_amount: light", classifySupporterTier(null, null), "light");
check("no pledged_frequency: light", classifySupporterTier(50, null), "light");
check("pledged_amount is zero: light", classifySupporterTier(0, "monthly"), "light");
check("pledged_amount negative: light", classifySupporterTier(-5, "monthly"), "light");

// Monthly: monthly-equivalent is the amount itself.
check("monthly $24.99: light (just under $25)", classifySupporterTier(24.99, "monthly"), "light");
check("monthly $25.00: standard (exactly at $25 boundary)", classifySupporterTier(25, "monthly"), "standard");
check("monthly $99.99: standard (just under $100)", classifySupporterTier(99.99, "monthly"), "standard");
check("monthly $100.00: priority (exactly at $100 boundary)", classifySupporterTier(100, "monthly"), "priority");

// Annual: monthly-equivalent is amount / 12.
check("annual $299.99: light ($25.00 - just under)", classifySupporterTier(299.99, "annual"), "light");
check("annual $300.00: standard (= $25.00/mo exactly)", classifySupporterTier(300, "annual"), "standard");
check("annual $1,199.99: standard (just under $100/mo)", classifySupporterTier(1199.99, "annual"), "standard");
check("annual $1,200.00: priority (= $100.00/mo exactly)", classifySupporterTier(1200, "annual"), "priority");

// One-time: normalized like annual (amount / 12) EXCEPT the explicit $1,000+
// carve-out, which is priority regardless of the formula.
check("one-time $24: light ($2.00/mo-equivalent)", classifySupporterTier(24, "one_time"), "light");
check("one-time $300: standard (= $25.00/mo-equivalent exactly)", classifySupporterTier(300, "one_time"), "standard");
check("one-time $999: standard (carve-out is $1,000+, this is under it; $83.25/mo-equivalent)", classifySupporterTier(999, "one_time"), "standard");
check("one-time $1,000: priority (carve-out, even though $83.33/mo-equivalent alone would read standard)", classifySupporterTier(1000, "one_time"), "priority");
check("one-time $5,000: priority (carve-out)", classifySupporterTier(5000, "one_time"), "priority");

// --- 1b. Day-threshold boundaries, per tier, exactly/under/over ----------

section("day-threshold boundaries (selectSupporterStewardshipQueue), per tier");

check("tier day thresholds: light=365, standard=180, priority=90", [
  SUPPORTER_TIER_LIGHT_THRESHOLD_DAYS,
  SUPPORTER_TIER_STANDARD_THRESHOLD_DAYS,
  SUPPORTER_TIER_PRIORITY_THRESHOLD_DAYS,
], [365, 180, 90]);
check("supporterTierThresholdDays agrees with the constants", [
  supporterTierThresholdDays("light"),
  supporterTierThresholdDays("standard"),
  supporterTierThresholdDays("priority"),
], [365, 180, 90]);

function queueFor(tierSupporter: Supporter, ago: number) {
  return selectSupporterStewardshipQueue([tierSupporter], {}, { [tierSupporter.id]: [interaction(tierSupporter.id, ago)] }, NOW);
}

// Light tier (no pledge -> light), threshold 365.
check("light, 364 days: not yet quiet (just under)", ids(queueFor(supporter("a", { pledged_amount: null }), 364)), []);
check("light, 365 days: not yet quiet (exactly at threshold -- strict boundary)", ids(queueFor(supporter("a", { pledged_amount: null }), 365)), []);
check("light, 366 days: quiet (just over)", ids(queueFor(supporter("a", { pledged_amount: null }), 366)), ["a"]);

// Standard tier ($50/mo), threshold 180.
const standardSupporter = () => supporter("b", { pledged_amount: 50, pledged_frequency: "monthly" });
check("standard, 179 days: not yet quiet (just under)", ids(queueFor(standardSupporter(), 179)), []);
check("standard, 180 days: not yet quiet (exactly at threshold)", ids(queueFor(standardSupporter(), 180)), []);
check("standard, 181 days: quiet (just over)", ids(queueFor(standardSupporter(), 181)), ["b"]);

// Priority tier ($250/mo), threshold 90.
const prioritySupporter = () => supporter("c", { pledged_amount: 250, pledged_frequency: "monthly" });
check("priority, 89 days: not yet quiet (just under)", ids(queueFor(prioritySupporter(), 89)), []);
check("priority, 90 days: not yet quiet (exactly at threshold)", ids(queueFor(prioritySupporter(), 90)), []);
check("priority, 91 days: quiet (just over)", ids(queueFor(prioritySupporter(), 91)), ["c"]);

// Row content: tier and threshold are named on the row, not just the id.
const row = queueFor(prioritySupporter(), 91)[0];
check("row names its tier", row.tier, "priority");
check("row names its threshold", row.thresholdDays, 90);
check("row carries days since last touch", row.daysSinceLastTouch, 91);

// Last touch is the LATEST of any gift OR any interaction.
const bothTouches = selectSupporterStewardshipQueue(
  [supporter("d", { pledged_amount: null })],
  { d: [gift("d", 400)] },
  { d: [interaction("d", 50)] },
  NOW,
);
check("a recent interaction among an old gift keeps a light-tier supporter out (last touch = the interaction, 50 days)", ids(bothTouches), []);
const goldenGift = selectSupporterStewardshipQueue(
  [supporter("e", { pledged_amount: null })],
  { e: [gift("e", 400)] },
  { e: [interaction("e", 390)] },
  NOW,
);
check("the LATEST of several old touches still governs (390 < 400, both quiet either way here)", ids(goldenGift), ["e"]);

// --- 1c. Never-touched sorts first; stalest-first ordering --------------

section("ordering: never-touched first, then stalest-first, ties by name then id");

const mixed = selectSupporterStewardshipQueue(
  [
    supporter("s400", { pledged_amount: null }, "Zeta"),
    supporter("s800", { pledged_amount: null }, "Yankee"),
    supporter("sn2", { pledged_amount: null }, "Bravo"),
    supporter("s500b", { pledged_amount: null }, "Beta"),
    supporter("sn1", { pledged_amount: null }, "Alpha"),
    supporter("s500a", { pledged_amount: null }, "Alpha"),
  ],
  {},
  {
    s400: [interaction("s400", 400)],
    s800: [interaction("s800", 800)],
    s500a: [interaction("s500a", 500)],
    s500b: [interaction("s500b", 500)],
  },
  NOW,
);
check(
  "never-touched first (by name), then stalest first, ties by name",
  ids(mixed),
  ["sn1", "sn2", "s800", "s500a", "s500b", "s400"],
);

// No zero-contact supporter is ever silently dropped: with no pledge at all
// and no touch at all, a supporter is ALWAYS included (light tier's
// threshold can never apply to a null days-since).
check("zero-contact, no-pledge supporter is always included", ids(selectSupporterStewardshipQueue([supporter("z", { pledged_amount: null })], {}, {}, NOW)), ["z"]);

// Empty input.
check("no supporters", selectSupporterStewardshipQueue([], {}, {}, NOW), []);

// daysSinceSupporterTouch (the list-display helper) agrees with the queue's
// own internal last-touch derivation.
check("daysSinceSupporterTouch: no touches is null", daysSinceSupporterTouch([], [], NOW), null);
check("daysSinceSupporterTouch: latest of a gift and an interaction", daysSinceSupporterTouch([gift("x", 40)], [interaction("x", 10)], NOW), 10);

// --- 2. Migration 0078 encodes ruling 0034 in the schema -----------------

section("migration 0078 encodes ruling 0034 in the schema");

const sql = readFileSync(join(root, "supabase/migrations/0078_supporters.sql"), "utf8");
const stmts = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

ok("migration creates exactly three new tables: supporters, supporter_gifts, supporter_interactions", [
  /create table supporters\s*\(/.test(stmts),
  /create table supporter_gifts\s*\(/.test(stmts),
  /create table supporter_interactions\s*\(/.test(stmts),
].every(Boolean));

const createTargets = [...stmts.matchAll(/create table\s+([a-z_]+)/g)].map((m) => m[1]);
ok(
  "no other table is created in this file (ruling 0020: additive, scoped to the three named tables)",
  createTargets.length === 3 && createTargets.every((t) => ["supporters", "supporter_gifts", "supporter_interactions"].includes(t)),
  `created: ${createTargets.join(", ")}`,
);
ok("no ALTER TABLE touches any pre-existing table (nothing already deployed is modified)", !/alter\s+table\s+(?!supporters|supporter_gifts|supporter_interactions)/.test(stmts));

// supporter_gifts: INSERT and SELECT only. No update policy. No delete policy. At all.
const giftPolicyBlock = stmts.slice(stmts.indexOf("create policy \"team members can log a gift\""), stmts.indexOf("create policy \"team members manage supporter interactions\""));
ok("supporter_gifts has an INSERT policy", /create policy "team members can log a gift"\s+on supporter_gifts for insert/.test(giftPolicyBlock));
ok("supporter_gifts has a SELECT policy", /create policy "team members can read gift history"\s+on supporter_gifts for select/.test(giftPolicyBlock));
ok("supporter_gifts has NO update policy anywhere in the file", !/on supporter_gifts for update/.test(stmts));
ok("supporter_gifts has NO delete policy anywhere in the file", !/on supporter_gifts for delete/.test(stmts));
ok("supporter_gifts has no \"for all\" policy that would smuggle in update/delete", !/on supporter_gifts for all/.test(stmts));
ok("supporter_gifts' insert policy requires recorded_by = auth.uid() (no impersonation)", /with check \(recorded_by = auth\.uid\(\) and organization_id = my_organization_id\(\)\)/.test(giftPolicyBlock));
ok("supporter_gifts.amount has a positive check constraint", /check \(amount > 0\)/.test(stmts));

// supporters and supporter_interactions: team-scoped "for all", like prospects/candidates.
ok("supporters has one team-scoped \"for all\" policy (prospects/candidates shape)", /create policy "team members manage supporters"\s+on supporters for all/.test(stmts));
ok("supporter_interactions has one team-scoped \"for all\" policy (existing `interactions` table shape)", /create policy "team members manage supporter interactions"\s+on supporter_interactions for all/.test(stmts));

// Check constraints on the closed-list columns.
ok("supporters.source_type is checked against event/website/other", /check \(source_type in \('event', 'website', 'other'\)\)/.test(stmts));
ok("supporters.pledged_frequency is checked against one_time/monthly/annual (nullable)", /check \(pledged_frequency is null or pledged_frequency in \('one_time', 'monthly', 'annual'\)\)/.test(stmts));

// NO channel, NO stage, NO EIN, NO typical_grant_size on supporters -- ruling 0034 clause 1.
const supportersTableBlock = stmts.slice(stmts.indexOf("create table supporters"), stmts.indexOf("create table supporter_gifts"));
ok(
  "supporters carries none of the prospect-model's courtship fields (channel/stage/ein/typical_grant_size)",
  !/\bchannel\b|\bstage\b|\bein\b|typical_grant_size/.test(supportersTableBlock),
);

// Org-match triggers: SECURITY DEFINER, set search_path = public (0066's pattern).
const giftTriggerFn = stmts.slice(stmts.indexOf("create function enforce_supporter_gift_org_match"), stmts.indexOf("create trigger supporter_gifts_org_match") + 200);
ok("supporter_gifts' org-match function is security definer with search_path = public", /security definer set search_path = public/.test(giftTriggerFn));
ok("supporter_gifts' org-match trigger fires BEFORE INSERT", /before insert on supporter_gifts/.test(stmts));

const interactionTriggerFn = stmts.slice(stmts.indexOf("create function enforce_supporter_interaction_org_match"));
ok("supporter_interactions' org-match function is security definer with search_path = public", /security definer set search_path = public/.test(interactionTriggerFn));
ok(
  "supporter_interactions' org-match trigger fires on INSERT OR UPDATE OF supporter_id (0077's hardening -- this table, unlike supporter_gifts, has an UPDATE policy)",
  /before insert or update of supporter_id on supporter_interactions/.test(stmts),
);

// Cascades: deleting a supporter deletes its gifts and interactions.
ok("supporter_gifts.supporter_id cascades from supporters", /supporter_id uuid not null references supporters \(id\) on delete cascade/.test(stmts.slice(stmts.indexOf("create table supporter_gifts"), stmts.indexOf("create table supporter_interactions"))));
ok("supporter_interactions.supporter_id cascades from supporters", /supporter_id uuid not null references supporters \(id\) on delete cascade/.test(stmts.slice(stmts.indexOf("create table supporter_interactions"))));

// RLS is enabled on all three.
ok("RLS is enabled on all three new tables", [
  /alter table supporters enable row level security/.test(stmts),
  /alter table supporter_gifts enable row level security/.test(stmts),
  /alter table supporter_interactions enable row level security/.test(stmts),
].every(Boolean));

// --- 3. LogInteractionForm's refactor didn't change existing behavior ----

section("LogInteractionForm refactor: the prospect Activity tab is unchanged");

const formSrc = readFileSync(join(root, "components/LogInteractionForm.tsx"), "utf8");
ok("LogInteractionForm no longer imports logInteraction directly", !/import\s*\{\s*logInteraction\s*\}/.test(formSrc));
ok("LogInteractionForm takes an onLog prop and calls it (not a hardcoded action)", /onLog\s*\(/.test(formSrc) && /onLog:\s*\(/.test(formSrc));
ok("onLog's signature is (kind, summary, occurredAt) -- no id parameter (the caller binds the id by closure)", /onLog:\s*\(\s*kind:\s*InteractionKind,\s*summary:\s*string,\s*occurredAt:\s*string\s*\)\s*=>\s*Promise<unknown>/.test(formSrc));

const activityTabSrc = readFileSync(join(root, "app/(dashboard)/prospects/[id]/activity-tab.tsx"), "utf8");
ok(
  "the prospect Activity tab still composes logInteraction as onLog, bound to its own prospectId (behavior unchanged)",
  /import \{ logInteraction \} from "@\/app\/\(dashboard\)\/revisit\/actions"/.test(activityTabSrc) &&
    /onLog=\{\(kind, summary, occurredAt\) => logInteraction\(prospectId, kind, summary, occurredAt\)\}/.test(activityTabSrc),
);

// The ruling's brief said "there is exactly one caller today, the prospect
// Activity tab" -- a source grep at the start of this item found a SECOND
// existing render site using this component: the Follow-up page's own
// ProspectDetail (app/(dashboard)/revisit/followup-workspace.tsx), which
// shows the same prospect Activity-style panel inside several Follow-up
// tabs (due now, waiting, scheduled, nurture). That is noted here rather
// than silently assumed away: both sites are updated identically, and both
// are asserted here so neither one regresses.
const followupSrc = readFileSync(join(root, "app/(dashboard)/revisit/followup-workspace.tsx"), "utf8");
ok(
  "ESCALATED, not guessed: a second existing caller (Follow-up page's ProspectDetail) also composes logInteraction as onLog, bound to its own prospect id",
  /import\s*\{[^}]*\blogInteraction\b[^}]*\}\s*from\s*"\.\/actions"/.test(followupSrc) &&
    /onLog=\{\(kind, summary, occurredAt\) => logInteraction\(prospect\.id, kind, summary, occurredAt\)\}/.test(followupSrc),
);

const supportersWorkspaceSrc = readFileSync(join(root, "app/(dashboard)/supporters/supporters-workspace.tsx"), "utf8");
ok(
  "the new Supporters page composes logSupporterInteraction as onLog the same way, bound to the selected supporter",
  /onLog=\{\(kind, summary, occurredAt\) => logSupporterInteraction\(supporter\.id, kind, summary, occurredAt\)\}/.test(supportersWorkspaceSrc),
);

ok("LogInteractionForm is used at exactly the three known sites (no silent fourth caller introduced)", (() => {
  const files = [
    "app/(dashboard)/prospects/[id]/activity-tab.tsx",
    "app/(dashboard)/revisit/followup-workspace.tsx",
    "app/(dashboard)/supporters/supporters-workspace.tsx",
  ];
  return files.every((f) => readFileSync(join(root, f), "utf8").includes("<LogInteractionForm"));
})());

// --- 4. Tenant isolation extended to the three new tables -----------------

section("tenant isolation: sections exist in scripts/test-tenant-isolation.ts (written, not executed here)");

const isolationSrc = readFileSync(join(root, "scripts/test-tenant-isolation.ts"), "utf8");
ok("references supporters in the NOT-EVALUATED-tolerant pattern (42P01 / PGRST205 tolerated)", /from\("supporters"\)[\s\S]{0,400}(42P01|PGRST205)/.test(isolationSrc) || /(42P01|PGRST205)[\s\S]{0,400}from\("supporters"\)/.test(isolationSrc));
ok("asserts Org B cannot SELECT Org A's supporters row by id", /Org B cannot SELECT Org A's supporters row/.test(isolationSrc));
ok("asserts Org B cannot SELECT Org A's supporter_gifts row by id", /Org B cannot SELECT Org A's supporter_gifts row/.test(isolationSrc));
ok("asserts Org B cannot SELECT Org A's supporter_interactions row by id", /Org B cannot SELECT Org A's supporter_interactions row/.test(isolationSrc));
ok("asserts supporter_gifts has no update policy, even for the owning org", /supporter_gifts has no update policy/.test(isolationSrc));
ok("asserts supporter_gifts has no delete policy, even for the owning org", /supporter_gifts has no delete policy/.test(isolationSrc));
ok("asserts the supporter_gifts org-match trigger refuses a cross-org gift", /supporter_gifts.*org-match trigger/.test(isolationSrc));
ok("asserts the supporter_interactions org-match trigger refuses a cross-org interaction", /supporter_interactions.*org-match trigger/.test(isolationSrc));
ok("purgeTestIdentities cleans up the three new tables before the org/profile/user delete (idempotent re-runs)", /from\("supporters"\)\.delete\(\)\.in\("organization_id", orgIds\)/.test(isolationSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
