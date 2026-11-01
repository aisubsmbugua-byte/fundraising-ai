// STATE item 104, ruling 0041: the "due soon" label counts calendar dates, not
// elapsed hours.
//
// The defect this guards: computeHealthStatus once subtracted a local-midnight
// timestamp for today from one for the due date and divided by 86,400,000. Across
// a clock change a calendar day lasts 23 or 25 hours, so a prospect due in
// exactly three days measured three days and one hour and read "On track" instead
// of "Due soon". It surfaced only on the first date it mattered (2026-10-31, the
// day before the US clocks went back), in two views that run in the owner's
// browser, and by failing assertions in two unrelated suites.
//
// What this tests, offline, with no database and no real clock:
//   1. A SWEEP: for every day of 2026, at three times of day, in five
//      timezones -- Pacific and London (clocks change forward and back in
//      different weeks), Sydney and Auckland (the opposite hemisphere, changing
//      at opposite times of year), and UTC (never changes) -- a due date k days
//      away, for k from -3 to +7, classifies exactly as the ruling says:
//      overdue below zero, due soon from zero through the three-day window, on
//      track beyond it. Thousands of cases, one pass/fail per timezone, with the
//      first mismatch printed.
//   2. THE SWEEP CATCHES THE BUG: the previous algorithm, reproduced inline
//      unchanged, FAILS the same sweep in Pacific time. A test that cannot fail
//      proves nothing.
//   3. The exact case that broke: 2026-10-31 to 2026-11-03 in Pacific time.
//   4. Behaviour kept: no date -> null, a malformed date -> "on_track" (as
//      before), the window boundary itself.
//
// Usage: npx tsx scripts/test-health-status.ts

import { computeHealthStatus, type HealthStatus } from "../lib/prospects";

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

const WINDOW_DAYS = 3; // DUE_SOON_WINDOW_DAYS in lib/prospects.ts (not exported; the sweep states it).

function expected(k: number): HealthStatus {
  if (k < 0) return "stalled";
  if (k <= WINDOW_DAYS) return "due_soon";
  return "on_track";
}

// The previous algorithm, reproduced UNCHANGED from before this item, taking the
// same `now` so it can be run through the same sweep.
function previousComputeHealthStatus(nextActionDue: string | null, now: Date): HealthStatus | null {
  if (!nextActionDue) return null;
  const due = new Date(nextActionDue + "T00:00:00");
  const today = new Date(now.getTime());
  today.setHours(0, 0, 0, 0);
  const daysUntilDue = (due.getTime() - today.getTime()) / 86400000;
  if (daysUntilDue < 0) return "stalled";
  if (daysUntilDue <= WINDOW_DAYS) return "due_soon";
  return "on_track";
}

// A calendar date k days from the given Y-M-D, by pure calendar arithmetic
// (UTC components), so building the expectation involves no timezone at all.
function datePlus(y: number, m: number, d: number, k: number): string {
  return new Date(Date.UTC(y, m, d + k)).toISOString().slice(0, 10);
}

const ZONES = ["UTC", "America/Los_Angeles", "Europe/London", "Australia/Sydney", "Pacific/Auckland"];
const HOURS = [0, 12, 23]; // local midnight hour, noon, and the last hour of the day
const K_RANGE = Array.from({ length: 11 }, (_, i) => i - 3); // -3 .. +7

type Sweep = { cases: number; mismatches: number; first: string | null };

function sweep(zone: string, fn: (due: string, now: Date) => HealthStatus | null): Sweep {
  process.env.TZ = zone;
  let cases = 0;
  let mismatches = 0;
  let first: string | null = null;
  for (let dayOfYear = 0; dayOfYear < 365; dayOfYear++) {
    // Local calendar date of the 'today' under test, built by calendar arithmetic.
    const base = new Date(Date.UTC(2026, 0, 1 + dayOfYear));
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth();
    const d = base.getUTCDate();
    for (const hour of HOURS) {
      const now = new Date(y, m, d, hour, 30, 0); // local wall-clock, in `zone`
      for (const k of K_RANGE) {
        const due = datePlus(y, m, d, k);
        const got = fn(due, now);
        cases++;
        if (got !== expected(k)) {
          mismatches++;
          if (first === null) first = `${zone}: today ${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")} ${hour}:30, due ${due} (k=${k}) -> ${got}, expected ${expected(k)}`;
        }
      }
    }
  }
  return { cases, mismatches, first };
}

// --- 1. The sweep, every timezone ------------------------------------------------

for (const zone of ZONES) {
  const r = sweep(zone, (due, now) => computeHealthStatus(due, now));
  ok(`${zone}: all ${r.cases} cases (every day of 2026 x 3 times of day x k from -3 to +7) classify as the ruling says`, r.mismatches === 0, `${r.mismatches} mismatch(es); first: ${r.first}`);
}

// --- 2. The sweep catches the previous algorithm ------------------------------------

{
  const r = sweep("America/Los_Angeles", (due, now) => previousComputeHealthStatus(due, now));
  ok(
    `the PREVIOUS algorithm FAILS this sweep in Pacific time (${r.mismatches} of ${r.cases} cases) -- the sweep can detect the bug`,
    r.mismatches > 0,
    "the previous algorithm passed the sweep, so the sweep proves nothing"
  );
  const u = sweep("UTC", (due, now) => previousComputeHealthStatus(due, now));
  ok("(and the previous algorithm was always right in UTC, which is why the server pages never showed it)", u.mismatches === 0, `${u.mismatches} mismatches in UTC`);
}

// --- 3. The exact case that broke ------------------------------------------------------

{
  process.env.TZ = "America/Los_Angeles";
  const now = new Date(2026, 9, 31, 10, 0, 0); // Sat 31 Oct 2026, 10:00 Pacific -- the day before the clocks go back
  check("2026-10-31 -> 2026-11-03 in Pacific time is due_soon (three calendar days, across the clock change)", computeHealthStatus("2026-11-03", now), "due_soon");
  check("(the previous algorithm called it on_track)", previousComputeHealthStatus("2026-11-03", now), "on_track");
  check("2026-11-04 is on_track (four calendar days)", computeHealthStatus("2026-11-04", now), "on_track");
  check("2026-10-30 is stalled (yesterday)", computeHealthStatus("2026-10-30", now), "stalled");
  check("2026-10-31 is due_soon (today)", computeHealthStatus("2026-10-31", now), "due_soon");
}

// --- 4. Behaviour kept -------------------------------------------------------------------

{
  process.env.TZ = "UTC";
  const now = new Date(2026, 5, 15, 9, 0, 0);
  check("no next action -> null (no false 'on track')", computeHealthStatus(null, now), null);
  check("empty string -> null", computeHealthStatus("", now), null);
  check("a malformed date falls through to on_track, as before", computeHealthStatus("not a date", now), "on_track");
  check("a date with a time part is not a calendar date; falls through to on_track, as before", computeHealthStatus("2026-06-16T00:00:00", now), "on_track");
  check("the window boundary: exactly 3 days is due_soon", computeHealthStatus("2026-06-18", now), "due_soon");
  check("the window boundary: 4 days is on_track", computeHealthStatus("2026-06-19", now), "on_track");
  // With no `now` argument it still works (reads the real clock): a date far in the past is stalled.
  check("default now: a long-past date is stalled", computeHealthStatus("2000-01-01"), "stalled");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
