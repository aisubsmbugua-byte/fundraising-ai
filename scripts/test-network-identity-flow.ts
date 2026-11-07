// STATE item 109 -- the shorter route through person identity (ruling 0044
// clauses 2 and 9).
//
// The invariant under test: an automatic LOOK is allowed (AI acts first); an
// automatic CONFIRMATION never is. Adding one person looks for their matches by
// itself; a list or an import is looked up only after a click that states the
// count and the cost; and in every case the only thing that turns a candidate
// into an identity is a human click on a button.
//
// Offline, like scripts/test-network-identity.ts: the pure rules and the client
// loop run for real; the REAL server actions run against an in-memory stand-in
// for Supabase and a scripted stand-in for the Anthropic client; source scans and
// server-rendered HTML cover what no run can show. No database, no network, no API
// key, no call to any live service.
//
// What this CANNOT prove (named so nobody over-reads a green run):
//   * It does not click anything in a browser. The component handlers are covered
//     by source scans and by running the same functions they call, in the same
//     order; the screens are server-rendered to static HTML for each phase.
//   * The fake client models neither row-level security nor Next's behaviour of
//     refreshing a page after a server action (revalidatePath).
//
// Mutation checks for the guards in this file run in
// scripts/mutation-check-network-identity-flow.ts.
//
// Usage: npx tsx scripts/test-network-identity-flow.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  IDENTITY_CLICK_CAP,
  MAX_CONSECUTIVE_FAILURES,
  STRONG_MATCHES_PER_SCREEN,
  buildLookupQueue,
  buildReviewPerson,
  lookupCostStatement,
  lookupLoopAddsUp,
  lookupSummary,
  nextBatchText,
  planAutoLook,
  progressText,
  runLookupLoop,
  statusLineParts,
  statusLineText,
  strongMatchPairs,
  type LookResultLike,
  type ReviewPerson,
} from "../lib/network-identity-flow";
import { computeAgreement, evidenceItems, evidenceLine, type IdentityFacts, type NetworkIdentityCandidate } from "../lib/network-identity";
import { NETWORK_DISCLOSURE, NETWORK_IMPORT_DISCLOSURE } from "../lib/network";
import { FakeNetDb, ORG_ID, USER_ID, makeStubber } from "./network-test-support";

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
const read = (p: string) => readFileSync(join(root, p), "utf8");
// Code only: comments legitimately DISCUSS what must not exist.
const stripComments = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");

