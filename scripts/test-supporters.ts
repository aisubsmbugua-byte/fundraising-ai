// STATE item 80, ruling 0034 -- the supporter model. This file asserts five
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
//   5. STATE item 81, ruling 0034 clause 4 -- CSV bulk import. parseCsv
//      (lib/candidates.ts, reused unmodified) feeding parseSupporterCsvRow
//      (lib/supporters.ts): a valid row imports; a row missing name is
//      skipped and counted as an error; a row with an invalid source_type or
//      an invalid pledged_frequency is skipped and counted as an error (the
//      documented choice, matched to importCandidatesCsv's own precedent for
//      an invalid channel -- the whole row is dropped, not imported with the
//      bad field left null); a row with an unparseable or negative
//      pledged_amount gets the same treatment; a row whose name or email
//      already appears earlier in the file or in the "already in the
//      database" list is skipped and counted as a duplicate, never folded
//      into the error count. importSupportersCsv itself
//      (app/(dashboard)/supporters/actions.ts) touches the database and is
//      not exercised here, matching this suite's existing posture toward
//      database-touching code (section 4 above does the same thing for
//      scripts/test-tenant-isolation.ts).
//
//   6. STATE item 82, ruling 0034 clauses 2 and 4 -- gift-history CSV bulk
//      import. parseGiftCsvRow (lib/supporters.ts): the HARD BOUNDARY that
//      this importer creates no supporters, ever -- a row matching zero
//      existing supporters is an error ("no match"), a row matching two or
//      more (an explicit same-name fixture, constructed deliberately, not
//      hypothesized) is an error ("ambiguous match"), never a guess; email
//      match is tried first and only falls back to name when email finds
//      nothing; an invalid amount (zero, negative, non-numeric, blank) is an
//      error ("invalid amount"); an invalid date is an error ("invalid
//      date"); every reason stays distinguishable in the counts, never
//      blended into one error bucket (ruling 0021, carried over from item
//      81's own test style immediately above). importSupporterGiftsCsv
//      itself (app/(dashboard)/supporters/actions.ts) touches the database
//      and is not exercised here, matching this suite's posture toward every
//      other database-touching action above.
//
// Usage: npx tsx scripts/test-supporters.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifySupporterTier,
  selectSupporterStewardshipQueue,
  daysSinceSupporterTouch,
  supporterTierThresholdDays,
  parseSupporterCsvRow,
  parseGiftCsvRow,
  SUPPORTER_TIER_LIGHT_THRESHOLD_DAYS,
  SUPPORTER_TIER_STANDARD_THRESHOLD_DAYS,
  SUPPORTER_TIER_PRIORITY_THRESHOLD_DAYS,
  SUPPORTER_TIER_STANDARD_MIN_MONTHLY_EQUIVALENT,
  SUPPORTER_TIER_PRIORITY_MIN_MONTHLY_EQUIVALENT,
  SUPPORTER_TIER_PRIORITY_ONE_TIME_PLEDGE_THRESHOLD,
  annualPledgeEquivalent,
  totalForecastAmount,
  type Supporter,
  type SupporterGift,
  type SupporterInteraction,
} from "../lib/supporters";
import { parseCsv } from "../lib/candidates";

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

// --- 1a-2. Forecast total (STATE item 85) --------------------------------

section("annualPledgeEquivalent / totalForecastAmount (Dashboard forecast, STATE item 85)");

check("monthly $100 annualizes to $1,200", annualPledgeEquivalent(100, "monthly"), 1200);
check("annual $1,200 stays $1,200 (already a yearly figure)", annualPledgeEquivalent(1200, "annual"), 1200);
check("one_time $500 stays $500 (a projection of this year's giving, not spread out)", annualPledgeEquivalent(500, "one_time"), 500);

check(
  "totalForecastAmount sums across mixed frequencies",
  totalForecastAmount([
    { pledged_amount: 100, pledged_frequency: "monthly" }, // -> 1200
    { pledged_amount: 500, pledged_frequency: "annual" }, // -> 500
    { pledged_amount: 250, pledged_frequency: "one_time" }, // -> 250
  ]),
  1950
);
check(
  "a supporter with no pledge captured contributes 0, never null-propagates the sum",
  totalForecastAmount([
    { pledged_amount: null, pledged_frequency: null },
    { pledged_amount: 100, pledged_frequency: "annual" },
  ]),
  100
);
check("totalForecastAmount of zero supporters is 0, not NaN or null", totalForecastAmount([]), 0);

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

