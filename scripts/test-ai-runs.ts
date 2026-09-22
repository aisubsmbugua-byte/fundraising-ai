// Ruling 0026: a run is recorded before it runs, and how it ended is a
// second fact. This file asserts the ledger's guarantees three ways:
//
//   1. Statically, by reading migration 0067 and asserting the schema
//      encodes the ruling: additive-only, org-scoped with RLS, no delete
//      policy, an outcome vocabulary with NO 'killed' value (a killed run
//      is a born row whose outcome stays null -- absence is the encoding,
//      and a column that could fake it must not exist), and updates only
//      from unfinalized to terminal.
//
//   2. By contract, running beginRun/finalizeRun against a stubbed client:
//      beginRun refuses to hand back an id it did not persist (clause 1 --
//      an operation that cannot first write its record does not run), and
//      finalizeRun never throws (a finalization error must not mask the
//      operation's own result -- the row correctly stays born-unfinalized).
//
//   3. By source scan, encoding ruling 0026's own test of compliance: every
//      file under app/ or lib/ that calls the model either IS one of the
//      shared lib/ai helpers (whose callers are instrumented at the
//      operation level) or contains a beginRun BEFORE its first model call.
//      A new model-calling file that skips the ledger fails this test.
//
// Parts 1-3 are pure logic plus file reads -- no DB, no API key.
//
// A fourth, DB-dependent section exercises the real table (birth row shape,
// terminal written once, the trigger, the check constraints) and needs env:
//
//   npx tsx --env-file=.env.local scripts/test-ai-runs.ts
//
// Without env it skips cleanly and says so. With env but WITHOUT migration
// 0067 applied, it reports NOT EVALUATED rather than pretending to pass --
// "not evaluated" and "evaluated and clean" are different facts.
//
// Usage (offline): npx tsx scripts/test-ai-runs.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beginRun, finalizeRun, newUsage, addUsage, addResponseUsage, AI_RUN_OPERATIONS } from "../lib/ai-runs";

const root = join(__dirname, "..");

let pass = 0;
let fail = 0;
const notEvaluated: string[] = [];
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

// --- 1. The migration encodes the ruling ----------------------------------

section("migration 0067 is additive and encodes the ruling");

const sql = readFileSync(join(root, "supabase/migrations/0067_ai_run_ledger.sql"), "utf8");
// Statements only -- the header comments legitimately discuss what the
// schema must NOT contain, so checks run against comment-stripped SQL.
const stmts = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

const alterTargets = [...stmts.matchAll(/alter\s+table\s+([a-z_]+)/g)].map((m) => m[1]);
ok(
  "every ALTER TABLE targets ai_runs and nothing else (ruling 0020: additive)",
  alterTargets.length > 0 && alterTargets.every((t) => t === "ai_runs"),
  `alter targets: ${alterTargets.join(", ")}`
);
ok("no DROP of any kind", !/\bdrop\b/.test(stmts));
ok("no ADD COLUMN on any existing table", !/add\s+column/.test(stmts));
ok("creates exactly one table, ai_runs", (stmts.match(/create\s+table/g) ?? []).length === 1 && /create\s+table\s+ai_runs/.test(stmts));

ok(
  "organization_id is not null, references organizations, defaults to my_organization_id() (hard rule 6)",
  /organization_id\s+uuid\s+not\s+null\s+references\s+organizations\s*\(id\)\s+default\s+my_organization_id\(\)/.test(stmts)
);
ok("started_at is not null with default now() -- birth carries its own time", /started_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/.test(stmts));
ok("row level security is enabled", /alter\s+table\s+ai_runs\s+enable\s+row\s+level\s+security/.test(stmts));