const SRC_GOOD = { url: "https://www.gracechurch.org/staff/jane-whitcombe", title: "Our Staff - Grace Church", passage: "Jane Whitcombe, Senior Pastor of Grace Church, Austin, TX" };
const SRC_NAMESAKE = { url: "https://example.com/news/jane-whitcombe-attorney", title: "Jane Whitcombe named partner", passage: "Jane Whitcombe, a Dallas attorney at Reed & Lane" };
const F: IdentityFacts = { person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX" };
const ids = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

async function main() {
  // =========================================================================
  section("1. One click looks at no more than 50 people, whatever a caller asks for (pure logic, unit-tested)");

  {
    ok("the per-click cap is 50", IDENTITY_CLICK_CAP === 50);
    const q = buildLookupQueue(ids(212));
    ok("THE CAP: 212 people waiting -> the click's queue is the first 50, in order, and the plan says 162 are beyond it", q.queue.length === 50 && q.queue[0] === "p1" && q.queue[49] === "p50" && q.eligible === 212 && q.beyondCap === 162 && q.capped, JSON.stringify({ n: q.queue.length, e: q.eligible }));
    ok("THE CEILING: a caller that asks for more than 50 (5000, Infinity) still gets 50 -- the ceiling is not a default", buildLookupQueue(ids(212), { cap: 5000 }).queue.length === 50 && buildLookupQueue(ids(212), { cap: Infinity }).queue.length === 50);
    ok("a caller may ask for fewer (10), and a negative or fractional cap is treated safely", buildLookupQueue(ids(212), { cap: 10 }).queue.length === 10 && buildLookupQueue(ids(212), { cap: -5 }).queue.length === 0 && buildLookupQueue(ids(212), { cap: 7.9 }).queue.length === 7);
    const small = buildLookupQueue(ids(20));
    ok("20 people -> all 20 in one click, not 'capped'", small.queue.length === 20 && !small.capped && small.beyondCap === 0);
    ok("nobody waiting -> an empty queue", buildLookupQueue([]).queue.length === 0 && buildLookupQueue([]).eligible === 0);
    ok("RESUMABILITY: people already done are skipped, so the next click carries on (done p1..p30 of 212 -> next 50 start at p31; eligible is 182)", (() => { const r = buildLookupQueue(ids(212), { done: new Set(ids(30)) }); return r.queue[0] === "p31" && r.queue.length === 50 && r.eligible === 182; })());
    ok("a repeated id is looked at once", buildLookupQueue(["a", "b", "a", "b", "c"]).queue.join() === "a,b,c");
    ok("the text says which batch: 'the next 50 of 212' and 'all 20'", nextBatchText(q) === "the next 50 of 212" && nextBatchText(small) === "all 20");
    ok("THE STATEMENT AT THE CLICK: the count, that each costs one AI run, and the cap are all in the sentence", lookupCostStatement(212) === "212 people not yet identified. Each one costs one AI run. This click looks up the next 50 of 212; click again for the rest." && /^20 people not yet identified\. Each one costs one AI run\. This click looks up all 20\.$/.test(lookupCostStatement(20)) && /^1 person not yet identified\./.test(lookupCostStatement(1)));
    ok("nobody waiting -> the statement says so and promises no cost", /Everyone who can be looked up has been looked at/.test(lookupCostStatement(0)));
    ok("progress reads 'Looking up 7 of 20'", progressText(7, 20) === "Looking up 7 of 20");
  }

  // =========================================================================
  section("2. The client loop: one person at a time through the single-person action, capped, stoppable, and unable to confirm");

  {
    const seen: unknown[][] = [];
    const lookOk = (stored = 2) => async (...args: unknown[]): Promise<LookResultLike> => {
      seen.push(args);
      return { success: true, stored };
    };

    // the cap inside the loop itself (a second line of defence behind buildLookupQueue)
    seen.length = 0;
    const big = await runLookupLoop({ queue: ids(80), look: lookOk(), shouldStop: () => false, cap: 1000 });
    ok("THE LOOP'S CAP: handed 80 people and a cap of 1000, it looks at exactly 50 and reports 0 left unreached (they were never in this click)", seen.length === 50 && big.attempted === 50 && big.looked === 50 && big.stoppedBy === "done" && lookupLoopAddsUp(big, 50), JSON.stringify(big).slice(0, 300));
    ok("... one person at a time: the single-person action is called with the person's id and NOTHING else (no cap, no ledger flag, no list)", seen.every((a) => a.length === 1 && typeof a[0] === "string"));
    ok("... in order, each exactly once", seen.map((a) => a[0]).join() === ids(50).join());

    // progress text
    const steps: string[] = [];
    await runLookupLoop({ queue: ids(20), look: lookOk(), shouldStop: () => false, onProgress: (p) => steps.push(progressText(p.position, p.total)) });
    ok("progress is reported before each person: 'Looking up 1 of 20' ... 'Looking up 20 of 20'", steps.length === 20 && steps[0] === "Looking up 1 of 20" && steps[6] === "Looking up 7 of 20" && steps[19] === "Looking up 20 of 20");

    // stop
    let n = 0;
    const stopped = await runLookupLoop({ queue: ids(20), look: async () => { n++; return { success: true, stored: 1 }; }, shouldStop: () => n >= 7 });
    ok("STOP: after the 7th person it stops, says the user stopped it and that 13 were not reached", stopped.attempted === 7 && stopped.looked === 7 && stopped.stoppedBy === "user" && stopped.notReached === 13 && lookupLoopAddsUp(stopped, 20));
    ok("... and the people it did look at are reported as done, so a later click skips them", stopped.doneIds.join() === ids(7).join() && buildLookupQueue(ids(20), { done: new Set(stopped.doneIds) }).queue[0] === "p8");
    ok("a stop requested before the first person looks at nobody", (await runLookupLoop({ queue: ids(5), look: lookOk(), shouldStop: () => true })).attempted === 0);

    // outcome counting
    const mixed = await runLookupLoop({
      queue: ids(6),
      look: async (id) => (id === "p2" ? { error: "This person is marked do not research, so nothing is looked up about them." } : id === "p4" ? { success: true, stored: 0 } : { success: true, stored: 3 }),
      shouldStop: () => false,
    });
    ok("a person the server refuses, one with no match found and the rest with matches are counted apart and add up (1 failed, 1 none found, 4 with matches, of 6)", mixed.failed === 1 && mixed.noCandidatesFound === 1 && mixed.withCandidates === 4 && mixed.looked === 5 && lookupLoopAddsUp(mixed, 6), JSON.stringify(mixed));
    ok("... and the server's own words for what went wrong are kept", mixed.errors[0] === "This person is marked do not research, so nothing is looked up about them.");

    // consecutive failures
    let calls = 0;
    const broken = await runLookupLoop({ queue: ids(30), look: async () => { calls++; return { error: "Could not record the run" }; }, shouldStop: () => false });
    ok(`A BROKEN CONNECTION DOES NOT SPEND THE CLICK: after ${MAX_CONSECUTIVE_FAILURES} problems in a row it stops (30 queued, ${calls} tried)`, calls === MAX_CONSECUTIVE_FAILURES && broken.stoppedBy === "problems" && broken.notReached === 27 && lookupLoopAddsUp(broken, 30));
    const thrown = await runLookupLoop({ queue: ids(2), look: async () => { throw new Error("network down"); }, shouldStop: () => false });
    ok("a look that THROWS (the network went away) is a counted problem, not a crash", thrown.failed === 2 && thrown.errors[0] === "network down");
    let flip = 0;
    const recovering = await runLookupLoop({ queue: ids(10), look: async () => (++flip % 3 === 0 ? { success: true, stored: 1 } : { error: "x" }), shouldStop: () => false });
    ok("problems that are not consecutive do not stop it (the count resets after a good look)", recovering.attempted === 10 && recovering.stoppedBy === "done");

    const sum = lookupSummary(stopped, 20, 212);
    ok("the summary after a stop is plain: how many looked up, how many were not, and 'Click again to carry on'", /Looked up 7 of 20 people/.test(sum) && /You stopped it, so 13 were not looked up\. Click again to carry on\./.test(sum), sum);
    ok("the summary after a full click says how many more are waiting", /192 more are waiting; click again for the next batch\./.test(lookupSummary(big, 50, 242)) || /more are waiting/.test(lookupSummary(big, 50, 242)));
  }

  // =========================================================================
  section("3. One person added by hand: may we look right now? (the same refusal the server applies, asked first)");

  {
    ok("an employer, a title, a city or a state is enough to look", ["affiliation", "title", "city", "state"].every((k) => planAutoLook({ person_name: "Jane Whitcombe", [k]: "x" }).look === true));
    const nameOnly = planAutoLook({ person_name: "Jane Whitcombe", affiliation: "", title: "  ", city: "", state: "" });
    ok("NAME ONLY: no look; the plain sentence asks for an employer, title or city", !nameOnly.look && nameOnly.reason === "too_few_facts" && /Add an employer, title or city so we can find the right person/.test(nameOnly.message), JSON.stringify(nameOnly));
    const dnr = planAutoLook({ person_name: "Jane Whitcombe", affiliation: "Grace Church", do_not_research: true });
    ok("DO NOT RESEARCH: no look, whatever else is recorded, and it says so", !dnr.look && dnr.reason === "do_not_research" && /do not research, so nothing is looked up/.test(dnr.message));
    ok("do-not-research outranks 'name only' (a person who is both is told the first)", (() => { const r = planAutoLook({ person_name: "Jane", do_not_research: true }); return !r.look && r.reason === "do_not_research"; })());
    ok("a blank name is not looked up", (() => { const r = planAutoLook({ person_name: "   ", affiliation: "x" }); return !r.look && r.reason === "no_name"; })());
    ok("saved either way: every no-look message begins 'Saved.' except the blank name (which cannot have been saved)", [nameOnly, dnr].every((r) => !r.look && /^Saved\./.test(r.message)));
  }

  // =========================================================================
  section("4. The review screen's pure parts: strong matches, the status line, the person as shown");

  {
    const mkCand = (id: string, src: { url: string; title: string | null; passage: string | null }, facts = F, label = "Jane Whitcombe"): NetworkIdentityCandidate => ({
      id, organization_id: ORG_ID, network_connection_id: "x", ai_run_id: null, label, headline: null, location_text: null, source_url: src.url, source_title: src.title, source_passage: src.passage,
      agreement: computeAgreement(facts, src, { label, headline: null, location_text: null }), rank: 1, created_at: "2026-01-01T00:00:00Z",
    });
    const row = { id: "u1", person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX" };
    const strongP = buildReviewPerson(row, [mkCand("c1", SRC_GOOD), mkCand("c2", SRC_NAMESAKE)]);
    const unclearP = buildReviewPerson({ ...row, id: "u2" }, [mkCand("c3", SRC_NAMESAKE)]);
    ok("buildReviewPerson preselects the one strong match and shows the evidence worked out by code", strongP.preselectedId === "c1" && strongP.candidates.length === 2 && strongP.candidates[0].evidenceLine === evidenceLine(computeAgreement(F, SRC_GOOD, { label: "Jane Whitcombe", headline: null, location_text: null })) && strongP.candidates[0].evidence.length === evidenceItems(computeAgreement(F, SRC_GOOD, { label: "Jane Whitcombe", headline: null, location_text: null })).length);
    ok("a person with no strong match has nothing preselected", unclearP.preselectedId === null);
    const pairs = strongMatchPairs([strongP, unclearP]);
    ok("the pairs 'Confirm your network (N)' posts are the strong matches and nothing else (the unclear person is not in them)", pairs.length === 1 && pairs[0].personId === "u1" && pairs[0].candidateId === "c1");
    ok("a person the human unticked or opened for a different choice is NOT in the pairs", strongMatchPairs([strongP, unclearP], new Set(["u1"])).length === 0);
    ok("a person whose preselected id is not among their candidates is not posted (nothing is invented)", strongMatchPairs([{ ...strongP, preselectedId: "ghost" } as ReviewPerson]).length === 0);
    ok("the screen lists at most 200 strong matches at a time (under the server's 500)", STRONG_MATCHES_PER_SCREEN === 200 && STRONG_MATCHES_PER_SCREEN < 500);
    const counts = { not_looked_at: 40, no_candidates_found: 6, candidates: 5, confirmed: 12, none_of_these: 3, do_not_research: 2 };
    ok("the status line carries the five counts the owner named, and the sixth state ('looked up, no match found') is not folded into 'not looked at'", statusLineText(counts) === "12 confirmed · 5 still to review · 3 none of these · 2 do not research · 6 looked up, no match found · 40 not looked at" && statusLineParts(counts).length === 6);
  }

  // =========================================================================
  // The real actions, run against a fake client and a scripted model
  // =========================================================================

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const S = makeStubber(root);
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  const revalidated: string[] = [];
  let db = new FakeNetDb();
  db.identityColumns = true;
  type Call = { body: any };
  const calls: Call[] = [];
  const isSearchCall = (body: any) => String(body?.tools?.[0]?.type ?? "").startsWith("web_search");
  const searchResp = (cited: { url: string; title: string; text: string }[]) => ({
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 1000, output_tokens: 100 },
    stop_reason: "end_turn",
    content: [
      { type: "web_search_tool_result", content: [] },
      { type: "text", text: "Findings", citations: cited.map((c) => ({ type: "web_search_result_location", url: c.url, title: c.title, cited_text: c.text, encrypted_index: "x" })) },
    ],
  });
  const selectResp = (candidates: unknown[]) => ({
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 400, output_tokens: 50 },
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tu_1", name: "submit_person_candidates", input: { candidates } }],
  });
  const respond = (body: any) =>
    isSearchCall(body)
      ? searchResp([{ url: SRC_GOOD.url, title: SRC_GOOD.title, text: SRC_GOOD.passage }, { url: SRC_NAMESAKE.url, title: SRC_NAMESAKE.title, text: SRC_NAMESAKE.passage }])
      : selectResp([
          { source_index: 0, label: "Jane Whitcombe", headline: "Senior Pastor, Grace Church", location_text: "Austin, TX" },
          { source_index: 1, label: "Jane Whitcombe", headline: "attorney", location_text: "Dallas" },
        ]);
  S.stub(S.resolve("lib/ai/anthropic.ts"), { anthropic: { messages: { create: async (body: any) => { calls.push({ body }); return respond(body); } } }, DRAFT_MODEL: "claude-sonnet-4-6" });
  S.stub(S.resolve("lib/supabase/server.ts"), { createClient: () => db });
  S.stub(require.resolve("next/cache"), { revalidatePath: (p: string) => revalidated.push(p) });
  for (const f of ["lib/auth.ts", "lib/ai/person-search.ts", "lib/network-store.ts", "lib/network-identity-store.ts", "app/(dashboard)/network/identity-actions.ts", "app/(dashboard)/network/actions.ts", "app/(dashboard)/network/import-actions.ts"]) S.forget(S.resolve(f));

  const U = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const CU = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const personRow = (n: number, over: Record<string, unknown> = {}) => ({
    id: U(n), organization_id: ORG_ID, recorded_by: USER_ID, person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX",
    how_known: null, strength: "warm", notes: null, created_at: `2026-01-01T00:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}Z`, updated_at: "2026-01-01T00:00:00Z",
    do_not_research: false, identity_status: "unconfirmed", identity_decided_by: null, identity_decided_at: null, identity_candidate_id: null, ...over,
  });
  const fresh = () => {
    db = new FakeNetDb();
    db.identityColumns = true;
    calls.length = 0;
    revalidated.length = 0;
    return db;
  };
  const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const orig = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = orig;
    }
  };

  try {
    const idn = require(S.resolve("app/(dashboard)/network/identity-actions.ts")) as Record<string, (...a: any[]) => Promise<any>>;
    const net = require(S.resolve("app/(dashboard)/network/actions.ts")) as Record<string, (...a: any[]) => Promise<any>>;
    const imp = require(S.resolve("app/(dashboard)/network/import-actions.ts")) as Record<string, (...a: any[]) => Promise<any>>;

    // -----------------------------------------------------------------------
    section("5. The client loop through the REAL single-person action: refusals are the server's, and nothing is confirmed");

    {
      const d = fresh();
      d.seed("network_connections", [
        personRow(1), personRow(2), personRow(3),
        personRow(10, { do_not_research: true }),
        personRow(11, { identity_status: "confirmed", identity_candidate_id: CU(900), identity_decided_by: USER_ID, identity_decided_at: "2026-01-02T00:00:00Z" }),
        personRow(12, { identity_status: "none_of_these", identity_decided_by: USER_ID, identity_decided_at: "2026-01-02T00:00:00Z" }),
        personRow(13, { affiliation: null, title: null, city: null, state: null }),
      ]);
      // The HOSTILE queue: every person, including the four who must never be looked at, with extra arguments a tampering client might add.
      // (interleaved, so that the "three problems in a row" stop does not end the click before the last refused person)
      const everyone = [U(10), U(1), U(11), U(2), U(12), U(3), U(13)];
      const outcome = await quiet(() =>
        runLookupLoop({
          queue: everyone,
          look: (id) => (idn.findIdentityCandidates as any)(id, { cap: 9999, ledger: false, skipRefusal: true, force: true }),
          shouldStop: () => false,
          cap: 9999,
        })
      );
      ok("REFUSALS HOLD THROUGH THE CLIENT LOOP: do-not-research, confirmed, none-of-these and name-only people are refused by the server even when a client hands them over with a ledger or cap argument", outcome.failed === 4 && outcome.looked === 3 && lookupLoopAddsUp(outcome, 7), JSON.stringify(outcome).slice(0, 400));
      const bornFor = d.rows("ai_runs").map((r) => r.source_id).sort();
      ok("... and no run was born for any of the four: exactly the three real people have a ledger row (one each)", bornFor.join() === [U(1), U(2), U(3)].join() && d.logOf("ai_runs", "insert").length === 3);
      ok("... and the model was called twice per real person (the search, then the selection) and not at all for the refused four", calls.length === 6);
      ok("the server's refusal words reach the screen (the do-not-research one is among them)", outcome.errors.some((e) => /do not research/.test(e)));
      ok("THE LOOP CONFIRMS NOBODY: after looking at three people who each have a strong match, none is confirmed, no chosen candidate, no decider, and not one write touched network_connections", ["1", "2", "3"].every((_, i) => { const r = d.rows("network_connections").find((x) => x.id === U(i + 1))!; return r.identity_status === "unconfirmed" && r.identity_candidate_id === null && r.identity_decided_by === null; }) && d.logOf("network_connections", "update").length === 0 && d.logOf("network_connections", "insert").length === 0);
      ok("... while the looked-up people DO now hold candidates to review (the look is the automatic part)", d.rows("network_identity_candidates").filter((c) => c.network_connection_id === U(1)).length === 2);
    }

    {
      const d = fresh();
      const people = Array.from({ length: 60 }, (_, i) => personRow(i + 1));
      d.seed("network_connections", [...people, personRow(70, { do_not_research: true }), personRow(71, { affiliation: null, title: null, city: null, state: null })]);
      const q = await idn.loadLookupQueue();
      ok("loadLookupQueue (a READ) names who is waiting: 60 eligible, the first 50 ids, and the do-not-research and name-only people are not among them", "success" in q && q.eligible === 60 && q.ids.length === 50 && !q.ids.includes(U(70)) && !q.ids.includes(U(71)) && q.totalRecorded === 62, JSON.stringify(q).slice(0, 200));
      ok("... it spends nothing and writes nothing: no run, no model call, no write at all", d.logOf("ai_runs", "insert").length === 0 && calls.length === 0 && d.log.every((l) => l.op === "select"));
      const end = await quiet(() => runLookupLoop({ queue: (q as any).ids, look: (id) => idn.findIdentityCandidates(id), shouldStop: () => false }));
      const q2 = await idn.loadLookupQueue();
      ok("RESUME: after that click, 50 are done and the next fetch says 10 are waiting (the 50 now have candidates, so they are not offered again)", end.looked === 50 && (q2 as any).eligible === 10 && (q2 as any).ids.every((id: string) => !(q as any).ids.includes(id)));
      const q3 = await (async () => { const e2 = await quiet(() => runLookupLoop({ queue: (q2 as any).ids, look: (id) => idn.findIdentityCandidates(id), shouldStop: () => false })); return { e2, q: await idn.loadLookupQueue() }; })();
      ok("... and a second click finishes the last 10, after which nobody is waiting", q3.e2.looked === 10 && (q3.q as any).eligible === 0 && d.logOf("ai_runs", "insert").length === 60);
    }

    // -----------------------------------------------------------------------
    section("6. One person added by hand, end to end through the real actions: saved, looked at, matches read back, NOT confirmed");

    {
      const d = fresh();
      const added = await net.addConnection({ person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX", how_known: "", strength: "warm", notes: "" });
      const newId = d.rows("network_connections")[0]?.id;
      ok("addConnection returns the new person's id so the page can look for their matches", "success" in added && typeof added.id === "string" && added.id === newId, JSON.stringify(added));
      ok("... the insert still names only the same keys (the id is read back; nothing else is sent)", JSON.stringify(Object.keys(d.logOf("network_connections", "insert")[0].payload as object).sort()) === JSON.stringify(["affiliation", "city", "how_known", "notes", "person_name", "recorded_by", "state", "strength", "title"]));
      // What the page does next, with the same functions in the same order:
      const plan = planAutoLook({ person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX" });
      ok("the page's plan says look", plan.look === true);
      const found = await quiet(() => idn.findIdentityCandidates(added.id));
      ok("the look ran: two matches found", "success" in found && found.stored === 2 && calls.length === 2);
      const loaded = await idn.loadPersonCandidates(added.id);
      ok("loadPersonCandidates returns the person with both candidates, the evidence worked out by code and the strong match preselected (a default highlight)", "success" in loaded && loaded.person?.candidates.length === 2 && loaded.person.preselectedId === loaded.person.candidates[0].id && loaded.person.candidates[0].evidence.length > 0, JSON.stringify(loaded).slice(0, 300));
      const p = d.rows("network_connections")[0];
      ok("AUTOMATIC LOOK, NO AUTOMATIC CONFIRMATION: the person is still unconfirmed, with no chosen candidate and no decider -- even though one candidate is the strong match", p.identity_status === "unconfirmed" && p.identity_candidate_id === null && p.identity_decided_by === null && p.identity_decided_at === null && d.logOf("network_connections", "update").length === 0);
      ok("loadPersonCandidates is a read: it wrote nothing and spent nothing beyond the look", d.logOf("ai_runs", "insert").length === 1 && d.log.filter((l) => l.op !== "select").every((l) => l.table === "ai_runs" || l.table === "network_identity_candidates" || l.table === "network_connections"));
      // the human click, as the buttons do it
      const none = await idn.markNoneOfThese(added.id);
      ok("only the human's click decides: 'None of these' records it", "success" in none && d.rows("network_connections")[0].identity_status === "none_of_these");
      const after = await idn.loadPersonCandidates(added.id);
      ok("a decided person is not offered again: loadPersonCandidates returns no person to choose for", "success" in after && after.person === null && after.state === "none_of_these");
    }

    {
      const d = fresh();
      d.seed("network_connections", [personRow(1, { identity_status: "confirmed", identity_candidate_id: CU(1), identity_decided_by: USER_ID, identity_decided_at: "2026-01-02T00:00:00Z" }), personRow(2, { do_not_research: true })]);
      const a = await idn.loadPersonCandidates(U(1));
      const b = await idn.loadPersonCandidates(U(2));
      const c = await idn.loadPersonCandidates("not-a-uuid");
      ok("loadPersonCandidates offers nothing for a confirmed person or a do-not-research person, and refuses a malformed id", a.person === null && b.person === null && "error" in c);
    }

    {
      // name only: the page does NOT look; and if a client looked anyway, the server refuses before any run is born
      const d = fresh();
      const added = await net.addConnection({ person_name: "John Smith", affiliation: "", title: "", city: "", state: "", how_known: "", strength: "warm", notes: "" });
      const plan = planAutoLook({ person_name: "John Smith" });
      ok("a name-only person is saved, the plan says do not look, and nothing was spent", "success" in added && !plan.look && d.logOf("ai_runs", "insert").length === 0 && calls.length === 0);
      const forced = await idn.findIdentityCandidates(added.id);
      ok("... and if a client looked anyway, the server refuses it before any run is born", "error" in forced && /A name alone cannot be matched/.test(forced.error) && d.logOf("ai_runs", "insert").length === 0 && calls.length === 0);
    }

    {
      // a failing look leaves the person saved
      const d = fresh();
      const added = await net.addConnection({ person_name: "Jane Whitcombe", affiliation: "Grace Church", how_known: "", strength: "warm", notes: "" });
      d.failInsert["ai_runs"] = { onCall: 1, message: "ledger down" };
      const failed = await quiet(() => idn.findIdentityCandidates(added.id));
      ok("THE LOOK NEVER BLOCKS SAVING: when the look fails, the person is still saved, nothing was confirmed, and the failure is returned in words (for 'Try again')", "error" in failed && d.rows("network_connections").length === 1 && d.rows("network_connections")[0].identity_status === "unconfirmed" && calls.length === 0, JSON.stringify(failed));
      const retry = await quiet(() => idn.findIdentityCandidates(added.id));
      ok("... and 'Try again' (the same action) works once the problem is gone", "success" in retry);
    }

    {
      // do-not-research from the start
      const d = fresh();
      const added = await net.addConnection({ person_name: "Jane Whitcombe", affiliation: "Grace Church", do_not_research: true, how_known: "", strength: "warm", notes: "" });
      const plan = planAutoLook({ person_name: "Jane Whitcombe", affiliation: "Grace Church", do_not_research: true });
      ok("a person added as do-not-research is saved and is not looked at", "success" in added && !plan.look && d.logOf("ai_runs", "insert").length === 0 && calls.length === 0);
    }

    // -----------------------------------------------------------------------
    section("7. An import is never looked up by itself");

    {
      const d = fresh();
      const rows = [
        { person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX", how_known: "2024 list", notes: null },
        { person_name: "Sam Lee", affiliation: "Hope Trust", title: null, city: null, state: null, how_known: "2024 list", notes: null },
      ];
      const result = await imp.importConnections(rows, { strength: "warm" });
      ok("THE IMPORT SPENDS NOTHING: two people with enough detail to look up were imported, and not one ledger run was born and not one model call was made", "success" in result && result.imported === 2 && d.logOf("ai_runs", "insert").length === 0 && calls.length === 0, JSON.stringify(result).slice(0, 200));
      ok("... and nothing was confirmed or decided", d.rows("network_connections").every((r) => r.identity_status === "unconfirmed" || r.identity_status === undefined));
      const q = await idn.loadLookupQueue();
      ok("the import's result page can state the count by reading the queue (a read): both are waiting, and still nothing was spent", "success" in q && q.eligible === 2 && d.logOf("ai_runs", "insert").length === 0);
    }

    // -----------------------------------------------------------------------
    section("8. Source scans: no code path confirms without a click, and no import path looks");

    {
      const TS = (p: string) => stripComments(read(p));
      const CONFIRMS = /confirmIdentity|confirmPreselectedIdentities|markNoneOfThese/;
      const FINDS = /findIdentityCandidates|findIdentityCandidatesForUnidentified|runLookupLoop/;

      // the add-person flow and the import flow, and the pure flow library
      const addFlow = ["app/(dashboard)/network/network-workspace.tsx", "app/(dashboard)/network/add-person-result.tsx", "app/(dashboard)/network/actions.ts", "lib/network-identity-flow.ts", "app/(dashboard)/network/identity/lookup-runner.tsx"];
      const importFlow = ["app/(dashboard)/network/import/import-workspace.tsx", "app/(dashboard)/network/import-actions.ts", "app/(dashboard)/network/import/page.tsx", "lib/network-import.ts", "lib/network-store.ts"];
      const confirmHits = [...addFlow, ...importFlow].filter((f) => CONFIRMS.test(TS(f)));
      ok(`NO ADD-PERSON OR IMPORT CODE CAN CONFIRM: none of the ${addFlow.length + importFlow.length} files of the add-person flow, the lookup button, the import flow and the flow library names confirmIdentity, confirmPreselectedIdentities or markNoneOfThese`, confirmHits.length === 0, confirmHits.join(", "));

      // where the confirm actions ARE called from in the UI: only the person card and the review screen's one button, each from a click handler
      const uiFiles: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(join(root, dir))) {
          const p = join(dir, name);
          if (statSync(join(root, p)).isDirectory()) walk(p);
          else if (/\.tsx$/.test(name)) uiFiles.push(p);
        }
      };
      walk("app/(dashboard)/network");
      const callers = uiFiles.filter((f) => CONFIRMS.test(TS(f))).sort();
      ok("the ONLY two UI files that name a confirm action are the person card and the review screen", callers.join() === ["app/(dashboard)/network/identity/identity-workspace.tsx", "app/(dashboard)/network/identity/person-card.tsx"].join(), callers.join());
      const card = TS("app/(dashboard)/network/identity/person-card.tsx");
      const ws = TS("app/(dashboard)/network/identity/identity-workspace.tsx");
      ok("neither of them has an effect, a timer or a page-load hook: confirming can only come from a click", ![card, ws].some((t) => /useEffect|useLayoutEffect|setTimeout|setInterval|requestAnimationFrame|onLoad|useInsertionEffect/.test(t)));
      ok("the person card calls confirmIdentity once, inside confirmChosen, and markNoneOfThese once, inside recordNone; each is reached only through an onClick", (card.match(/confirmIdentity\(/g) ?? []).length === 1 && (card.match(/markNoneOfThese\(/g) ?? []).length === 1 && card.indexOf("confirmIdentity(") > card.indexOf("const confirmChosen") && card.indexOf("markNoneOfThese(") > card.indexOf("const recordNone") && /onClick=\{confirmChosen\}/.test(card) && /onClick=\{recordNone\}/.test(card) && /onClick=\{submit\}/.test(card) && (card.match(/\bsubmit\b/g) ?? []).length === 2);
      ok("the review screen's one batch button posts only strongMatchPairs(...) minus anyone unticked or opened, and only from onClick={confirmNetwork}", (ws.match(/confirmPreselectedIdentities\(/g) ?? []).length === 1 && /const pairs = strongMatchPairs\(strong, new Set\(\[\.\.\.excluded, \.\.\.choosing\]\)\)/.test(ws) && /confirmPreselectedIdentities\(pairs\)/.test(ws) && /onClick=\{confirmNetwork\}/.test(ws));

      // the add flow: the look happens only after a successful save, only if the plan allows, and the form is not blocked by it
      const nw = TS("app/(dashboard)/network/network-workspace.tsx");
      const afterSave = nw.slice(nw.indexOf("const afterSave"), nw.indexOf("return (", nw.indexOf("const afterSave")));
      ok("the add flow looks only after the save succeeded and only when the plan says so: planAutoLook(...) precedes lookFor(...) in afterSave", afterSave.indexOf("planAutoLook(") > 0 && afterSave.indexOf("lookFor(") > afterSave.indexOf("planAutoLook(") && /if \(!plan\.look\)/.test(afterSave));
      ok("afterSave is called only on success of addConnection / updateConnection (never on an error)", /if \("success" in result\) afterSave\(result\.id, input\)/.test(nw) && /if \("success" in result\) afterSave\(saved\.id, input\)/.test(nw));
      ok("the look is not awaited by the form (void lookFor), so saving is never blocked by it; the form returns the SAVE result", /void lookFor\(id, name\)/.test(afterSave) && /return result;/.test(nw.slice(nw.indexOf("const result = await addConnection(input)"), nw.indexOf("const result = await addConnection(input)") + 400)));
      ok("findIdentityCandidates appears in the add flow only inside lookFor (called by afterSave and by 'Try again')", (nw.match(/findIdentityCandidates\(/g) ?? []).length === 2 && nw.indexOf("await findIdentityCandidates(id)") > nw.indexOf("const lookFor") && nw.indexOf("await findIdentityCandidates(id)") < nw.indexOf("const afterSave"));
      ok("the in-place panel uses the SAME card as the review screen (PersonCard, mode single): the confirm logic is not duplicated", /import \{ PersonCard \} from "\.\/identity\/person-card"/.test(TS("app/(dashboard)/network/add-person-result.tsx")) && /<PersonCard key=\{phase\.person\.id\} p=\{phase\.person\} mode="single" \/>/.test(TS("app/(dashboard)/network/add-person-result.tsx")));

      // the import: no look at all
      const importHits = importFlow.filter((f) => FINDS.test(TS(f)));
      ok("AN IMPORT NEVER TRIGGERS A LOOK: no import-flow file names findIdentityCandidates, findIdentityCandidatesForUnidentified or runLookupLoop", importHits.length === 0, importHits.join(", "));
      const impActions = TS("app/(dashboard)/network/import-actions.ts");
      ok("... the import action imports nothing from the identity actions, the ledger or the person search", !/identity-actions|ai-runs|person-search|network-identity/.test(impActions.split("\n").filter((l) => /^import|from "/.test(l)).join("\n")));
      const impUi = TS("app/(dashboard)/network/import/import-workspace.tsx");
      ok("... the import page only READS who is waiting (loadLookupQueue) after a successful import, and shows the button; the button starts nothing by itself", /loadLookupQueue\(\)/.test(impUi) && /<LookupRunner eligible=\{waiting\}/.test(impUi) && (impUi.match(/loadLookupQueue\(/g) ?? []).length === 1);
      ok("... and tells the person nothing has been looked up and that the click is theirs to make", /Nothing has been looked up\./.test(impUi) && /costs one AI run/.test(impUi));

      // the lookup button
      const lr = TS("app/(dashboard)/network/identity/lookup-runner.tsx");
      ok("THE LOOKUP LOOP STARTS ONLY FROM A CLICK: runLookupLoop( is called once, inside start, and start is reached only via onStart <- onClick", (lr.match(/runLookupLoop\(/g) ?? []).length === 1 && lr.indexOf("runLookupLoop(") > lr.indexOf("const start = async") && /onStart=\{start\}/.test(lr) && /onClick=\{onStart\}/.test(lr) && (lr.match(/\bstart\b/g) ?? []).length === 2);
      const effects = lr.match(/useEffect\(/g) ?? [];
      ok("... its one effect only STOPS the loop on leaving the page (it returns a cleanup that sets the stop flag and starts nothing)", effects.length === 1 && /useEffect\(\s*\(\) => \(\) => \{\s*stopRef\.current = true;\s*\},\s*\[\]\s*\)/.test(lr));
      ok("... it calls the SINGLE-person action in the loop (not the bulk server action), passing the id alone", /look: \(personId\) => findIdentityCandidates\(personId\)/.test(lr) && !/ForUnidentified/.test(lr));
      ok("THE OLD BULK BUTTON IS GONE FROM THE UI: no client file calls findIdentityCandidatesForUnidentified (the server action and its tests remain)", uiFiles.every((f) => !/findIdentityCandidatesForUnidentified/.test(TS(f))) && /export async function findIdentityCandidatesForUnidentified/.test(TS("app/(dashboard)/network/identity-actions.ts")));
      ok("the pages that load data (network/page.tsx, identity/page.tsx, import/page.tsx) call no find / confirm action", ["app/(dashboard)/network/page.tsx", "app/(dashboard)/network/identity/page.tsx", "app/(dashboard)/network/import/page.tsx"].every((f) => !FINDS.test(TS(f)) && !CONFIRMS.test(TS(f))));

      // 'use server' module shape, and the new reads
      const act = read("app/(dashboard)/network/identity-actions.ts");
      ok("identity-actions stays a 'use server' file that exports only async functions (types are erased)", /^"use server";/.test(act) && !/export (const|let|var|class)\b/.test(stripComments(act)));
      ok("loadLookupQueue and loadPersonCandidates make no write: no insert, update, delete or run in their bodies", (() => { const t = stripComments(act); const a = t.indexOf("export async function loadLookupQueue"); const b = t.indexOf("export type BulkFindResult"); const body = t.slice(a, b); return a > 0 && b > a && !/\.insert\(|\.update\(|\.delete\(|beginRun|finalizeRun|findPersonCandidates/.test(body); })());

      // the assistant and external agent
      const surface: string[] = [];
      const walk2 = (dir: string) => {
        for (const name of readdirSync(join(root, dir))) {
          const p = join(dir, name);
          if (statSync(join(root, p)).isDirectory()) walk2(p);
          else if (/\.(ts|tsx)$/.test(name)) surface.push(p);
        }
      };
      for (const d of ["lib/assistant", "lib/agent", "app/api"]) walk2(d);
      const NEW_NAMES = /loadLookupQueue|loadPersonCandidates|network-identity-flow|runLookupLoop|planAutoLook|strongMatchPairs/;
      ok(`the assistant, the external agent and the HTTP routes (${surface.length} files) can reach none of the new reads, the flow library or the loop`, surface.every((f) => !NEW_NAMES.test(stripComments(read(f)))), surface.filter((f) => NEW_NAMES.test(stripComments(read(f)))).join(", "));
      ok("the flow library imports nothing from Next, Supabase, the ledger or the model (pure, so it cannot spend or confirm)", !/from "(next|@supabase|@\/lib\/supabase|@\/lib\/ai|\.\/ai|@\/lib\/ai-runs|\.\/ai-runs)/.test(stripComments(read("lib/network-identity-flow.ts"))) && !/from "@?\/?[^"]*identity-actions/.test(read("lib/network-identity-flow.ts")));
      ok("every UI file in the flow uses the shared design tokens (lib/ui) and the new cards set boxSizing border-box", ["lookup-runner.tsx", "person-card.tsx", "identity-workspace.tsx"].every((n) => /from "@\/lib\/ui"/.test(read(`app/(dashboard)/network/identity/${n}`))) && /boxSizing: "border-box"/.test(card) && /boxSizing: "border-box"/.test(lr));
    }

    // -----------------------------------------------------------------------
    section("9. The screens, rendered for every phase (server-rendered to static HTML with fixture data)");

    {
      (globalThis as any).React = require("react");
      const { renderToStaticMarkup } = require("react-dom/server");
      const { createElement } = require("react");
      const html = (c: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(c as any, props)) as string;
      const apr = require("../app/(dashboard)/network/add-person-result");
      const lrn = require("../app/(dashboard)/network/identity/lookup-runner");
      const nw = require("../app/(dashboard)/network/network-workspace").default;

      const mkCand = (id: string, src: { url: string; title: string | null; passage: string | null }): NetworkIdentityCandidate => ({
        id, organization_id: ORG_ID, network_connection_id: "x", ai_run_id: null, label: "Jane Whitcombe", headline: "Senior Pastor, Grace Church", location_text: "Austin, TX", source_url: src.url, source_title: src.title, source_passage: src.passage,
        agreement: computeAgreement(F, src, { label: "Jane Whitcombe", headline: "Senior Pastor, Grace Church", location_text: "Austin, TX" }), rank: 1, created_at: "2026-01-01T00:00:00Z",
      });
      const person = buildReviewPerson({ id: "u1", person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX" }, [mkCand("c1", SRC_GOOD), mkCand("c2", SRC_NAMESAKE)]);
      const noop = () => {};
      const view = (phase: unknown) => html(apr.AddPersonResultView, { phase, onTryAgain: noop, onAddDetails: noop });

      ok("idle: nothing is shown under the form", view({ kind: "idle" }) === "");
      const looking = view({ kind: "looking", name: "Jane Whitcombe" });
      ok("LOOKING: 'Looking for matches…' is shown in place, with the name, and says it is one AI run", /Looking for matches…/.test(looking) && /Jane Whitcombe/.test(looking) && /one AI run/.test(looking) && /role="status"/.test(looking));
      const matches = view({ kind: "matches", name: "Jane Whitcombe", person });
      ok("MATCHES: each candidate is shown in place with its source link and the evidence line", html(apr.AddPersonResultView, { phase: { kind: "matches", name: "x", person }, onTryAgain: noop, onAddDetails: noop }).includes(`href="${SRC_GOOD.url}"`) && /found in source/.test(matches.replace(/<!-- -->/g, "")) && /Found 2 possible matches/.test(matches.replace(/<!-- -->/g, "")));
      ok("... with exactly the two buttons the owner asked for, 'Confirm this person' and 'None of these' -- and no radio for 'None of these', no 'Look again', no 'Do not research' on this panel", /Confirm this person<\/button>/.test(matches) && /None of these<\/button>/.test(matches) && !/Confirm this is the person/.test(matches) && !/Look again/.test(matches) && !/Do not research this person/.test(matches) && (matches.match(/type="radio"/g) ?? []).length === 2);
      ok("... the strong match is pre-chosen and marked 'Suggested — please check' (a highlight; the confirm button still needs a click), and nothing says it is confirmed", (matches.match(/checked=""/g) ?? []).length === 1 && /Suggested — please check/.test(matches) && /Nothing is confirmed until you say so/.test(matches.replace(/<!-- -->/g, "")) && !/>Confirmed:/.test(matches));
      const noPre = view({ kind: "matches", name: "Sam", person: buildReviewPerson({ id: "u2", person_name: "Jane Whitcombe", affiliation: "Grace Church", title: "Senior Pastor", city: "Austin", state: "TX" }, [mkCand("c9", SRC_NAMESAKE)]) });
      ok("... when there is no strong match nothing is pre-chosen and 'Confirm this person' is disabled until the human picks", (noPre.match(/checked=""/g) ?? []).length === 0 && /<button[^>]*disabled=""[^>]*>Confirm this person<\/button>/.test(noPre));
      const nameOnly = view({ kind: "not_looked", name: "John Smith", message: planAutoLook({ person_name: "John Smith" }).look === false ? (planAutoLook({ person_name: "John Smith" }) as any).message : "", canAddDetails: true });
      ok("NAME ONLY: the plain sentence is shown with a way to edit ('Add details'), and nothing was looked up", /Add an employer, title or city so we can find the right person/.test(nameOnly) && /Add details<\/button>/.test(nameOnly) && !/Looking for matches/.test(nameOnly));
      const dnr = view({ kind: "not_looked", name: "Jane", message: (planAutoLook({ person_name: "Jane", affiliation: "x", do_not_research: true }) as any).message, canAddDetails: false });
      ok("DO NOT RESEARCH: the sentence is shown with no 'Add details' and no 'Try again'", /marked do not research, so nothing is looked up/.test(dnr) && !/Add details/.test(dnr) && !/Try again/.test(dnr));
      const failedLook = view({ kind: "failed", name: "Jane Whitcombe", message: "Could not record the run, so nothing was looked up.", step: "look" });
      ok("A FAILED LOOK says so plainly, says the person is saved, shows the reason in words, and leaves 'Try again'", /Saved\./.test(failedLook) && /did not complete/.test(failedLook) && /Could not record the run/.test(failedLook) && /Try again<\/button>/.test(failedLook));
      ok("a failed read of the matches is told apart from a failed look", /could not be shown/.test(view({ kind: "failed", name: "J", message: "x", step: "read" })));
      ok("NO MATCHES: the message says so, with nothing to confirm and no buttons", /No candidates found/.test(view({ kind: "no_matches", name: "J", message: "Saved. No candidates found: none of the 3 pages found described someone who could be this person." })) && !/<button/.test(view({ kind: "no_matches", name: "J", message: "Saved." })));

      // the lookup button, every phase
      const lv = (phase: unknown, extra: Record<string, unknown> = {}) => html(lrn.LookupRunnerView, { phase, eligible: 212, label: "Confirm your network", primary: true, reviewHref: "/network/identity", whenNoneWaiting: "link", onStart: noop, onStop: noop, ...extra });
      const idle = lv({ kind: "idle" });
      ok("IDLE: one button 'Confirm your network' and, beside it, the count, that each costs one AI run, and 'the next 50 of 212'", /Confirm your network<\/button>/.test(idle) && /212 people not yet identified\. Each one costs one AI run\. This click looks up the next 50 of 212; click again for the rest\./.test(idle));
      ok("... it is the primary button (the shared buttonPrimary style), the secondary one for 'Look up more people'", /background:[^;"]*;/.test(idle) && lv({ kind: "idle" }, { primary: false, label: "Look up more people" }).includes("Look up more people"));
      ok("a count that is not known yet still states the cost and the cap", /Each person looked up costs one AI run\. One click looks up at most 50 people\./.test(lv({ kind: "idle" }, { eligible: null })));
      ok("nobody waiting -> the button is a link to the review screen and says everyone has been looked at", /<a[^>]*href="\/network\/identity"[^>]*>Confirm your network<\/a>/.test(lv({ kind: "idle" }, { eligible: 0 })) && /Everyone who can be looked up has been looked at/.test(lv({ kind: "idle" }, { eligible: 0 })));
      const running = lv({ kind: "running", position: 7, total: 20, stopping: false });
      ok("RUNNING: 'Looking up 7 of 20', a Stop button, a progress bar, the AI-run reminder and 'nobody is confirmed by this'; the start button is disabled", /Looking up 7 of 20/.test(running) && /Stop<\/button>/.test(running) && /<progress[^>]*max="20"/.test(running) && /Each person is one AI run/.test(running) && /Nobody is confirmed by this/.test(running) && /<button[^>]*disabled=""[^>]*>Looking up 7 of 20<\/button>/.test(running));
      ok("... after Stop is pressed it says it is stopping after this person, and Stop is disabled", /Stopping after this person…/.test(lv({ kind: "running", position: 7, total: 20, stopping: true })));
      const fin = lv({ kind: "finished", message: "Looked up 7 of 20 people: 5 now have matches to review and 2 had none found. You stopped it, so 13 were not looked up. Click again to carry on.", clean: false });
      ok("FINISHED (stopped): the summary and a link to review what was found", /Looked up 7 of 20 people/.test(fin) && /href="\/network\/identity"[^>]*>Review what was found/.test(fin));
      ok("on the review screen itself, with nobody waiting, the button shows nothing (no link to the page you are on), but a finished click still shows what happened", lv({ kind: "idle" }, { eligible: 0, whenNoneWaiting: "nothing" }) === "" && /Looked up 1 of 1/.test(lv({ kind: "finished", message: "Looked up 1 of 1 person: 1 now has matches to review and 0 had none found.", clean: true }, { eligible: 0, whenNoneWaiting: "nothing" })));
      ok("an error reading the queue is shown in words", /Could not read your network/.test(lv({ kind: "error", message: "Could not read your network just now, so nobody was looked up." })));

      // disclosure unchanged and still where people are entered
      const nwHtml = html(nw, { connections: [], totalRecorded: 0, matching: 0, q: "", window: { page: 1, totalPages: 1, from: 0, to: 0, first: 1, last: 1 }, identity: { available: true, counts: { confirmed: 0, noneOfThese: 0, doNotResearch: 0 }, byId: {}, eligible: 0 } });
      const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
      ok("DISCLOSURE IS UNCHANGED AND STILL SHOWN where a person is entered: the add form renders NETWORK_DISCLOSURE word for word", nwHtml.includes(esc(NETWORK_DISCLOSURE)));
      ok("... and the import page still renders NETWORK_IMPORT_DISCLOSURE", /\{NETWORK_IMPORT_DISCLOSURE\}/.test(stripComments(read("app/(dashboard)/network/import/import-workspace.tsx"))) && NETWORK_IMPORT_DISCLOSURE.length > 0);
      ok("with no one recorded, the Network page shows no 'Confirm your network' entry (nothing to confirm) but still the add form", !/Confirm your network/.test(nwHtml) && /Add someone you know/.test(nwHtml));
    }
  } finally {
    S.restore();
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