// --- 5. CSV bulk import (STATE item 81, ruling 0034 clause 4) ------------

section("CSV import: parseCsv + parseSupporterCsvRow, offline, no database");

// A whole small CSV run through parseCsv (unmodified, the same function
// importCandidatesCsv uses) and then parseSupporterCsvRow row by row, same
// loop shape importSupportersCsv uses -- counts kept in three separate
// buckets throughout, never blended (ruling 0021's discipline).
const csvText = [
  "name,email,phone,source_type,source_detail,pledged_amount,pledged_frequency,notes",
  "Jane Doe,jane@example.com,555-1000,event,Fall Gala,25,monthly,Met at the gala",
  ",missing@example.com,,event,,,,", // missing name
  "Bad Source,bad@example.com,,carnival,,,,", // invalid source_type
  "Bad Frequency,freq@example.com,,website,,10,weekly,", // invalid pledged_frequency
  "Bad Amount,amt@example.com,,website,,not-a-number,monthly,", // unparseable pledged_amount
  "Negative Amount,neg@example.com,,website,,-5,monthly,", // negative pledged_amount
  "Jane Doe,someone-else@example.com,,website,,,,", // duplicate by name
  "Second Person,jane@example.com,,website,,,,", // duplicate by email
].join("\n");

const csvRows = parseCsv(csvText);
check("parseCsv reads 8 data rows from the 9-line file (1 header + 8 rows)", csvRows.length, 8);

function runImport(rows: Record<string, string>[]) {
  const known: { name: string; email: string | null }[] = [];
  let imported = 0;
  let errors = 0;
  let duplicates = 0;
  for (const row of rows) {
    const outcome = parseSupporterCsvRow(row, known);
    if (outcome.kind === "error") errors++;
    else if (outcome.kind === "duplicate") duplicates++;
    else {
      known.push({ name: outcome.supporter.name, email: outcome.supporter.email });
      imported++;
    }
  }
  return { imported, errors, duplicates, total: rows.length };
}

const result = runImport(csvRows);
// Denominators: 8 rows in, split imported(1) + errors(5) + duplicates(2) = 8.
check("counts: imported", result.imported, 1);
check("counts: errors", result.errors, 5);
check("counts: duplicates", result.duplicates, 2);
ok("counts cover every row with no overlap and no gap (imported + errors + duplicates = rows in)", result.imported + result.errors + result.duplicates === result.total, `${result.imported}+${result.errors}+${result.duplicates} != ${result.total}`);

// The one valid row actually imports, with every field carried through.
check("the valid row's outcome", parseSupporterCsvRow(csvRows[0], []), {
  kind: "insert",
  supporter: {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "555-1000",
    source_type: "event",
    source_detail: "Fall Gala",
    pledged_amount: 25,
    pledged_frequency: "monthly",
    notes: "Met at the gala",
  },
});

// A row missing name is skipped and counted as an error, not silently
// dropped (STATE item 81's acceptance criterion, in the exact words used).
check("row missing name: skipped as an error (not silently dropped)", parseSupporterCsvRow({ name: "", email: "x@example.com" }, []), { kind: "error" });
check("row with only whitespace for name: also an error", parseSupporterCsvRow({ name: "   " }, []), { kind: "error" });

// Invalid source_type or pledged_frequency: documented choice -- the WHOLE
// row is skipped and counted as an error, matched to importCandidatesCsv's
// own precedent for an invalid channel (discovery/actions.ts:135). It is
// NOT imported with the bad field left null.
check("invalid source_type: whole row skipped as an error, not imported with source_type nulled", parseSupporterCsvRow({ name: "Bad Source", source_type: "carnival" }, []), { kind: "error" });
check("invalid pledged_frequency: whole row skipped as an error, not imported with pledged_frequency nulled", parseSupporterCsvRow({ name: "Bad Freq", pledged_frequency: "weekly" }, []), { kind: "error" });
check("unparseable pledged_amount: whole row skipped as an error", parseSupporterCsvRow({ name: "Bad Amount", pledged_amount: "not-a-number" }, []), { kind: "error" });
check("negative pledged_amount: whole row skipped as an error", parseSupporterCsvRow({ name: "Negative", pledged_amount: "-5" }, []), { kind: "error" });