// The outcome vocabulary, read from the constraint itself rather than
// trusted from this test's own expectations.
const outcomeCheck = stmts.match(/ai_runs_outcome_check\s+check\s*\(outcome\s+in\s*\(([^)]*)\)\)/);
const allowedOutcomes = (outcomeCheck?.[1] ?? "")
  .split(",")
  .map((s) => s.trim().replace(/'/g, ""))
  .filter(Boolean)
  .sort();
ok(
  "outcome check allows exactly completed | empty | failed",
  JSON.stringify(allowedOutcomes) === JSON.stringify(["completed", "empty", "failed"]),
  `allowed: ${allowedOutcomes.join(", ")}`
);
// `comment on` statements legitimately EXPLAIN why 'killed' does not exist,
// so they are excluded; every remaining statement is one that could shape
// what the table stores.
const storableStmts = stmts.replace(/comment\s+on[\s\S]*?;/g, "");
ok("there is NO 'killed' value anywhere a statement could store one", !/'killed'/.test(storableStmts));
ok(
  "ended_at cannot exist without an outcome (nothing can fake a third, undefined state)",
  /outcome\s+is\s+null\s+and\s+ended_at\s+is\s+null/.test(stmts) && /outcome\s+is\s+not\s+null\s+and\s+ended_at\s+is\s+not\s+null/.test(stmts)
);

const policyKinds = [...stmts.matchAll(/for\s+(insert|select|update|delete)/g)].map((m) => m[1]).sort();
ok(
  "policies are insert + select + update, and there is NO delete policy",
  JSON.stringify(policyKinds) === JSON.stringify(["insert", "select", "update"]),
  `policies: ${policyKinds.join(", ")}`
);
const updatePolicy = stmts.match(/for\s+update[\s\S]*?with\s+check\s*\([^)]*\)/);
ok(
  "the update policy's USING gates on outcome is null -- session clients can only move unfinalized rows",
  !!updatePolicy && /using\s*\(organization_id\s*=\s*my_organization_id\(\)\s+and\s+outcome\s+is\s+null\)/.test(updatePolicy[0])
);
ok(
  "a BEFORE UPDATE trigger enforces terminal-written-once for every role, service role included",
  /create\s+trigger\s+ai_runs_terminal_once\s+before\s+update\s+on\s+ai_runs/.test(stmts) &&
    /old\.outcome\s+is\s+not\s+null/.test(stmts) &&
    /new\.outcome\s+is\s+null/.test(stmts)
);
ok("the trigger also pins the birth facts (operation, organization, started_at, source)", /new\.operation\s+is\s+distinct\s+from\s+old\.operation/.test(stmts) && /new\.started_at\s+is\s+distinct\s+from\s+old\.started_at/.test(stmts));
ok("insert and select policies are org-scoped via my_organization_id()", /for\s+insert[\s\S]*?with\s+check\s*\(organization_id\s*=\s*my_organization_id\(\)\)/.test(stmts) && /for\s+select[\s\S]*?using\s*\(organization_id\s*=\s*my_organization_id\(\)\)/.test(stmts));

// --- 2. The helper's contract, against a stubbed client --------------------
// (Inside a function because tsx compiles scripts as CJS, where top-level
// await is unavailable; main() runs this before the DB section.)

async function helperAndScanSections() {
  section("beginRun and finalizeRun honor the contract");

type Call = { table: string; op: string; payload?: Record<string, unknown>; filters?: [string, string, unknown][] };
function stubClient(behavior: { insertError?: string; updateError?: string; updateThrows?: boolean }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          calls.push({ table, op: "insert", payload });
          return {
            select: () => ({
              single: async () =>
                behavior.insertError ? { data: null, error: { message: behavior.insertError } } : { data: { id: "run-00000000" }, error: null },
            }),
          };
        },
        update(payload: Record<string, unknown>) {
          const call: Call = { table, op: "update", payload, filters: [] };
          calls.push(call);
          const builder = {
            eq(col: string, val: unknown) {
              call.filters!.push(["eq", col, val]);
              return builder;
            },
            is(col: string, val: unknown) {
              call.filters!.push(["is", col, val]);
              return builder;
            },
            then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
              if (behavior.updateThrows) return Promise.reject(new Error("update transport failed")).then(resolve, reject);
              return Promise.resolve({ error: behavior.updateError ? { message: behavior.updateError } : null }).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

await (async () => {
  const { client, calls } = stubClient({});
  const id = await beginRun(client, { operation: "research", sourceTable: "research_runs", sourceId: "r1" });
  ok("beginRun inserts the birth row and returns its id", id === "run-00000000" && calls[0].op === "insert" && calls[0].table === "ai_runs");
  ok(
    "the birth row carries operation and source, and no terminal fact",
    calls[0].payload!.operation === "research" &&
      calls[0].payload!.source_table === "research_runs" &&
      !("outcome" in calls[0].payload!) &&
      !("ended_at" in calls[0].payload!)
  );
  ok(
    "beginRun does not send organization_id when none is passed -- the column default (my_organization_id) owns it on the session path",
    !("organization_id" in calls[0].payload!)
  );
})();

await (async () => {
  const { client, calls } = stubClient({});
  await beginRun(client, { operation: "discovery_search", organizationId: "org-1" });
  ok("beginRun sends the explicit organization_id on the admin-client path", calls[0].payload!.organization_id === "org-1");
})();

await (async () => {
  const { client } = stubClient({ insertError: "permission denied" });
  let threw = false;
  try {
    await beginRun(client, { operation: "draft" });
  } catch {
    threw = true;
  }
  ok("beginRun THROWS when the birth insert fails -- an operation that cannot first write its record does not run (clause 1)", threw);
})();

await (async () => {
  const { client, calls } = stubClient({});
  await finalizeRun(client, "run-1", { outcome: "completed", model: "m", inputTokens: 10, outputTokens: 2 });
  const update = calls.find((c) => c.op === "update")!;
  ok(
    "finalizeRun writes outcome, ended_at and the captured consumption in one terminal write",
    update.payload!.outcome === "completed" && typeof update.payload!.ended_at === "string" && update.payload!.input_tokens === 10
  );
  ok(
    "finalizeRun only reaches an unfinalized row (guarded by id AND outcome is null)",
    JSON.stringify(update.filters!.map(([f, c]) => [f, c])) === JSON.stringify([["eq", "id"], ["is", "outcome"]]) &&
      update.filters![1][2] === null
  );
})();

await (async () => {
  const { client, calls } = stubClient({});
  await finalizeRun(client, "run-2", { outcome: "failed", errorNote: "search timed out" });
  const update = calls.find((c) => c.op === "update")!;
  ok(
    "a run whose response never arrived finalizes with NULL consumption -- no figures is a fact, not a zero (clause 3)",
    update.payload!.input_tokens === null && update.payload!.output_tokens === null && update.payload!.model === null
  );
})();

await (async () => {
  const { client } = stubClient({ updateError: "row is immutable" });
  let threw = false;
  try {
    await finalizeRun(client, "run-3", { outcome: "completed" });
  } catch {
    threw = true;
  }
  ok("finalizeRun never throws on a returned error -- a finalization failure must not mask the operation's result", !threw);
})();

await (async () => {
  const { client } = stubClient({ updateThrows: true });
  let threw = false;
  try {
    await finalizeRun(client, "run-4", { outcome: "failed" });
  } catch {
    threw = true;
  }
  ok("finalizeRun never throws even when the transport itself throws -- the row correctly stays born-unfinalized", !threw);
})();

section("consumption is captured, never estimated");

{
  const acc = newUsage();
  ok("before any response arrives, every figure is null -- not zero", acc.model === null && acc.inputTokens === null && acc.outputTokens === null);
  addUsage(acc, { model: "model-a", inputTokens: 100, outputTokens: 10 });
  addUsage(acc, { model: "model-b", inputTokens: 50, outputTokens: 5 });
  ok("tokens aggregate across an operation's calls", acc.inputTokens === 150 && acc.outputTokens === 15);
  ok("model records the FIRST call's model; the per-call split lives in the operation's own table", acc.model === "model-a");
}
{
  const acc = newUsage();
  addResponseUsage(acc, { model: "model-c", usage: { input_tokens: 7, output_tokens: 3 } });
  ok("addResponseUsage reads figures off the SDK response shape", acc.model === "model-c" && acc.inputTokens === 7 && acc.outputTokens === 3);
}

// --- 3. Every live model call sits behind a birth row ----------------------

section("source scan: no model call without a ledger write before it (ruling 0026's test of compliance)");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const sourceFiles = [...walk(join(root, "app")), ...walk(join(root, "lib"))];
// The call can be line-wrapped (`client.messages\n  .stream(`) and comes in
// two SDK spellings (create and stream), so this is a pattern, not a
// substring.
const MESSAGES_CREATE = /\.messages\s*\.\s*(create|stream)\s*\(/;
const modelCallers = sourceFiles
  .filter((f) => !relative(root, f).startsWith(join("lib", "tier2")))
  .filter((f) => MESSAGES_CREATE.test(readFileSync(f, "utf8")))
  .map((f) => relative(root, f))
  .sort();

// The shared helpers: their model calls are metered by the OPERATION that
// invokes them (research, research_verify, strategy), which is where one
// user-perceived run lives. Everything else calling the model must carry
// its own beginRun.
const HELPER_FILES = ["lib/ai/funder-search.ts", "lib/ai/research-extract.ts", "lib/ai/research-verify.ts"].sort();
const INSTRUMENTED_FILES = [
  "app/(dashboard)/discovery/search/actions.ts",
  "app/(dashboard)/organization/channel-fit/actions.ts",
  "app/(dashboard)/prospects/[id]/draft-actions.ts",
  "app/(dashboard)/prospects/[id]/strategy-actions.ts",
  "app/(dashboard)/revisit/actions.ts",
].sort();

ok(
  "the set of model-calling files is exactly the instrumented actions plus the shared helpers -- a new model-calling file must join the ledger or fail here",
  JSON.stringify(modelCallers) === JSON.stringify([...HELPER_FILES, ...INSTRUMENTED_FILES].sort()),
  `found: ${modelCallers.join(", ")}`
);

// The helper-calling operations too: research-actions.ts holds runResearch
// and verifyRunClaims, which reach the model through the helpers.
const OPERATION_FILES = [...INSTRUMENTED_FILES, "app/(dashboard)/prospects/[id]/research-actions.ts"];
const MODEL_CALL_TOKENS = ["await anthropic.messages.create", "await searchFunderWeb(", "await extractResearchClaims(", "await verifyResearchClaims("];

for (const file of OPERATION_FILES) {
  const text = readFileSync(join(root, file), "utf8");
  const birthAt = text.indexOf("await beginRun(");
  const firstCallAt = Math.min(...MODEL_CALL_TOKENS.map((t) => text.indexOf(t)).filter((i) => i >= 0));
  ok(`${file}: a beginRun exists and precedes the first model call`, birthAt >= 0 && Number.isFinite(firstCallAt) && birthAt < firstCallAt, `beginRun at ${birthAt}, first model call at ${firstCallAt}`);
  ok(`${file}: finalizeRun is present to write the terminal fact`, text.includes("finalizeRun("));
}

// STATE item 63: proposal drafting is its own metered operation, born
// before its own model call -- not a second write under "draft".
ok(
  "proposal drafting is a DISTINCT operation from draft in AI_RUN_OPERATIONS (decision 0006 prices per operation)",
  AI_RUN_OPERATIONS.includes("draft") && AI_RUN_OPERATIONS.includes("proposal_draft")
);
{
  const text = readFileSync(join(root, "app/(dashboard)/prospects/[id]/draft-actions.ts"), "utf8");
  const start = text.indexOf("export async function generateProposalDraft");
  const end = text.indexOf("export async function", start + 1);
  const slice = start >= 0 ? text.slice(start, end < 0 ? undefined : end) : "";
  const birthAt = slice.indexOf('operation: "proposal_draft"');
  const callAt = slice.indexOf("await anthropic.messages.create");
  ok(
    "generateProposalDraft: its OWN birth row (operation proposal_draft) precedes its own model call",
    start >= 0 && birthAt >= 0 && callAt > birthAt,
    `slice start ${start}, birth at ${birthAt}, call at ${callAt}`
  );
  ok(
    "generateProposalDraft finalizes its run on every path (completed and empty in the try, failed in the catch)",
    (slice.match(/finalizeRun\(/g) ?? []).length >= 3,
    `finalizeRun occurrences: ${(slice.match(/finalizeRun\(/g) ?? []).length}`
  );
}

// STATE item 66: the deck outline is likewise its own metered operation,
// born before its own model call -- not a second write under "draft" or
// "proposal_draft".
ok(
  "deck drafting is a DISTINCT operation in AI_RUN_OPERATIONS (decision 0006 prices per operation; a deck is neither an email nor a proposal)",
  AI_RUN_OPERATIONS.includes("deck_draft") && AI_RUN_OPERATIONS.includes("proposal_draft") && AI_RUN_OPERATIONS.includes("draft")
);
{
  const text = readFileSync(join(root, "app/(dashboard)/prospects/[id]/draft-actions.ts"), "utf8");
  const start = text.indexOf("export async function generateDeckOutline");
  const end = text.indexOf("export async function", start + 1);
  const slice = start >= 0 ? text.slice(start, end < 0 ? undefined : end) : "";
  const birthAt = slice.indexOf('operation: "deck_draft"');
  const callAt = slice.indexOf("await anthropic.messages.create");
  ok(
    "generateDeckOutline: its OWN birth row (operation deck_draft) precedes its own model call",
    start >= 0 && birthAt >= 0 && callAt > birthAt,
    `slice start ${start}, birth at ${birthAt}, call at ${callAt}`
  );
  ok(
    "generateDeckOutline finalizes its run on every path (completed and empty in the try, failed in the catch)",
    (slice.match(/finalizeRun\(/g) ?? []).length >= 3,
    `finalizeRun occurrences: ${(slice.match(/finalizeRun\(/g) ?? []).length}`
  );
  // The item-63 probe pattern: pre-migration, the action refuses BEFORE
  // beginRun and before any model call -- fails closed without spending
  // tokens and without recording a run that never could have stored.
  const probeAt = slice.indexOf('.eq("kind", "deck")');
  const beginAt = slice.indexOf("await beginRun(");
  ok(
    "generateDeckOutline fails closed pre-migration: the 'deck' enum probe precedes beginRun (and therefore the model call), naming migration 0072",
    probeAt >= 0 && beginAt > probeAt && /0072/.test(slice),
    `probe at ${probeAt}, beginRun at ${beginAt}`
  );
}

// Every operation name in the union is actually written by some call site,
// and no call site writes a name outside the union (the union is the only
// vocabulary, so a mismatch either way is a metering hole).
const writtenOperations = new Set<string>();
for (const file of OPERATION_FILES) {
  const text = readFileSync(join(root, file), "utf8");
  for (const m of text.matchAll(/operation:\s*"([a-z_]+)"/g)) writtenOperations.add(m[1]);
}
  ok(
    "the operations written at call sites are exactly AI_RUN_OPERATIONS",
    JSON.stringify([...writtenOperations].sort()) === JSON.stringify([...AI_RUN_OPERATIONS].sort()),
    `written: ${[...writtenOperations].sort().join(", ")} / declared: ${[...AI_RUN_OPERATIONS].sort().join(", ")}`
  );
}

// --- 4. DB-dependent: the live schema's own behavior -----------------------

async function dbSection() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.log(
      "\nSKIPPED: DB assertions (no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment)." +
        "\n         Run with --env-file=.env.local once migration 0067 is applied."
    );
    notEvaluated.push("DB assertions -- no env supplied");
    return;
  }

  section("DB: birth, terminal-once, and the killed-run encoding");
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { error: probeError } = await admin.from("ai_runs").select("id").limit(1);
  if (probeError && probeError.code === "42P01") {
    console.log("NOT EVALUATED: ai_runs does not exist in this database -- migration 0067 is not applied. This is not a pass.");
    notEvaluated.push("DB assertions -- migration 0067 not applied");
    return;
  }
  if (probeError) throw new Error(`Could not probe ai_runs: ${probeError.message}`);

  // Equality-matched throwaway org, purged before and after -- same
  // discipline as test-tenant-isolation.ts: no like/ilike, refuse to touch
  // an org that holds any profile, idempotent either way.
  const ORG_NAME = "AI Runs Ledger Test Org";
  async function purge(phase: string) {
    const { data: orgs, error } = await admin.from("organizations").select("id, name").eq("name", ORG_NAME);
    if (error) throw new Error(`[${phase}] could not list test orgs: ${error.message}`);
    const orgIds = (orgs ?? []).filter((o) => o.name === ORG_NAME).map((o) => o.id as string);
    if (orgIds.length === 0) return;
    const { data: occupants } = await admin.from("profiles").select("email").in("organization_id", orgIds);
    if ((occupants?.length ?? 0) > 0) throw new Error(`[${phase}] refusing to purge: test org has profiles (${occupants!.map((o) => o.email).join(", ")})`);
    const { error: runsError } = await admin.from("ai_runs").delete().in("organization_id", orgIds);
    if (runsError) throw new Error(`[${phase}] could not delete test ai_runs: ${runsError.message}`);
    const { error: orgError } = await admin.from("organizations").delete().in("id", orgIds);
    if (orgError) throw new Error(`[${phase}] could not delete test org: ${orgError.message}`);
  }

  await purge("pre-run");
  const { data: org, error: orgError } = await admin.from("organizations").insert({ name: ORG_NAME }).select("id").single();
  if (orgError || !org) throw new Error(`Could not create test org: ${orgError?.message}`);
  const orgId = org.id as string;

  try {
    // Birth through the real helper, on the admin-client path.
    const runId = await beginRun(admin, { operation: "research", organizationId: orgId });
    const { data: born } = await admin.from("ai_runs").select("*").eq("id", runId).single();
    ok(
      "a birth row carries operation, organization and started_at, and nothing terminal",
      !!born && born.operation === "research" && born.organization_id === orgId && !!born.started_at && born.outcome === null && born.ended_at === null && born.model === null && born.input_tokens === null
    );
    ok(
      "the killed-run encoding exists: a born row that is never finalized is simply outcome null -- there is no value to write and nothing to infer it from",
      !!born && born.outcome === null
    );

    await finalizeRun(admin, runId, { outcome: "completed", model: "test-model", inputTokens: 100, outputTokens: 10 });
    const { data: done } = await admin.from("ai_runs").select("*").eq("id", runId).single();
    ok("finalizeRun writes the terminal facts once", !!done && done.outcome === "completed" && done.model === "test-model" && done.input_tokens === 100 && !!done.ended_at);

    await finalizeRun(admin, runId, { outcome: "failed", errorNote: "should not land" });
    const { data: after } = await admin.from("ai_runs").select("outcome, error_note").eq("id", runId).single();
    ok("a second finalize is a no-op -- terminal is written once (helper guard)", !!after && after.outcome === "completed" && after.error_note === null);

    const { error: rewriteError } = await admin.from("ai_runs").update({ outcome: "failed", ended_at: new Date().toISOString() }).eq("id", runId);
    ok("a direct update on a finalized row raises -- terminal-once holds even for the service role (trigger)", !!rewriteError, rewriteError?.message ?? "no error");

    const bornId = await beginRun(admin, { operation: "draft", organizationId: orgId });
    const { error: nonTerminalError } = await admin.from("ai_runs").update({ model: "sneaky" }).eq("id", bornId);
    ok("an update that does not write a terminal outcome raises -- unfinalized to terminal is the only legal transition (trigger)", !!nonTerminalError, nonTerminalError?.message ?? "no error");

    const { error: killedError } = await admin.from("ai_runs").insert({ operation: "research", organization_id: orgId, outcome: "killed", ended_at: new Date().toISOString() });
    ok("'killed' cannot be stored (check constraint)", !!killedError, killedError?.message ?? "no error");

    const { error: shapeError } = await admin.from("ai_runs").insert({ operation: "research", organization_id: orgId, ended_at: new Date().toISOString() });
    ok("ended_at without an outcome cannot be stored (terminal shape constraint)", !!shapeError, shapeError?.message ?? "no error");

    const { error: pairError } = await admin.from("ai_runs").insert({ operation: "research", organization_id: orgId, source_table: "research_runs" });
    ok("a source_table without a source_id cannot be stored (pairing constraint)", !!pairError, pairError?.message ?? "no error");
  } finally {
    await purge("teardown");
    const { data: leftover } = await admin.from("organizations").select("id").eq("name", ORG_NAME);
    if ((leftover?.length ?? 0) > 0) {
      console.error(`CLEANUP PROBLEM: ${leftover!.length} test org(s) still present`);
      fail++;
    } else {
      console.log("Teardown verified: no test org or ai_runs rows remain.");
    }
  }
}

async function main() {
  await helperAndScanSections();
  await dbSection();
  console.log(`\n${pass} passed, ${fail} failed.`);
  for (const n of notEvaluated) console.log(`NOT EVALUATED: ${n}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  console.error(`Run aborted. Of the assertions that executed before the abort: ${pass} passed, ${fail} failed.`);
  process.exit(1);
});
