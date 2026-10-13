// STATE item 87, ruling 0037: the in-platform assistant.
//
// Offline and deterministic: no database, no network, no API key. Everything
// the assistant does against Supabase runs here against a small in-memory fake
// client that deliberately returns WHOLE rows (contact emails, phone numbers,
// notes, interaction text, pledge amounts) regardless of the columns a handler
// asked for -- so a field that leaks is a field the code failed to drop, not a
// field the fixture happened to omit.
//
// Sections:
//   1  the registry: exact names, kinds, no forbidden semantics
//   2  config: enablement list, provider configuration
//   3  the provider adapter, against a fake fetch (URL, bearer, tool shape,
//      usage mapping, tool_calls parsed from the JSON string, failure kinds)
//   4  argument validation and dispatch (untrusted input never reaches a
//      handler; allowlists are enforced at runtime, not only asserted)
//   5  reads: allowlists against contaminated fixtures; equivalence with the
//      pages they mirror
//   6  proposals and executors
//   7  the bounded loop with a fake provider (bounds, failure paths)
//   8  the turn: ordering, refusal-before-birth, exactly one finalize
//   9  the decision logic (approve / dismiss) against a fake client
//  10  source scans: executor reachability, import closure, key containment,
//      client graph, birth-before-call, route budget
//  11  the migration, by text
//
// Not covered here, by construction: the live provider (never called by the
// build; scripts/assistant-smoke.ts is the owner's tool), and the database's
// own trigger behaviour (written into scripts/test-tenant-isolation.ts, which
// needs a live database and reports NOT EVALUATED without one).
//
// Usage: npx tsx scripts/test-assistant.ts

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ABILITIES, ABILITY_NAMES, findAbility } from "../lib/assistant/abilities";
import {
  parseEnabledOrgIds,
  isAssistantEnabledForOrg,
  isAssistantEnabledAnywhere,
  readProviderConfig,
  DEFAULT_MODEL_BASE_URL,
  DEFAULT_ASSISTANT_MODEL,
  PROVIDER_ID,
} from "../lib/assistant/config";
import { buildRequest, callProvider, parseResponse, type FetchLike, type ProviderCallResult } from "../lib/assistant/provider";
import { dispatchToolCall, enforceAllowlist, collectKeys, MAX_TOOL_RESULT_CHARS } from "../lib/assistant/dispatch";
import {
  runAssistantLoop,
  capHistory,
  MAX_STEPS,
  PER_CALL_TIMEOUT_MS,
  TURN_DEADLINE_MS,
  MAX_TOOL_CALLS_PER_STEP,
  HISTORY_MESSAGE_CAP,
  type ProviderCaller,
} from "../lib/assistant/loop";
import {
  countFollowUpsDueWithin,
  selectDueNow,
  selectRevisitsDue,
  getProspect,
  MAX_CLAIMS,
  MAX_CLAIM_CHARS,
} from "../lib/assistant/reads";
import {
  validatePayload,
  buildSummary,
  describePayload,
  MAX_PROPOSALS_PER_TURN,
  previousForCompare,
  type SetNextActionPayload,
} from "../lib/assistant/proposals";
import { executeProposal, isRedirectError, type EntryPoints } from "../lib/assistant/executors";
import { approveProposalCore, dismissProposalCore } from "../lib/assistant/decide";
import { handleAssistantTurn, MAX_USER_MESSAGE_CHARS } from "../lib/assistant/turn";
import { isMissingRelation } from "../lib/assistant/access";
import { newUsage } from "../lib/ai-runs";
import { buildOutcomeIndex, isClosedToWork, isRevisitDue, type ProspectOutcomeRow, type RevisitDispositionRow } from "../lib/prospect-outcomes";
import { computeHealthStatus } from "../lib/prospects";
import { totalForecastAmount, selectSupporterStewardshipQueue, type Supporter, type SupporterGift, type SupporterInteraction } from "../lib/supporters";
import type { ApprovedIntelligence } from "../lib/prospect-intelligence";
import { additiveViolations } from "./ledger-check";
import type { Ability, ToolContext } from "../lib/assistant/types";

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

// --- a small in-memory Supabase fake ----------------------------------------

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Err = { code?: string; message: string };
type LogEntry = { table: string; op: "select" | "insert" | "update" | "delete"; columns?: string; payload?: any; filters: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class FakeDb {
  tables: Record<string, Row[]> = {};
  log: LogEntry[] = [];
  insertErrors: Record<string, Err> = {};
  selectErrors: Record<string, Err> = {};
  updateErrors: Record<string, Err> = {};
  // Rows whose update affects zero rows (simulates a lost race / RLS filter).
  blockUpdate = new Set<string>();
  seq = 0;
  nowIso = "2026-10-13T12:00:00.000Z";

  uuid(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }
  seed(table: string, rows: Row[]) {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
  }
  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }
  from(table: string) {
    return new Query(this, table);
  }
  client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
  applyDefaults(table: string, p: Row): Row {
    const base: Row = { id: this.uuid(), created_at: `2026-10-13T12:00:${String(this.seq % 60).padStart(2, "0")}.000Z` };
    if (table === "assistant_threads") return { ...base, organization_id: ORG, created_by: USER, ...p };
    if (table === "assistant_messages")
      return {
        ...base,
        organization_id: ORG,
        created_by: USER,
        content: "",
        cards: [],
        response_model: null,
        stop_reason: null,
        input_tokens: null,
        output_tokens: null,
        error_note: null,
        finalized_at: null,
        provider: null,
        model: null,
        ...p,
      };
    if (table === "assistant_proposals")
      return {
        ...base,
        organization_id: ORG,
        created_by: USER,
        status: "pending",
        expires_at: new Date(Date.parse(this.nowIso) + 24 * 3600 * 1000).toISOString(),
        claimed_at: null,
        decided_at: null,
        result: null,
        error_note: null,
        ...p,
      };
    if (table === "ai_runs") return { ...base, organization_id: ORG, outcome: null, ended_at: null, model: null, input_tokens: null, output_tokens: null, error_note: null, ...p };
    return { ...base, ...p };
  }
}

class Query {
  private op: LogEntry["op"] = "select";
  private columns = "*";
  private filters: ((r: Row) => boolean)[] = [];
  private filterDesc: string[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private head = false;
  private wantCount = false;
  private payload: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  private mode: "many" | "single" | "maybe" = "many";
  private returning = false;

  constructor(private db: FakeDb, private table: string) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.columns = cols;
      this.head = !!opts?.head;
      this.wantCount = !!opts?.count;
    } else {
      this.returning = true;
      this.columns = cols;
    }
    return this;
  }
  insert(p: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.op = "insert";
    this.payload = p;
    return this;
  }
  update(p: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.op = "update";
    this.payload = p;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  private f(desc: string, fn: (r: Row) => boolean) {
    this.filters.push(fn);
    this.filterDesc.push(desc);
    return this;
  }
  eq(c: string, v: unknown) { return this.f(`eq ${c}`, (r) => r[c] === v); }
  neq(c: string, v: unknown) { return this.f(`neq ${c}`, (r) => r[c] !== v); }
  in(c: string, vs: unknown[]) { return this.f(`in ${c}`, (r) => vs.includes(r[c])); }
  is(c: string, v: null) { return this.f(`is ${c}`, (r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); }
  not(c: string, op: string, v: unknown) {
    return this.f(`not ${c} ${op}`, (r) => (op === "is" && v === null ? r[c] !== null && r[c] !== undefined : r[c] !== v));
  }
  gte(c: string, v: any) { return this.f(`gte ${c}`, (r) => r[c] >= v); } // eslint-disable-line @typescript-eslint/no-explicit-any
  lte(c: string, v: any) { return this.f(`lte ${c}`, (r) => r[c] <= v); } // eslint-disable-line @typescript-eslint/no-explicit-any
  gt(c: string, v: any) { return this.f(`gt ${c}`, (r) => r[c] > v); } // eslint-disable-line @typescript-eslint/no-explicit-any
  lt(c: string, v: any) { return this.f(`lt ${c}`, (r) => r[c] < v); } // eslint-disable-line @typescript-eslint/no-explicit-any
  order(col: string, o?: { ascending?: boolean }) {
    this.orderBy = { col, asc: o?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  returns() {
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }

  // A thenable, as the real query builder is: `await query` runs it.
  then(resolve?: (v: any) => unknown, reject?: (e: unknown) => unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return Promise.resolve(this.run()).then(resolve, reject);
  }

  private run(): { data: any; error: Err | null; count?: number | null } { // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = this.db;
    db.log.push({ table: this.table, op: this.op, columns: this.columns, payload: this.payload, filters: this.filterDesc });
    const t = (db.tables[this.table] ??= []);
    const match = () => t.filter((r) => this.filters.every((fn) => fn(r)));

    if (this.op === "select") {
      const err = db.selectErrors[this.table];
      if (err) return { data: null, error: err };
      let rows = match().map((r) => ({ ...r }));
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.rangeFrom !== null && this.rangeTo !== null) rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
      if (this.lim !== null) rows = rows.slice(0, this.lim);
      if (this.head) return { data: null, error: null, count: match().length };
      return this.shape(rows, this.wantCount ? match().length : null);
    }
    if (this.op === "insert") {
      const err = db.insertErrors[this.table];
      if (err) return { data: null, error: err };
      const list: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = list.map((p) => db.applyDefaults(this.table, p));
      t.push(...inserted);
      if (!this.returning) return { data: null, error: null };
      return this.shape(inserted.map((r) => ({ ...r })), null);
    }
    if (this.op === "update") {
      const err = db.updateErrors[this.table];
      if (err) return { data: null, error: err };
      const targets = match().filter((r) => !db.blockUpdate.has(`${this.table}:${r.id}`));
      for (const r of targets) Object.assign(r, this.payload);
      if (!this.returning) return { data: null, error: null };
      return this.shape(targets.map((r) => ({ ...r })), null);
    }
    const targets = match();
    db.tables[this.table] = t.filter((r) => !targets.includes(r));
    return { data: null, error: null };
  }

  private shape(rows: Row[], count: number | null) {
    if (this.mode === "single") {
      if (rows.length === 1) return { data: rows[0], error: null, count };
      return { data: null, error: { code: "PGRST116", message: "no single row" }, count };
    }
    if (this.mode === "maybe") return { data: rows[0] ?? null, error: null, count };
    return { data: rows, error: null, count };
  }
}

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

// A contaminated tenant: every table carries the columns an allowlist exists
// to keep away from the provider.
const SECRET = {
  prospectEmail: "funder.contact@secret-funder.example",
  prospectContact: "Pat Q. Contactperson",
  prospectNotes: "NOTES-SECRET: privately negotiated, do not share",
  supporterEmail: "donor.private@example.org",
  supporterPhone: "+1-555-0142-SECRET",
  supporterNotes: "SUPPORTER-NOTES-SECRET prefers no calls",
  interactionSummary: "INTERACTION-SUMMARY-SECRET discussed a gift",
  candidateEmail: "candidate.secret@example.org",
  candidateNotes: "CANDIDATE-NOTES-SECRET",
  pledgeAmount: 87654,
};

const P = {
  due: "10000000-0000-4000-8000-000000000001",
  overdue: "10000000-0000-4000-8000-000000000002",
  never: "10000000-0000-4000-8000-000000000003",
  revisit: "10000000-0000-4000-8000-000000000004",
  later: "10000000-0000-4000-8000-000000000005",
  quiet: "10000000-0000-4000-8000-000000000006",
  noaction: "10000000-0000-4000-8000-000000000007",
};
const S = {
  priority: "20000000-0000-4000-8000-000000000001",
  light: "20000000-0000-4000-8000-000000000002",
  fresh: "20000000-0000-4000-8000-000000000003",
};

function contaminatedDb(): FakeDb {
  const db = new FakeDb();
  const base = (id: string, name: string, extra: Row = {}): Row => ({
    id,
    name,
    channel: "foundation",
    stage: "outreach",
    ask_amount: 25000,
    next_action: null,
    next_action_due: null,
    contact_name: SECRET.prospectContact,
    contact_email: SECRET.prospectEmail,
    notes: SECRET.prospectNotes,
    website: "https://secret-funder.example",
    ein: "12-3456789",
    organization: "Secret Funder Org",
    ...extra,
  });
  db.seed("prospects", [
    base(P.due, "Due Soon Fund", { next_action: "Call the program officer", next_action_due: dayOffset(2) }),
    base(P.overdue, "Overdue Trust", { next_action: "Send the report", next_action_due: dayOffset(-10), stage: "proposal" }),
    base(P.never, "Closed Forever Foundation", { next_action: "Should not be offered", next_action_due: dayOffset(1) }),
    base(P.revisit, "Revisit Me Fund", { next_action: null, next_action_due: null, stage: "discovery" }),
    base(P.later, "Far Future Fund", { next_action: "Check in", next_action_due: dayOffset(20) }),
    base(P.quiet, "Gone Quiet Church", { stage: "stewardship", next_action: null }),
    base(P.noaction, "Plain Prospect", { channel: "major_donor", ask_amount: null }),
  ]);
  db.seed("prospect_outcomes", [
    { id: "o-never", prospect_id: P.never, outcome: "declined", reason: "REASON-SECRET too small", occurred_on: dayOffset(-30), recorded_by: USER, recorded_at: "2026-09-01T00:00:00Z" },
    { id: "o-revisit", prospect_id: P.revisit, outcome: "declined", reason: "REASON-SECRET timing", occurred_on: dayOffset(-60), recorded_by: USER, recorded_at: "2026-08-01T00:00:00Z" },
  ]);
  db.seed("prospect_outcome_dispositions", [
    { id: "d-never", prospect_outcome_id: "o-never", disposition: "never", revisit_on: null, reason: "x", decided_by: USER, decided_at: "2026-09-02T00:00:00Z" },
    { id: "d-revisit", prospect_outcome_id: "o-revisit", disposition: "revisit_on", revisit_on: dayOffset(-3), reason: "x", decided_by: USER, decided_at: "2026-08-02T00:00:00Z" },
  ]);
  db.seed("prospect_outcome_retractions", []);
  db.seed("interactions", [
    { id: "i1", prospect_id: P.quiet, kind: "call", summary: SECRET.interactionSummary, occurred_at: dayOffset(-90), created_by: USER, created_at: "2026-07-01T00:00:00Z" },
    { id: "i2", prospect_id: P.due, kind: "email", summary: SECRET.interactionSummary, occurred_at: dayOffset(-2), created_by: USER, created_at: "2026-10-11T00:00:00Z" },
  ]);
  db.seed("candidates", [
    { id: "c1", name: "Pending Candidate One", status: "pending", channel: "foundation", contact_email: SECRET.candidateEmail, notes: SECRET.candidateNotes, created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" },
    { id: "c2", name: "Pending Candidate Two", status: "pending", channel: "daf", contact_email: SECRET.candidateEmail, notes: SECRET.candidateNotes, created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" },
    { id: "c3", name: "Accepted Candidate", status: "accepted", channel: "church", contact_email: SECRET.candidateEmail, notes: SECRET.candidateNotes, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" },
  ]);
  db.seed("discovery_search_runs", [
    { id: "r1", channel: "foundation", status: "done", found_count: 3, status_message: "STATUS-SECRET", error_message: null, created_by: USER, created_at: "2026-10-10T00:00:00Z" },
    { id: "r2", channel: "daf", status: "error", found_count: null, status_message: "STATUS-SECRET", error_message: "ERR-SECRET", created_by: USER, created_at: "2026-10-09T00:00:00Z" },
  ]);
  db.seed("strategy_runs", [
    { id: "s1", prospect_id: P.due, status: "ready_for_review", approved_strategy: null, created_at: "2026-10-12T00:00:00Z" },
    { id: "s2", prospect_id: P.overdue, status: "ready_for_review", approved_strategy: { a: 1 }, created_at: "2026-10-11T00:00:00Z" },
  ]);
  const sup = (id: string, name: string, extra: Row = {}): Row => ({
    id,
    name,
    email: SECRET.supporterEmail,
    phone: SECRET.supporterPhone,
    notes: SECRET.supporterNotes,
    source_type: "event",
    source_detail: "SOURCE-DETAIL-SECRET",
    pledged_amount: SECRET.pledgeAmount,
    pledged_frequency: "annual",
    ...extra,
  });
  db.seed("supporters", [
    sup(S.priority, "Priority Supporter", { pledged_amount: 200, pledged_frequency: "monthly" }),
    sup(S.light, "Light Supporter", { pledged_amount: 100, pledged_frequency: "annual" }),
    sup(S.fresh, "Freshly Touched Supporter", { pledged_amount: 50, pledged_frequency: "monthly" }),
  ]);
  db.seed("supporter_gifts", [
    { id: "g1", supporter_id: S.priority, amount: 555.55, gift_date: dayOffset(-200), note: "GIFT-NOTE-SECRET", recorded_by: USER, created_at: "2026-01-01T00:00:00Z" },
    { id: "g2", supporter_id: S.fresh, amount: 20, gift_date: dayOffset(-5), note: "GIFT-NOTE-SECRET", recorded_by: USER, created_at: "2026-10-08T00:00:00Z" },
  ]);
  db.seed("supporter_interactions", [
    { id: "si1", supporter_id: S.light, kind: "call", summary: SECRET.interactionSummary, occurred_at: dayOffset(-400), created_by: USER, created_at: "2025-01-01T00:00:00Z" },
  ]);
  db.seed("profiles", [{ id: USER, organization_id: ORG }]);
  return db;
}

function ctxFor(db: FakeDb, over: Partial<ToolContext> = {}): ToolContext {
  return {
    supabase: db.client(),
    userId: USER,
    threadId: "30000000-0000-4000-8000-000000000001",
    messageId: "40000000-0000-4000-8000-000000000001",
    now: new Date(),
    proposalsCreated: 0,
    ...over,
  };
}

function leaks(text: string): string[] {
  return Object.values(SECRET)
    .map(String)
    .concat(["REASON-SECRET", "STATUS-SECRET", "ERR-SECRET", "SOURCE-DETAIL-SECRET", "GIFT-NOTE-SECRET"])
    .filter((s) => text.includes(s));
}

// --- fake provider helpers ---------------------------------------------------

function reply(opts: {
  content?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  usage?: { inputTokens: number; outputTokens: number } | null;
  model?: string | null;
}): ProviderCallResult {
  return {
    ok: true,
    result: {
      content: opts.content ?? "",
      toolCalls: (opts.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, argumentsRaw: c.args })),
      usage: opts.usage === undefined ? { inputTokens: 100, outputTokens: 10 } : opts.usage,
      model: opts.model === undefined ? "muse-spark-test" : opts.model,
      finishReason: "stop",
    },
  };
}
function failure(kind: "http" | "timeout" | "network" | "malformed", status?: number): ProviderCallResult {
  const messages = {
    http: `The model provider answered with an error (HTTP ${status}).`,
    timeout: "The model provider did not answer in time.",
    network: "The model provider could not be reached.",
    malformed: "The model provider's answer could not be read.",
  } as const;
  return { ok: false, error: { kind, status, message: messages[kind], detail: kind === "http" ? `HTTP ${status}: upstream said no` : `detail ${kind}` } };
}
type SeenCall = { messages: any[]; tools: { name: string }[]; timeoutMs: number }; // eslint-disable-line @typescript-eslint/no-explicit-any
function scripted(steps: (ProviderCallResult | ((req: SeenCall) => ProviderCallResult))[], loop = false) {
  const seen: SeenCall[] = [];
  let i = 0;
  const call: ProviderCaller = async (req, timeoutMs) => {
    seen.push({ messages: JSON.parse(JSON.stringify(req.messages)), tools: req.tools.map((t) => ({ name: t.name })), timeoutMs });
    const step = loop ? steps[Math.min(i, steps.length - 1)] : steps[i];
    i += 1;
    if (!step) throw new Error("scripted provider ran out of steps");
    return typeof step === "function" ? step(seen[seen.length - 1]) : step;
  };
  return { call, seen };
}

function fakeFetch(handler: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => { status?: number; body?: unknown; text?: string } | "hang" | Error) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init: { method: init.method, headers: init.headers, body: init.body } });
    const r = handler(url, init);
    if (r === "hang") {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    if (r instanceof Error) return Promise.reject(r);
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.body ?? {});
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
  };
  return { fetchImpl, calls };
}