// A blank source_type defaults to "other" (matches createSupporter's own
// default) rather than erroring; a blank pledged_frequency is a legible "no
// pledge on file" null, not an error either -- only an INVALID non-blank
// value is an error.
check("blank source_type defaults to other, does not error", parseSupporterCsvRow({ name: "No Source" }, []).kind, "insert");
check("blank pledged_frequency is null, does not error", (parseSupporterCsvRow({ name: "No Pledge" }, []) as { kind: "insert"; supporter: { pledged_frequency: string | null } }).supporter.pledged_frequency, null);
check("blank pledged_amount is null, does not error", (parseSupporterCsvRow({ name: "No Amount" }, []) as { kind: "insert"; supporter: { pledged_amount: number | null } }).supporter.pledged_amount, null);

// Duplicate matching: exact name match (case/whitespace-insensitive), and
// exact email match when both rows have one -- deliberately NOT isSameOrg's
// substring-containment rule, which is calibrated for organization names and
// would misfire on person names (see lib/supporters.ts's comment on
// parseSupporterCsvRow for "Jon" / "Jonathan Smith").
check("duplicate by exact name match (case/whitespace-insensitive)", parseSupporterCsvRow({ name: "  JANE DOE  " }, [{ name: "Jane Doe", email: null }]), { kind: "duplicate" });
check("duplicate by exact email match, different name", parseSupporterCsvRow({ name: "Someone New", email: "JANE@EXAMPLE.COM" }, [{ name: "Jane Doe", email: "jane@example.com" }]), { kind: "duplicate" });
check("NOT a duplicate: a short name merely contained in a longer one (the isSameOrg behavior this deliberately avoids)", parseSupporterCsvRow({ name: "Jon" }, [{ name: "Jonathan Smith", email: null }])?.kind, "insert");
check("not a duplicate: different name, no email overlap", parseSupporterCsvRow({ name: "Totally Different" }, [{ name: "Jane Doe", email: "jane@example.com" }])?.kind, "insert");

// --- regression: STATE item 84 -----------------------------------------
// A real VWI import carried "Projected Annual Amount" (lowercased by
// parseCsv to "projected annual amount") instead of the canonical
// `pledged_amount` column, and the value was dollar-formatted ("$2,000").
// Both silently produced a null pledge on live data before this fix.
{
  const row = { name: "Enrique and Michelle Cuevas", "projected annual amount": " $2,000 ", email: "quiquecue@gmail.com" };
  const result = parseSupporterCsvRow(row, []);
  check("real-world header alias ('projected annual amount') is recognized", result.kind, "insert");
  if (result.kind === "insert") {
    check("currency formatting ($ and commas) is stripped before parsing", result.supporter.pledged_amount, 2000);
    check("the column name's own cadence (annual) is captured, not left null", result.supporter.pledged_frequency, "annual");
  }
}
check(
  "an explicit pledged_frequency column is never overridden by the alias's implied cadence",
  (parseSupporterCsvRow({ name: "X", "projected annual amount": "100", pledged_frequency: "monthly" }, []) as { kind: "insert"; supporter: { pledged_frequency: string | null } }).supporter.pledged_frequency,
  "monthly"
);
check(
  "an unrecognized header is ignored, not an error",
  parseSupporterCsvRow({ name: "X", "some other column": "whatever" }, [])?.kind,
  "insert"
);

// --- 6. Gift-history CSV import (STATE item 82, ruling 0034 clauses 2/4) -

section("gift-history CSV import: parseGiftCsvRow, offline, no database");

const janeSupporter = { id: "sup-jane", name: "Jane Doe", email: "jane@example.com" };
const johnSupporter = { id: "sup-john", name: "John Smith", email: "john@example.com" };
// Two DIFFERENT existing supporters who happen to share a name -- constructed
// explicitly, per the item's own instruction, to prove a shared-name row is
// reported ambiguous rather than guessed at either one.
const amySmithA = { id: "sup-amy-a", name: "Amy Smith", email: "amy.a@example.com" };
const amySmithB = { id: "sup-amy-b", name: "Amy Smith", email: "amy.b@example.com" };
const giftKnown = [janeSupporter, johnSupporter, amySmithA, amySmithB];

