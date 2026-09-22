// The discovery cron pause gate (STATE.md item 64).
//
// Two things are tested, matching the two ways this gate could silently
// rot:
//
//   1. The truthiness parse (envFlagTruthy, lib/discovery-search.ts) --
//      unit-tested directly, since it is the thing the owner's hand-typed
//      Vercel env value passes through.
//
//   2. The gate's POSITION in the route source -- after the CRON_SECRET
//      auth check (the pause must not become an auth bypass: an
//      unauthenticated caller still gets 401 before the pause is ever
//      consulted) and before any other work (no admin client, no
//      database read, no channel search, and therefore no ai_runs birth
//      -- ruling 0026: a run that does not happen births nothing).
//      Source-position assertions, same technique as
//      scripts/test-ai-runs.ts uses for beginRun-precedes-model-call.
//
// Run: npx tsx scripts/test-cron-gate.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envFlagTruthy } from "../lib/discovery-search";

const root = join(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

// --- 1. The truthiness parse ----------------------------------------------

section("envFlagTruthy: unset and explicit-off values do not pause");

ok("undefined is not truthy (var never set)", envFlagTruthy(undefined) === false);
ok("null is not truthy", envFlagTruthy(null) === false);
ok('"" is not truthy (var set empty)', envFlagTruthy("") === false);
ok('"   " is not truthy (whitespace only)', envFlagTruthy("   ") === false);
ok('"0" is not truthy (explicit off)', envFlagTruthy("0") === false);
ok('"false" is not truthy (explicit off)', envFlagTruthy("false") === false);
ok('"FALSE" is not truthy (casing ignored)', envFlagTruthy("FALSE") === false);
ok('"False" is not truthy', envFlagTruthy("False") === false);
ok('" false " is not truthy (whitespace ignored)', envFlagTruthy(" false ") === false);
ok('" 0 " is not truthy', envFlagTruthy(" 0 ") === false);

section("envFlagTruthy: any other non-empty value pauses");

ok('"1" is truthy', envFlagTruthy("1") === true);
ok('"true" is truthy', envFlagTruthy("true") === true);
ok('"TRUE" is truthy', envFlagTruthy("TRUE") === true);
ok('"yes" is truthy (any non-empty value counts)', envFlagTruthy("yes") === true);
ok('"paused while testers are paused" is truthy (a note-to-self value still pauses)', envFlagTruthy("paused while testers are paused") === true);
ok('"00" is truthy (only the exact tokens "0"/"false" mean off)', envFlagTruthy("00") === true);
ok('" 1 " is truthy (whitespace ignored)', envFlagTruthy(" 1 ") === true);

// --- 2. The gate's position in the route ----------------------------------

section("route source: the gate sits after auth, before any work");

const routePath = "app/api/cron/discovery-auto-search/route.ts";
const src = readFileSync(join(root, routePath), "utf8");

// Anchor points. Each must exist exactly once for the position checks to
// mean anything, so existence and uniqueness are asserted first.
function only(label: string, needle: string): number {
  const first = src.indexOf(needle);
  const last = src.lastIndexOf(needle);
  ok(`${routePath} contains exactly one ${label}`, first >= 0 && first === last, `first at ${first}, last at ${last}`);
  return first;
}

const authAt = only("401 auth rejection", "status: 401");
const gateAt = only("pause gate", "envFlagTruthy(process.env.DISCOVERY_CRON_PAUSED)");
const skipBodyAt = only("skip body naming the pause", 'return Response.json({ skipped: "DISCOVERY_CRON_PAUSED" })');
const adminClientAt = only("admin client construction", "createAdminClient()");
const searchCallAt = only("channel search call", "await runAutoDiscoverySearchForChannel(");

ok("the CRON_SECRET check precedes the pause gate (pause is not an auth bypass)", authAt >= 0 && gateAt > authAt, `auth at ${authAt}, gate at ${gateAt}`);
ok("the pause gate precedes the admin client -- no database reachable while paused", gateAt >= 0 && adminClientAt > gateAt, `gate at ${gateAt}, createAdminClient() at ${adminClientAt}`);
ok(
  "the pause gate precedes the channel search call -- no model call, no beginRun, reachable while paused (ruling 0026)",
  gateAt >= 0 && searchCallAt > gateAt,
  `gate at ${gateAt}, search call at ${searchCallAt}`
);
ok("the route itself never calls beginRun (births belong to the operations it invokes)", !src.includes("beginRun"));
ok(
  "the skip response is the gate's own return (body immediately inside the gate block)",
  skipBodyAt > gateAt && skipBodyAt < adminClientAt,
  `gate at ${gateAt}, skip body at ${skipBodyAt}, createAdminClient() at ${adminClientAt}`
);
ok(
  "the skip return carries no explicit status -- Response.json defaults to 200, so Vercel cron does not retry",
  !src.slice(gateAt, skipBodyAt + 100).includes("status:")
);
{
  const logAt = src.indexOf('"DISCOVERY_CRON_PAUSED"', gateAt);
  ok(
    "a structured log line naming DISCOVERY_CRON_PAUSED sits between the gate and its return, so the skip is visible in Vercel logs",
    logAt > gateAt && logAt < skipBodyAt && src.slice(gateAt, skipBodyAt).includes("console.log"),
    `gate at ${gateAt}, log token at ${logAt}, skip body at ${skipBodyAt}`
  );
}

// The gate reads the env through the tested parse, not an ad-hoc check.
ok(
  "the route imports envFlagTruthy from lib/discovery-search -- the parse tested above is the parse in production",
  src.includes('import { envFlagTruthy } from "@/lib/discovery-search"')
);

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