// --- source helpers ----------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(root, p);
function read(p: string) {
  return readFileSync(join(root, p), "utf8");
}
// Comments are stripped before pattern scans so a header that DISCUSSES an
// import is not read as one.
function code(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

const ASSISTANT_LIB = readdirSync(join(root, "lib/assistant"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `lib/assistant/${f}`);
const ASSISTANT_SURFACE = [...ASSISTANT_LIB, "app/(dashboard)/assistant/page.tsx", "app/(dashboard)/assistant/assistant-thread.tsx", "app/(dashboard)/assistant/actions.ts", "app/api/assistant/turn/route.ts"];

async function main() {
  // =========================================================================
  section("1. the registry is closed, exact, and has no forbidden semantics");

  const EXPECTED_READS = ["get_dashboard_summary", "list_followups_due", "list_supporters_needing_stewardship", "search_prospects", "get_prospect", "list_recent_activity"];
  const EXPECTED_ACTS = ["propose_log_prospect_interaction", "propose_set_prospect_next_action", "propose_log_supporter_interaction"];
  ok(
    "the ability names are EXACTLY the ruled list (six reads, three act-on-approval)",
    JSON.stringify([...ABILITY_NAMES].sort()) === JSON.stringify([...EXPECTED_READS, ...EXPECTED_ACTS].sort()),
    ABILITY_NAMES.join(", ")
  );
  ok("no duplicate ability name", new Set(ABILITY_NAMES).size === ABILITY_NAMES.length);
  ok(
    "kinds are data on the entry: the six reads are 'read'",
    EXPECTED_READS.every((n) => findAbility(n)?.kind === "read")
  );
  ok(
    "kinds are data on the entry: the three proposals are 'act_on_approval'",
    EXPECTED_ACTS.every((n) => findAbility(n)?.kind === "act_on_approval")
  );
  ok(
    "no `prepare` ability and no research/strategy ability exists (deferred; see the report)",
    !ABILITIES.some((a) => (a.kind as string) === "prepare") && !ABILITY_NAMES.some((n) => /research|strategy/i.test(n))
  );
  ok(
    "every act_on_approval ability is named propose_*, and no read is",
    ABILITIES.filter((a) => a.kind === "act_on_approval").every((a) => a.name.startsWith("propose_")) &&
      ABILITIES.filter((a) => a.kind === "read").every((a) => !a.name.startsWith("propose_"))
  );

  const FORBIDDEN = /send|advance|approve|delete|remove|gift/i;
  const forbiddenHits = ABILITIES.filter((a) => FORBIDDEN.test(a.name) || FORBIDDEN.test(a.description) || FORBIDDEN.test(JSON.stringify(a.parameters)));
  ok(
    "no ability's name, description or parameter schema speaks of send, advance, approve, delete, remove or gift",
    forbiddenHits.length === 0,
    forbiddenHits.map((a) => a.name).join(", ")
  );
  ok(
    "no ability name implies a stage move, a claim or strategy decision, or a message (stage|claim|decide|draft|email_|message)",
    !ABILITY_NAMES.some((n) => /stage_|move|claim|decide|draft|message|outreach/i.test(n))
  );

  ok(
    "every parameter schema is a closed object (additionalProperties false)",
    ABILITIES.every((a) => a.parameters.type === "object" && a.parameters.additionalProperties === false)
  );
  const SENSITIVE_KEY = /(email|phone|notes?$|^notes?|summary|pledge|frequency|contact|connection|website|^ein$|reason|description)/i;
  const readsWithSensitive = ABILITIES.filter((a) => a.kind === "read").filter((a) => a.allowlist.some((k) => SENSITIVE_KEY.test(k)));
  ok(
    "no read's allowlist names an email, phone, note, summary, contact, connection, website, ein, reason or pledge field",
    readsWithSensitive.length === 0,
    readsWithSensitive.map((a) => `${a.name}: ${a.allowlist.filter((k) => SENSITIVE_KEY.test(k)).join(",")}`).join("; ")
  );
  ok(
    "get_prospect's claim projection is exactly four fields: claimKey, claim, reportingPeriod, humanDecided",
    ["claimKey", "claim", "reportingPeriod", "humanDecided"].every((k) => findAbility("get_prospect")!.allowlist.includes(k)) &&
      !findAbility("get_prospect")!.allowlist.some((k) => /limitation|advisory|override|sources|url/i.test(k))
  );

  // =========================================================================
  section("2. configuration: enablement is off unless an organization is listed");

  ok("absent ASSISTANT_ENABLED_ORG_IDS disables everyone", !isAssistantEnabledForOrg(ORG, {}) && !isAssistantEnabledAnywhere({}));
  ok("an empty value disables everyone", !isAssistantEnabledForOrg(ORG, { ASSISTANT_ENABLED_ORG_IDS: "" }) && !isAssistantEnabledAnywhere({ ASSISTANT_ENABLED_ORG_IDS: " , ," }));
  ok("a listed organization is enabled; an unlisted one is not", isAssistantEnabledForOrg(ORG, { ASSISTANT_ENABLED_ORG_IDS: `${ORG}, ${OTHER_ORG}` }) && !isAssistantEnabledForOrg("33333333-3333-4333-8333-333333333333", { ASSISTANT_ENABLED_ORG_IDS: ORG }));
  ok("matching is case-insensitive and tolerant of spaces", isAssistantEnabledForOrg(ORG.toUpperCase(), { ASSISTANT_ENABLED_ORG_IDS: `  ${ORG}  ` }));
  ok("a malformed entry is dropped, never a wildcard", parseEnabledOrgIds("*, all, true, 1").size === 0 && !isAssistantEnabledForOrg(ORG, { ASSISTANT_ENABLED_ORG_IDS: "*" }));
  ok("a null or missing organization is never enabled", !isAssistantEnabledForOrg(null, { ASSISTANT_ENABLED_ORG_IDS: ORG }) && !isAssistantEnabledForOrg(undefined, { ASSISTANT_ENABLED_ORG_IDS: ORG }));
  {
    const none = readProviderConfig({});
    ok("no MODEL_API_KEY: not configured, reason missing_key", !none.ok && none.reason === "missing_key");
    ok("a whitespace key is not a key", !readProviderConfig({ MODEL_API_KEY: "   " }).ok);
    const good = readProviderConfig({ MODEL_API_KEY: "k" });
    ok(
      "defaults: base URL https://api.meta.ai/v1 and model muse-spark-1.1",
      good.ok && good.config.baseUrl === DEFAULT_MODEL_BASE_URL && good.config.model === DEFAULT_ASSISTANT_MODEL && DEFAULT_MODEL_BASE_URL === "https://api.meta.ai/v1" && DEFAULT_ASSISTANT_MODEL === "muse-spark-1.1"
    );
    const over = readProviderConfig({ MODEL_API_KEY: "k", MODEL_API_BASE_URL: "https://proxy.example.com/v1/", ASSISTANT_MODEL: "muse-spark-9" });
    ok("environment overrides the model and base URL; a trailing slash is normalized", over.ok && over.config.model === "muse-spark-9" && over.config.baseUrl === "https://proxy.example.com/v1");
    ok("an empty override falls back to the default", (() => { const r = readProviderConfig({ MODEL_API_KEY: "k", MODEL_API_BASE_URL: "", ASSISTANT_MODEL: "" }); return r.ok && r.config.model === DEFAULT_ASSISTANT_MODEL && r.config.baseUrl === DEFAULT_MODEL_BASE_URL; })());
    ok("a non-https, non-loopback base URL is refused", !readProviderConfig({ MODEL_API_KEY: "k", MODEL_API_BASE_URL: "http://api.example.com/v1" }).ok && readProviderConfig({ MODEL_API_KEY: "k", MODEL_API_BASE_URL: "http://localhost:9999/v1" }).ok);
  }
  ok(
    "a missing relation is recognised by both Postgres (42P01) and PostgREST (PGRST205) codes, and by the schema-cache message",
    isMissingRelation({ code: "42P01", message: "relation \"assistant_threads\" does not exist" }) &&
      isMissingRelation({ code: "PGRST205", message: "Could not find the table 'public.assistant_threads' in the schema cache" }) &&
      isMissingRelation({ message: "Could not find the table 'public.assistant_threads' in the schema cache" }) &&
      !isMissingRelation({ code: "23505", message: "duplicate key" }) &&
      !isMissingRelation(null)
  );

  // =========================================================================
  section("3. the provider adapter, against a fake fetch");

  {
    const cfg = { apiKey: "test-key-123", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.1" };
    const tool = { name: "get_x", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false } };
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: {
        model: "muse-spark-1.1-2026",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_x", arguments: '{"a":1,"b":"two"}' } },
                { id: "call_2", type: "function", function: { name: "get_y", arguments: "" } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 321, completion_tokens: 45 },
      },
    }));
    const res = await callProvider(
      cfg,
      {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: null, tool_calls: [{ id: "c0", name: "get_x", argumentsRaw: '{"q":1}' }] },
          { role: "tool", tool_call_id: "c0", content: '{"ok":true}' },
        ],
        tools: [tool],
        maxTokens: 321,
      },
      { timeoutMs: 1000, fetchImpl }
    );
    const sent = calls[0];
    const body = JSON.parse(sent.init.body);
    ok("request goes to {base}/chat/completions by POST", sent.url === "https://api.meta.ai/v1/chat/completions" && sent.init.method === "POST");
    ok("Authorization is a Bearer of the configured key", sent.init.headers.Authorization === "Bearer test-key-123");
    ok("body carries the model and max_tokens", body.model === "muse-spark-1.1" && body.max_tokens === 321);
    ok(
      "tools are sent in the function shape {type, function:{name, description, parameters}}",
      Array.isArray(body.tools) && body.tools.length === 1 && body.tools[0].type === "function" && body.tools[0].function.name === "get_x" && body.tools[0].function.description === "d" && body.tools[0].function.parameters.type === "object"
    );
    ok(
      "an assistant tool-call message and a tool result are mapped to the wire shape (arguments stay a string, tool_call_id carried)",
      body.messages[2].role === "assistant" &&
        body.messages[2].tool_calls[0].type === "function" &&
        body.messages[2].tool_calls[0].function.arguments === '{"q":1}' &&
        body.messages[3].role === "tool" &&
        body.messages[3].tool_call_id === "c0"
    );
    ok("the API key is not in the body or the URL", !sent.init.body.includes("test-key-123") && !sent.url.includes("test-key-123"));
    ok(
      "response: usage maps prompt_tokens/completion_tokens to input/output, model and finish reason captured",
      res.ok && res.result.usage?.inputTokens === 321 && res.result.usage?.outputTokens === 45 && res.result.model === "muse-spark-1.1-2026" && res.result.finishReason === "tool_calls"
    );
    ok(
      "response: tool_calls are returned with their arguments as the raw JSON STRING, id and name preserved",
      res.ok && res.result.toolCalls.length === 2 && res.result.toolCalls[0].id === "call_1" && res.result.toolCalls[0].name === "get_x" && res.result.toolCalls[0].argumentsRaw === '{"a":1,"b":"two"}'
    );
    ok("response: null content becomes an empty string", res.ok && res.result.content === "");

    const noTools = buildRequest(cfg, { messages: [{ role: "user", content: "x" }], tools: [] });
    ok("with no tools offered the request carries no tools key", !("tools" in JSON.parse(noTools.body)));
  }
  {
    const cfg = { apiKey: "k", baseUrl: "https://api.meta.ai/v1", model: "m" };
    const input = { messages: [{ role: "user" as const, content: "x" }], tools: [] };
    const non2xx = await callProvider(cfg, input, { timeoutMs: 500, fetchImpl: fakeFetch(() => ({ status: 429, body: { error: { message: "rate limited" } } })).fetchImpl });
    ok("a non-2xx answer is an http error with its status, and a plain message", !non2xx.ok && non2xx.error.kind === "http" && non2xx.error.status === 429 && /HTTP 429/.test(non2xx.error.message) && /rate limited/.test(non2xx.error.detail));
    const t0 = Date.now();
    const slow = await callProvider(cfg, input, { timeoutMs: 40, fetchImpl: fakeFetch(() => "hang").fetchImpl });
    ok("a call that never answers is a timeout, and is cut at the per-call limit", !slow.ok && slow.error.kind === "timeout" && Date.now() - t0 < 1500);
    const net = await callProvider(cfg, input, { timeoutMs: 500, fetchImpl: fakeFetch(() => new Error("ECONNRESET")).fetchImpl });
    ok("a transport failure is a network error", !net.ok && net.error.kind === "network");
    const junk = await callProvider(cfg, input, { timeoutMs: 500, fetchImpl: fakeFetch(() => ({ text: "<html>gateway</html>" })).fetchImpl });
    ok("a non-JSON 200 is malformed", !junk.ok && junk.error.kind === "malformed");
    const nochoices = await callProvider(cfg, input, { timeoutMs: 500, fetchImpl: fakeFetch(() => ({ body: { choices: [] } })).fetchImpl });
    ok("a response with no choices is malformed", !nochoices.ok && nochoices.error.kind === "malformed");
    const nousage = await callProvider(cfg, input, { timeoutMs: 500, fetchImpl: fakeFetch(() => ({ body: { choices: [{ message: { content: "hi" } }] } })).fetchImpl });
    ok("no usage block and no model: both stay null -- not zero, not assumed", nousage.ok && nousage.result.usage === null && nousage.result.model === null && nousage.result.content === "hi");
    const objArgs = parseResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "a", function: { name: "n", arguments: { q: 1 } } }] } }] });
    ok("object-valued arguments are tolerated by re-serializing", objArgs.ok && objArgs.result.toolCalls[0].argumentsRaw === '{"q":1}');
    const parts = parseResponse({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] });
    ok("a parts-array content is joined", parts.ok && parts.result.content === "ab");
  }

  // =========================================================================
  section("4. argument validation and dispatch: untrusted input never reaches a handler");

  {
    const db = contaminatedDb();
    const ctx = ctxFor(db);
    const before = () => db.log.length;
    async function expectRefused(label: string, name: string, args: string, kind: string) {
      const n = before();
      const r = await dispatchToolCall({ name, argumentsRaw: args }, ctx);
      ok(`${label}: refused as ${kind}, no database call made`, !r.ok && r.errorKind === kind && db.log.length === n, `${JSON.stringify({ ok: r.ok, kind: r.errorKind, calls: db.log.length - n })}`);
      return r;
    }
    await expectRefused("an unknown tool name", "send_email", "{}", "unknown_tool");
    await expectRefused("a name that is not on the registry (prototype key)", "constructor", "{}", "unknown_tool");
    await expectRefused("argument text that is not JSON", "get_prospect", "{not json", "invalid_arguments");
    await expectRefused("arguments that are a JSON array", "get_prospect", "[1,2]", "invalid_arguments");
    await expectRefused("a bad uuid", "get_prospect", JSON.stringify({ prospect_id: "not-a-uuid" }), "validation");
    await expectRefused("an SQL-ish id", "get_prospect", JSON.stringify({ prospect_id: "' or 1=1 --" }), "validation");
    await expectRefused("a missing required argument", "get_prospect", "{}", "validation");
    await expectRefused("an argument the schema does not name", "get_prospect", JSON.stringify({ prospect_id: P.due, include_email: true }), "validation");
    await expectRefused("an over-long search string", "search_prospects", JSON.stringify({ query: "x".repeat(81) }), "validation");
    await expectRefused("an out-of-set stage", "search_prospects", JSON.stringify({ stage: "closed_won" }), "validation");
    await expectRefused("a limit above the cap", "search_prospects", JSON.stringify({ limit: 500 }), "validation");
    await expectRefused("a non-integer limit", "search_prospects", JSON.stringify({ limit: "ten" }), "validation");
    await expectRefused("a calendar-impossible date", "propose_log_prospect_interaction", JSON.stringify({ prospect_id: P.due, kind: "call", summary: "Spoke", occurred_at: "2026-02-31" }), "validation");
    await expectRefused("a non-ISO date", "propose_log_prospect_interaction", JSON.stringify({ prospect_id: P.due, kind: "call", summary: "Spoke", occurred_at: "13/10/2026" }), "validation");
    await expectRefused("a future interaction date", "propose_log_prospect_interaction", JSON.stringify({ prospect_id: P.due, kind: "call", summary: "Spoke", occurred_at: dayOffset(30) }), "validation");
    await expectRefused("an over-long summary", "propose_log_prospect_interaction", JSON.stringify({ prospect_id: P.due, kind: "call", summary: "s".repeat(1001), occurred_at: dayOffset(-1) }), "validation");
    await expectRefused("an empty summary", "propose_log_prospect_interaction", JSON.stringify({ prospect_id: P.due, kind: "call", summary: "   ", occurred_at: dayOffset(-1) }), "validation");
    await expectRefused("an unknown interaction kind", "propose_log_supporter_interaction", JSON.stringify({ supporter_id: S.light, kind: "gift", summary: "x", occurred_at: dayOffset(-1) }), "validation");
    await expectRefused("a control character in a string", "propose_set_prospect_next_action", JSON.stringify({ prospect_id: P.due, next_action: "do\u0000this" }), "validation");
    await expectRefused("an over-long next action", "propose_set_prospect_next_action", JSON.stringify({ prospect_id: P.due, next_action: "n".repeat(201) }), "validation");
    await expectRefused("a bad next-action date", "propose_set_prospect_next_action", JSON.stringify({ prospect_id: P.due, next_action: "Call", next_action_due: "tomorrow" }), "validation");
    ok("no proposal row was written by any refused call", db.rows("assistant_proposals").length === 0);
  }
  {
    // The allowlist is enforced at runtime, not only asserted.
    const fake: Ability = {
      name: "fake_read",
      kind: "read",
      description: "x",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      allowlist: ["rows", "name"],
      validate: () => ({ ok: true, value: {} }),
      handler: async () => ({
        ok: true,
        modelResult: { rows: [{ name: "A", email: "leak@example.com", nested: { phone: "555" } }], contact_email: "leak2@example.com", name: "ok" },
      }),
    };
    const r = await dispatchToolCall({ name: "fake_read", argumentsRaw: "{}" }, ctxFor(new FakeDb()), () => fake);
    const parsed = JSON.parse(r.toolMessage);
    ok(
      "the dispatcher strips any key not on the allowlist, at any depth, before the model sees it",
      r.ok && !r.toolMessage.includes("leak") && !r.toolMessage.includes("555") && parsed.rows[0].name === "A" && parsed.name === "ok",
      r.toolMessage
    );
    ok("the stripped keys are reported", r.strippedKeys.includes("email") && r.strippedKeys.includes("contact_email") && r.strippedKeys.includes("nested"));
    ok(
      "enforceAllowlist + collectKeys agree: after stripping, every key is on the list",
      [...collectKeys(enforceAllowlist({ a: 1, b: { c: 2, a: [{ d: 1, a: 1 }] } }, new Set(["a", "b", "c"]), []))].every((k) => ["a", "b", "c"].includes(k))
    );
    const big: Ability = { ...fake, name: "big_read", allowlist: ["x"], handler: async () => ({ ok: true, modelResult: { x: "y".repeat(MAX_TOOL_RESULT_CHARS + 10) } }) };
    const tooBig = await dispatchToolCall({ name: "big_read", argumentsRaw: "{}" }, ctxFor(new FakeDb()), () => big);
    ok("an over-large result is not handed to the model", !tooBig.ok && tooBig.errorKind === "result_too_large");
    const thrower: Ability = { ...fake, name: "throw_read", handler: async () => { throw new Error("DB-SECRET-DETAIL connection string"); } };
    const threw = await dispatchToolCall({ name: "throw_read", argumentsRaw: "{}" }, ctxFor(new FakeDb()), () => thrower);
    ok("a throwing handler becomes a generic error result that does not carry the exception text", !threw.ok && threw.errorKind === "handler_error" && !threw.toolMessage.includes("DB-SECRET-DETAIL"));
  }

  // =========================================================================
  section("5. reads: allowlists against contaminated fixtures, and equivalence with the pages");

  {
    const db = contaminatedDb();
    const ctx = ctxFor(db);
    const results: Record<string, { toolMessage: string; keys: Set<string>; card: unknown; stripped: string[] }> = {};
    const argsFor: Record<string, unknown> = {
      get_prospect: { prospect_id: P.due },
      search_prospects: {},
    };
    for (const name of EXPECTED_READS) {
      const r = await dispatchToolCall({ name, argumentsRaw: JSON.stringify(argsFor[name] ?? {}) }, ctx);
      ok(`${name}: returns a result`, r.ok, r.toolMessage);
      results[name] = { toolMessage: r.toolMessage, keys: collectKeys(JSON.parse(r.toolMessage)), card: r.card, stripped: r.strippedKeys };
    }
    for (const name of EXPECTED_READS) {
      const a = findAbility(name)!;
      const extra = [...results[name].keys].filter((k) => !a.allowlist.includes(k));
      ok(`${name}: every output key is on its declared allowlist`, extra.length === 0, extra.join(", "));
      ok(`${name}: the handler itself dropped everything -- the runtime stripper had nothing to do`, results[name].stripped.length === 0, results[name].stripped.join(", "));
      const model = leaks(results[name].toolMessage);
      const card = leaks(JSON.stringify(results[name].card));
      ok(`${name}: no email, phone, note, interaction text, reason or pledge amount in what the model sees`, model.length === 0, model.join(", "));
      ok(`${name}: ... nor in the card the client renders`, card.length === 0, card.join(", "));
    }

    // The projection at the query, independent of the stripper.
    const sensitiveCols = /\*|email|phone|notes|summary|note\b|reason|source_detail|contact|website|ein\b/i;
    const readTables = new Set(["prospects", "supporters", "supporter_gifts", "supporter_interactions", "interactions", "candidates", "discovery_search_runs", "strategy_runs"]);
    const bad = db.log.filter((l) => l.op === "select" && readTables.has(l.table) && sensitiveCols.test(l.columns ?? "*"));
    ok(
      "every read of a contact-bearing table names a column list with no contact, note or summary column and no `*`",
      bad.length === 0,
      bad.map((b) => `${b.table}(${b.columns})`).join("; ")
    );
    ok(
      "no handler in the registry ever writes (reads issue only selects)",
      db.log.every((l) => l.op === "select"),
      db.log.filter((l) => l.op !== "select").map((l) => `${l.op} ${l.table}`).join(", ")
    );

    // Figures: dashboard summary
    const dash = JSON.parse(results.get_dashboard_summary.toolMessage);
    ok("dashboard: opportunities pending counts only status=pending candidates (2)", dash.opportunitiesPending === 2);
    ok("dashboard: active prospects is every prospect (7)", dash.activeProspects === 7);
    ok("dashboard: follow-ups due in 7 days excludes the closed-to-work prospect and the far-future and overdue ones (1)", dash.followUpsDueNext7Days === 1, String(dash.followUpsDueNext7Days));
    ok("dashboard: strategies awaiting review counts only the unapproved latest run (1)", dash.strategiesAwaitingReview === 1);
    ok("dashboard: supporters is the count (3) and the forecast is the page's totalForecastAmount", dash.supporters === 3 && dash.supporterForecastAnnualAmount === totalForecastAmount(db.rows("supporters") as Supporter[]), JSON.stringify(dash));
    ok("dashboard: the forecast is an aggregate -- no individual pledge amount appears anywhere", !results.get_dashboard_summary.toolMessage.includes(String(SECRET.pledgeAmount)));
    ok("dashboard: pipeline total potential sums ask_amount (6 x 25000)", dash.pipelineTotalPotentialAmount === 150000);
    ok("dashboard: stage rows are labelled by the platform's own stage labels", Array.isArray(dash.pipelineByStage) && dash.pipelineByStage.length === 6 && dash.pipelineByStage[0].stage === "Discovery");

    // Follow-ups
    const fu = JSON.parse(results.list_followups_due.toolMessage);
    const dueIds = fu.dueNow.map((r: { prospectId: string }) => r.prospectId);
    ok("follow-ups: due-now lists the overdue and due-soon prospects, overdue first", JSON.stringify(dueIds) === JSON.stringify([P.overdue, P.due]), JSON.stringify(dueIds));
    ok("follow-ups: a prospect closed with `never` appears in no list, however its dates read", !results.list_followups_due.toolMessage.includes(P.never) && !results.list_followups_due.toolMessage.includes("Closed Forever"));
    ok("follow-ups: a declined funder whose revisit date has arrived is a revisit, not also a due-now row", fu.revisitsDue.length === 1 && fu.revisitsDue[0].prospectId === P.revisit && !dueIds.includes(P.revisit));
    ok("follow-ups: a stewardship prospect with no contact in 90 days has gone quiet, with the day count and no interaction text", fu.goneQuiet.length === 1 && fu.goneQuiet[0].prospectId === P.quiet && fu.goneQuiet[0].daysSinceLastTouch >= 89);
    ok("follow-ups: totals are true counts", fu.dueNowTotal === 2 && fu.revisitsDueTotal === 1 && fu.goneQuietTotal === 1);

    // Supporters
    const sq = JSON.parse(results.list_supporters_needing_stewardship.toolMessage);
    const direct = selectSupporterStewardshipQueue(
      db.rows("supporters") as unknown as Supporter[],
      groupBy(db.rows("supporter_gifts") as unknown as SupporterGift[], "supporter_id"),
      groupBy(db.rows("supporter_interactions") as unknown as SupporterInteraction[], "supporter_id"),
      ctx.now
    );
    ok(
      "supporters: the read is the platform's own stewardship queue (same members, same order) on full rows",
      JSON.stringify(sq.supporters.map((s: { supporterId: string }) => s.supporterId)) === JSON.stringify(direct.map((d) => d.supporter.id)),
      JSON.stringify(sq.supporters)
    );
    ok("supporters: each row is id, name, tier label, days quiet, threshold and nothing else", sq.supporters.every((s: Record<string, unknown>) => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(["daysSinceLastTouch", "name", "quietAfterDays", "supporterId", "tier"])));
    ok("supporters: a recently touched supporter is not listed", !sq.supporters.some((s: { supporterId: string }) => s.supporterId === S.fresh));
    ok("supporters: tier is a label, not a pledge", sq.supporters.every((s: { tier: string }) => ["Light", "Standard", "Priority"].includes(s.tier)));

    // Search and get_prospect
    const sp = JSON.parse(results.search_prospects.toolMessage);
    ok("search: returns id, name, channel and stage only, with the true total", sp.total === 7 && sp.prospects.every((p: Record<string, unknown>) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["channel", "name", "prospectId", "stage"])));
    const q = await dispatchToolCall({ name: "search_prospects", argumentsRaw: JSON.stringify({ query: "fund", stage: "outreach" }) }, ctx);
    const qp = JSON.parse(q.toolMessage);
    ok("search: name substring, stage filter and ordering are applied by code", qp.prospects.every((p: { name: string; stage: string }) => /fund/i.test(p.name) && p.stage === "Outreach") && qp.total >= 2);
    const gp = JSON.parse(results.get_prospect.toolMessage);
    ok(
      "get_prospect: id, name, channel, stage, ask amount, next action and due, health, outcome, research flag -- and nothing about contacts or notes",
      gp.prospectId === P.due && gp.name === "Due Soon Fund" && gp.channel === "Foundation & Family Trust" && gp.stage === "Outreach" && gp.askAmount === 25000 && gp.nextAction === "Call the program officer" && gp.health === "Due soon" && gp.outcome === null && gp.researchAvailable === false && Array.isArray(gp.researchClaims),
      JSON.stringify(gp)
    );
    const gn = JSON.parse((await dispatchToolCall({ name: "get_prospect", argumentsRaw: JSON.stringify({ prospect_id: P.never }) }, ctx)).toolMessage);
    ok("get_prospect: a recorded decline is shown as the platform's own disposition label", gn.outcome === "Declined · Never revisit", JSON.stringify(gn));
    const missing = await dispatchToolCall({ name: "get_prospect", argumentsRaw: JSON.stringify({ prospect_id: "99999999-9999-4999-8999-999999999999" }) }, ctx);
    ok("get_prospect: an id the session cannot see is 'not found' -- the same answer as an id that does not exist", !missing.ok && /No prospect/.test(missing.toolMessage));

    // Claim projection, with a stubbed loader
    const claimBase = { sources: [{ url: "https://src.example/x", title: "SOURCE-TITLE-SECRET" }], limitation: "LIMITATION-SECRET", humanOverride: true, overrideNote: "OVERRIDE-NOTE-SECRET" };
    const intel: ApprovedIntelligence = {
      researchRunId: "run-1",
      version: 1,
      confirmedEin: "12-3456789",
      withheld: [{ claimKey: "w", claim: "WITHHELD-SECRET", reason: "r" }],
      claims: [
        ...Array.from({ length: MAX_CLAIMS + 3 }, (_, i) => ({ claimId: `cl-${i}`, humanDecided: i % 2 === 0, claimKey: `k.${i}`, claim: `Claim ${i} ` + "z".repeat(i === 0 ? MAX_CLAIM_CHARS + 50 : 5), reportingPeriod: i === 1 ? "FY2024" : null, advisory: false, ...claimBase })),
        { claimId: "adv", humanDecided: false, claimKey: "k.adv", claim: "ADVISORY-CLAIM-SECRET", reportingPeriod: null, advisory: true, ...claimBase },
      ],
    };
    const gi = await getProspect(db.client(), { prospectId: P.due }, { loadIntelligence: async () => intel });
    ok("claims: get_prospect with research returns ok", gi.ok);
    if (gi.ok) {
      const text = JSON.stringify(gi.modelResult) + JSON.stringify(gi.card);
      const claims = gi.modelResult.researchClaims as Record<string, unknown>[];
      ok("claims: each is exactly {claimKey, claim, reportingPeriod, humanDecided}", claims.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["claim", "claimKey", "humanDecided", "reportingPeriod"])));
      ok(`claims: capped at ${MAX_CLAIMS}, and the omission is counted, not hidden`, claims.length === MAX_CLAIMS && gi.modelResult.researchClaimsOmitted === 3, `${claims.length} / ${gi.modelResult.researchClaimsOmitted}`);
      ok(`claims: text is clipped to ${MAX_CLAIM_CHARS} characters`, claims.every((c) => String(c.claim).length <= MAX_CLAIM_CHARS));
      ok("claims: sources, limitation, override notes, withheld claims and advisory (unconfirmed) context never reach the model or the card", !/SOURCE-TITLE-SECRET|src\.example|LIMITATION-SECRET|OVERRIDE-NOTE-SECRET|WITHHELD-SECRET|ADVISORY-CLAIM-SECRET|12-3456789/.test(text), text.slice(0, 300));
    }
    const gnone = await getProspect(db.client(), { prospectId: P.due }, { loadIntelligence: async () => null });
    ok("claims: an unresolved funder (loader returns nothing) is reported as no research, never an empty list read as 'checked'", gnone.ok && gnone.modelResult.researchAvailable === false);
  }

  // More rows than PostgREST returns in one page: the read must not stop at 1000.
  {
    const db = new FakeDb();
    db.seed(
      "supporters",
      Array.from({ length: 1250 }, (_, i) => ({ id: `50000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Bulk ${String(i).padStart(4, "0")}`, email: SECRET.supporterEmail, pledged_amount: null, pledged_frequency: null }))
    );
    const r = await dispatchToolCall({ name: "list_supporters_needing_stewardship", argumentsRaw: "{}" }, ctxFor(db));
    const parsed = JSON.parse(r.toolMessage);
    ok("a read pages past the 1000-row cap: all 1250 never-touched supporters are counted, and only the first 20 are shown", r.ok && parsed.total === 1250 && parsed.supporters.length === 20, `${parsed.total}/${parsed.supporters?.length}`);
    const pages = db.log.filter((l) => l.table === "supporters" && l.op === "select").length;
    ok("... by paging (two page reads), not by one unbounded select", pages === 2, String(pages));
  }

  // Read failure is "not evaluated", not zero.
  {
    const db = contaminatedDb();
    db.selectErrors["supporters"] = { code: "XX000", message: "boom" };
    const r = await dispatchToolCall({ name: "list_supporters_needing_stewardship", argumentsRaw: "{}" }, ctxFor(db));
    ok("a failed read is an error result, not an empty list the model would read as clean", !r.ok && /could not read/i.test(r.toolMessage));
  }

  // Equivalence with the pages (offline pins).
  {
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const outcomes: ProspectOutcomeRow[] = [
      { id: "o1", prospect_id: "p-never", outcome: "declined", reason: null, occurred_on: "2026-01-01", recorded_by: null, recorded_at: "2026-01-01T00:00:00Z" },
      { id: "o2", prospect_id: "p-rev-due", outcome: "declined", reason: null, occurred_on: "2026-01-01", recorded_by: null, recorded_at: "2026-01-01T00:00:00Z" },
      { id: "o3", prospect_id: "p-rev-future", outcome: "declined", reason: null, occurred_on: "2026-01-01", recorded_by: null, recorded_at: "2026-01-01T00:00:00Z" },
      { id: "o4", prospect_id: "p-undecided", outcome: "declined", reason: null, occurred_on: "2026-01-01", recorded_by: null, recorded_at: "2026-01-01T00:00:00Z" },
      { id: "o5", prospect_id: "p-retracted", outcome: "declined", reason: null, occurred_on: "2026-01-01", recorded_by: null, recorded_at: "2026-01-01T00:00:00Z" },
    ];
    const disp = (id: string, oid: string, d: string, on: string | null): RevisitDispositionRow => ({ id, prospect_outcome_id: oid, disposition: d, revisit_on: on, reason: null, decided_by: null, decided_at: "2026-01-02T00:00:00Z" });
    const dispositions = [disp("d1", "o1", "never", null), disp("d2", "o2", "revisit_on", dayOffset(-1)), disp("d3", "o3", "revisit_on", dayOffset(10)), disp("d5", "o5", "never", null)];
    const retractions = [{ id: "r5", prospect_outcome_id: "o5", note: null, retracted_by: null, retracted_at: "2026-01-03T00:00:00Z" }];
    const index = buildOutcomeIndex(outcomes, dispositions, retractions);
    const mk = (id: string, due: string | null) => ({ id, name: id, next_action: null, next_action_due: due });
    const all = [
      mk("p-never", dayOffset(1)),
      mk("p-rev-due", dayOffset(-2)),
      mk("p-rev-future", dayOffset(2)),
      mk("p-undecided", dayOffset(-4)),
      mk("p-retracted", dayOffset(0)),
      mk("p-plain-soon", dayOffset(3)),
      mk("p-plain-week", dayOffset(6)),
      mk("p-plain-later", dayOffset(30)),
      mk("p-plain-none", null),
      mk("p-plain-edge", dayOffset(7)),
    ];

    // The dashboard's inline logic, copied from app/(dashboard)/dashboard/page.tsx.
    const sevenDaysOut = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const pageDueThisWeek = all.filter((p) => p.next_action_due != null && p.next_action_due >= todayIso && p.next_action_due <= sevenDaysOut);
    const pageFollowUps = pageDueThisWeek.filter((p) => !isClosedToWork(index.get(p.id))).length;
    ok("dashboard pin: countFollowUpsDueWithin(7) equals the dashboard page's inline figure", countFollowUpsDueWithin(all, index, now, 7) === pageFollowUps, `${countFollowUpsDueWithin(all, index, now, 7)} vs ${pageFollowUps}`);

    // The follow-up page's inline logic, copied from app/(dashboard)/revisit/page.tsx.
    const offered = all.filter((p) => !isClosedToWork(index.get(p.id)));
    const dueAsRevisit = (p: { id: string }) => {
      const outcome = index.get(p.id);
      return outcome != null && isRevisitDue(outcome, todayIso);
    };
    const pageDueNow = offered.filter((p) => {
      if (dueAsRevisit(p)) return false;
      const h = computeHealthStatus(p.next_action_due);
      return h === "due_soon" || h === "stalled";
    });
    const pageDueRevisits = all.filter((p) => {
      const outcome = index.get(p.id);
      return outcome != null && isRevisitDue(outcome, todayIso);
    });
    ok(
      "follow-up page pin: selectDueNow returns the page's Due-now members",
      JSON.stringify(selectDueNow(all, index, todayIso).map((p) => p.id)) === JSON.stringify(pageDueNow.map((p) => p.id)),
      JSON.stringify(selectDueNow(all, index, todayIso).map((p) => p.id))
    );
    ok(
      "follow-up page pin: selectRevisitsDue returns the page's due revisits",
      JSON.stringify(selectRevisitsDue(all, index, todayIso).map((r) => r.prospect.id)) === JSON.stringify(pageDueRevisits.map((p) => p.id))
    );
    // The sidebar badge's inline logic, copied from app/(dashboard)/layout.tsx.
    const badge = all.filter((p) => {
      const outcome = index.get(p.id);
      if (isClosedToWork(outcome)) return false;
      if (outcome && isRevisitDue(outcome, todayIso)) return true;
      const h = computeHealthStatus(p.next_action_due);
      return h === "due_soon" || h === "stalled";
    }).length;
    ok(
      "sidebar badge pin: due-now plus due revisits equals the layout's badge count (each prospect counted once)",
      selectDueNow(all, index, todayIso).length + selectRevisitsDue(all, index, todayIso).length === badge,
      `${selectDueNow(all, index, todayIso).length}+${selectRevisitsDue(all, index, todayIso).length} vs ${badge}`
    );
    ok("a retracted `never` closes nothing (it is absent from the index), so that prospect is offered", !isClosedToWork(index.get("p-retracted")) && selectDueNow(all, index, todayIso).some((p) => p.id === "p-undecided"));

    // Drift detectors: the pages still contain the expressions mirrored above.
    const dash = read("app/(dashboard)/dashboard/page.tsx");
    const rev = read("app/(dashboard)/revisit/page.tsx");
    const lay = read("app/(dashboard)/layout.tsx");
    ok("drift: the dashboard page still computes the 7-day window as gte(today) / lte(today+7) and filters with isClosedToWork", /\.gte\("next_action_due", todayStr\)/.test(dash) && /\.lte\("next_action_due", sevenDaysOut\)/.test(dash) && /dueThisWeekProspects \?\? \[\]\)\.filter\(\(p\) => !isClosedToWork\(outcomeIndex\.get\(p\.id\)\)\)/.test(dash));
    ok("drift: the dashboard page still uses totalForecastAmount and countStrategiesReadyForReview", /totalForecastAmount\(supporters \?\? \[\]\)/.test(dash) && /countStrategiesReadyForReview\(supabase\)/.test(dash));
    ok("drift: the follow-up page still builds Due now from isClosedToWork, isRevisitDue and due_soon|stalled", /const offered = all\.filter\(\(p\) => !isClosedToWork\(outcomeIndex\.get\(p\.id\)\)\)/.test(rev) && /h === "due_soon" \|\| h === "stalled"/.test(rev) && /isRevisitDue\(outcome, todayIso\)/.test(rev) && /selectNurtureQueue\(all, interactionsByProspect, outcomeIndex, new Date\(\)\)/.test(rev));
    ok("drift: the layout badge still uses isClosedToWork, isRevisitDue and due_soon|stalled", /isClosedToWork\(outcome\)/.test(lay) && /isRevisitDue\(outcome, todayIso\)/.test(lay));
    ok("the assistant's reads call the platform's own functions rather than a second copy", (() => {
      const r = code("lib/assistant/reads.ts");
      return /countStrategiesReadyForReview\(supabase\)/.test(r) && /selectNurtureQueue\(/.test(r) && /selectSupporterStewardshipQueue\(/.test(r) && /totalForecastAmount\(/.test(r) && /loadOutcomeIndex\(supabase\)/.test(r) && /isClosedToWork\(/.test(r);
    })());
  }

  // =========================================================================
  section("6. proposals and executors");

  {
    const db = contaminatedDb();
    const ctx = ctxFor(db);
    const args = { prospect_id: P.due, kind: "call", summary: "Spoke with the program officer; they want a one-page summary.", occurred_at: dayOffset(-1) };
    const r = await dispatchToolCall({ name: "propose_log_prospect_interaction", argumentsRaw: JSON.stringify(args) }, ctx);
    ok("a valid interaction proposal is accepted and returns a pending proposal", r.ok && !!r.proposal && r.proposal.status === "pending");
    const row = db.rows("assistant_proposals")[0];
    ok("exactly one proposal row was written, pending, unclaimed", db.rows("assistant_proposals").length === 1 && row.status === "pending" && row.claimed_at === null);
    ok("the stored payload is exactly the validated arguments plus the code-read subject name", JSON.stringify(row.payload) === JSON.stringify({ prospect_id: P.due, subject_name: "Due Soon Fund", kind: "call", summary: args.summary, occurred_at: args.occurred_at }), JSON.stringify(row.payload));
    ok("the summary is built by code from the payload (not the model's text)", row.summary === buildSummary("log_prospect_interaction", row.payload) && /Due Soon Fund/.test(row.summary));
    ok("the proposal view's fields come from the stored payload", r.proposal!.fields.some((f) => f.label === "What happened" && f.value === args.summary) && JSON.stringify(r.proposal!.fields) === JSON.stringify(describePayload("log_prospect_interaction", row.payload)));
    ok("the subject is recorded as a prospect reference", row.subject_table === "prospects" && row.subject_id === P.due && row.action_key === "log_prospect_interaction");
    ok("the model is told nothing has changed and that the user must confirm", /Nothing has changed yet/.test(JSON.parse(r.toolMessage).note) && /must confirm/.test(JSON.parse(r.toolMessage).note) && JSON.parse(r.toolMessage).status === "pending");
    ok("no write to prospects, supporters or interactions happened", db.log.every((l) => l.op === "select" || l.table === "assistant_proposals"));

    const na = await dispatchToolCall({ name: "propose_set_prospect_next_action", argumentsRaw: JSON.stringify({ prospect_id: P.due, next_action: "Send the one-pager", next_action_due: dayOffset(5) }) }, ctx);
    const naRow = db.rows("assistant_proposals")[1];
    ok("a next-action proposal carries the PREVIOUS value, read from the database by code", na.ok && (naRow.payload as SetNextActionPayload).previous.next_action === "Call the program officer" && (naRow.payload as SetNextActionPayload).previous.next_action_due === dayOffset(2), JSON.stringify(naRow?.payload));
    const sp = await dispatchToolCall({ name: "propose_log_supporter_interaction", argumentsRaw: JSON.stringify({ supporter_id: S.light, kind: "note", summary: "Sent a thank-you note.", occurred_at: dayOffset(0) }) }, ctx);
    ok("a supporter interaction proposal targets the supporters table", sp.ok && db.rows("assistant_proposals")[2].subject_table === "supporters" && db.rows("assistant_proposals")[2].action_key === "log_supporter_interaction");
    const fourth = await dispatchToolCall({ name: "propose_log_prospect_interaction", argumentsRaw: JSON.stringify(args) }, ctx);
    ok(`at most ${MAX_PROPOSALS_PER_TURN} proposals per turn, enforced in code`, !fourth.ok && db.rows("assistant_proposals").length === MAX_PROPOSALS_PER_TURN);

    const ghost = await dispatchToolCall({ name: "propose_log_prospect_interaction", argumentsRaw: JSON.stringify({ ...args, prospect_id: "99999999-9999-4999-8999-999999999999" }) }, ctxFor(db));
    ok("a subject the session cannot see is 'not found' and nothing is stored", !ghost.ok && /No prospect/.test(ghost.toolMessage) && db.rows("assistant_proposals").length === MAX_PROPOSALS_PER_TURN);
    const dbErr = contaminatedDb();
    dbErr.insertErrors["assistant_proposals"] = { code: "42501", message: "RLS-DETAIL-SECRET" };
    const failed = await dispatchToolCall({ name: "propose_log_prospect_interaction", argumentsRaw: JSON.stringify(args) }, ctxFor(dbErr));
    ok("a failed proposal insert is an error result and leaks no database text", !failed.ok && !failed.toolMessage.includes("RLS-DETAIL-SECRET"));
  }
  {
    // The stored payload is re-validated by the executor before any write.
    const calls: string[] = [];
    const eps: EntryPoints = {
      logInteraction: async (...a) => { calls.push(`logInteraction:${JSON.stringify(a)}`); },
      updateNextAction: async (...a) => { calls.push(`updateNextAction:${JSON.stringify(a)}`); },
      logSupporterInteraction: async (...a) => { calls.push(`logSupporterInteraction:${JSON.stringify(a)}`); },
    };
    const now = new Date();
    const good = { prospect_id: P.due, subject_name: "Due Soon Fund", kind: "call", summary: "Spoke.", occurred_at: dayOffset(-1) };
    const r1 = await executeProposal("log_prospect_interaction", good, now, eps);
    ok("an interaction executes through logInteraction with exactly the stored fields", r1.ok && calls[0] === `logInteraction:${JSON.stringify([P.due, "call", "Spoke.", dayOffset(-1)])}`, calls[0]);
    const next: SetNextActionPayload = { prospect_id: P.due, subject_name: "Due Soon Fund", next_action: "Send it", next_action_due: null, previous: { next_action: null, next_action_due: null } };
    const r2 = await executeProposal("set_prospect_next_action", next, now, eps);
    ok("a next action executes through updateNextAction; no due date is passed as the empty string the entry point expects", r2.ok && calls[1] === `updateNextAction:${JSON.stringify([P.due, "Send it", ""])}`, calls[1]);
    const r3 = await executeProposal("log_supporter_interaction", { supporter_id: S.light, subject_name: "Light Supporter", kind: "email", summary: "Thanks.", occurred_at: dayOffset(0) }, now, eps);
    ok("a supporter interaction executes through logSupporterInteraction", r3.ok && calls[2].startsWith("logSupporterInteraction:"));
    const n = calls.length;
    const bad1 = await executeProposal("log_prospect_interaction", { ...good, kind: "gift" }, now, eps);
    const bad2 = await executeProposal("log_prospect_interaction", { ...good, extra: 1 }, now, eps);
    const bad3 = await executeProposal("set_prospect_stage", { prospect_id: P.due }, now, eps);
    const bad4 = await executeProposal("log_prospect_interaction", "not an object", now, eps);
    ok("a stored payload that no longer validates (bad kind, extra key, unknown action, wrong type) is refused with NO write", !bad1.ok && !bad2.ok && !bad3.ok && !bad4.ok && calls.length === n);
    const thrower: EntryPoints = { ...eps, logInteraction: async () => { throw new Error("insert failed: permission denied"); } };
    const r4 = await executeProposal("log_prospect_interaction", good, now, thrower);
    ok("an entry point that throws becomes a returned failure carrying its message", !r4.ok && /permission denied/.test(r4.error));
    const redirecting: EntryPoints = { ...eps, logInteraction: async () => { throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }); } };
    const r5 = await executeProposal("log_prospect_interaction", good, now, redirecting);
    ok("redirect() (a thrown NEXT_REDIRECT) is handled as a plain failure, not an unhandled throw", !r5.ok && /signed in/i.test(r5.error) && isRedirectError(new Error("x")) === false);
    const sameVal = previousForCompare("x".repeat(3000));
    ok("the stale comparison value is bounded the same way on both sides", sameVal !== null && sameVal.length === 2000 && previousForCompare(null) === null);
  }
  {
    const p = validatePayload("log_prospect_interaction", { prospect_id: P.due, subject_name: "A", kind: "call", summary: "s", occurred_at: "2026-02-30" }, new Date());
    ok("payload validation uses the same calendar-date rule as argument validation", !p.ok);
  }

  // =========================================================================
  section("7. the bounded loop, with a fake provider");

  function loopInput(db: FakeDb, call: ProviderCaller, extra: Partial<Parameters<typeof runAssistantLoop>[0]> = {}) {
    return { aiRunId: "run-1", system: "SYSTEM", history: [{ role: "user" as const, content: "What's going on?" }], ctx: ctxFor(db), usage: newUsage(), call, ...extra };
  }
  {
    const db = contaminatedDb();
    const { call, seen } = scripted([
      reply({ toolCalls: [{ id: "t1", name: "get_dashboard_summary", args: "{}" }], usage: { inputTokens: 100, outputTokens: 10 } }),
      reply({ content: "You have 2 opportunities waiting.", usage: { inputTokens: 150, outputTokens: 20 } }),
    ]);
    const usage = newUsage();
    const out = await runAssistantLoop(loopInput(db, call, { usage }));
    ok("a two-step turn answers, and completes", out.outcome === "completed" && out.stopReason === "answered" && out.stepsUsed === 2 && out.content === "You have 2 opportunities waiting.");
    ok("the card was rendered by code from the tool result", out.cards.length === 1 && out.cards[0].kind === "facts" && JSON.stringify(out.cards[0]).includes("New opportunities waiting"));
    ok("tokens aggregate across both calls (one run, summed), model from the response", usage.inputTokens === 250 && usage.outputTokens === 30 && usage.model === "muse-spark-test");
    ok("the second request carries the tool result as a `tool` message holding the allowlisted JSON", (() => {
      const toolMsg = seen[1].messages.find((m) => m.role === "tool");
      return !!toolMsg && toolMsg.tool_call_id === "t1" && JSON.parse(toolMsg.content).activeProspects === 7 && leaks(toolMsg.content).length === 0;
    })());
    ok("tools are offered on the first call", seen[0].tools.length === ABILITIES.length);
    ok("the system prompt is first and the history follows", seen[0].messages[0].role === "system" && seen[0].messages[0].content === "SYSTEM" && seen[0].messages[1].content === "What's going on?");
  }
  {
    const db = contaminatedDb();
    const { call, seen } = scripted([reply({ toolCalls: [{ id: "t", name: "get_dashboard_summary", args: "{}" }] })], true);
    const out = await runAssistantLoop(loopInput(db, call, { limits: { maxSteps: 3 } }));
    ok("a model that never stops calling tools is stopped at the step cap", out.stopReason === "step_cap" && out.stepsUsed === 3 && seen.length === 3);
    ok("the last step offers NO tools, so the model must answer in text", seen[2].tools.length === 0 && seen[0].tools.length > 0 && seen[1].tools.length > 0);
    ok("a capped turn finalizes with what it has and says so in a platform notice", out.cards[out.cards.length - 1].kind === "notice" && /step limit/.test(JSON.stringify(out.cards[out.cards.length - 1])) && out.outcome === "completed" && /step limit/.test(out.errorNote ?? ""));
    ok("the ledger-bound constants are named and finite", MAX_STEPS === 5 && PER_CALL_TIMEOUT_MS === 30_000 && TURN_DEADLINE_MS === 120_000);
  }
  {
    // Even if a model ignores "no tools" on the last step, nothing runs.
    const db = contaminatedDb();
    const { call } = scripted([reply({ toolCalls: [{ id: "t", name: "get_dashboard_summary", args: "{}" }] })], true);
    const out = await runAssistantLoop(loopInput(db, call, { limits: { maxSteps: 1 } }));
    ok("with one step and a tool request, the tool is not executed and the turn ends at the cap", out.stopReason === "step_cap" && out.toolCalls === 0 && db.log.length === 0);
  }
  {
    const db = contaminatedDb();
    let t = 0;
    const clock = () => t;
    const { call, seen } = scripted([
      (req) => { void req; t += 70_000; return reply({ toolCalls: [{ id: "t", name: "get_dashboard_summary", args: "{}" }] }); },
      (req) => { void req; t += 70_000; return reply({ toolCalls: [{ id: "t2", name: "get_dashboard_summary", args: "{}" }] }); },
      reply({ content: "should never be asked" }),
    ]);
    const out = await runAssistantLoop(loopInput(db, call, { clock }));
    ok("past the wall-clock deadline no new model call is started", out.stopReason === "deadline" && seen.length === 2, `${out.stopReason}, ${seen.length} calls`);
    ok("a deadline stop says so and keeps what was retrieved", out.cards.some((c) => c.kind === "notice" && /time limit/.test(c.text)) && out.cards.filter((c) => c.kind === "facts").length === 2);
    ok("each call's timeout is capped by the time left", seen[0].timeoutMs === 30_000 && seen[1].timeoutMs === 30_000);
  }
  {
    const db = contaminatedDb();
    const { call, seen } = scripted([
      reply({ toolCalls: [{ id: "bad", name: "get_prospect", args: '{"prospect_id": ' }] }),
      reply({ content: "I could not look that up." }),
    ]);
    const out = await runAssistantLoop(loopInput(db, call));
    const toolMsg = seen[1].messages.find((m) => m.role === "tool");
    ok("malformed arguments are returned to the model as an error, never executed, and the turn goes on", out.stopReason === "answered" && out.toolErrors === 1 && JSON.parse(toolMsg.content).error && db.log.length === 0);
  }
  {
    const db = contaminatedDb();
    const { call, seen } = scripted([
      reply({ toolCalls: [{ id: "u", name: "send_email_to_funder", args: '{"to":"a@b.c"}' }] }),
      reply({ content: "I cannot send email." }),
    ]);
    const out = await runAssistantLoop(loopInput(db, call));
    const toolMsg = seen[1].messages.find((m) => m.role === "tool");
    ok("an unknown tool name is an error result, never executed", out.toolErrors === 1 && /no tool named/.test(JSON.parse(toolMsg.content).error) && db.log.length === 0 && out.stepsUsed === 2);
  }
  {
    const db = contaminatedDb();
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_STEP + 2 }, (_, i) => ({ id: `c${i}`, name: "get_dashboard_summary", args: "{}" }));
    const { call } = scripted([reply({ toolCalls: calls }), reply({ content: "done" })]);
    const out = await runAssistantLoop(loopInput(db, call));
    ok(`only ${MAX_TOOL_CALLS_PER_STEP} tool calls are run per step; the rest are refused`, out.toolCalls === MAX_TOOL_CALLS_PER_STEP && out.toolErrors === 2);
  }
  {
    const db = contaminatedDb();
    const http = await runAssistantLoop(loopInput(db, scripted([failure("http", 503)]).call));
    ok("a provider non-2xx ends the turn as failed with a plain note and no content", http.outcome === "failed" && http.stopReason === "provider_error" && /provider answered with an error/.test(http.errorNote ?? "") && http.providerError?.kind === "http");
    const to = await runAssistantLoop(loopInput(db, scripted([failure("timeout")]).call));
    ok("a provider timeout ends the turn as failed", to.outcome === "failed" && to.providerError?.kind === "timeout");
    const midway = await runAssistantLoop(loopInput(db, scripted([reply({ toolCalls: [{ id: "t", name: "get_dashboard_summary", args: "{}" }] }), failure("network")]).call));
    ok("a failure after a tool ran still returns the card it produced", midway.outcome === "failed" && midway.cards.length === 1);
    const empty = await runAssistantLoop(loopInput(db, scripted([reply({ content: "   " })]).call));
    ok("an answer with no text and nothing retrieved is `empty`, not `completed`", empty.outcome === "empty" && empty.stopReason === "answered");
    let threw = false;
    try {
      await runAssistantLoop({ ...loopInput(db, scripted([reply({ content: "x" })]).call), aiRunId: "" });
    } catch {
      threw = true;
    }
    ok("the loop will not run without the turn's ledger row (ruling 0026 clause 1)", threw);
    const noUsage = newUsage();
    await runAssistantLoop(loopInput(db, scripted([reply({ content: "x", usage: null, model: null })]).call, { usage: noUsage }));
    ok("a response with no usage block leaves the ledger figures null, not zero", noUsage.inputTokens === null && noUsage.outputTokens === null && noUsage.model === null);
  }
  {
    const long = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", content: `m${i}` }));
    const capped = capHistory(long);
    ok(`history is capped at the last ${HISTORY_MESSAGE_CAP} text messages, newest kept`, capped.length === HISTORY_MESSAGE_CAP && capped[capped.length - 1].content === "m29" && capped[0].content === "m18");
    ok("empty messages are not resent", capHistory([{ role: "user", content: " " }, { role: "assistant", content: "x" }]).length === 1);
  }

  // =========================================================================
  section("8. the turn: refusals come before any birth; one finalize per run and per message");

  const ENV_ON = { MODEL_API_KEY: "k", ASSISTANT_ENABLED_ORG_IDS: ORG };
  const turnDb = () => {
    const db = contaminatedDb();
    return db;
  };
  const writes = (db: FakeDb) => db.log.filter((l) => l.op === "insert" || l.op === "update");
  {
    const db = turnDb();
    const { call } = scripted([reply({ content: "x" })]);
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "hello" }, { env: { MODEL_API_KEY: "k", ASSISTANT_ENABLED_ORG_IDS: OTHER_ORG }, call });
    ok("a disabled organization is refused (403) before anything is written", r.status === 403 && r.body.code === "not_enabled" && writes(db).length === 0);
  }
  {
    const db = turnDb();
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "hello" }, { env: { ASSISTANT_ENABLED_ORG_IDS: ORG } });
    ok("a missing key is refused (503) before anything is written, and no ledger row exists", r.status === 503 && r.body.code === "not_configured" && writes(db).length === 0 && db.rows("ai_runs").length === 0);
  }
  {
    const db = turnDb();
    const none = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "hello" }, { env: {} });
    ok("with no enablement list at all the answer is the same refusal, with no profile lookup needed", none.status === 403 && writes(db).length === 0);
    const long = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "x".repeat(MAX_USER_MESSAGE_CHARS + 1) }, { env: ENV_ON });
    const blank = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "   " }, { env: ENV_ON });
    const num = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: 5 }, { env: ENV_ON });
    const badThread = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "hi", threadId: "nope" }, { env: ENV_ON });
    ok("an over-long, blank, non-text message or bad thread id is refused (400) before anything is written", [long, blank, num, badThread].every((r) => r.status === 400) && writes(db).length === 0);
  }
  {
    const db = turnDb();
    db.insertErrors["assistant_threads"] = { code: "PGRST205", message: "Could not find the table 'public.assistant_threads' in the schema cache" };
    const { call, seen } = scripted([reply({ content: "x" })]);
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "hello" }, { env: ENV_ON, call });
    ok("tables absent (PGRST205): a plain 'setup pending' answer naming migration 0080, no run born, no model called", r.status === 503 && r.body.code === "setup_pending" && /0080/.test(String(r.body.error)) && db.rows("ai_runs").length === 0 && seen.length === 0);
    const db2 = turnDb();
    db2.selectErrors["assistant_threads"] = { code: "42P01", message: 'relation "assistant_threads" does not exist' };
    const r2 = await handleAssistantTurn({ supabase: db2.client(), userId: USER, message: "hello", threadId: "30000000-0000-4000-8000-0000000000aa" }, { env: ENV_ON, call });
    ok("tables absent (42P01) on an existing thread id: the same plain answer", r2.status === 503 && r2.body.code === "setup_pending" && seen.length === 0);
  }
  {
    // A full successful turn: ordering and finalization counts.
    const db = turnDb();
    const { call, seen } = scripted([
      reply({ toolCalls: [{ id: "t1", name: "get_dashboard_summary", args: "{}" }], usage: { inputTokens: 100, outputTokens: 10 } }),
      reply({ content: "Here is where things stand.", usage: { inputTokens: 200, outputTokens: 30 } }),
    ]);
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "What's going on?" }, { env: ENV_ON, call });
    ok("a normal turn returns 200 with the message, its cards and no failure", r.status === 200 && r.body.ok === true && (r.body.cards as unknown[]).length === 1);
    const order = db.log.filter((l) => (l.table === "assistant_messages" || l.table === "ai_runs" || l.table === "assistant_threads") && l.op !== "select").map((l) => `${l.op}:${l.table}:${l.payload?.role ?? l.payload?.operation ?? l.payload?.outcome ?? l.payload?.status ?? ""}`);
    ok(
      "write order: thread, user message, assistant message (running), run birth, run finalize, message finalize",
      JSON.stringify(order) === JSON.stringify(["insert:assistant_threads:", "insert:assistant_messages:user", "insert:assistant_messages:assistant", "insert:ai_runs:assistant_turn", "update:ai_runs:completed", "update:assistant_messages:completed"]),
      JSON.stringify(order)
    );
    const msgRow = db.rows("assistant_messages").find((m) => m.role === "assistant")!;
    const born = db.log.find((l) => l.table === "assistant_messages" && l.op === "insert" && l.payload.role === "assistant")!;
    ok("the assistant row was born running and NAMING the provider and the model before the model was called", born.payload.status === "running" && born.payload.provider === PROVIDER_ID && born.payload.model === "muse-spark-1.1" && PROVIDER_ID === "meta-model-api");
    const run = db.rows("ai_runs")[0];
    ok("the run row is born pointing at the assistant message (source_table, source_id)", run.operation === "assistant_turn" && run.source_table === "assistant_messages" && run.source_id === msgRow.id);
    ok("exactly one run finalization and exactly one message finalization", db.log.filter((l) => l.table === "ai_runs" && l.op === "update").length === 1 && db.log.filter((l) => l.table === "assistant_messages" && l.op === "update").length === 1);
    ok("the run was finalized completed with aggregated captured tokens and the response's model", run.outcome === "completed" && run.input_tokens === 300 && run.output_tokens === 40 && run.model === "muse-spark-test");
    ok("the message row was finalized once with content, cards and tokens", msgRow.status === "completed" && msgRow.content === "Here is where things stand." && msgRow.cards.length === 1 && msgRow.input_tokens === 300 && msgRow.finalized_at !== null);
    ok("the model saw the history (the user's message) and was called twice", seen.length === 2 && seen[0].messages.some((m) => m.role === "user" && m.content === "What's going on?"));
  }
  {
    const db = turnDb();
    db.insertErrors["ai_runs"] = { code: "42501", message: "ledger down" };
    const { call, seen } = scripted([reply({ content: "must not be asked" })]);
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "hello" }, { env: ENV_ON, call });
    const msgRow = db.rows("assistant_messages").find((m) => m.role === "assistant")!;
    ok("a ledger birth failure means NO model call, a failed message row, and a plain refusal", r.status === 500 && r.body.code === "ledger_unavailable" && seen.length === 0 && msgRow.status === "failed");
  }
  {
    const db = turnDb();
    const { call } = scripted([failure("http", 500)]);
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "hello" }, { env: ENV_ON, call });
    const run = db.rows("ai_runs")[0];
    const msgRow = db.rows("assistant_messages").find((m) => m.role === "assistant")!;
    ok("a provider failure finalizes the run failed with a plain note, exactly once", r.status === 502 && r.body.code === "provider_error" && run.outcome === "failed" && /HTTP 500/.test(run.error_note) && db.log.filter((l) => l.table === "ai_runs" && l.op === "update").length === 1);
    ok("... and the message failed, exactly once, with null (not zero) token counts", msgRow.status === "failed" && db.log.filter((l) => l.table === "assistant_messages" && l.op === "update").length === 1 && run.input_tokens === null);
    ok("... and the client's error is plain, without the provider's own detail", !/HTTP 500: /.test(String(r.body.error)) && /Try again/.test(String(r.body.error)));
  }
  {
    const db = turnDb();
    const { call } = scripted([reply({ toolCalls: [{ id: "t", name: "get_dashboard_summary", args: "{}" }] })], true);
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "loop" }, { env: ENV_ON, call, limits: { maxSteps: 2 } });
    const run = db.rows("ai_runs")[0];
    ok("a capped turn is finalized once, completed, with the stop named", r.status === 200 && run.outcome === "completed" && /step limit/.test(run.error_note) && db.log.filter((l) => l.table === "ai_runs" && l.op === "update").length === 1);
  }
  {
    const db = turnDb();
    const { call } = scripted([reply({ toolCalls: [{ id: "p", name: "propose_log_prospect_interaction", args: JSON.stringify({ prospect_id: P.due, kind: "call", summary: "Spoke.", occurred_at: dayOffset(-1) }) }] }), reply({ content: "I have proposed that for you to confirm." })]);
    const r = await handleAssistantTurn({ supabase: db.client(), userId: USER, message: "log a call with Due Soon Fund yesterday" }, { env: ENV_ON, call });
    const prop = db.rows("assistant_proposals")[0];
    const asst = db.rows("assistant_messages").find((m) => m.role === "assistant")!;
    ok("a proposal made in a turn points at the assistant message born for that turn, and is pending", r.status === 200 && prop.message_id === asst.id && prop.status === "pending" && (r.body.proposals as unknown[]).length === 1);
    ok("the turn changed nothing but its own records (no prospect, supporter or interaction write)", db.log.filter((l) => l.op !== "select").every((l) => ["assistant_threads", "assistant_messages", "assistant_proposals", "ai_runs"].includes(l.table)));
  }

  // =========================================================================
  section("9. approve and dismiss, against a fake client");

  function proposalDb(over: Row = {}, payload?: Row) {
    const db = contaminatedDb();
    const row = db.applyDefaults("assistant_proposals", {
      thread_id: "30000000-0000-4000-8000-000000000001",
      message_id: "40000000-0000-4000-8000-000000000001",
      action_key: "log_prospect_interaction",
      payload: payload ?? { prospect_id: P.due, subject_name: "Due Soon Fund", kind: "call", summary: "Spoke.", occurred_at: dayOffset(-1) },
      subject_table: "prospects",
      subject_id: P.due,
      summary: "Log a call on prospect \"Due Soon Fund\"",
      ...over,
    });
    db.seed("assistant_proposals", [row]);
    return { db, id: row.id as string };
  }
  const NOW = new Date(Date.parse("2026-10-13T12:00:00.000Z"));
  const okExec = (log: string[]) => async (actionKey: string, payload: unknown) => {
    log.push(`${actionKey}:${JSON.stringify(payload)}`);
    return { ok: true as const, result: { entryPoint: "stub" } };
  };
  {
    const { db, id } = proposalDb();
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    const row = db.rows("assistant_proposals")[0];
    ok("approve: a pending, unexpired, own proposal executes once with exactly the stored payload and ends `executed`", "success" in r && row.status === "executed" && log.length === 1 && log[0] === `log_prospect_interaction:${JSON.stringify(row.payload)}`);
    ok("approve: claimed_at and decided_at are both set, the result recorded", row.claimed_at !== null && row.decided_at !== null && row.result?.entryPoint === "stub");
    const again = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    ok("approve: a second approval is refused and does not execute again", "error" in again && log.length === 1);
  }
  {
    const { db, id } = proposalDb();
    const log: string[] = [];
    // Two concurrent requests: the claim is the arbiter.
    const [a, b] = await Promise.all([
      approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) }),
      approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) }),
    ]);
    ok("approve: a double click executes exactly once (the atomic claim)", log.length === 1 && [a, b].filter((x) => "success" in x).length === 1, `${log.length} executions`);
  }
  {
    const { db, id } = proposalDb({ expires_at: "2026-10-12T00:00:00.000Z" });
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    ok("approve: an expired proposal is not executed and is marked expired", "error" in r && /expired/i.test(r.error) && log.length === 0 && db.rows("assistant_proposals")[0].status === "expired");
  }
  {
    const { db, id } = proposalDb({ status: "dismissed", decided_at: "2026-10-13T11:00:00Z" });
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    ok("approve: a dismissed proposal is not executed", "error" in r && log.length === 0);
  }
  {
    const { db, id } = proposalDb({ created_by: OTHER_USER });
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    ok("approve: someone else's proposal is 'not found' and not executed", "error" in r && /could not be found/.test(r.error) && log.length === 0);
  }
  {
    const { db, id } = proposalDb();
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: false, now: NOW, execute: okExec(log) });
    ok("approve: refused when the assistant is no longer enabled for the organization", "error" in r && log.length === 0 && db.rows("assistant_proposals")[0].status === "pending");
  }
  {
    const { db, id } = proposalDb({ subject_id: "99999999-9999-4999-8999-999999999999" });
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    ok("approve: a subject that no longer exists (or is not visible) fails the proposal and executes nothing", "error" in r && log.length === 0 && db.rows("assistant_proposals")[0].status === "failed" && /no longer exists/.test(db.rows("assistant_proposals")[0].error_note));
  }
  {
    const payload: SetNextActionPayload = { prospect_id: P.due, subject_name: "Due Soon Fund", next_action: "New thing", next_action_due: dayOffset(9), previous: { next_action: "Call the program officer", next_action_due: dayOffset(2) } };
    const fresh = proposalDb({ action_key: "set_prospect_next_action" }, payload as unknown as Row);
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: fresh.db.client(), userId: USER, proposalId: fresh.id, enabled: true, now: NOW, execute: okExec(log) });
    ok("approve: a next-action change whose subject is unchanged executes", "success" in r && log.length === 1);

    const stale = proposalDb({ action_key: "set_prospect_next_action" }, { ...payload, previous: { next_action: "Something it used to say", next_action_due: null } } as unknown as Row);
    const log2: string[] = [];
    const r2 = await approveProposalCore({ supabase: stale.db.client(), userId: USER, proposalId: stale.id, enabled: true, now: NOW, execute: okExec(log2) });
    ok("approve: a next-action change whose subject has changed since is refused as stale and not executed", "error" in r2 && /changed since/.test(r2.error) && log2.length === 0 && stale.db.rows("assistant_proposals")[0].status === "failed");
  }
  {
    const { db, id } = proposalDb();
    const r = await approveProposalCore({
      supabase: db.client(),
      userId: USER,
      proposalId: id,
      enabled: true,
      now: NOW,
      execute: async () => ({ ok: false as const, error: "insert failed: permission denied" }),
    });
    ok("approve: an execution failure is recorded on the proposal as its own failure, never thrown", "error" in r && r.proposal?.status === "failed" && db.rows("assistant_proposals")[0].status === "failed" && /permission denied/.test(db.rows("assistant_proposals")[0].error_note));
  }
  {
    const { db, id } = proposalDb();
    db.blockUpdate.add(`assistant_proposals:${id}`);
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    ok("approve: when the claim cannot be won, nothing executes", "error" in r && log.length === 0);
  }
  {
    const { db, id } = proposalDb({ claimed_at: "2026-10-13T11:59:00.000Z" });
    const log: string[] = [];
    const r = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    const d = await dismissProposalCore({ supabase: db.client(), userId: USER, proposalId: id, now: NOW });
    ok("a claimed-but-undecided proposal (an attempted, unconfirmed approval) is neither re-run nor dismissible", "error" in r && "error" in d && log.length === 0 && /already started/.test((r as { error: string }).error));
  }
  {
    const { db, id } = proposalDb();
    const r = await dismissProposalCore({ supabase: db.client(), userId: USER, proposalId: id, now: NOW });
    const row = db.rows("assistant_proposals")[0];
    ok("dismiss: a pending proposal becomes dismissed, once, with a decision time, and nothing executes", "success" in r && row.status === "dismissed" && row.decided_at !== null && row.claimed_at === null);
    const again = await dismissProposalCore({ supabase: db.client(), userId: USER, proposalId: id, now: NOW });
    ok("dismiss: a second dismissal is refused", "error" in again);
    const log: string[] = [];
    const approveAfter = await approveProposalCore({ supabase: db.client(), userId: USER, proposalId: id, enabled: true, now: NOW, execute: okExec(log) });
    ok("a dismissed proposal can never be approved afterwards", "error" in approveAfter && log.length === 0);
  }
  {
    const { db, id } = proposalDb({ created_by: OTHER_USER });
    const r = await dismissProposalCore({ supabase: db.client(), userId: USER, proposalId: id, now: NOW });
    ok("dismiss: someone else's proposal is 'not found'", "error" in r && db.rows("assistant_proposals")[0].status === "pending");
  }

  // =========================================================================
  section("10. source scans: reachability, import closure, key containment, client graph");

  const all = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))].map(rel);
  const MODEL_FILES = ["lib/assistant/abilities.ts", "lib/assistant/provider.ts", "lib/assistant/loop.ts", "lib/assistant/reads.ts", "lib/assistant/dispatch.ts"];

  {
    // executors.ts: one importer, the approve action.
    const importers = all.filter((f) => f !== "lib/assistant/executors.ts").filter((f) => importSpecifiers(code(f)).some((s) => /(^|\/)assistant\/executors$|^\.\/executors$/.test(s) && (f.startsWith("lib/assistant/") ? s === "./executors" : true)));
    ok("lib/assistant/executors.ts is imported by exactly one file: the approve action", JSON.stringify(importers) === JSON.stringify(["app/(dashboard)/assistant/actions.ts"]), importers.join(", "));
    const anyMention = all.filter((f) => f !== "lib/assistant/executors.ts" && /assistant\/executors|from "\.\/executors"/.test(code(f)));
    ok("no other file even names the module in code", JSON.stringify(anyMention) === JSON.stringify(["app/(dashboard)/assistant/actions.ts"]), anyMention.join(", "));

    const execImports = importSpecifiers(code("lib/assistant/executors.ts")).sort();
    ok(
      "executors.ts imports exactly the three existing entry points' modules plus its own types and validators",
      JSON.stringify(execImports) === JSON.stringify(["./proposals", "./types", "@/app/(dashboard)/prospects/actions", "@/app/(dashboard)/revisit/actions", "@/app/(dashboard)/supporters/actions"].sort()),
      execImports.join(", ")
    );
    const execCode = code("lib/assistant/executors.ts");
    const named = [...execCode.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/app\/[^"]+"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean)).sort();
    ok("... and from them names only logInteraction, updateNextAction and logSupporterInteraction", JSON.stringify(named) === JSON.stringify(["logInteraction", "logSupporterInteraction", "updateNextAction"]), named.join(", "));

    const actions = code("app/(dashboard)/assistant/actions.ts");
    ok("the approve action's only non-assistant imports are session, auth and cache helpers", importSpecifiers(actions).every((s) => s.startsWith("@/lib/assistant/") || ["next/cache", "@/lib/supabase/server", "@/lib/auth"].includes(s)), importSpecifiers(actions).join(", "));
  }
  {
    // Closure: what the model-facing modules may never import.
    const FORBIDDEN_IMPORT = /executors|send-draft|draft-send|supabase\/admin|lib\/ai\/anthropic|prospect-workflow|pipeline\/actions|send-actions|draft-actions|strategy-actions|research-actions|network-actions|resend|@anthropic-ai/;
    for (const f of ASSISTANT_LIB.filter((x) => x !== "lib/assistant/executors.ts")) {
      const bad = importSpecifiers(code(f)).filter((s) => FORBIDDEN_IMPORT.test(s));
      ok(`${f}: imports no executor, send path, stage move, draft/strategy/research action, Anthropic client or service-role client`, bad.length === 0, bad.join(", "));
    }
    for (const f of MODEL_FILES) {
      const rel2 = importSpecifiers(code(f)).filter((s) => s.startsWith("@/app/") || s.includes("(dashboard)"));
      ok(`${f}: imports nothing from app/ (no server action of any kind)`, rel2.length === 0, rel2.join(", "));
    }
    const everything = ASSISTANT_SURFACE.map((f) => ({ f, c: code(f) }));
    const admin = everything.filter(({ c }) => /createAdminClient|SUPABASE_SERVICE_ROLE_KEY|service_role|supabase\/admin/.test(c)).map((x) => x.f);
    ok("no assistant file uses a service-role client or names the service-role key", admin.length === 0, admin.join(", "));
    const sendish = everything.filter(({ c }) => /sendFunderEmail|isSendConfigured|resend\.emails|moveProspectStage|approveStrategy|approveDraft|decideClaim|approveVerifiedIntelligence|deleteProspect|deleteSupporter|logSupporterGift/.test(c)).map((x) => x.f);
    ok("no assistant file references a send, stage-move, approval, deletion or gift-logging function", sendish.length === 0, sendish.join(", "));
    ok("the provider module imports only its own config types", JSON.stringify(importSpecifiers(code("lib/assistant/provider.ts"))) === JSON.stringify(["./config"]));
    ok("the assistant's only network call is the provider's fetch", (() => {
      const withFetch = ASSISTANT_SURFACE.filter((f) => /\bfetch\s*\(|\bfetch\s+as\b/.test(code(f)));
      return JSON.stringify(withFetch.sort()) === JSON.stringify(["app/(dashboard)/assistant/assistant-thread.tsx", "lib/assistant/provider.ts"].sort());
    })());
    const chatFiles = all.filter((f) => /chat\/completions/.test(code(f)));
    ok("exactly one file in app/ or lib/ names the chat-completions endpoint: the provider", JSON.stringify(chatFiles) === JSON.stringify(["lib/assistant/provider.ts"]), chatFiles.join(", "));
  }
  {
    // Key containment (hard rule 5).
    const holders = all.filter((f) => /process\.env\.MODEL_API_KEY|env\.MODEL_API_KEY|\.MODEL_API_KEY/.test(code(f)));
    ok("MODEL_API_KEY is read in exactly one file: lib/assistant/config.ts", JSON.stringify(holders) === JSON.stringify(["lib/assistant/config.ts"]), holders.join(", "));
    const configImporters = all.filter((f) => importSpecifiers(code(f)).some((s) => /assistant\/config$|^\.\/config$/.test(s)));
    const clientFiles = all.filter((f) => /^\s*["']use client["']/.test(read(f)));
    const clientImportsAssistant = clientFiles.filter((f) => importSpecifiers(code(f)).some((s) => /lib\/assistant|^\.\/(executors|provider|config|loop)/.test(s)));
    ok("no 'use client' file in app/, lib/ or components/ imports anything under lib/assistant (so no key, no provider, no executor reaches a bundle)", clientImportsAssistant.length === 0, clientImportsAssistant.join(", "));
    ok("the thread surface is a client component and imports only the approve/dismiss actions, router helpers and ui tokens", (() => {
      const f = "app/(dashboard)/assistant/assistant-thread.tsx";
      return clientFiles.includes(f) && importSpecifiers(code(f)).every((s) => ["react", "next/link", "./actions", "@/lib/ui"].includes(s));
    })());
    ok("config.ts is imported only by assistant server modules, the page, the layout-adjacent access check and the smoke script", configImporters.every((f) => f.startsWith("lib/assistant/") || f === "app/(dashboard)/assistant/page.tsx"), configImporters.join(", "));
    ok("no assistant file is imported by a component under components/", !all.filter((f) => f.startsWith("components/")).some((f) => /lib\/assistant/.test(code(f))));
    ok("MODEL_API_KEY is absent from every client component's source", !clientFiles.some((f) => /MODEL_API_KEY/.test(read(f))));
  }
  {
    // Birth before call, by source order.
    const turn = code("lib/assistant/turn.ts");
    const idx = (s: string) => turn.indexOf(s);
    const bornRunning = idx('role: "assistant", status: "running"');
    const userRow = idx('role: "user", status: "completed"');
    const begin = idx("await beginRun(");
    const loopCall = idx("await runAssistantLoop(");
    const providerCall = idx("callProvider(config");
    const enabledCheck = idx("resolveAssistantAccess(supabase");
    const configCheck = idx("readProviderConfig(env)");
    const firstInsert = turn.indexOf(".insert(");
    ok("turn.ts: the assistant row (running, naming provider and model) is written before beginRun", bornRunning > 0 && begin > bornRunning, `${bornRunning} / ${begin}`);
    ok("turn.ts: beginRun precedes the loop, which holds the only model call", begin > 0 && loopCall > begin && providerCall > begin, `${begin} / ${loopCall} / ${providerCall}`);
    ok("turn.ts: the user's message is written before the assistant row", userRow > 0 && bornRunning > userRow);
    ok("turn.ts: enablement and configuration are checked before the first insert of any kind", enabledCheck > 0 && configCheck > enabledCheck && firstInsert > configCheck, `${enabledCheck} ${configCheck} ${firstInsert}`);
    ok("turn.ts: a birth failure returns before the loop, finalizing the message as failed", /catch \(err\)[\s\S]{0,400}status: "failed"[\s\S]{0,500}return refusal\(500, "ledger_unavailable"/.test(turn) && /ledger_unavailable/.test(turn.slice(begin, loopCall)));
    ok("turn.ts: names the provider constant and the configured model in the birth row", /provider: PROVIDER_ID, model: config\.model/.test(turn));
    ok("turn.ts: finalizes the run and the message (completed path) after the loop, in that order", (() => {
      const after = turn.slice(loopCall);
      const run = after.indexOf("await finalizeRun(");
      const msg = after.indexOf("await finalizeMessage(");
      return run > 0 && msg > run;
    })());
    ok("loop.ts: requires the ledger id before any call", /if \(!input\.aiRunId\)/.test(code("lib/assistant/loop.ts")) && code("lib/assistant/loop.ts").indexOf("if (!input.aiRunId)") < code("lib/assistant/loop.ts").indexOf("input.call("));
    ok("the provider is called only through the loop's injected caller (turn.ts is the sole constructor of it)", all.filter((f) => /callProvider\(/.test(code(f))).sort().join(",") === ["lib/assistant/provider.ts", "lib/assistant/turn.ts"].join(","), all.filter((f) => /callProvider\(/.test(code(f))).join(", "));

    const route = code("app/api/assistant/turn/route.ts");
    ok("route: the session check (401) comes before the turn handler", route.indexOf("auth.getUser()") > 0 && route.indexOf("auth.getUser()") < route.indexOf("handleAssistantTurn(") && /status: 401|, 401\)/.test(route));
    ok("route: hands the SESSION client to the turn (createClient from lib/supabase/server), never an admin client", /createClient\(\)/.test(route) && /@\/lib\/supabase\/server/.test(route) && !/admin/i.test(route));
    ok("route: never throws to the client (outer try/catch returns JSON 500)", /catch \(err\)[\s\S]*500/.test(route));
    const md = /export const maxDuration = (\d+);/.exec(read("app/api/assistant/turn/route.ts"));
    const seconds = md ? Number(md[1]) : 0;
    ok("route: exports a literal maxDuration", seconds > 0, String(seconds));
    ok("MAX_STEPS x PER_CALL_TIMEOUT_MS cannot exceed the route's maxDuration", MAX_STEPS * PER_CALL_TIMEOUT_MS <= seconds * 1000, `${MAX_STEPS * PER_CALL_TIMEOUT_MS} vs ${seconds * 1000}`);
    ok("TURN_DEADLINE_MS leaves headroom inside maxDuration for the database writes after the loop", TURN_DEADLINE_MS + 15_000 <= seconds * 1000);
    ok("a turn is ONE fetch from the client: no polling loop over Server Actions", (() => {
      const c = code("app/(dashboard)/assistant/assistant-thread.tsx");
      return (c.match(/fetch\(/g) ?? []).length === 1 && !/setInterval|setTimeout/.test(c);
    })());
  }
  {
    // Surface contract.
    const thread = read("app/(dashboard)/assistant/assistant-thread.tsx");
    ok("surface: the composer is aligned with the shared field token (box-sizing border-box via fieldStyle)", /\.\.\.fieldStyle/.test(thread) && /boxSizing: "border-box"/.test(read("lib/ui.ts")));
    ok("surface: model prose is labelled AI-written and cards are labelled as read from the data", /AI-written/.test(thread) && /From your data/.test(thread));
    ok("surface: the three starter prompts are present", ["What's going on?", "Who needs follow-up this week?", "Which supporters have gone quiet?"].every((s) => thread.includes(s)));
    const flat = thread.replace(/\s+/g, " ");
    ok("surface: the disclosure names the provider and says what is and is not shared", /\{providerLabel\}/.test(thread) && /names, stages, dates/.test(flat) && /never sent/.test(flat) && /phone numbers/.test(flat));
    ok("surface: Approve and Dismiss exist and show each payload field", /Approve/.test(thread) && /Dismiss/.test(thread) && /proposal\.fields\.map/.test(thread));
    ok("surface: only shared tokens, no one-off hex colours", !/#[0-9a-fA-F]{3,6}\b/.test(code("app/(dashboard)/assistant/assistant-thread.tsx")));
    const page = read("app/(dashboard)/assistant/page.tsx");
    ok("page: reports setup pending when the tables are absent, and an explanation when not enabled or not configured", /isMissingRelation/.test(page) && /not switched on/.test(page) && /model connection is not set up/.test(page));
    const layout = read("app/(dashboard)/layout.tsx");
    const dIdx = layout.indexOf('label: "Dashboard"');
    const aIdx = layout.indexOf('label: "Assistant"');
    const oIdx = layout.indexOf('label: "Org Profile"');
    ok("nav: Assistant sits right after Dashboard in BEFORE_PIPELINE and only when enabled", dIdx > 0 && aIdx > dIdx && oIdx > aIdx && /assistantAccess\.enabled \?/.test(layout) && /icon: "sparkles"/.test(layout));
    const sidebar = read("components/Sidebar.tsx");
    ok(
      "sidebar: ICON_MAP gains sparkles and every existing entry is still present",
      /sparkles: Sparkles/.test(sidebar) && ["home: HomeIcon", '"layout-dashboard": LayoutDashboard', "building2: Building2", "search: Search", '"clipboard-check": ClipboardCheck', "users: Users", '"file-text": FileText', '"calendar-clock": CalendarClock', "settings: SettingsIcon", "network: Network", "heart: Heart"].every((e) => sidebar.includes(e))
    );
    ok("the layout's own nav entries and badge logic are otherwise untouched (existing hrefs all present)", ["/dashboard", "/organization", "/discovery", "/prospects/review", "/contacts", "/supporters", "/network", "/evidence", "/revisit", "/settings"].every((h) => layout.includes(`href: "${h}"`)));
  }
  {
    // Env and docs.
    const env = read(".env.example");
    ok(".env.example documents MODEL_API_KEY, MODEL_API_BASE_URL, ASSISTANT_MODEL and ASSISTANT_ENABLED_ORG_IDS, with a server-only note", ["MODEL_API_KEY=", "MODEL_API_BASE_URL=", "ASSISTANT_MODEL=", "ASSISTANT_ENABLED_ORG_IDS="].every((k) => env.includes(k)) && /server-only/i.test(env.slice(env.indexOf("Assistant (STATE item 87"))));
    ok("OVERVIEW.md's external-services table has the provider row", /Meta Model API \(Muse Spark\)/.test(read("docs/architecture/OVERVIEW.md")));
    ok("the smoke script exists, documents itself, and refuses without a key", existsSync(join(root, "scripts/assistant-smoke.ts")) && /MODEL_API_KEY is not set/.test(read("scripts/assistant-smoke.ts")) && /process\.exit\(2\)/.test(read("scripts/assistant-smoke.ts")));
  }

  // =========================================================================
  section("11. migration 0080, by text");

  {
    const files = readdirSync(join(root, "supabase/migrations")).filter((f) => /^\d{4}_/.test(f)).sort();
    const mine = files.find((f) => /assistant/.test(f))!;
    ok("the migration is the next number after the previous highest, and names the assistant", !!mine && files[files.length - 1] === mine && mine === "0080_assistant.sql", files.slice(-3).join(", "));
    const sql = read(`supabase/migrations/${mine}`);
    const stmts = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").toLowerCase();
    const creates = [...stmts.matchAll(/create\s+table\s+([a-z_]+)/g)].map((m) => m[1]).sort();
    ok("creates exactly three tables: assistant_threads, assistant_messages, assistant_proposals", JSON.stringify(creates) === JSON.stringify(["assistant_messages", "assistant_proposals", "assistant_threads"]), creates.join(", "));
    const alters = [...stmts.matchAll(/alter\s+table\s+([a-z_]+)/g)].map((m) => m[1]);
    ok("every ALTER TABLE targets one of the three new tables (ruling 0020: additive)", alters.length > 0 && alters.every((t) => creates.includes(t)), [...new Set(alters)].join(", "));
    ok("no DROP, no ADD COLUMN, no rename, no column type change", !/\bdrop\b/.test(stmts) && !/add\s+column/.test(stmts) && !/\brename\b/.test(stmts) && !/alter\s+column/.test(stmts));
    ok("the ledger's own additivity check passes", additiveViolations(sql).length === 0, additiveViolations(sql).join("; "));
    ok("every table has organization_id uuid not null references organizations default my_organization_id() (hard rule 6)", (stmts.match(/organization_id\s+uuid\s+not\s+null\s+references\s+organizations\s*\(id\)\s+default\s+my_organization_id\(\)/g) ?? []).length === 3);
    ok("every table has created_by defaulting to auth.uid()", (stmts.match(/created_by\s+uuid\s+not\s+null\s+default\s+auth\.uid\(\)\s+references\s+auth\.users/g) ?? []).length === 3);
    ok("row level security is enabled on all three", creates.every((t) => new RegExp(`alter\\s+table\\s+${t}\\s+enable\\s+row\\s+level\\s+security`).test(stmts)));
    const kinds = [...stmts.matchAll(/for\s+(insert|select|update|delete|all)\b/g)].map((m) => m[1]);
    ok("there is NO delete policy and no 'for all' policy anywhere", !kinds.includes("delete") && !kinds.includes("all") && !/for\s+delete/.test(stmts));
    ok("policy census: threads insert+select; messages insert+select+update; proposals insert+select+update", kinds.filter((k) => k === "insert").length === 3 && kinds.filter((k) => k === "select").length === 3 && kinds.filter((k) => k === "update").length === 2, kinds.join(","));
    const policies = [...stmts.matchAll(/create\s+policy[\s\S]*?;/g)].map((m) => m[0]);
    ok("every policy is scoped by organization AND author (created_by = auth.uid())", policies.length === 8 && policies.every((p) => /organization_id\s*=\s*my_organization_id\(\)/.test(p) && /created_by\s*=\s*auth\.uid\(\)/.test(p)), String(policies.length));
    ok("the message update policy reaches only a running row; the proposal update policy only a pending one", /on\s+assistant_messages\s+for\s+update[\s\S]*?using\s*\([^;]*status\s*=\s*'running'/.test(stmts) && /on\s+assistant_proposals\s+for\s+update[\s\S]*?using\s*\([^;]*status\s*=\s*'pending'/.test(stmts));
    ok("a proposal can only be inserted pending and unclaimed", /on\s+assistant_proposals\s+for\s+insert[\s\S]*?status\s*=\s*'pending'[\s\S]*?claimed_at\s+is\s+null/.test(stmts));
    ok("an assistant message can only be inserted running", /on\s+assistant_messages\s+for\s+insert[\s\S]*?role\s*=\s*'user'\s+or\s+status\s*=\s*'running'/.test(stmts));
    ok("a BEFORE UPDATE trigger terminal-once-guards messages and pins the birth columns", /create\s+trigger\s+assistant_messages_finalize_once\s+before\s+update\s+on\s+assistant_messages/.test(stmts) && /old\.status\s*<>\s*'running'/.test(stmts) && /new\.provider\s+is\s+distinct\s+from\s+old\.provider/.test(stmts) && /new\.model\s+is\s+distinct\s+from\s+old\.model/.test(stmts));
    ok("a BEFORE UPDATE trigger pins payload, action, subject, summary and expiry, and allows only claim then decision", /create\s+trigger\s+assistant_proposals_transitions\s+before\s+update\s+on\s+assistant_proposals/.test(stmts) && ["payload", "action_key", "subject_table", "subject_id", "summary", "expires_at", "created_by"].every((c) => new RegExp(`new\\.${c}\\s+is\\s+distinct\\s+from\\s+old\\.${c}`).test(stmts)) && /old\.status\s*<>\s*'pending'/.test(stmts));
    ok("executed or failed requires a prior claim; dismissed or expired forbids one (trigger and check constraint)", /new\.status\s+in\s*\('executed',\s*'failed'\)\s+and\s+old\.claimed_at\s+is\s+null/.test(stmts) && /new\.status\s+in\s*\('dismissed',\s*'expired'\)\s+and\s+old\.claimed_at\s+is\s+not\s+null/.test(stmts) && /assistant_proposals_claim_shape_check/.test(stmts));
    ok("a claim is refused after expiry and `expired` cannot be written before it", /now\(\)\s*>\s*old\.expires_at/.test(stmts) && /now\(\)\s*<=\s*old\.expires_at/.test(stmts));
    const fns = [...stmts.matchAll(/create\s+function\s+(enforce_[a-z_]+)\(\)[\s\S]*?language\s+plpgsql([^;]*);/g)];
    ok("org-match functions exist for message->thread and proposal->thread/message, security definer with a fixed search_path", fns.length === 2 && fns.every((m) => /security\s+definer/.test(m[2]) && /set\s+search_path\s*=\s*public/.test(m[2])), fns.map((m) => m[1]).join(","));
    ok("org-match triggers are attached before insert on messages and proposals", /create\s+trigger\s+assistant_messages_thread_match\s+before\s+insert/.test(stmts) && /create\s+trigger\s+assistant_proposals_refs_match\s+before\s+insert\s+on\s+assistant_proposals/.test(stmts));
    ok("the proposal's message must be a running assistant message of the same thread, and the author must own the thread", /m_role\s+is\s+distinct\s+from\s+'assistant'\s+or\s+m_status\s+is\s+distinct\s+from\s+'running'/.test(stmts) && /new\.thread_id\s+is\s+distinct\s+from\s+m_thread/.test(stmts) && /new\.created_by\s+is\s+distinct\s+from\s+t_owner/.test(stmts));
    ok("the action vocabulary is closed in the database as well as in code", /action_key\s+in\s*\('log_prospect_interaction',\s*'set_prospect_next_action',\s*'log_supporter_interaction'\)/.test(stmts));
    ok("a message row must name its provider and model when it is the assistant's", /role\s*=\s*'assistant'\s+and\s+provider\s+is\s+not\s+null\s+and\s+model\s+is\s+not\s+null/.test(stmts));
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

function groupBy<T extends Record<string, unknown>>(rows: T[], key: string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[r[key] as string] ??= []).push(r);
  return out;
}

main().catch((err) => {
  console.error("FAILED:", err);
  console.error(`Run aborted. Of the assertions that executed before the abort: ${pass} passed, ${fail} failed.`);
  process.exit(1);
});