// A row matching exactly one supporter by email imports correctly.
check(
  "matches by exact case-insensitive email",
  parseGiftCsvRow({ supporter_email: "JANE@EXAMPLE.COM", amount: "50", gift_date: "2026-03-15", note: "Spring gift" }, giftKnown),
  { kind: "insert", supporterId: "sup-jane", amount: 50, giftDate: "2026-03-15", note: "Spring gift" },
);

// A row matching by name when email is absent.
check(
  "matches by exact case-insensitive name when no email is given",
  parseGiftCsvRow({ supporter_name: "john smith", amount: "100", gift_date: "2026-04-01" }, giftKnown),
  { kind: "insert", supporterId: "sup-john", amount: 100, giftDate: "2026-04-01", note: null },
);

// A row with an email that matches no one falls back to name.
check(
  "falls back to name when the given email matches no one",
  parseGiftCsvRow({ supporter_email: "nobody@example.com", supporter_name: "Jane Doe", amount: "10", gift_date: "2026-01-01" }, giftKnown),
  { kind: "insert", supporterId: "sup-jane", amount: 10, giftDate: "2026-01-01", note: null },
);

// A row matching TWO existing supporters sharing a name is "ambiguous", not
// a guess -- the explicit two-same-named-supporters fixture above.
check(
  "two existing supporters sharing a name: ambiguous match, never guessed",
  parseGiftCsvRow({ supporter_name: "Amy Smith", amount: "25", gift_date: "2026-02-01" }, giftKnown),
  { kind: "error", reason: "ambiguous match" },
);

// A row matching zero supporters (neither identifier resolves) is "no match".
check(
  "no identifier resolves to any existing supporter: no match",
  parseGiftCsvRow({ supporter_name: "Nobody Here", amount: "25", gift_date: "2026-02-01" }, giftKnown),
  { kind: "error", reason: "no match" },
);
check(
  "blank supporter_email and supporter_name: no match (not a crash)",
  parseGiftCsvRow({ amount: "25", gift_date: "2026-02-01" }, giftKnown),
  { kind: "error", reason: "no match" },
);

// Invalid amount: zero, negative, non-numeric, blank -- all "invalid amount".
check("zero amount: invalid amount", parseGiftCsvRow({ supporter_email: "jane@example.com", amount: "0", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });
check("negative amount: invalid amount", parseGiftCsvRow({ supporter_email: "jane@example.com", amount: "-5", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });
check("non-numeric amount: invalid amount", parseGiftCsvRow({ supporter_email: "jane@example.com", amount: "fifty", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });
check("blank amount: invalid amount", parseGiftCsvRow({ supporter_email: "jane@example.com", amount: "", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });

// Invalid date: unparseable, blank -- "invalid date". A matched supporter and
// a valid amount are not enough on their own to import the row.
check("unparseable gift_date: invalid date", parseGiftCsvRow({ supporter_email: "jane@example.com", amount: "25", gift_date: "not-a-date" }, giftKnown), { kind: "error", reason: "invalid date" });
check("blank gift_date: invalid date", parseGiftCsvRow({ supporter_email: "jane@example.com", amount: "25", gift_date: "" }, giftKnown), { kind: "error", reason: "invalid date" });

// A whole small CSV run through parseCsv + parseGiftCsvRow, counts kept in
// separate per-reason buckets throughout, never blended (ruling 0021).
const giftCsvText = [
  "supporter_email,supporter_name,amount,gift_date,note",
  "jane@example.com,,50,2026-03-15,Spring gift", // insert (email match)
  ",John Smith,100,2026-04-01,", // insert (name match)
  ",Amy Smith,25,2026-02-01,", // ambiguous (two Amy Smiths)
  ",Nobody Here,25,2026-02-01,", // no match
  "jane@example.com,,-5,2026-01-01,", // invalid amount
  "jane@example.com,,25,not-a-date,", // invalid date
].join("\n");

const giftCsvRows = parseCsv(giftCsvText);
check("parseCsv reads 6 data rows from the 7-line gift file", giftCsvRows.length, 6);

function runGiftImport(rows: Record<string, string>[], known: { id: string; name: string; email: string | null }[]) {
  let imported = 0;
  const errorsByReason: Record<string, number> = { "no match": 0, "ambiguous match": 0, "invalid amount": 0, "invalid date": 0 };
  for (const row of rows) {
    const outcome = parseGiftCsvRow(row, known);
    if (outcome.kind === "error") errorsByReason[outcome.reason]++;
    else imported++;
  }
  const errors = Object.values(errorsByReason).reduce((a, b) => a + b, 0);
  return { imported, errors, errorsByReason, total: rows.length };
}

// Before -> after: an empty-looking run (no known supporters) would reject
// every row as "no match"; the real run below, against the fixture roster,
// is what's asserted.
const emptyKnownResult = runGiftImport(giftCsvRows, []);
check("before: with NO known supporters, every row is a no-match error", emptyKnownResult, {
  imported: 0,
  errors: 6,
  errorsByReason: { "no match": 6, "ambiguous match": 0, "invalid amount": 0, "invalid date": 0 },
  total: 6,
});

const giftResult = runGiftImport(giftCsvRows, giftKnown);
check("after: counts: imported", giftResult.imported, 2);
check("after: counts: errors (total)", giftResult.errors, 4);
check("after: counts by reason, each distinguishable (never blended into one bucket)", giftResult.errorsByReason, {
  "no match": 1,
  "ambiguous match": 1,
  "invalid amount": 1,
  "invalid date": 1,
});
ok(
  "counts cover every row with no overlap and no gap (imported + errors = rows in)",
  giftResult.imported + giftResult.errors === giftResult.total,
  `${giftResult.imported}+${giftResult.errors} != ${giftResult.total}`,
);

// --- 7. STATE item 84: updateSupporter / deleteSupporter / bulkDeleteSupporters
//
// Offline, source-level assertions only -- these three touch the database
// (an update, a delete, a bulk delete), matching this suite's existing
// posture toward every other database-touching action (sections 4-6 above
// do the same thing rather than running against a live Supabase project).

section("STATE item 84: updateSupporter / deleteSupporter / bulkDeleteSupporters");

const actionsSrc = readFileSync(join(root, "app/(dashboard)/supporters/actions.ts"), "utf8");

// Signatures.
ok(
  "updateSupporter(id: string, formData: FormData) exists with the stated signature",
  /export async function updateSupporter\(id: string, formData: FormData\)/.test(actionsSrc),
);
ok(
  "deleteSupporter(id: string) exists with the stated signature",
  /export async function deleteSupporter\(id: string\)/.test(actionsSrc),
);
ok(
  "bulkDeleteSupporters(ids: string\\[\\]) exists with the stated signature",
  /export async function bulkDeleteSupporters\(ids: string\[\]\)/.test(actionsSrc),
);

// Isolates exactly one function's own body -- NOT sliced up to the next
// `export async function` text (that would also capture the NEXT function's
// leading comment block, which for this file's functions explicitly
// discusses supporter_gifts/supporter_interactions and would falsely trip
// the "never references" assertions below). Brace-counted from the first
// `{` after the signature to its matching `}` instead, so only real code
// between those braces is returned.
function bodyOf(name: string): string {
  const sigStart = actionsSrc.indexOf(`export async function ${name}`);
  if (sigStart < 0) return "";
  const braceStart = actionsSrc.indexOf("{", sigStart);
  if (braceStart < 0) return "";
  let depth = 0;
  for (let i = braceStart; i < actionsSrc.length; i++) {
    if (actionsSrc[i] === "{") depth++;
    else if (actionsSrc[i] === "}") {
      depth--;
      if (depth === 0) return actionsSrc.slice(sigStart, i + 1);
    }
  }
  return actionsSrc.slice(sigStart);
}

const updateBody = bodyOf("updateSupporter");
const deleteBody = bodyOf("deleteSupporter");
const bulkDeleteBody = bodyOf("bulkDeleteSupporters");

ok("updateSupporter is non-empty (found by the slicer)", updateBody.length > 0);
ok("deleteSupporter is non-empty (found by the slicer)", deleteBody.length > 0);
ok("bulkDeleteSupporters is non-empty (found by the slicer)", bulkDeleteBody.length > 0);

// Error-return convention (not throw), matching createSupporter/logSupporterGift:
// every failure path returns { error: ... }, and the function body contains
// no bare `throw` of its own (a throw from requireUser() inside the try is
// still caught and converted to a returned error, same as every other action
// in this file -- see the catch block in each).
for (const [name, body] of [
  ["updateSupporter", updateBody],
  ["deleteSupporter", deleteBody],
  ["bulkDeleteSupporters", bulkDeleteBody],
] as const) {
  ok(`${name} returns { error: ... } on failure, like createSupporter/logSupporterGift`, /return\s*\{\s*error:/.test(body));
  ok(`${name} returns { success: true`, /return\s*\{\s*success:\s*true/.test(body));
  ok(`${name} wraps its body in try/catch (no bare throw escapes to the caller)`, /try\s*\{/.test(body) && /catch\s*\(err\)/.test(body));
  ok(`${name} does not itself \`throw\` (every failure is a returned { error })`, !/\n\s*throw /.test(body));
}

// updateSupporter: same field set and same validation as createSupporter.
const createBody = bodyOf("createSupporter");
for (const field of ["name", "email", "phone", "source_type", "source_detail", "pledged_amount", "pledged_frequency", "notes"]) {
  ok(`updateSupporter touches the "${field}" field, same as createSupporter`, updateBody.includes(field) && createBody.includes(field));
}
ok(
  "updateSupporter validates source_type against SOURCE_TYPE_VALUES, same as createSupporter",
  /SOURCE_TYPE_VALUES\.includes\(sourceType\)/.test(updateBody),
);
ok(
  "updateSupporter validates pledged_frequency against PLEDGE_FREQUENCY_VALUES, same as createSupporter",
  /PLEDGE_FREQUENCY_VALUES\.includes\(pledgedFrequency\)/.test(updateBody),
);
ok("updateSupporter rejects a negative pledge, same as createSupporter", /pledgedAmount\s*<\s*0/.test(updateBody));
ok("updateSupporter writes via .update(...), not .insert(...)", /\.from\("supporters"\)\s*\n?\s*\.update\(/.test(updateBody) || /\.update\(\{/.test(updateBody));
ok("updateSupporter scopes its update with .eq(\"id\", id)", /\.eq\("id",\s*id\)/.test(updateBody));
ok("updateSupporter revalidates /supporters", /revalidatePath\("\/supporters"\)/.test(updateBody));

// deleteSupporter: a real delete, scoped by id.
ok("deleteSupporter calls .from(\"supporters\").delete()", /\.from\("supporters"\)[\s\S]*?\.delete\(\)/.test(deleteBody));
ok("deleteSupporter scopes its delete with .eq(\"id\", id)", /\.delete\(\)\s*\.eq\("id",\s*id\)/.test(deleteBody));
ok("deleteSupporter revalidates /supporters", /revalidatePath\("\/supporters"\)/.test(deleteBody));

// bulkDeleteSupporters: genuinely accepts multiple ids via ONE .in() delete,
// not a loop calling deleteSupporter (or a second .delete().eq()) once per
// id. Documented choice (see the function's own comment in actions.ts): a
// single `.in("id", ids)` statement is one round trip and one atomic
// operation, matching this file's own batch-insert precedent
// (importSupportersCsv's single `.insert(toInsert)` rather than one insert
// per row) -- not a deliberate exception, the same pattern applied to delete.
ok(
  "bulkDeleteSupporters deletes with ONE .in(\"id\", ids) call, not a per-id loop",
  /\.delete\(\)\s*\.in\("id",\s*ids\)/.test(bulkDeleteBody),
);
ok("bulkDeleteSupporters contains no loop over ids calling delete per-item", !/for\s*\([^)]*ids[^)]*\)/.test(bulkDeleteBody) && !/ids\.map/.test(bulkDeleteBody) && !/ids\.forEach/.test(bulkDeleteBody));
ok("bulkDeleteSupporters does not call deleteSupporter internally (it is its own single-statement delete)", !/deleteSupporter\(/.test(bulkDeleteBody));
ok("bulkDeleteSupporters revalidates /supporters", /revalidatePath\("\/supporters"\)/.test(bulkDeleteBody));

// Neither delete path touches supporter_gifts or supporter_interactions
// directly -- cascade is the database's job via the ON DELETE CASCADE
// foreign keys migration 0078 already put on both child tables (asserted
// independently in section 2 above, at "supporter_gifts.supporter_id
// cascades from supporters" / "supporter_interactions.supporter_id cascades
// from supporters").
ok("deleteSupporter never references supporter_gifts", !/supporter_gifts/.test(deleteBody));
ok("deleteSupporter never references supporter_interactions", !/supporter_interactions/.test(deleteBody));
ok("bulkDeleteSupporters never references supporter_gifts", !/supporter_gifts/.test(bulkDeleteBody));
ok("bulkDeleteSupporters never references supporter_interactions", !/supporter_interactions/.test(bulkDeleteBody));

// The cascade those two assertions rely on is independently verified here
// too (not merely assumed), against the migration text itself, so this
// section stands on its own even if section 2's assertions above ever moved.
const migrationSql = readFileSync(join(root, "supabase/migrations/0078_supporters.sql"), "utf8").toLowerCase();
ok(
  "verified: supporter_gifts.supporter_id has ON DELETE CASCADE back to supporters",
  /supporter_id uuid not null references supporters \(id\) on delete cascade/.test(
    migrationSql.slice(migrationSql.indexOf("create table supporter_gifts"), migrationSql.indexOf("create table supporter_interactions")),
  ),
);
ok(
  "verified: supporter_interactions.supporter_id has ON DELETE CASCADE back to supporters",
  /supporter_id uuid not null references supporters \(id\) on delete cascade/.test(
    migrationSql.slice(migrationSql.indexOf("create table supporter_interactions")),
  ),
);

// UI: an edit control and a delete control exist on the detail panel, and a
// row-selection checkbox plus a "Delete selected (N)" control exist on the
// list -- both with an expand-then-confirm step for the destructive actions,
// never an instant single-click delete.
const workspaceSrc = readFileSync(join(root, "app/(dashboard)/supporters/supporters-workspace.tsx"), "utf8");
ok("the detail panel composes updateSupporter (edit control)", /updateSupporter\(supporter\.id, formData\)/.test(workspaceSrc));
ok("the detail panel composes deleteSupporter (delete control)", /deleteSupporter\(supporter\.id\)/.test(workspaceSrc));
ok("the list composes bulkDeleteSupporters (bulk delete control)", /bulkDeleteSupporters\(ids\)/.test(workspaceSrc));
// Expand-then-confirm, the ProspectOutcomePanel retraction model: the
// FIRST click only opens a confirm step (setDeleteOpen(true) /
// setBulkDeleteOpen(true)); the actual delete call is gated behind that
// state, not reachable from the initial render's button.
ok(
  "single delete's visible button opens a confirm step first (setDeleteOpen(true)), it does not call deleteSupporter directly",
  /onClick=\{\(\) => setDeleteOpen\(true\)\}/.test(workspaceSrc),
);
ok(
  "deleteSupporter is only ever called from inside the confirm step's own handler, after deleteOpen is already true",
  (() => {
    const confirmStepStart = workspaceSrc.indexOf("onClick=\{\(\) => setDeleteOpen(true)\}");
    const deleteCallIndex = workspaceSrc.indexOf("deleteSupporter(supporter.id)");
    return confirmStepStart >= 0 && deleteCallIndex > confirmStepStart;
  })(),
);
ok(
  "bulk delete's visible button opens a confirm step first (setBulkDeleteOpen(true)), it does not call bulkDeleteSupporters directly",
  /onClick=\{\(\) => setBulkDeleteOpen\(true\)\}/.test(workspaceSrc),
);
ok(
  "bulkDeleteSupporters is only ever called from inside the confirm step's own handler, after bulkDeleteOpen is already true",
  (() => {
    const confirmStepStart = workspaceSrc.indexOf("onClick={() => setBulkDeleteOpen(true)}");
    const deleteCallIndex = workspaceSrc.indexOf("bulkDeleteSupporters(ids)");
    return confirmStepStart >= 0 && deleteCallIndex > confirmStepStart;
  })(),
);
ok("both confirm steps have a Cancel path back out (setDeleteOpen(false) / setBulkDeleteOpen(false))", /setDeleteOpen\(false\)/.test(workspaceSrc) && /setBulkDeleteOpen\(false\)/.test(workspaceSrc));
ok("the list renders a checkbox per row for bulk selection", /type="checkbox"/.test(workspaceSrc) && /checkedIds/.test(workspaceSrc));
ok("a 'Delete selected' control only renders once at least one row is checked", /checkedIds\.size > 0/.test(workspaceSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
