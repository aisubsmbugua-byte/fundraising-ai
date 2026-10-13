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
//  11  the migration (0080), by text
//  12  command mode (STATE item 92, ruling 0038): the registry's command and
//      gate kinds, the quotation check, the cap, the "shown earlier" rule and
//      the fingerprint, each gate's guard matrix, each command, the audit
//      record's order, the click-driven restore, the time budget
//  13  item 93: a strategy revision is a NEW row, every refusal precedes the
//      ledger birth, the literal operation string
//  14  the choke point and the surface, by source scan; migration 0081, by text
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
  MIN_CALL_BUDGET_MS,
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
import {
  runCommand,
  verifyQuote,
  normalizeQuoteText,
  findDisplayedGateCard,
  MAX_COMMANDS_PER_TURN,
  MIN_QUOTE_CHARS,
  TIME_MARGIN_MS,
} from "../lib/assistant/command";
import {
  COMMAND_DEFS,
  REVISE_DRAFT_MAX_MS,
  PUSH_BACK_MAX_MS,
  GENERATE_DRAFT_MAX_MS,
  MAX_DRAFT_TEXT_CHARS,
  RESTORE_ACTION_NAME,
} from "../lib/assistant/command-defs";
import { canonicalJson, strategyFingerprint, draftFingerprint, sha256Hex } from "../lib/assistant/fingerprint";
import { restoreCommandPreviousCore } from "../lib/assistant/restore";
import { prospectIdFromRedirect, isRedirectError as isRedirectErrorCmd } from "../lib/assistant/redirect";
import { getStrategyForReview, getDrafts } from "../lib/assistant/reads";
import { shapeStrategyResult, MAX_STRATEGY_FEEDBACK_CHARS } from "../lib/strategy";
import { AI_RUN_OPERATIONS } from "../lib/ai-runs";
import { approveProposalCore, dismissProposalCore } from "../lib/assistant/decide";
import { handleAssistantTurn, MAX_USER_MESSAGE_CHARS } from "../lib/assistant/turn";
import { isMissingRelation } from "../lib/assistant/access";
import { newUsage } from "../lib/ai-runs";
import { buildOutcomeIndex, isClosedToWork, isRevisitDue, type ProspectOutcomeRow, type RevisitDispositionRow } from "../lib/prospect-outcomes";
import { computeHealthStatus } from "../lib/prospects";
import { totalForecastAmount, selectSupporterStewardshipQueue, type Supporter, type SupporterGift, type SupporterInteraction } from "../lib/supporters";
import type { ApprovedIntelligence } from "../lib/prospect-intelligence";
import { additiveViolations } from "./ledger-check";
import type { Ability, CommandEntryPoints, ToolContext } from "../lib/assistant/types";

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
  // What createClient()'s client exposes for the sign-in check the server
  // actions make (only the item-93 section, which runs a real action, uses it).
  auth = { getUser: async () => ({ data: { user: { id: USER, email: "user@example.org" } } }) };

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
    if (table === "assistant_command_events") return { ...base, organization_id: ORG, created_by: USER, ...p };
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
    // Command mode (ruling 0038). Reads and proposals never touch these; the
    // command sections build their own context with real values.
    userMessage: "What's going on?",
    userMessageId: "40000000-0000-4000-8000-0000000000aa",
    userMessageAt: "2026-10-13T12:00:00.000Z",
    commandsRun: 0,
    remainingMs: () => 240_000,
    loadEntryPoints: async () => {
      throw new Error("a read or proposal test must never load entry points");
    },
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
  // Ruling 0038 adds two reads (the content a gate is decided on) ...
  const EXPECTED_CONTENT_READS = ["get_strategy_for_review", "get_drafts"];
  const EXPECTED_ACTS = ["propose_log_prospect_interaction", "propose_set_prospect_next_action", "propose_log_supporter_interaction"];
  // ... ten commands and two gates.
  const EXPECTED_COMMANDS = [
    "add_prospect",
    "edit_draft",
    "revise_draft_with_feedback",
    "push_back_on_strategy",
    "generate_outreach_draft",
    "unapprove_draft",
    "log_prospect_interaction",
    "set_prospect_next_action",
    "log_supporter_interaction",
    "set_prospect_ask_amount",
  ];
  const EXPECTED_GATES = ["approve_strategy", "approve_draft"];
  ok(
    "the ability names are EXACTLY the ruled list (eight reads, three act-on-approval, ten commands, two gates)",
    JSON.stringify([...ABILITY_NAMES].sort()) === JSON.stringify([...EXPECTED_READS, ...EXPECTED_CONTENT_READS, ...EXPECTED_ACTS, ...EXPECTED_COMMANDS, ...EXPECTED_GATES].sort()),
    ABILITY_NAMES.join(", ")
  );
  ok("the registry has exactly 23 abilities", ABILITIES.length === 23, String(ABILITIES.length));
  ok("no duplicate ability name", new Set(ABILITY_NAMES).size === ABILITY_NAMES.length);
  ok(
    "kinds are data on the entry: the eight reads are 'read'",
    [...EXPECTED_READS, ...EXPECTED_CONTENT_READS].every((n) => findAbility(n)?.kind === "read")
  );
  ok("kinds are data on the entry: the ten commands are 'command'", EXPECTED_COMMANDS.every((n) => findAbility(n)?.kind === "command"));
  ok("kinds are data on the entry: the two gates are 'gate'", EXPECTED_GATES.every((n) => findAbility(n)?.kind === "gate"));
  ok(
    "the kind set is closed: read, act_on_approval, command, gate -- and nothing else is representable",
    ABILITIES.every((a) => ["read", "act_on_approval", "command", "gate"].includes(a.kind)) && ABILITIES.filter((a) => a.kind === "gate").length === 2
  );
  ok(
    "kinds are data on the entry: the three proposals are 'act_on_approval'",
    EXPECTED_ACTS.every((n) => findAbility(n)?.kind === "act_on_approval")
  );
  ok(
    "no `prepare` ability and no research ability exists, and the only strategy abilities are the read, the push-back and the gate",
    !ABILITIES.some((a) => (a.kind as string) === "prepare") &&
      !ABILITY_NAMES.some((n) => /research/i.test(n)) &&
      JSON.stringify(ABILITY_NAMES.filter((n) => /strategy/i.test(n)).sort()) === JSON.stringify(["approve_strategy", "get_strategy_for_review", "push_back_on_strategy"])
  );
  ok(
    "every act_on_approval ability is named propose_*, and no read is",
    ABILITIES.filter((a) => a.kind === "act_on_approval").every((a) => a.name.startsWith("propose_")) &&
      ABILITIES.filter((a) => a.kind === "read").every((a) => !a.name.startsWith("propose_"))
  );

  // Ruling 0038 clause 4: nothing on the list speaks of sending, moving a
  // stage, deleting, recording a gift, or contact details -- in its name, its
  // description or its parameter schema (enum VALUES are vocabulary, checked
  // separately below). "approve" is no longer forbidden outright: two gates and
  // one reversal carry it, by name, and the test pins exactly which.
  const FORBIDDEN_BASE = /send|\bsent\b|advance|\bmov(e|ing)|delet|remov|gift/i;
  // A READ's description may DISCLAIM contact details ("not available"); an
  // action may not speak of them at all.
  const FORBIDDEN_CONTACT = /contact|recipient|email address|e-mail address/i;
  const FORBIDDEN = new RegExp(`${FORBIDDEN_BASE.source}|${FORBIDDEN_CONTACT.source}`, "i");
  const speaksForbidden = (a: Ability, text: string) => FORBIDDEN_BASE.test(text) || (a.kind !== "read" && FORBIDDEN_CONTACT.test(text));
  const schemaWithoutEnums = (a: Ability) => JSON.stringify(a.parameters, (k, v) => (k === "enum" ? undefined : v));
  const forbiddenHits = ABILITIES.filter((a) => speaksForbidden(a, a.name) || speaksForbidden(a, a.description) || speaksForbidden(a, schemaWithoutEnums(a)));
  ok(
    "no ability's name, description or parameter schema speaks of send, advance, move, delete, remove, gift, contact or a recipient",
    forbiddenHits.length === 0,
    forbiddenHits.map((a) => a.name).join(", ")
  );
  ok(
    "every enum value in every parameter schema is plain vocabulary (no send, advance, move, delete, remove, gift or contact)",
    ABILITIES.every((a) => {
      const values: unknown[] = [];
      JSON.stringify(a.parameters, (k, v) => {
        if (k === "enum" && Array.isArray(v)) values.push(...v);
        return v;
      });
      return values.every((v) => !FORBIDDEN.test(String(v)));
    })
  );
  ok(
    "'approve' appears in a name only on the two gates and the reversal -- exactly approve_strategy, approve_draft, unapprove_draft",
    JSON.stringify(ABILITY_NAMES.filter((n) => /approv/i.test(n)).sort()) === JSON.stringify(["approve_draft", "approve_strategy", "unapprove_draft"]) &&
      findAbility("approve_strategy")!.kind === "gate" &&
      findAbility("approve_draft")!.kind === "gate" &&
      findAbility("unapprove_draft")!.kind === "command"
  );
  ok(
    "no non-gate ability's description or schema speaks of approving, except the reads that report approval status and the reversal",
    ABILITIES.filter((a) => a.kind === "command" || a.kind === "act_on_approval").every((a) => a.name === "unapprove_draft" || !/approv/i.test(a.description + schemaWithoutEnums(a))),
    ABILITIES.filter((a) => (a.kind === "command" || a.kind === "act_on_approval") && a.name !== "unapprove_draft" && /approv/i.test(a.description + schemaWithoutEnums(a))).map((a) => a.name).join(", ")
  );
  ok(
    "no ability name implies a stage move, a claim decision, a message, or a send (stage_|move|claim|decide|message|send)",
    !ABILITY_NAMES.some((n) => /stage_|move|claim|decide|message|send/i.test(n))
  );
  ok(
    "the only names that speak of a draft or outreach are the six that are about drafts, and none of them sends",
    JSON.stringify(ABILITY_NAMES.filter((n) => /draft|outreach/i.test(n)).sort()) ===
      JSON.stringify(["approve_draft", "edit_draft", "generate_outreach_draft", "get_drafts", "revise_draft_with_feedback", "unapprove_draft"])
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
    ok(
      "the ledger-bound constants are named and finite (the turn deadline is 240 s since ruling 0038: a long ability runs inside the turn)",
      MAX_STEPS === 5 && PER_CALL_TIMEOUT_MS === 30_000 && TURN_DEADLINE_MS === 240_000 && MIN_CALL_BUDGET_MS === 5_000
    );
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
      // 130 s per call: the second call ends past the 240 s deadline.
      (req) => { void req; t += 130_000; return reply({ toolCalls: [{ id: "t", name: "get_dashboard_summary", args: "{}" }] }); },
      (req) => { void req; t += 130_000; return reply({ toolCalls: [{ id: "t2", name: "get_dashboard_summary", args: "{}" }] }); },
      reply({ content: "should never be asked" }),
    ]);
    const out = await runAssistantLoop(loopInput(db, call, { clock }));
    ok("past the wall-clock deadline no new model call is started", out.stopReason === "deadline" && seen.length === 2, `${out.stopReason}, ${seen.length} calls`);
    ok("a deadline stop says so and keeps what was retrieved", out.cards.some((c) => c.kind === "notice" && /time limit/.test(c.text)) && out.cards.filter((c) => c.kind === "facts").length === 2);
    ok("each call's timeout is capped by the time left", seen[0].timeoutMs === 30_000 && seen[1].timeoutMs === 30_000);
    // A call is never started with a sliver of time left: it would fail by
    // construction, after the turn may already have executed a command.
    let t2 = 0;
    const { call: call2, seen: seen2 } = scripted([
      (req) => { void req; t2 += TURN_DEADLINE_MS - 1_000; return reply({ toolCalls: [{ id: "t", name: "get_dashboard_summary", args: "{}" }] }); },
      reply({ content: "must not be asked with one second left" }),
    ]);
    const out2 = await runAssistantLoop(loopInput(db, call2, { clock: () => t2 }));
    ok(
      `no model call is started with under ${MIN_CALL_BUDGET_MS} ms of the deadline left (the turn ends with what it has, and says so)`,
      out2.stopReason === "deadline" && seen2.length === 1 && out2.cards.some((c) => c.kind === "notice"),
      `${out2.stopReason} / ${seen2.length}`
    );
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
    // Since item 92 the same file also hosts the click-driven Restore, which
    // injects the page's own updateDraft; that one extra import is named.
    ok(
      "the click actions' only non-assistant imports are session, auth and cache helpers, and the page's own updateDraft (for Restore)",
      importSpecifiers(actions).every(
        (s) => s.startsWith("@/lib/assistant/") || ["next/cache", "@/lib/supabase/server", "@/lib/auth", "@/app/(dashboard)/prospects/[id]/draft-actions"].includes(s)
      ),
      importSpecifiers(actions).join(", ")
    );
    ok(
      "... and from draft-actions it names updateDraft and nothing else",
      JSON.stringify([...actions.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/app\/\(dashboard\)\/prospects\/\[id\]\/draft-actions"/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()))) === JSON.stringify(["updateDraft"])
    );
  }
  {
    // Closure: what the model-facing modules may never import.
    const FORBIDDEN_IMPORT = /executors|send-draft|draft-send|supabase\/admin|lib\/ai\/anthropic|prospect-workflow|pipeline\/actions|send-actions|draft-actions|strategy-actions|research-actions|network-actions|resend|@anthropic-ai/;
    // lib/assistant/command-entrypoints.ts is the ONE module that wires the
    // entry points a command may call (ruling 0038 clause 1: the signed-in
    // user's own page actions). It is exempt from the closure below and
    // asserted instead by an exact import list -- see section 14.
    for (const f of ASSISTANT_LIB.filter((x) => x !== "lib/assistant/executors.ts" && x !== "lib/assistant/command-entrypoints.ts")) {
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
    // The two gates ARE on the list (ruling 0038 clause 3) and are reachable
    // only through the three files that carry them; everything else keeps the
    // original, unrelaxed pattern. approveVerifiedIntelligence (a research
    // claim decision), the send path, stage moves, deletions and gifts are
    // referenced nowhere under the assistant.
    const GATE_FILES = ["lib/assistant/command-entrypoints.ts", "lib/assistant/command-exec.ts", "lib/assistant/types.ts"];
    const sendish = everything
      .filter(({ f, c }) => !GATE_FILES.includes(f) && /sendFunderEmail|isSendConfigured|resend\.emails|moveProspectStage|approveStrategy|approveDraft|decideClaim|approveVerifiedIntelligence|deleteProspect|deleteSupporter|logSupporterGift/.test(c))
      .map((x) => x.f);
    ok("no assistant file outside the gate files references a send, stage-move, approval, deletion or gift-logging function", sendish.length === 0, sendish.join(", "));
    const hardRefs = everything
      .filter(({ c }) => /sendFunderEmail|isSendConfigured|resend\.emails|moveProspectStage|decideClaim|approveVerifiedIntelligence|deleteProspect|deleteSupporter|logSupporterGift|sendApprovedDraft|deleteDraft|deleteInteraction|updateContact\b/.test(c))
      .map((x) => x.f);
    ok("NO assistant file at all references a send, stage-move, claim-decision, deletion, gift or contact-change function (the gate files included)", hardRefs.length === 0, hardRefs.join(", "));
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
    ok(
      "the LAST model call can start just before the deadline and still end, with 15 s to spare, inside maxDuration (deadline + one call's timeout + writes)",
      TURN_DEADLINE_MS + PER_CALL_TIMEOUT_MS + 15_000 <= seconds * 1000,
      `${TURN_DEADLINE_MS + PER_CALL_TIMEOUT_MS + 15_000} vs ${seconds * 1000}`
    );
    ok(
      "every long ability's stated maximum plus the choke point's margin fits inside the turn deadline (so one can always be begun in a fresh turn)",
      [REVISE_DRAFT_MAX_MS, PUSH_BACK_MAX_MS, GENERATE_DRAFT_MAX_MS].every((ms) => ms + TIME_MARGIN_MS <= TURN_DEADLINE_MS) &&
        COMMAND_DEFS.filter((d) => d.maxDurationMs !== null).map((d) => d.name).sort().join(",") === "generate_outreach_draft,push_back_on_strategy,revise_draft_with_feedback"
    );
    ok("maxDuration is 300 s, a figure this project already deploys with (the cron route declares 280; the prospect page 450)", seconds === 300 && /maxDuration = 280/.test(read("app/api/cron/discovery-auto-search/route.ts")) && /maxDuration = 450/.test(read("app/(dashboard)/prospects/[id]/page.tsx")));
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
    const mine = files.find((f) => /^0080_/.test(f))!;
    ok(
      "migration 0080 is still the assistant's, and 0081 (assistant_commands) follows it directly as the highest",
      !!mine && mine === "0080_assistant.sql" && files[files.length - 1] === "0081_assistant_commands.sql" && files[files.length - 2] === mine,
      files.slice(-3).join(", ")
    );
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

  await commandModeSections();

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

// =============================================================================
// STATE item 92 (ruling 0038): command mode.
// =============================================================================

const CT = {
  thread: "30000000-0000-4000-8000-000000000001",
  asst: "40000000-0000-4000-8000-000000000001",
  user: "40000000-0000-4000-8000-0000000000aa",
};
const USER_AT = "2026-10-13T12:00:00.000Z";
const SHOWN_AT = "2026-10-13T11:00:00.000Z";
const LATER_AT = "2026-10-13T12:00:01.000Z";
const SR = {
  ready: "70000000-0000-4000-8000-000000000001",
  approved: "70000000-0000-4000-8000-000000000002",
  old: "70000000-0000-4000-8000-000000000003",
  newer: "70000000-0000-4000-8000-000000000004",
  analyzing: "70000000-0000-4000-8000-000000000005",
  elsewhere: "70000000-0000-4000-8000-000000000006",
};
const DR = {
  email: "80000000-0000-4000-8000-000000000001",
  call: "80000000-0000-4000-8000-000000000002",
  proposal: "80000000-0000-4000-8000-000000000003",
  deck: "80000000-0000-4000-8000-000000000004",
  approved: "80000000-0000-4000-8000-000000000005",
  sent: "80000000-0000-4000-8000-000000000006",
  empty: "80000000-0000-4000-8000-000000000007",
  elsewhere: "80000000-0000-4000-8000-000000000008",
};
const STRATEGY_FIXTURE = {
  outreach_approach: "Open with a short call to the program officer, then a one-page summary.",
  ask_positioning: "A $25,000 program grant, framed around the youth literacy outcomes.",
  rationale: "Their stated giving priorities match our outcomes.",
  key_talking_points: ["Literacy gains of 18% over two years", "Local, volunteer-powered"],
  evidence_to_highlight: ["Third-party evaluation of the reading program"],
};
const INTEL_FIXTURE = {
  location: "Dallas, TX",
  funder_type: "Private foundation",
  geographic_focus: "Texas",
  typical_grant_size: "$10,000-$50,000",
  focus_areas: ["education", "youth"],
};

type EpCall = { name: string; args: unknown[] };
type EpOverride = Partial<Record<keyof CommandEntryPoints, (...a: any[]) => Promise<unknown>>>; // eslint-disable-line @typescript-eslint/no-explicit-any

function redirectError(path: string) {
  return Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;push;${path};307;` });
}

// Counting fake entry points. Each records one marker into db.log (so its
// position relative to the audit inserts is checkable) and applies the effect
// the real one has on the fake tables, so post-checks and re-reads see it.
function fakeEntryPoints(db: FakeDb, override: EpOverride = {}) {
  const calls: EpCall[] = [];
  const mark = (name: string, args: unknown[]) => {
    calls.push({ name, args });
    db.log.push({ table: "__entry_point__", op: "select", columns: name, payload: args, filters: [] });
  };
  const draftRow = (id: string) => db.rows("drafts").find((d) => d.id === id);
  const ep: CommandEntryPoints = {
    createProspect: async (fd) => {
      mark("createProspect", [Object.fromEntries((fd as FormData).entries())]);
      const id = db.uuid();
      db.seed("prospects", [{ id, name: fd.get("name"), channel: fd.get("channel"), stage: (fd.get("stage") as string) || "discovery", next_action: null, next_action_due: null, ask_amount: null }]);
      throw redirectError(`/prospects/${id}`);
    },
    updateDraft: async (id, pid, subject, content) => {
      mark("updateDraft", [id, pid, subject, content]);
      const r = draftRow(id);
      if (!r) return { error: "Draft not found." };
      if (r.status === "approved") return { error: "This draft has been approved, so its content is locked." };
      r.subject = subject;
      r.content = content;
      return { ok: true };
    },
    reviseDraftWithFeedback: async (id, feedback) => {
      mark("reviseDraftWithFeedback", [id, feedback]);
      const r = draftRow(id);
      if (!r) return { error: "Draft not found." };
      r.content = `${r.content}\n# Revised\nAddressed: ${feedback}`;
      return { ok: true, content: r.content };
    },
    reviseStrategyWithFeedback: async (runId, feedback) => {
      mark("reviseStrategyWithFeedback", [runId, feedback]);
      const run = db.rows("strategy_runs").find((r) => r.id === runId);
      if (!run) return { error: "That strategy run could not be found." };
      const id = db.uuid();
      db.seed("strategy_runs", [
        { id, prospect_id: run.prospect_id, status: "ready_for_review", strategy: { ...STRATEGY_FIXTURE, rationale: `Revised: ${feedback}` }, organization_intel: INTEL_FIXTURE, approved_strategy: null, created_at: "2026-10-13T12:00:30.000Z" },
      ]);
      return { ok: true, runId: id };
    },
    generateDraft: async (pid, runId, kind) => {
      mark("generateDraft", [pid, runId, kind]);
      db.seed("drafts", [
        { id: db.uuid(), prospect_id: pid, strategy_run_id: runId, kind, status: "draft", subject: kind === "intro_email" ? "A first hello" : null, content: "Generated first-draft text.", sent_at: null, created_at: "2026-10-13T12:00:40.000Z" },
      ]);
    },
    unapproveDraft: async (id, pid) => {
      mark("unapproveDraft", [id, pid]);
      const r = draftRow(id);
      if (!r) return { error: "Draft not found." };
      r.status = "draft";
      return { ok: true };
    },
    approveDraft: async (id, pid) => {
      mark("approveDraft", [id, pid]);
      const r = draftRow(id);
      if (r) r.status = "approved";
    },
    approveStrategy: async (runId, pid, strategy, intel) => {
      mark("approveStrategy", [runId, pid, strategy, intel]);
      const r = db.rows("strategy_runs").find((x) => x.id === runId);
      if (r) r.approved_strategy = strategy;
    },
    logInteraction: async (...a) => mark("logInteraction", a),
    updateNextAction: async (id, action, due) => {
      mark("updateNextAction", [id, action, due]);
      const r = db.rows("prospects").find((x) => x.id === id);
      if (r) {
        r.next_action = action;
        r.next_action_due = due || null;
      }
    },
    logSupporterInteraction: async (...a) => mark("logSupporterInteraction", a),
    updateAskAmount: async (id, amount) => {
      mark("updateAskAmount", [id, amount]);
      const r = db.rows("prospects").find((x) => x.id === id);
      if (r) r.ask_amount = amount;
    },
    ...(override as Partial<CommandEntryPoints>),
  };
  // An override replaces the effect but must still count as a call.
  for (const key of Object.keys(override) as (keyof CommandEntryPoints)[]) {
    const inner = (override as Record<string, (...a: unknown[]) => Promise<unknown>>)[key];
    (ep as unknown as Record<string, unknown>)[key] = async (...a: unknown[]) => {
      mark(String(key), a);
      return inner(...a);
    };
  }
  return { ep, calls };
}

function commandDb(): FakeDb {
  const db = contaminatedDb();
  db.tables["strategy_runs"] = [];
  db.seed("strategy_runs", [
    // P.due: an old superseded run and the current one waiting for review.
    { id: SR.old, prospect_id: P.due, status: "ready_for_review", strategy: { ...STRATEGY_FIXTURE, rationale: "Old take" }, organization_intel: INTEL_FIXTURE, approved_strategy: null, created_at: "2026-10-10T09:00:00.000Z" },
    { id: SR.ready, prospect_id: P.due, status: "ready_for_review", strategy: STRATEGY_FIXTURE, organization_intel: INTEL_FIXTURE, approved_strategy: null, created_at: "2026-10-12T09:00:00.000Z" },
    // P.overdue: already approved.
    { id: SR.approved, prospect_id: P.overdue, status: "ready_for_review", strategy: STRATEGY_FIXTURE, organization_intel: INTEL_FIXTURE, approved_strategy: STRATEGY_FIXTURE, created_at: "2026-10-11T09:00:00.000Z" },
    // P.later: still being built.
    { id: SR.analyzing, prospect_id: P.later, status: "analyzing", strategy: null, organization_intel: null, approved_strategy: null, created_at: "2026-10-12T09:00:00.000Z" },
    // P.quiet: a run on a DIFFERENT prospect (for the wrong-prospect guard).
    { id: SR.elsewhere, prospect_id: P.quiet, status: "ready_for_review", strategy: STRATEGY_FIXTURE, organization_intel: INTEL_FIXTURE, approved_strategy: null, created_at: "2026-10-12T09:00:00.000Z" },
  ]);
  let draftSeq = 20;
  const draft = (id: string, kind: string, extra: Row = {}): Row => {
    const createdAt = `2026-10-12T10:00:${String(draftSeq--).padStart(2, "0")}.000Z`;
    return {
    id,
    prospect_id: P.due,
    strategy_run_id: SR.ready,
    kind,
    status: "draft",
    subject: kind === "intro_email" ? "Introducing our literacy program" : null,
    content: `Text of the ${kind} draft.`,
    sent_at: null,
    created_at: createdAt,
    // Columns a draft row really holds that must never reach the model.
    resend_message_id: "RESEND-MESSAGE-ID-SECRET",
    sent_by: "SENT-BY-SECRET",
    contact_email: SECRET.prospectEmail,
    ...extra,
    };
  };
  db.tables["drafts"] = [];
  db.seed("drafts", [
    draft(DR.email, "intro_email"),
    draft(DR.call, "call_prep"),
    draft(DR.proposal, "proposal", { content: "# Statement of need\nLiteracy is low.\n> evidence: e1" }),
    draft(DR.deck, "deck", { content: "# Slide one\nA point" }),
    draft(DR.approved, "intro_email", { status: "approved", subject: "Already approved", content: "Approved body." }),
    draft(DR.sent, "intro_email", { status: "approved", sent_at: "2026-10-01T00:00:00Z", content: "Gone out." }),
    draft(DR.empty, "intro_email", { content: "   " }),
    draft(DR.elsewhere, "intro_email", { prospect_id: P.quiet }),
  ]);
  // The thread the commands run in: the user's message of THIS turn.
  db.seed("assistant_threads", [{ id: CT.thread, organization_id: ORG, created_by: USER, title: "t", created_at: SHOWN_AT }]);
  db.seed("assistant_messages", [
    { id: CT.user, thread_id: CT.thread, organization_id: ORG, created_by: USER, role: "user", status: "completed", content: "Approve the Due Soon strategy.", cards: [], provider: null, model: null, finalized_at: USER_AT, created_at: USER_AT },
    { id: CT.asst, thread_id: CT.thread, organization_id: ORG, created_by: USER, role: "assistant", status: "running", content: "", cards: [], provider: "meta-model-api", model: "m", finalized_at: null, created_at: USER_AT },
  ]);
  return db;
}

// The real read's card, persisted on an assistant message finalized at `at`.
async function seedShownCards(db: FakeDb, cards: unknown[], over: Row = {}) {
  db.seed("assistant_messages", [
    { id: db.uuid(), thread_id: CT.thread, organization_id: ORG, created_by: USER, role: "assistant", status: "completed", content: "Here it is.", cards, provider: "meta-model-api", model: "m", finalized_at: SHOWN_AT, created_at: SHOWN_AT, ...over },
  ]);
}
async function shownStrategyCard(db: FakeDb, prospectId = P.due) {
  const r = await getStrategyForReview(db.client(), { prospectId });
  if (!r.ok) throw new Error("fixture read failed");
  return { card: r.card as Extract<typeof r.card, { kind: "strategy_review" }>, fingerprint: (r.modelResult as { fingerprint: string }).fingerprint };
}
async function shownDraftCard(db: FakeDb, prospectId = P.due) {
  const r = await getDrafts(db.client(), { prospectId, draftId: null });
  if (!r.ok) throw new Error("fixture read failed");
  const items = (r.modelResult as { drafts: { draftId: string; fingerprint: string }[] }).drafts;
  return { card: r.card, fp: (id: string) => items.find((d) => d.draftId === id)!.fingerprint };
}

function cmdCtx(db: FakeDb, userMessage: string, over: Partial<ToolContext> = {}, eps?: ReturnType<typeof fakeEntryPoints>) {
  const fake = eps ?? fakeEntryPoints(db);
  const ctx: ToolContext = {
    ...ctxFor(db),
    threadId: CT.thread,
    messageId: CT.asst,
    userMessage,
    userMessageId: CT.user,
    userMessageAt: USER_AT,
    commandsRun: 0,
    remainingMs: () => 240_000,
    loadEntryPoints: async () => fake.ep,
    ...over,
  };
  return { ctx, fake };
}

const events = (db: FakeDb) => db.rows("assistant_command_events");
type Outcome = Awaited<ReturnType<typeof runCommand>>;
const mr = (o: Outcome): Record<string, any> => (o.ok ? o.modelResult : {}); // eslint-disable-line @typescript-eslint/no-explicit-any
const cardOf = (o: Outcome) => (o.ok ? o.card : undefined);
const refused = (o: Outcome, code?: string) => o.ok && mr(o).status === "refused" && mr(o).nothingWasDone === true && (code === undefined || mr(o).code === code);
const done = (o: Outcome) => o.ok && mr(o).status === "done";
const writesOutsideAudit = (db: FakeDb) => db.log.filter((l) => l.op !== "select" && l.table !== "assistant_command_events");

async function commandModeSections() {
  // ===========================================================================
  section("12a. the quotation: verified in code against the user's message of THIS turn");

  {
    const acting = ABILITIES.filter((a) => a.kind === "command" || a.kind === "gate");
    ok(
      "every command and gate REQUIRES a string authorizing_quote in its parameter schema; no read or proposal takes one",
      acting.length === 12 &&
        acting.every((a) => a.parameters.required?.includes("authorizing_quote") && (a.parameters.properties.authorizing_quote as { type?: string }).type === "string") &&
        ABILITIES.filter((a) => a.kind === "read" || a.kind === "act_on_approval").every((a) => !("authorizing_quote" in a.parameters.properties))
    );
    const gate = (n: string) => findAbility(n)!.parameters;
    ok(
      "each gate additionally REQUIRES its subject id and the fingerprint the displayed card carried",
      gate("approve_strategy").required!.includes("run_id") &&
        gate("approve_strategy").required!.includes("fingerprint") &&
        gate("approve_draft").required!.includes("draft_id") &&
        gate("approve_draft").required!.includes("fingerprint") &&
        acting.filter((a) => a.kind === "command").every((a) => !a.parameters.required!.includes("fingerprint"))
    );
    ok(
      "the registry's validate rejects a command or gate call that omits the quotation, before any handler",
      (await Promise.all(
        acting.map(async (a) => {
          const r = await dispatchToolCall({ name: a.name, argumentsRaw: JSON.stringify({}) }, ctxFor(new FakeDb()));
          return !r.ok && r.errorKind === "validation";
        })
      )).every(Boolean)
    );
    ok(
      "act_on_approval entries are unchanged: still named propose_*, still writing only a pending proposal, and none of them calls runCommand",
      ABILITIES.filter((a) => a.kind === "act_on_approval").length === 3 && !/runCommand/.test(code("lib/assistant/proposals.ts"))
    );
  }

  {
    const msg = "Please approve the Due Soon   strategy now, and add Harvest Foundation.";
    ok("a verbatim excerpt passes", verifyQuote("approve the Due Soon strategy", msg).ok);
    ok("case and whitespace variants pass (collapsed whitespace, case folded)", verifyQuote("APPROVE THE due soon STRATEGY", msg).ok && verifyQuote("due   soon\n strategy", msg).ok);
    ok("normalizeQuoteText collapses runs of whitespace and folds case, and does nothing more", normalizeQuoteText("  A \n\t b  ") === "a b");
    const v = verifyQuote("approve the DUE soon strategy", msg);
    ok("the words are recorded as the user TYPED them (their casing and spacing), not as the model cased them", v.ok && v.wordsAsTyped === "approve the Due Soon   strategy", JSON.stringify(v));
    ok("a paraphrase fails", !verifyQuote("go ahead and accept the Due Soon plan", msg).ok);
    ok("a quote from an EARLIER message or a tool result (not in this message) fails", !verifyQuote("Nothing else matters except the red button", msg).ok);
    ok("an empty or whitespace quote fails as missing", verifyQuote("", msg).ok === false && verifyQuote("   ", msg).ok === false && verifyQuote(undefined, msg).ok === false && verifyQuote(42, msg).ok === false);
    const short = verifyQuote("ap", msg);
    ok(`a quote shorter than ${MIN_QUOTE_CHARS} characters fails, even though it is a substring`, !short.ok && short.code === "quote_too_short");
    ok("the quote must be a substring: one word added to a real excerpt fails", !verifyQuote("approve the Due Soon strategy immediately", msg).ok);
    ok("no user message in the turn means nothing can be authorized", !verifyQuote("approve", "").ok && !verifyQuote("approve it", undefined).ok);
    ok("a quote that straddles two sentences is accepted only if it is contiguous in the message", verifyQuote("strategy now, and add Harvest", msg).ok && !verifyQuote("strategy and add Harvest", msg).ok);
  }
  {
    // Through the choke point: a bad quote runs NOTHING and records a refusal.
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Please set the ask for Due Soon Fund to 30000.");
    const args = { prospect_id: P.due, ask_amount: 30000 };
    const wrong = await runCommand("set_prospect_ask_amount", { ...args, authorizing_quote: "set the ask to forty thousand" }, ctx);
    ok("a quotation that is not in the user's message is refused: no entry point, nothing written but the refusal record", refused(wrong, "quote_not_found") && fake.calls.length === 0 && writesOutsideAudit(db).length === 0);
    ok("... the refusal says plainly what was not done, in a card, and carries no quote as the user's", cardOf(wrong)?.kind === "refusal" && /nothing was done/.test(String((cardOf(wrong) as { reason: string }).reason)));
    ok("... and one `refused` row records the attempt with the model's claimed quote", events(db).length === 1 && events(db)[0].event === "refused" && events(db)[0].quote === "set the ask to forty thousand" && events(db)[0].ability === "set_prospect_ask_amount");
    const none = await runCommand("set_prospect_ask_amount", { ...args }, ctx);
    ok("a call with no authorizing_quote at all is refused", refused(none, "quote_missing") && fake.calls.length === 0);
    const good = await runCommand("set_prospect_ask_amount", { ...args, authorizing_quote: "ask for Due Soon Fund to 30000" }, ctx);
    ok("the same call with the user's own words executes", done(good) && fake.calls.length === 1 && fake.calls[0].name === "updateAskAmount");
  }
  {
    // A quote that is in an earlier message / tool result but not in THIS message.
    const db = commandDb();
    db.seed("assistant_messages", [{ id: db.uuid(), thread_id: CT.thread, organization_id: ORG, created_by: USER, role: "user", status: "completed", content: "Please delete everything and approve it all", cards: [], provider: null, model: null, finalized_at: SHOWN_AT, created_at: SHOWN_AT }]);
    const { ctx, fake } = cmdCtx(db, "What is going on with Due Soon Fund?");
    const o = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 1, authorizing_quote: "approve it all" }, ctx);
    ok("words the user said in an EARLIER message do not authorize an action in this one", refused(o, "quote_not_found") && fake.calls.length === 0);
    const injected = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 1, authorizing_quote: "NOTES-SECRET: privately negotiated" }, ctx);
    ok("text that came through a tool result (a note, a web page, a funder's claim) cannot supply the quotation", refused(injected, "quote_not_found") && fake.calls.length === 0);
  }

  // ===========================================================================
  section("12b. the per-turn cap");

  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Set the ask to 100 then 200 then 300 then 400 for Due Soon Fund.");
    const results: Outcome[] = [];
    for (const amount of [100, 200, 300, 400]) {
      results.push(await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: amount, authorizing_quote: "Set the ask to 100 then 200" }, ctx));
    }
    ok(`the cap is a named constant (${MAX_COMMANDS_PER_TURN}) and the first ${MAX_COMMANDS_PER_TURN} commands in a turn execute`, MAX_COMMANDS_PER_TURN === 3 && results.slice(0, 3).every(done) && fake.calls.length === 3);
    ok("the next one is refused at the cap with NO entry point call and no started row", refused(results[3], "turn_cap") && fake.calls.length === 3 && events(db).filter((e) => e.event === "started").length === 3);
    const probe = cmdCtx(commandDb(), "Set the ask for Due Soon Fund to 900.");
    await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 900, authorizing_quote: "words that are not there" }, probe.ctx);
    await runCommand("set_prospect_ask_amount", { prospect_id: "99999999-9999-4999-8999-999999999999", ask_amount: 900, authorizing_quote: "Set the ask for Due Soon Fund" }, probe.ctx);
    ok("a REFUSED command does not consume the cap (only a command that was recorded as started does)", probe.ctx.commandsRun === 0);
    const fresh = cmdCtx(db, "Set the ask to 500 for Due Soon Fund.");
    const next = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 500, authorizing_quote: "Set the ask to 500" }, fresh.ctx);
    ok("... a fresh turn executes again", done(next) && fresh.fake.calls.length === 1);
  }

  // ===========================================================================
  section("12c. a gate is decided only on what was shown in an EARLIER turn, pinned by fingerprint");

  const approveArgs = (runId: string, fp: string, prospectId = P.due) => ({ prospect_id: prospectId, run_id: runId, fingerprint: fp, authorizing_quote: "Approve the Due Soon strategy" });
  {
    const db = commandDb();
    const { card, fingerprint } = await shownStrategyCard(db);
    await seedShownCards(db, [card]);
    const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
    const o = await runCommand("approve_strategy", approveArgs(SR.ready, fingerprint), ctx);
    ok("a strategy shown in an earlier turn, with the same fingerprint, is approved: approveStrategy called once with the STORED strategy and intel", done(o) && fake.calls.length === 1 && fake.calls[0].name === "approveStrategy" && JSON.stringify(fake.calls[0].args) === JSON.stringify([SR.ready, P.due, STRATEGY_FIXTURE, INTEL_FIXTURE]));
    ok("... and the card says approving is not sending, and carries the user's own words", cardOf(o)?.kind === "command_result" && /Nothing has been sent/.test((cardOf(o) as { summary: string }).summary) && (cardOf(o) as { quote: string }).quote === "Approve the Due Soon strategy");
  }
  {
    // No card at all.
    const db = commandDb();
    const { fingerprint } = await shownStrategyCard(db);
    const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
    const o = await runCommand("approve_strategy", approveArgs(SR.ready, fingerprint), ctx);
    ok("a gate with no earlier display is refused, and nothing runs", refused(o, "not_shown_earlier") && fake.calls.length === 0 && writesOutsideAudit(db).length === 0);
  }
  {
    // Same-turn card: persisted after the user's message, or on this turn's own row.
    const db = commandDb();
    const { card, fingerprint } = await shownStrategyCard(db);
    await seedShownCards(db, [card], { finalized_at: LATER_AT, created_at: LATER_AT });
    await seedShownCards(db, [card], { id: CT.asst, status: "completed", finalized_at: SHOWN_AT });
    const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
    // (the turn's own row id appears twice in the fake -- the neq filter drops both)
    const o = await runCommand("approve_strategy", approveArgs(SR.ready, fingerprint), ctx);
    ok("a card shown in the SAME turn (after the user's message, or on this turn's own row) does not count: the user cannot approve in the breath the assistant first reads it", refused(o, "not_shown_earlier") && fake.calls.length === 0);
  }
  {
    // Wrong subject / wrong fingerprint / unusable messages.
    const db = commandDb();
    const { card, fingerprint } = await shownStrategyCard(db);
    const other = await shownStrategyCard(db, P.quiet);
    await seedShownCards(db, [other.card]);
    const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
    const o1 = await runCommand("approve_strategy", approveArgs(SR.ready, fingerprint), ctx);
    ok("a card for a DIFFERENT strategy does not satisfy the gate (wrong subject)", refused(o1, "not_shown_earlier") && fake.calls.length === 0);
    const db2 = commandDb();
    const s2 = await shownStrategyCard(db2);
    await seedShownCards(db2, [{ ...s2.card, fingerprint: sha256Hex("something else") }]);
    const c2 = cmdCtx(db2, "Approve the Due Soon strategy.");
    const o2 = await runCommand("approve_strategy", approveArgs(SR.ready, s2.fingerprint), c2.ctx);
    ok("a card for the right strategy with a DIFFERENT fingerprint does not satisfy the gate (wrong fingerprint)", refused(o2, "not_shown_earlier") && c2.fake.calls.length === 0);
    const db3 = commandDb();
    const s3 = await shownStrategyCard(db3);
    await seedShownCards(db3, [s3.card], { status: "failed" });
    await seedShownCards(db3, [s3.card], { status: "running", finalized_at: null });
    await seedShownCards(db3, [s3.card], { thread_id: "30000000-0000-4000-8000-0000000000ff" });
    await seedShownCards(db3, [s3.card], { role: "user" });
    const c3 = cmdCtx(db3, "Approve the Due Soon strategy.");
    const o3 = await runCommand("approve_strategy", approveArgs(SR.ready, s3.fingerprint), c3.ctx);
    ok("only an EARLIER, COMPLETED ASSISTANT message of THIS thread counts (failed, running, other-thread and user rows do not)", refused(o3, "not_shown_earlier") && c3.fake.calls.length === 0);
    void card;
  }
  {
    // Changed since shown: the model passes the OLD (displayed) fingerprint.
    const db = commandDb();
    const { card, fingerprint } = await shownStrategyCard(db);
    await seedShownCards(db, [card]);
    const row = db.rows("strategy_runs").find((r) => r.id === SR.ready)!;
    row.strategy = { ...STRATEGY_FIXTURE, ask_positioning: "A $250,000 grant, not $25,000." };
    const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
    const o = await runCommand("approve_strategy", approveArgs(SR.ready, fingerprint), ctx);
    ok("content changed since it was shown: the fingerprint is RECOMPUTED from the live row, differs, and nothing runs", refused(o, "changed_since_shown") && fake.calls.length === 0 && writesOutsideAudit(db).length === 0);
    // ... and passing the NEW fingerprint does not help: that version was never shown.
    const newFp = strategyFingerprint(row.strategy, row.organization_intel);
    const o2 = await runCommand("approve_strategy", approveArgs(SR.ready, newFp), ctx);
    ok("... nor does passing the NEW fingerprint: that version was never displayed in an earlier turn", refused(o2, "not_shown_earlier") && fake.calls.length === 0);
  }

  // ===========================================================================
  section("12d. approve_strategy: every guard has a failing fixture");

  {
    const shownFor = async (db: FakeDb, prospectId: string) => {
      const s = await shownStrategyCard(db, prospectId);
      await seedShownCards(db, [s.card]);
      return s;
    };
    // already approved
    {
      const db = commandDb();
      const row = db.rows("strategy_runs").find((r) => r.id === SR.approved)!;
      // The approved run's card is shown with approved:true and no fingerprint; build the
      // card a stale client might hold: the proposal's fingerprint on an approved:false card.
      const fp = strategyFingerprint(row.strategy, row.organization_intel);
      await seedShownCards(db, [{ kind: "strategy_review", runId: SR.approved, fingerprint: fp, approved: false }]);
      const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
      const o = await runCommand("approve_strategy", approveArgs(SR.approved, fp, P.overdue), ctx);
      ok("guard: an already-approved run is refused (a second approval would silently overwrite the first)", refused(o, "already_approved") && fake.calls.length === 0);
    }
    // not latest
    {
      const db = commandDb();
      const old = db.rows("strategy_runs").find((r) => r.id === SR.old)!;
      const fp = strategyFingerprint(old.strategy, old.organization_intel);
      await seedShownCards(db, [{ kind: "strategy_review", runId: SR.old, fingerprint: fp, approved: false }]);
      const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
      const o = await runCommand("approve_strategy", approveArgs(SR.old, fp), ctx);
      ok("guard: a run that is not the prospect's LATEST is refused", refused(o, "not_latest") && fake.calls.length === 0);
    }
    // wrong prospect
    {
      const db = commandDb();
      const s = await shownFor(db, P.due);
      const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
      const o = await runCommand("approve_strategy", approveArgs(SR.ready, s.fingerprint, P.quiet), ctx);
      ok("guard: a run that belongs to a different prospect than the one named is refused", refused(o, "wrong_prospect") && fake.calls.length === 0);
    }
    // not ready for review
    {
      const db = commandDb();
      const row = db.rows("strategy_runs").find((r) => r.id === SR.ready)!;
      row.status = "analyzing";
      const fp = strategyFingerprint(row.strategy, row.organization_intel);
      await seedShownCards(db, [{ kind: "strategy_review", runId: SR.ready, fingerprint: fp, approved: false }]);
      const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
      const o = await runCommand("approve_strategy", approveArgs(SR.ready, fp), ctx);
      ok("guard: a run that is not ready for review is refused", refused(o, "not_ready") && fake.calls.length === 0);
    }
    // not found / not visible
    {
      const db = commandDb();
      const s = await shownFor(db, P.due);
      const ghost = "70000000-0000-4000-8000-0000000000ff";
      await seedShownCards(db, [{ kind: "strategy_review", runId: ghost, fingerprint: s.fingerprint, approved: false }]);
      const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
      const o = await runCommand("approve_strategy", approveArgs(ghost, s.fingerprint), ctx);
      ok("guard: an id the session cannot see is 'not found' -- even with a matching displayed card", refused(o, "not_found") && fake.calls.length === 0);
    }
    // no proposal stored
    {
      const db = commandDb();
      const row = db.rows("strategy_runs").find((r) => r.id === SR.ready)!;
      row.strategy = null;
      const fp = sha256Hex("x");
      await seedShownCards(db, [{ kind: "strategy_review", runId: SR.ready, fingerprint: fp, approved: false }]);
      const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
      const o = await runCommand("approve_strategy", approveArgs(SR.ready, fp), ctx);
      ok("guard: a run holding no proposed strategy is refused", refused(o, "no_proposal") && fake.calls.length === 0);
    }
    // bad id / fingerprint shapes
    {
      const db = commandDb();
      const { ctx, fake } = cmdCtx(db, "Approve the Due Soon strategy.");
      const o1 = await runCommand("approve_strategy", { ...approveArgs(SR.ready, "not-a-hash") }, ctx);
      const o2 = await runCommand("approve_strategy", { ...approveArgs("nope", sha256Hex("x")) }, ctx);
      ok("guard: a malformed id or fingerprint is refused before any read of the strategy", refused(o1, "invalid_arguments") && refused(o2, "invalid_arguments") && fake.calls.length === 0);
    }
  }

  // ===========================================================================
  section("12e. approve_draft: every guard has a failing fixture");

  const draftArgs = (draftId: string, fp: string, prospectId = P.due) => ({ prospect_id: prospectId, draft_id: draftId, fingerprint: fp, authorizing_quote: "approve the email draft" });
  {
    const db = commandDb();
    const shown = await shownDraftCard(db);
    await seedShownCards(db, [shown.card]);
    const { ctx, fake } = cmdCtx(db, "Yes, approve the email draft.");
    const o = await runCommand("approve_draft", draftArgs(DR.email, shown.fp(DR.email)), ctx);
    ok("a draft shown in an earlier turn with the same fingerprint is approved: approveDraft called once with (draftId, prospectId)", done(o) && fake.calls.length === 1 && fake.calls[0].name === "approveDraft" && fake.calls[0].args[0] === DR.email && fake.calls[0].args[1] === P.due);
    ok("... the card says approving is not sending, and offers no restore", /not sending/i.test((cardOf(o) as { summary: string }).summary) && (cardOf(o) as { restorable: boolean }).restorable === false);
    ok("... and the draft really is approved in the fake", db.rows("drafts").find((d) => d.id === DR.email)!.status === "approved");
  }
  {
    // A matrix: each guard against its own fixture, each with a displayed card.
    const cases: { label: string; id: string; mutate?: (db: FakeDb) => void; prospect?: string; code: string }[] = [
      { label: "an approved draft (approveDraft itself has no status guard)", id: DR.approved, code: "not_a_draft" },
      { label: "a delivered draft", id: DR.sent, code: "already_sent" },
      { label: "a draft with no text", id: DR.empty, code: "empty" },
      { label: "a draft that belongs to a different prospect than the one named", id: DR.elsewhere, code: "wrong_prospect" },
      { label: "a draft that does not exist", id: "80000000-0000-4000-8000-0000000000ff", code: "not_found" },
    ];
    for (const c of cases) {
      const db = commandDb();
      const row = db.rows("drafts").find((d) => d.id === c.id);
      const fp = row ? draftFingerprint({ kind: row.kind, subject: row.subject, content: row.content }) : sha256Hex("ghost");
      await seedShownCards(db, [{ kind: "draft_review", drafts: [{ draftId: c.id, fingerprint: fp }] }]);
      const { ctx, fake } = cmdCtx(db, "Yes, approve the email draft.");
      const o = await runCommand("approve_draft", draftArgs(c.id, fp, c.prospect ?? P.due), ctx);
      ok(`guard: ${c.label} is refused (${c.code}) and approveDraft is not called`, refused(o, c.code) && fake.calls.length === 0 && writesOutsideAudit(db).length === 0, JSON.stringify(mr(o)));
    }
    // A card from a DIFFERENT draft does not satisfy the gate; changed text since.
    const db = commandDb();
    const shown = await shownDraftCard(db);
    await seedShownCards(db, [shown.card]);
    const wrong = cmdCtx(db, "Yes, approve the email draft.");
    const o1 = await runCommand("approve_draft", draftArgs(DR.call, shown.fp(DR.email)), wrong.ctx);
    ok("a draft id paired with ANOTHER draft's fingerprint was never displayed together and is refused", refused(o1, "not_shown_earlier") && wrong.fake.calls.length === 0);
    db.rows("drafts").find((d) => d.id === DR.email)!.content = "Edited after it was shown.";
    const changed = cmdCtx(db, "Yes, approve the email draft.");
    const o2 = await runCommand("approve_draft", draftArgs(DR.email, shown.fp(DR.email)), changed.ctx);
    ok("draft text changed since it was shown: the fingerprint is recomputed, differs, and approveDraft is not called", refused(o2, "changed_since_shown") && changed.fake.calls.length === 0);
  }
  {
    // The narrow race approveDraft cannot close: text changes in the instant of approval.
    const db = commandDb();
    const shown = await shownDraftCard(db);
    await seedShownCards(db, [shown.card]);
    const fake = fakeEntryPoints(db, {
      approveDraft: async (id: string) => {
        const r = db.rows("drafts").find((d) => d.id === id)!;
        r.content = "Changed in another tab at the same instant.";
        r.status = "approved";
      },
    });
    const { ctx } = cmdCtx(db, "Yes, approve the email draft.", {}, fake);
    const o = await runCommand("approve_draft", draftArgs(DR.email, shown.fp(DR.email)), ctx);
    ok("if the text changed at the instant of approval the result carries a warning rather than a clean approval", done(o) && /not exactly what was shown/.test(String(mr(o).warning)));
  }

  // ===========================================================================
  section("12f. entry points that throw, return an error, or redirect");

  {
    const db = commandDb();
    const s = await shownStrategyCard(db);
    await seedShownCards(db, [s.card]);
    const fake = fakeEntryPoints(db, { approveStrategy: async () => { throw new Error("update failed: permission denied"); } });
    const { ctx } = cmdCtx(db, "Approve the Due Soon strategy.", {}, fake);
    const o = await runCommand("approve_strategy", approveArgs(SR.ready, s.fingerprint), ctx);
    ok("a throwing entry point is a `failed` result and the model is told it was NOT done", o.ok && mr(o).status === "failed" && /permission denied/.test(String(mr(o).reason)) && !/approved/.test(String(mr(o).summary ?? "")));
    ok("... and a terminal `failed` row follows the `started` row, exactly once", events(db).map((e) => e.event).join(",") === "started,failed");
    const redirect = fakeEntryPoints(db, { approveStrategy: async () => { throw redirectError("/login"); } });
    const c2 = cmdCtx(db, "Approve the Due Soon strategy.", {}, redirect);
    const o2 = await runCommand("approve_strategy", approveArgs(SR.ready, s.fingerprint), c2.ctx);
    ok("a NEXT_REDIRECT (signed out) is handled as a plain failure, not an unhandled throw", o2.ok && mr(o2).status === "failed" && /signed in/i.test(String(mr(o2).reason)));
    const silent = fakeEntryPoints(db, { approveStrategy: async () => undefined });
    const c3 = cmdCtx(db, "Approve the Due Soon strategy.", {}, silent);
    const o3 = await runCommand("approve_strategy", approveArgs(SR.ready, s.fingerprint), c3.ctx);
    ok("an entry point that returns without writing is NOT reported as done (the approval is confirmed against the row)", o3.ok && mr(o3).status === "failed");
    const errReturn = fakeEntryPoints(db, { updateDraft: async () => ({ error: "Draft not found." }) });
    const c4 = cmdCtx(db, "Change the email to say hello.", {}, errReturn);
    const o4 = await runCommand("edit_draft", { draft_id: DR.email, content: "Hello there.", authorizing_quote: "Change the email to say hello" }, c4.ctx);
    ok("an {error} return is a `failed` result carrying the entry point's own words", o4.ok && mr(o4).status === "failed" && /Draft not found/.test(String(mr(o4).reason)));
    const noLoad = cmdCtx(db, "Change the email to say hello.", { loadEntryPoints: async () => { throw new Error("module graph failed"); } });
    const o5 = await runCommand("edit_draft", { draft_id: DR.call, content: "Call notes v2", authorizing_quote: "Change the email to say hello" }, noLoad.ctx);
    ok("entry points that cannot be loaded fail the command after the record, and say nothing was done", o5.ok && mr(o5).status === "failed" && db.rows("drafts").find((d) => d.id === DR.call)!.content !== "Call notes v2");
  }

  // ===========================================================================
  section("12g. add_prospect");

  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Add Harvest Foundation as a prospect, channel private foundation, in Austin.");
    const o = await runCommand(
      "add_prospect",
      { name: "Harvest Foundation", channel: "foundation", location: "Austin, TX", authorizing_quote: "Add Harvest Foundation as a prospect" },
      ctx
    );
    ok("a valid add executes through createProspect with exactly the validated fields", done(o) && fake.calls.length === 1 && fake.calls[0].name === "createProspect");
    const form = fake.calls[0].args[0] as Record<string, string>;
    ok("the form has name, channel and location -- and NO stage key, so the entry point's own default lands it in Discovery", form.name === "Harvest Foundation" && form.channel === "foundation" && form.location === "Austin, TX" && !("stage" in form) && !("stage_reason" in form));
    const created = db.rows("prospects").find((p) => p.name === "Harvest Foundation")!;
    ok("the new prospect's id is RETURNED (read from the redirect, confirmed against the row) and the stage is Discovery", mr(o).prospectId === created.id && created.stage === "discovery" && (cardOf(o) as { href: string }).href === `/prospects/${created.id}`);
    ok("the terminal row carries the new subject", events(db).map((e) => e.event).join(",") === "started,executed" && events(db)[1].subject_id === created.id && events(db)[1].subject_table === "prospects");
  }
  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Please add  due SOON fund  as a prospect.");
    const o = await runCommand("add_prospect", { name: "due SOON  fund", channel: "foundation", authorizing_quote: "add  due SOON fund  as a prospect" }, ctx);
    ok("an exact, case-insensitive, whitespace-normalised duplicate name is refused, with the existing prospect's link", refused(o, "duplicate") && mr(o).existingProspectId === P.due && (cardOf(o) as { href: string }).href === `/prospects/${P.due}` && fake.calls.length === 0);
    const near = await runCommand("add_prospect", { name: "Due Soon", channel: "foundation", authorizing_quote: "add  due SOON fund" }, ctx);
    ok("a near-match is NOT treated as a duplicate (exact match only)", done(near) && fake.calls.length === 1);
  }
  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Add Harvest Foundation as a prospect.");
    const o = await runCommand("add_prospect", { name: "Harvest Foundation", channel: "big_whale", authorizing_quote: "Add Harvest Foundation as a prospect" }, ctx);
    ok("a channel outside the seven is refused at the choke point's own validation", refused(o, "invalid_arguments") && fake.calls.length === 0);
    const viaDispatch = await dispatchToolCall(
      { name: "add_prospect", argumentsRaw: JSON.stringify({ name: "X Fund", channel: "stage_two", stage: "proposal", authorizing_quote: "Add X Fund as a prospect" }) },
      ctx
    );
    ok("... and a stage argument (starting elsewhere is a stage decision) is refused by the dispatcher as an unknown argument", !viaDispatch.ok && viaDispatch.errorKind === "validation" && fake.calls.length === 0);
    const missing = await dispatchToolCall({ name: "add_prospect", argumentsRaw: JSON.stringify({ name: "X Fund", channel: "foundation" }) }, ctx);
    ok("a missing authorizing_quote is refused by the dispatcher before the handler", !missing.ok && missing.errorKind === "validation");
    const ctrl = await runCommand("add_prospect", { name: "Bad\u0000Name", channel: "foundation", authorizing_quote: "Add Harvest Foundation" }, ctx);
    ok("a control character in the name is refused", refused(ctrl, "invalid_arguments") && fake.calls.length === 0);
  }
  {
    const db = commandDb();
    const fake = fakeEntryPoints(db, { createProspect: async () => { throw redirectError("/login"); } });
    const { ctx } = cmdCtx(db, "Add Harvest Foundation as a prospect.", {}, fake);
    const o = await runCommand("add_prospect", { name: "Harvest Foundation", channel: "foundation", authorizing_quote: "Add Harvest Foundation as a prospect" }, ctx);
    ok("a redirect to /login is a failure -- the prospect is NOT reported as added", o.ok && mr(o).status === "failed" && !db.rows("prospects").some((p) => p.name === "Harvest Foundation"));
    ok("the redirect parser reads a prospect id and nothing else", prospectIdFromRedirect(redirectError("/prospects/00000000-0000-4000-8000-000000000009?tab=activity&logOpen=1")) === "00000000-0000-4000-8000-000000000009" && prospectIdFromRedirect(redirectError("/login")) === null && prospectIdFromRedirect(new Error("x")) === null && isRedirectErrorCmd(redirectError("/x")));
  }

  // ===========================================================================
  section("12h. draft commands: edit, revise, reopen, generate");

  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Make the email warmer: 'Hello friend, thank you for your time.'");
    const before = db.rows("drafts").find((d) => d.id === DR.email)!;
    const prevSubject = before.subject;
    const prevContent = before.content;
    const o = await runCommand(
      "edit_draft",
      { draft_id: DR.email, subject: "A warm hello", content: "Hello friend, thank you for your time.", authorizing_quote: "Make the email warmer" },
      ctx
    );
    ok("edit_draft calls updateDraft with the row's own prospect id, the new subject and the complete new text", done(o) && fake.calls.length === 1 && JSON.stringify(fake.calls[0].args) === JSON.stringify([DR.email, P.due, "A warm hello", "Hello friend, thank you for your time."]));
    const started = events(db).find((e) => e.event === "started")!;
    ok("the PREVIOUS subject and text are captured on the started row (born before the effect)", started.previous.subject === prevSubject && started.previous.content === prevContent, JSON.stringify(started.previous));
    ok("the result card shows what it replaced, in full, and offers Restore", cardOf(o)?.kind === "command_result" && JSON.stringify((cardOf(o) as { replaced: unknown[] }).replaced).includes(prevContent) && (cardOf(o) as { restorable: boolean }).restorable === true);
    ok("the audit payload holds the exact new subject and text, and the quote is the user's words", started.payload.content === "Hello friend, thank you for your time." && started.quote === "Make the email warmer" && !("authorizing_quote" in started.payload));
    const noop = await runCommand("edit_draft", { draft_id: DR.email, subject: "A warm hello", content: "Hello friend, thank you for your time.", authorizing_quote: "Make the email warmer" }, cmdCtx(db, "Make the email warmer", {}, fake).ctx);
    ok("an edit that changes nothing is refused (no_change), not recorded as a command", refused(noop, "no_change") && fake.calls.length === 1);
  }
  {
    const db = commandDb();
    const msg = "Edit the drafts as I said.";
    const { ctx, fake } = cmdCtx(db, msg);
    const q = "Edit the drafts as I said";
    const approved = await runCommand("edit_draft", { draft_id: DR.approved, content: "New text", authorizing_quote: q }, ctx);
    const sent = await runCommand("edit_draft", { draft_id: DR.sent, content: "New text", authorizing_quote: q }, ctx);
    const proposal = await runCommand("edit_draft", { draft_id: DR.proposal, content: "# New\nx", authorizing_quote: q }, ctx);
    const callWithSubject = await runCommand("edit_draft", { draft_id: DR.call, subject: "A subject", content: "New notes", authorizing_quote: q }, ctx);
    const missing = await runCommand("edit_draft", { draft_id: "80000000-0000-4000-8000-0000000000ff", content: "New text", authorizing_quote: q }, ctx);
    ok("an approved draft is refused (not_a_draft): its text is locked", refused(approved, "not_a_draft"));
    ok("a delivered draft is refused (already_sent)", refused(sent, "already_sent"));
    ok("a proposal is refused (wrong_kind): it is revised with feedback instead", refused(proposal, "wrong_kind"));
    ok("call-prep notes with a subject are refused (no_subject)", refused(callWithSubject, "no_subject"));
    ok("a draft that does not exist is 'not found'", refused(missing, "not_found"));
    ok("every one of those refused WITHOUT calling updateDraft, and no draft changed", fake.calls.length === 0 && writesOutsideAudit(db).length === 0);
    ok(`text beyond ${MAX_DRAFT_TEXT_CHARS} characters is refused`, refused(await runCommand("edit_draft", { draft_id: DR.email, content: "x".repeat(MAX_DRAFT_TEXT_CHARS + 1), authorizing_quote: q }, ctx), "invalid_arguments"));
  }
  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Revise the proposal: lead with the outcomes.");
    const before = db.rows("drafts").find((d) => d.id === DR.proposal)!.content;
    const o = await runCommand("revise_draft_with_feedback", { draft_id: DR.proposal, feedback: "Lead with the outcomes.", authorizing_quote: "Revise the proposal" }, ctx);
    ok("revise_draft_with_feedback calls the existing reviseDraftWithFeedback with the draft id and the feedback", done(o) && fake.calls.length === 1 && fake.calls[0].name === "reviseDraftWithFeedback" && JSON.stringify(fake.calls[0].args) === JSON.stringify([DR.proposal, "Lead with the outcomes."]));
    ok("... the previous text is captured before the effect and the card is restorable", events(db)[0].previous.content === before && (cardOf(o) as { restorable: boolean }).restorable === true);
    const q = "Revise the proposal";
    const email = await runCommand("revise_draft_with_feedback", { draft_id: DR.email, feedback: "Warmer", authorizing_quote: q }, ctx);
    const appr = await runCommand("revise_draft_with_feedback", { draft_id: DR.approved, feedback: "Warmer", authorizing_quote: q }, ctx);
    ok("an outreach draft or an approved draft is refused before the entry point", refused(email, "wrong_kind") && refused(appr, "not_a_draft") && fake.calls.length === 1);
    const longFb = await runCommand("revise_draft_with_feedback", { draft_id: DR.deck, feedback: "x".repeat(MAX_STRATEGY_FEEDBACK_CHARS + 1), authorizing_quote: q }, ctx);
    ok("feedback over the named cap is refused", refused(longFb, "invalid_arguments"));
  }
  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Reopen the approved email for editing.");
    const o = await runCommand("unapprove_draft", { draft_id: DR.approved, authorizing_quote: "Reopen the approved email" }, ctx);
    ok("unapprove_draft calls unapproveDraft(draftId, the row's prospect id) and the text is unchanged", done(o) && fake.calls[0].name === "unapproveDraft" && fake.calls[0].args[1] === P.due && db.rows("drafts").find((d) => d.id === DR.approved)!.content === "Approved body.");
    const notApproved = await runCommand("unapprove_draft", { draft_id: DR.email, authorizing_quote: "Reopen the approved email" }, ctx);
    const sent = await runCommand("unapprove_draft", { draft_id: DR.sent, authorizing_quote: "Reopen the approved email" }, ctx);
    ok("a draft that is not approved, or has been delivered, is refused before the entry point", refused(notApproved, "not_approved") && refused(sent, "already_sent") && fake.calls.length === 1);
  }
  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Write me an intro email for Due Soon Fund.");
    const q = "Write me an intro email";
    const noApproved = await runCommand("generate_outreach_draft", { prospect_id: P.later, kind: "intro_email", authorizing_quote: q }, ctx);
    ok("generate_outreach_draft with no approved strategy on the prospect's latest run is refused", refused(noApproved, "no_approved_strategy") && fake.calls.length === 0);
    db.rows("strategy_runs").find((r) => r.id === SR.ready)!.approved_strategy = STRATEGY_FIXTURE;
    const o = await runCommand("generate_outreach_draft", { prospect_id: P.due, kind: "intro_email", authorizing_quote: q }, ctx);
    ok("with an approved strategy it calls generateDraft(prospect, the LATEST run's id, kind) once", done(o) && fake.calls.length === 1 && JSON.stringify(fake.calls[0].args) === JSON.stringify([P.due, SR.ready, "intro_email"]));
    const newId = mr(o).draftId as string;
    ok("the new draft's id is identified (a draft that did not exist before) and shown in full on a second card", !!newId && !([DR.email, DR.call, DR.proposal].includes(newId)) && (o.ok && o.cards?.[0]?.kind === "draft_review"));
    const bad = await runCommand("generate_outreach_draft", { prospect_id: P.due, kind: "proposal", authorizing_quote: q }, ctx);
    ok("only the two outreach kinds can be requested", refused(bad, "invalid_arguments") && fake.calls.length === 1);
  }

  // ===========================================================================
  section("12i. strategy push-back, logging, next action, ask amount");

  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Push back on the Due Soon strategy: the ask is too high.");
    const o = await runCommand("push_back_on_strategy", { run_id: SR.ready, feedback: "The ask is too high.", authorizing_quote: "Push back on the Due Soon strategy" }, ctx);
    ok("push_back_on_strategy calls reviseStrategyWithFeedback(runId, feedback) and returns the NEW run's id", done(o) && fake.calls.length === 1 && JSON.stringify(fake.calls[0].args) === JSON.stringify([SR.ready, "The ask is too high."]) && typeof mr(o).newRunId === "string" && mr(o).newRunId !== SR.ready);
    ok("the revision is shown in full, in the same turn, as a strategy card -- so it can be approved in a later one", o.ok && o.cards?.some((c) => c.kind === "strategy_review" && (c as { runId: string | null }).runId === mr(o).newRunId) === true);
    const original = db.rows("strategy_runs").find((r) => r.id === SR.ready)!;
    ok("the original run is untouched", JSON.stringify(original.strategy) === JSON.stringify(STRATEGY_FIXTURE) && original.approved_strategy === null);
    const ghost = await runCommand("push_back_on_strategy", { run_id: "70000000-0000-4000-8000-0000000000ff", feedback: "x", authorizing_quote: "Push back on the Due Soon strategy" }, ctx);
    ok("a run id the session cannot see is 'not found'", refused(ghost, "not_found") && fake.calls.length === 1);
  }
  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Log a call with Due Soon Fund today: they want a one-pager. Next action: send the one-pager by Friday.");
    const today = new Date().toISOString().slice(0, 10);
    const q1 = "Log a call with Due Soon Fund today";
    const log = await runCommand("log_prospect_interaction", { prospect_id: P.due, kind: "call", summary: "They want a one-pager.", occurred_at: today, authorizing_quote: q1 }, ctx);
    ok("log_prospect_interaction calls logInteraction with the validated fields", done(log) && JSON.stringify(fake.calls[0].args) === JSON.stringify([P.due, "call", "They want a one-pager.", today]));
    const future = await runCommand("log_prospect_interaction", { prospect_id: P.due, kind: "call", summary: "x", occurred_at: "2999-01-01", authorizing_quote: q1 }, ctx);
    ok("a future date is refused", refused(future, "invalid_arguments"));
    const sup = await runCommand("log_supporter_interaction", { supporter_id: S.light, kind: "note", summary: "Thanked them.", occurred_at: today, authorizing_quote: q1 }, ctx);
    ok("log_supporter_interaction calls logSupporterInteraction", done(sup) && fake.calls[1].name === "logSupporterInteraction");
    const ghost = await runCommand("log_supporter_interaction", { supporter_id: "20000000-0000-4000-8000-0000000000ff", kind: "note", summary: "x", occurred_at: today, authorizing_quote: q1 }, ctx);
    ok("an unseen supporter is 'not found'", refused(ghost, "not_found"));
    const next = await runCommand("set_prospect_next_action", { prospect_id: P.due, next_action: "Send the one-pager", next_action_due: "2026-10-16", authorizing_quote: "send the one-pager by Friday" }, ctx);
    ok("set_prospect_next_action calls updateNextAction and the card shows what it replaced", done(next) && fake.calls[2].name === "updateNextAction" && JSON.stringify((cardOf(next) as { replaced: { value: string }[] }).replaced).includes("Call the program officer"));
    ok("... the previous next action and due date are captured on the started row", events(db).find((e) => e.ability === "set_prospect_next_action" && e.event === "started")!.previous.next_action === "Call the program officer");
  }
  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Set the ask for Due Soon Fund to $40,000.");
    const q = "Set the ask for Due Soon Fund to $40,000";
    const o = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 40000, authorizing_quote: q }, ctx);
    ok("set_prospect_ask_amount calls updateAskAmount with the number, and records the previous amount", done(o) && JSON.stringify(fake.calls[0].args) === JSON.stringify([P.due, 40000]) && events(db)[0].previous.ask_amount === 25000);
    const bad: Record<string, unknown>[] = [
      { ask_amount: -5 },
      { ask_amount: Number.NaN },
      { ask_amount: Number.POSITIVE_INFINITY },
      { ask_amount: 2_000_000_000 },
      { ask_amount: "40000" },
      { ask_amount: null },
      {},
      { ask_amount: 5, clear_ask_amount: true },
      { clear_ask_amount: "yes" },
    ];
    const results: Outcome[] = [];
    for (const extra of bad) results.push(await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ...extra, authorizing_quote: q }, cmdCtx(db, "Set the ask for Due Soon Fund to $40,000.", {}, fake).ctx));
    ok("a negative, NaN, infinite, absurdly large, string, null or missing amount (or amount AND clear together) is refused", results.every((r) => refused(r, "invalid_arguments")) && fake.calls.length === 1);
    const clearNothing = await runCommand("set_prospect_ask_amount", { prospect_id: P.noaction, clear_ask_amount: true, authorizing_quote: q }, cmdCtx(db, "Set the ask for Due Soon Fund to $40,000.", {}, fake).ctx);
    ok("clearing an ask that is already empty is refused as no change", refused(clearNothing, "no_change"));
    const clearReal = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, clear_ask_amount: true, authorizing_quote: q }, cmdCtx(db, "Set the ask for Due Soon Fund to $40,000.", {}, fake).ctx);
    ok("clear_ask_amount clears it through updateAskAmount(prospect, null) and records the previous amount", done(clearReal) && JSON.stringify(fake.calls[1].args) === JSON.stringify([P.due, null]));
  }

  // ===========================================================================
  section("12j. the record is born BEFORE the effect; the outcome is written once");

  {
    const db = commandDb();
    const { ctx } = cmdCtx(db, "Set the ask for Due Soon Fund to $40,000.");
    await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 40000, authorizing_quote: "Set the ask for Due Soon Fund" }, ctx);
    const order = db.log
      .filter((l) => l.table === "assistant_command_events" || l.table === "__entry_point__")
      .map((l) => (l.table === "__entry_point__" ? `entry:${l.columns}` : `${l.op}:${l.payload.event}`));
    ok("the started row is written, THEN the entry point is called, THEN exactly one terminal row", JSON.stringify(order) === JSON.stringify(["insert:started", "entry:updateAskAmount", "insert:executed"]), JSON.stringify(order));
    const [started, terminal] = events(db);
    ok("both rows carry the same command id, thread, user message and assistant turn", started.command_id === terminal.command_id && started.thread_id === CT.thread && started.user_message_id === CT.user && started.assistant_message_id === CT.asst && terminal.assistant_message_id === CT.asst);
    ok("the started row holds ability, subject, exact payload, the quote and what will be replaced; the terminal row holds the result", started.ability === "set_prospect_ask_amount" && started.subject_table === "prospects" && started.subject_id === P.due && started.payload.ask_amount === 40000 && started.quote === "Set the ask for Due Soon Fund" && started.previous.ask_amount === 25000 && terminal.result !== null && terminal.previous === null, JSON.stringify({ started, terminal }));
    ok("origin is 'command' and no row is ever updated or deleted by the choke point", started.origin === "command" && db.log.filter((l) => l.table === "assistant_command_events" && (l.op === "update" || l.op === "delete")).length === 0);
  }
  {
    // A started row that cannot be written means NO effect.
    const db = commandDb();
    db.insertErrors["assistant_command_events"] = { code: "42501", message: "RLS-DETAIL-SECRET" };
    const { ctx, fake } = cmdCtx(db, "Set the ask for Due Soon Fund to $40,000.");
    const o = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 40000, authorizing_quote: "Set the ask for Due Soon Fund" }, ctx);
    ok("if the record cannot be written, the command does not run, and the refusal leaks no database text", refused(o, "record_failed") && fake.calls.length === 0 && !JSON.stringify(o).includes("RLS-DETAIL-SECRET"));
    // Table absent (migration 0081 not applied): plain setup-pending, nothing written.
    const db2 = commandDb();
    db2.insertErrors["assistant_command_events"] = { code: "PGRST205", message: "Could not find the table 'public.assistant_command_events' in the schema cache" };
    const c2 = cmdCtx(db2, "Set the ask for Due Soon Fund to $40,000.");
    const o2 = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 40000, authorizing_quote: "Set the ask for Due Soon Fund" }, c2.ctx);
    ok("table absent: 'setup pending -- apply migration 0081', no entry point called, and NO write to any other table", refused(o2, "setup_pending") && /0081/.test(String(mr(o2).reason)) && c2.fake.calls.length === 0 && writesOutsideAudit(db2).length === 0);
    ok("... for a gate as well (the setup message, not a silent skip)", await (async () => {
      const db3 = commandDb();
      const s = await shownStrategyCard(db3);
      await seedShownCards(db3, [s.card]);
      db3.insertErrors["assistant_command_events"] = { code: "42P01", message: 'relation "assistant_command_events" does not exist' };
      const c3 = cmdCtx(db3, "Approve the Due Soon strategy.");
      const r = await runCommand("approve_strategy", approveArgs(SR.ready, s.fingerprint), c3.ctx);
      return refused(r, "setup_pending") && c3.fake.calls.length === 0;
    })());
  }

  // ===========================================================================
  section("12k. time budget: a long ability refuses BEFORE it starts when the turn cannot finish it");

  {
    const longCases: [string, Record<string, unknown>, number][] = [
      ["revise_draft_with_feedback", { draft_id: DR.proposal, feedback: "Warmer" }, REVISE_DRAFT_MAX_MS],
      ["push_back_on_strategy", { run_id: SR.ready, feedback: "Lower the ask" }, PUSH_BACK_MAX_MS],
    ];
    for (const [name, args, max] of longCases) {
      const db = commandDb();
      const tight = cmdCtx(db, "Please do the long thing now.", { remainingMs: () => max + TIME_MARGIN_MS - 1 });
      const o = await runCommand(name, { ...args, authorizing_quote: "do the long thing" }, tight.ctx);
      ok(`${name}: with less than its maximum plus the margin left it is refused (not_enough_time), nothing started`, refused(o, "not_enough_time") && tight.fake.calls.length === 0 && events(db).every((e) => e.event === "refused"));
      const enough = cmdCtx(db, "Please do the long thing now.", { remainingMs: () => max + TIME_MARGIN_MS });
      const o2 = await runCommand(name, { ...args, authorizing_quote: "do the long thing" }, enough.ctx);
      ok(`${name}: with exactly its maximum plus the margin left it runs`, done(o2) && enough.fake.calls.length === 1);
    }
    const db = commandDb();
    db.rows("strategy_runs").find((r) => r.id === SR.ready)!.approved_strategy = STRATEGY_FIXTURE;
    const gen = cmdCtx(db, "Please do the long thing now.", { remainingMs: () => GENERATE_DRAFT_MAX_MS + TIME_MARGIN_MS - 1 });
    const o = await runCommand("generate_outreach_draft", { prospect_id: P.due, kind: "call_prep", authorizing_quote: "do the long thing" }, gen.ctx);
    ok("generate_outreach_draft is a long ability too", refused(o, "not_enough_time") && gen.fake.calls.length === 0);
    // Through the real loop: the figure comes from the loop's own clock and deadline.
    {
      const db2 = commandDb();
      let t = 0;
      const eps2 = fakeEntryPoints(db2);
      const { ctx: loopCtx } = cmdCtx(db2, "Please push back on the Due Soon strategy: lower the ask.", {}, eps2);
      const { call } = scripted([
        (req) => {
          void req;
          t += 200_000; // 200 s into a 240 s deadline: 40 s left, push-back needs 75 + 10
          return reply({ toolCalls: [{ id: "a", name: "get_dashboard_summary", args: "{}" }] });
        },
        reply({ toolCalls: [{ id: "b", name: "push_back_on_strategy", args: JSON.stringify({ run_id: SR.ready, feedback: "Lower the ask.", authorizing_quote: "push back on the Due Soon strategy" }) }] }),
        reply({ content: "That needs its own message." }),
      ]);
      const out = await runAssistantLoop({ aiRunId: "run-1", system: "S", history: [{ role: "user", content: "x" }], ctx: loopCtx, usage: newUsage(), call, clock: () => t });
      ok(
        "through the loop: with 40 s of the deadline left, push_back_on_strategy is refused before it starts (the loop's own clock feeds the choke point)",
        out.cards.some((c) => c.kind === "refusal" && /not enough time/i.test((c as { reason: string }).reason)) && eps2.calls.length === 0 && events(db2).every((e) => e.event === "refused")
      );
    }
    const quick = cmdCtx(db, "Set the ask for Due Soon Fund to 1.", { remainingMs: () => 0 });
    const q = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 1, authorizing_quote: "Set the ask for Due Soon Fund" }, quick.ctx);
    ok("a quick command is not subject to the long-ability check", done(q));
  }

  // ===========================================================================
  section("12l. through the dispatcher: allowlisted results, cards, and no row ever reaches the model");

  {
    const db = commandDb();
    const { ctx } = cmdCtx(db, "Please set the ask for Due Soon Fund to 31000.");
    const r = await dispatchToolCall(
      { name: "set_prospect_ask_amount", argumentsRaw: JSON.stringify({ prospect_id: P.due, ask_amount: 31000, authorizing_quote: "set the ask for Due Soon Fund to 31000" }) },
      ctx
    );
    const keys = collectKeys(JSON.parse(r.toolMessage));
    ok("a command's result to the model uses only its allowlisted keys, with nothing stripped", r.ok && r.strippedKeys.length === 0 && [...keys].every((k) => findAbility("set_prospect_ask_amount")!.allowlist.includes(k)), [...keys].join(","));
    ok("the user gets a command-result card with the quoted words", r.card?.kind === "command_result" && (r.card as { quote: string }).quote.toLowerCase() === "set the ask for due soon fund to 31000");
    ok("the model is told the status and the code-written summary, not a row", JSON.parse(r.toolMessage).status === "done" && !leaks(r.toolMessage).length);
    const refusedCall = await dispatchToolCall(
      { name: "set_prospect_ask_amount", argumentsRaw: JSON.stringify({ prospect_id: P.due, ask_amount: 1, authorizing_quote: "completely different words" }) },
      ctx
    );
    ok("a refusal reaches the model as a structured result and the user as a card", JSON.parse(refusedCall.toolMessage).status === "refused" && JSON.parse(refusedCall.toolMessage).nothingWasDone === true && refusedCall.card?.kind === "refusal");
    const gateless = await dispatchToolCall({ name: "approve_strategy", argumentsRaw: JSON.stringify({ prospect_id: P.due, run_id: SR.ready, fingerprint: "a".repeat(64), authorizing_quote: "Please set the ask" }) }, ctx);
    ok("a gate called through the dispatcher with no earlier display is refused", JSON.parse(gateless.toolMessage).status === "refused" && JSON.parse(gateless.toolMessage).code === "not_shown_earlier");
  }

  // ===========================================================================
  section("12m. fingerprints: one pure function, stable under key order and edge whitespace, sensitive to words");

  {
    const a = strategyFingerprint({ ...STRATEGY_FIXTURE }, { ...INTEL_FIXTURE });
    const reordered = strategyFingerprint(
      {
        evidence_to_highlight: STRATEGY_FIXTURE.evidence_to_highlight,
        key_talking_points: STRATEGY_FIXTURE.key_talking_points,
        rationale: STRATEGY_FIXTURE.rationale,
        ask_positioning: STRATEGY_FIXTURE.ask_positioning,
        outreach_approach: STRATEGY_FIXTURE.outreach_approach,
      },
      { focus_areas: INTEL_FIXTURE.focus_areas, typical_grant_size: INTEL_FIXTURE.typical_grant_size, geographic_focus: INTEL_FIXTURE.geographic_focus, funder_type: INTEL_FIXTURE.funder_type, location: INTEL_FIXTURE.location }
    );
    ok("a strategy's fingerprint is stable under key order", a === reordered && /^[0-9a-f]{64}$/.test(a));
    const trimmed = strategyFingerprint(
      { ...STRATEGY_FIXTURE, rationale: `  ${STRATEGY_FIXTURE.rationale}\n`, key_talking_points: STRATEGY_FIXTURE.key_talking_points.map((t) => ` ${t} `) },
      { ...INTEL_FIXTURE, location: `${INTEL_FIXTURE.location}  ` }
    );
    ok("... and under leading and trailing whitespace on any string", a === trimmed);
    ok("... but not under a change of words", a !== strategyFingerprint({ ...STRATEGY_FIXTURE, rationale: "Their stated giving priorities match our outcomes!" }, INTEL_FIXTURE) && a !== strategyFingerprint(STRATEGY_FIXTURE, { ...INTEL_FIXTURE, location: "Austin, TX" }));
    ok("... nor under a re-ordered LIST (order is content)", a !== strategyFingerprint({ ...STRATEGY_FIXTURE, key_talking_points: [...STRATEGY_FIXTURE.key_talking_points].reverse() }, INTEL_FIXTURE));
    ok("a sparse stored row hashes the same way in the read and the executor (missing fields normalise)", strategyFingerprint({ rationale: "x" }, null) === strategyFingerprint({ rationale: "x", key_talking_points: [], outreach_approach: "" }, {}));
    ok("a draft's fingerprint covers kind, subject and text, stable under key order and edge whitespace", draftFingerprint({ kind: "intro_email", subject: "S", content: "Body" }) === draftFingerprint({ content: " Body\n", subject: " S", kind: "intro_email" }) && draftFingerprint({ kind: "intro_email", subject: "S", content: "Body" }) !== draftFingerprint({ kind: "intro_email", subject: "S", content: "Body." }));
    ok("... and a null subject differs from an empty one", draftFingerprint({ kind: "call_prep", subject: null, content: "x" }) !== draftFingerprint({ kind: "call_prep", subject: "", content: "x" }));
    ok("canonicalJson sorts keys at every depth and drops undefined members", canonicalJson({ b: { z: 1, a: [{ y: 2, x: undefined, w: 3 }] }, a: " t " }) === '{"a":"t","b":{"a":[{"w":3,"y":2}],"z":1}}');
    // The read and the executor use the same function: pinned by source.
    const readsSrc = code("lib/assistant/reads.ts");
    const execSrc = code("lib/assistant/command-exec.ts");
    ok("the reads that produce a card and the executors that recompute both import the fingerprint functions from ONE module", /from "\.\/fingerprint"/.test(readsSrc) && /from "\.\/fingerprint"/.test(execSrc) && /strategyFingerprint\(/.test(readsSrc) && /strategyFingerprint\(/.test(execSrc) && /draftFingerprint\(/.test(readsSrc) && /draftFingerprint\(/.test(execSrc));
    ok(
      "the sha256 is computed in one file under lib/assistant: fingerprint.ts",
      JSON.stringify(ASSISTANT_LIB.filter((f) => /createHash\(/.test(code(f))).sort()) === JSON.stringify(["lib/assistant/fingerprint.ts"])
    );
  }

  // ===========================================================================
  section("12n. cards render the content IN FULL: what a gate is pinned to is what was shown");

  {
    const db = commandDb();
    const long = "word ".repeat(2000);
    const row = db.rows("strategy_runs").find((r) => r.id === SR.ready)!;
    row.strategy = { outreach_approach: long, ask_positioning: long + "!", rationale: long + "?", key_talking_points: ["t".repeat(5000)], evidence_to_highlight: ["e".repeat(5000)] };
    row.organization_intel = { ...INTEL_FIXTURE, focus_areas: ["f".repeat(3000)] };
    const r = await getStrategyForReview(db.client(), { prospectId: P.due });
    ok("the strategy card carries every fingerprinted field untruncated (10,000-character fields)", r.ok && r.card.kind === "strategy_review" && r.card.strategy!.outreach_approach === long && r.card.strategy!.ask_positioning === long + "!" && r.card.strategy!.key_talking_points[0].length === 5000 && r.card.organizationIntel!.focus_areas[0].length === 3000);
    ok("... and the card's fingerprint IS the fingerprint of the stored row (the read and the recompute agree)", r.ok && r.card.kind === "strategy_review" && r.card.fingerprint === strategyFingerprint(row.strategy, row.organization_intel));
    const dr = db.rows("drafts").find((d) => d.id === DR.proposal)!;
    dr.content = "# Section\n" + "paragraph ".repeat(3000);
    const g = await getDrafts(db.client(), { prospectId: P.due, draftId: DR.proposal });
    ok("the draft card carries the whole text of a 30,000-character draft", g.ok && g.card.kind === "draft_review" && g.card.drafts[0].content === dr.content && g.card.drafts[0].fingerprint === draftFingerprint({ kind: "proposal", subject: null, content: dr.content }));
    ok("a draft too large for the model's budget is FLAGGED to the model, not silently cut (the card still has it all)", g.ok && (g.modelResult.drafts as { content: string | null; contentOmittedForSize: boolean }[])[0].content === null && (g.modelResult.drafts as { contentOmittedForSize: boolean }[])[0].contentOmittedForSize === true);
    // The surface: no truncation applied to those fields in the component.
    const thread = code("app/(dashboard)/assistant/assistant-thread.tsx");
    const strat = thread.slice(thread.indexOf("function StrategyReviewView"), thread.indexOf("function CommandResultView"));
    ok("the strategy and draft views apply no slice, clip, substring or ellipsis to the fingerprinted fields", strat.length > 500 && !/\.slice\(0|\.substring\(|\.substr\(|clip\(|…|\.\.\.\"|line-clamp|textOverflow|WebkitLineClamp/.test(strat.replace(/fingerprint\.slice\(0, 8\)/g, "")));
    const listAll = await getDrafts(db.client(), { prospectId: P.due, draftId: null });
    ok("every listed draft is on the card in full (six at most, with the overflow said aloud)", listAll.ok && listAll.card.kind === "draft_review" && listAll.card.drafts.every((d) => typeof d.content === "string" && d.fingerprint.length === 64));
  }

  // ===========================================================================
  section("12o. allowlists of the two new reads: the content the user asked about, nothing else of the row");

  {
    const db = commandDb();
    const ctx = ctxFor(db);
    const strategy = await dispatchToolCall({ name: "get_strategy_for_review", argumentsRaw: JSON.stringify({ prospect_id: P.due }) }, ctx);
    const drafts = await dispatchToolCall({ name: "get_drafts", argumentsRaw: JSON.stringify({ prospect_id: P.due }) }, ctx);
    for (const [name, res] of [["get_strategy_for_review", strategy], ["get_drafts", drafts]] as const) {
      const keys = [...collectKeys(JSON.parse(res.toolMessage))];
      const a = findAbility(name)!;
      ok(`${name}: returns a result, every key on its allowlist, nothing for the stripper to do`, res.ok && keys.every((k) => a.allowlist.includes(k)) && res.strippedKeys.length === 0, keys.join(","));
      ok(`${name}: no contact email, recipient, message id, sender, funder note or secret column in the result or the card`, leaks(res.toolMessage + JSON.stringify(res.card)).length === 0 && !/RESEND-MESSAGE-ID|SENT-BY|contact_email|recipient/i.test(res.toolMessage + JSON.stringify(res.card)));
    }
    ok("get_strategy_for_review does not return the run's findings, evidence ids, model or error text", !/findings|evidence_item_ids|"model"|error_message/.test(strategy.toolMessage));
    const select = db.log.filter((l) => l.op === "select" && (l.table === "strategy_runs" || l.table === "drafts")).map((l) => l.columns ?? "");
    ok("the queries name their columns: no `*`, no findings, no recipient, no send-attempt table", select.every((c) => !/\*|findings|resend|sent_by|contact/.test(c)) && !db.log.some((l) => l.table === "draft_send_attempts"), select.join(" | "));
    const sd = JSON.parse(strategy.toolMessage);
    ok("the strategy read reports its LATEST run only (the older one is not offered)", sd.runId === SR.ready && sd.canBeApproved === true && /^[0-9a-f]{64}$/.test(sd.fingerprint));
    const approvedRead = JSON.parse((await dispatchToolCall({ name: "get_strategy_for_review", argumentsRaw: JSON.stringify({ prospect_id: P.overdue }) }, ctx)).toolMessage);
    ok("an approved strategy is reported as approved, cannot be approved again, and carries no fingerprint", approvedRead.approved === true && approvedRead.canBeApproved === false && approvedRead.fingerprint === null);
    const noRun = JSON.parse((await dispatchToolCall({ name: "get_strategy_for_review", argumentsRaw: JSON.stringify({ prospect_id: P.never }) }, ctx)).toolMessage);
    ok("a prospect with no strategy says so", noRun.hasRun === false && noRun.canBeApproved === false);
    const ghost = await dispatchToolCall({ name: "get_drafts", argumentsRaw: JSON.stringify({ prospect_id: "99999999-9999-4999-8999-999999999999" }) }, ctx);
    ok("an unseen prospect is 'not found'", !ghost.ok && /No prospect/.test(ghost.toolMessage));
  }

  // ===========================================================================
  section("12p. restoring what a command replaced: a user's click, never a tool call");

  {
    const db = commandDb();
    const fakeEdit = fakeEntryPoints(db);
    const { ctx } = cmdCtx(db, "Make the email warmer please.", {}, fakeEdit);
    const original = { ...db.rows("drafts").find((d) => d.id === DR.email)! };
    const edit = await runCommand("edit_draft", { draft_id: DR.email, subject: "Warm", content: "Dear friend,\nThank you.", authorizing_quote: "Make the email warmer" }, ctx);
    const commandId = mr(edit).commandId as string;
    ok("the edit executed and is restorable", done(edit) && (cardOf(edit) as { restorable: boolean }).restorable === true && !!commandId);
    const updateDraftFn = async (id: string, pid: string, subject: string | null, content: string) => fakeEdit.ep.updateDraft(id, pid, subject, content);
    const before = fakeEdit.calls.length;
    const r = await restoreCommandPreviousCore({ supabase: db.client(), userId: USER, commandId, updateDraft: updateDraftFn });
    const row = db.rows("drafts").find((d) => d.id === DR.email)!;
    ok("Restore puts the previous subject and text back through updateDraft", "ok" in r && row.content === original.content && row.subject === original.subject && fakeEdit.calls.length === before + 1 && fakeEdit.calls[before].name === "updateDraft");
    const restoreEvents = events(db).filter((e) => e.ability === RESTORE_ACTION_NAME);
    ok("it records its OWN started-then-executed events, origin click, no quote, pointing at the command it undid", restoreEvents.map((e) => e.event).join(",") === "started,executed" && restoreEvents.every((e) => e.origin === "click" && e.quote === null && e.restores_command_id === commandId));
    const again = await restoreCommandPreviousCore({ supabase: db.client(), userId: USER, commandId, updateDraft: updateDraftFn });
    ok("a second Restore is refused (already restored)", "error" in again && /already restored/i.test(again.error));
  }
  {
    const db = commandDb();
    const fake = fakeEntryPoints(db);
    const { ctx } = cmdCtx(db, "Make the email warmer please.", {}, fake);
    const edit = await runCommand("edit_draft", { draft_id: DR.email, subject: "Warm", content: "Dear friend,", authorizing_quote: "Make the email warmer" }, ctx);
    const commandId = mr(edit).commandId as string;
    const updateDraftFn = async (id: string, pid: string, s: string | null, c: string) => fake.ep.updateDraft(id, pid, s, c);
    const row = db.rows("drafts").find((d) => d.id === DR.email)!;
    row.content = "A person edited this again afterwards.";
    const stale = await restoreCommandPreviousCore({ supabase: db.client(), userId: USER, commandId, updateDraft: updateDraftFn });
    ok("if the draft was changed again since, Restore refuses rather than destroy that later work", "error" in stale && /changed again/.test(stale.error) && row.content === "A person edited this again afterwards.");
    row.content = "Dear friend,";
    row.status = "approved";
    const approved = await restoreCommandPreviousCore({ supabase: db.client(), userId: USER, commandId, updateDraft: updateDraftFn });
    ok("an approved draft's text is locked: Restore is refused", "error" in approved && /locked|approved/.test(approved.error));
    row.status = "draft";
    const other = await restoreCommandPreviousCore({ supabase: db.client(), userId: OTHER_USER, commandId, updateDraft: updateDraftFn });
    ok("someone else's command is 'not found'", "error" in other && /could not be found/.test(other.error));
    const junk = await restoreCommandPreviousCore({ supabase: db.client(), userId: USER, commandId: "not-a-uuid", updateDraft: updateDraftFn });
    ok("a malformed id is refused", "error" in junk);
    const notRestorable = await runCommand("set_prospect_ask_amount", { prospect_id: P.due, ask_amount: 123, authorizing_quote: "Make the email warmer" }, ctx);
    const noRestore = await restoreCommandPreviousCore({ supabase: db.client(), userId: USER, commandId: mr(notRestorable).commandId, updateDraft: updateDraftFn });
    ok("only draft text is restorable: an ask-amount command is refused", "error" in noRestore && /Nothing about that action/.test(noRestore.error));
    const dbAbsent = commandDb();
    dbAbsent.selectErrors["assistant_command_events"] = { code: "PGRST205", message: "Could not find the table" };
    const absent = await restoreCommandPreviousCore({ supabase: dbAbsent.client(), userId: USER, commandId: "00000000-0000-4000-8000-0000000000aa", updateDraft: updateDraftFn });
    ok("table absent: a plain setup-pending message", "error" in absent && /0081/.test(absent.error));
  }

  // ===========================================================================
  section("12q. a whole turn: showing and approving are separate turns, enforced end to end");

  {
    const db = commandDb();
    // Start from a thread-less state: the turn creates its own thread and messages.
    db.tables["assistant_threads"] = [];
    db.tables["assistant_messages"] = [];
    const fake = fakeEntryPoints(db);
    let clock = Date.parse("2026-10-13T12:00:00.000Z");
    const now = () => new Date(clock);
    const env = { MODEL_API_KEY: "k", ASSISTANT_ENABLED_ORG_IDS: ORG };

    // Turn 1: "show me the strategy" -- the model reads it, and (misbehaving)
    // also tries to approve in the same breath, quoting the user's words.
    const t1 = scripted([
      reply({ toolCalls: [{ id: "g", name: "get_strategy_for_review", args: JSON.stringify({ prospect_id: P.due }) }] }),
      (req: SeenCall) => {
        const fp = JSON.parse(req.messages.find((m) => m.role === "tool").content).fingerprint as string;
        return reply({ toolCalls: [{ id: "a", name: "approve_strategy", args: JSON.stringify({ prospect_id: P.due, run_id: SR.ready, fingerprint: fp, authorizing_quote: "approve the Due Soon strategy" }) }] });
      },
      reply({ content: "Here is the strategy; tell me if you want me to approve it." }),
    ]);
    const r1 = await handleAssistantTurn(
      { supabase: db.client(), userId: USER, message: "Show me the Due Soon strategy and approve the Due Soon strategy if it looks fine" },
      { env, call: t1.call, now, entryPoints: fake.ep }
    );
    ok("turn 1: the strategy is shown, and an approval in the SAME turn is refused -- approveStrategy never ran", r1.status === 200 && fake.calls.every((c) => c.name !== "approveStrategy") && (r1.body.cards as { kind: string }[]).some((c) => c.kind === "strategy_review") && (r1.body.cards as { kind: string }[]).some((c) => c.kind === "refusal"));
    ok("turn 1: the row says approved_strategy is still null", db.rows("strategy_runs").find((r) => r.id === SR.ready)!.approved_strategy === null);
    const threadId = r1.body.threadId as string;

    // Turn 2: the user says approve. The model reads again for the current
    // fingerprint, then approves, quoting the user's own words.
    clock += 5 * 60_000;
    const t2 = scripted([
      reply({ toolCalls: [{ id: "g", name: "get_strategy_for_review", args: JSON.stringify({ prospect_id: P.due }) }] }),
      (req: SeenCall) => {
        const fp = JSON.parse(req.messages.filter((m) => m.role === "tool").pop().content).fingerprint as string;
        return reply({ toolCalls: [{ id: "a", name: "approve_strategy", args: JSON.stringify({ prospect_id: P.due, run_id: SR.ready, fingerprint: fp, authorizing_quote: "approve it" }) }] });
      },
      reply({ content: "Approved." }),
    ]);
    const r2 = await handleAssistantTurn({ supabase: db.client(), userId: USER, threadId, message: "Yes, approve it." }, { env, call: t2.call, now, entryPoints: fake.ep });
    ok("turn 2: the user's own next message approves the version shown in turn 1 -- approveStrategy ran once", r2.status === 200 && fake.calls.filter((c) => c.name === "approveStrategy").length === 1 && db.rows("strategy_runs").find((r) => r.id === SR.ready)!.approved_strategy !== null);
    const cmdCard = (r2.body.cards as { kind: string; quote?: string }[]).find((c) => c.kind === "command_result");
    ok("turn 2: the result card names the user's own words", !!cmdCard && cmdCard.quote === "approve it");
    const ev = events(db).filter((e) => e.ability === "approve_strategy");
    ok("the record: a refused row from turn 1, then started + executed from turn 2, with the right user messages", ev.map((e) => e.event).join(",") === "refused,started,executed" && ev[0].user_message_id !== ev[1].user_message_id && ev[1].quote === "approve it");
    ok("the model was told the user's message came in turn 2: the loop's ctx held it (a quote of turn 1's words fails in turn 2)", await (async () => {
      const t3 = scripted([
        reply({ toolCalls: [{ id: "x", name: "set_prospect_ask_amount", args: JSON.stringify({ prospect_id: P.due, ask_amount: 77, authorizing_quote: "Show me the Due Soon strategy" }) }] }),
        reply({ content: "done?" }),
      ]);
      clock += 5 * 60_000;
      const before = fake.calls.length;
      await handleAssistantTurn({ supabase: db.client(), userId: USER, threadId, message: "What is going on?" }, { env, call: t3.call, now, entryPoints: fake.ep });
      return fake.calls.length === before;
    })());
  }

  // ===========================================================================
  section("12r. a command that is NOT on the list cannot be reached under any name");

  {
    const db = commandDb();
    const { ctx, fake } = cmdCtx(db, "Send the intro email to the funder and move them to the proposal stage and delete the old one.");
    const names = ["send_draft", "send_email", "send_approved_draft", "move_prospect_stage", "advance_stage", "delete_draft", "delete_prospect", "approve_claim", "record_gift", "update_contact", "set_stage", "compose_email", "start_research", "run_strategy"];
    const results = await Promise.all(names.map((n) => dispatchToolCall({ name: n, argumentsRaw: JSON.stringify({ authorizing_quote: "Send the intro email to the funder" }) }, ctx)));
    ok("every send / stage / delete / claim / gift / contact / start-a-run name is an unknown tool", results.every((r) => !r.ok && r.errorKind === "unknown_tool") && fake.calls.length === 0);
    const direct = await runCommand("send_draft", { authorizing_quote: "Send the intro email" }, ctx);
    ok("... and runCommand itself will not run a name outside its own table", !direct.ok && fake.calls.length === 0);
  }

  // ===========================================================================
  section("13. STATE item 93: pushing back on a strategy -- a revision is a NEW row; every refusal precedes the ledger birth");

  {
    // The pure shape guard.
    const pool = new Set(["ev-1", "ev-2"]);
    const shaped = shapeStrategyResult(
      {
        organization_intel: { location: "AI-guessed city", funder_type: "AI type", geographic_focus: "", typical_grant_size: "$1", focus_areas: ["a", 7, "b"] },
        strategy: { outreach_approach: "Call.", ask_positioning: "", rationale: "Because.", key_talking_points: ["one", 2, null], evidence_to_highlight: "not an array" },
        evidence_used: ["ev-1", "invented", 5],
      },
      { location: "Typed by a person", funder_type: null, geographic_focus: null, typical_grant_size: null, focus_areas: ["edu"] },
      pool
    );
    ok("shapeStrategyResult: a person's existing value is never overwritten by the model's; the model fills gaps", shaped.intel.location === "Typed by a person" && shaped.intel.funder_type === "AI type" && shaped.intel.focus_areas.join() === "edu");
    ok("... list items must be strings, a non-array becomes an empty list, missing prose becomes empty", shaped.strategy.key_talking_points.join() === "one" && shaped.strategy.evidence_to_highlight.length === 0 && shaped.strategy.ask_positioning === "");
    ok("... cited evidence ids are validated against the pool the model was handed (an invented id is dropped)", JSON.stringify(shaped.evidenceItemIds) === JSON.stringify(["ev-1"]));
    ok("... an absent evidence_used is null (the caller keeps the run's own ids), not an empty list", shapeStrategyResult({ strategy: { rationale: "x" } }, {}, pool).evidenceItemIds === null);
    ok("... a result with no prose at all has no substance", !shapeStrategyResult({ strategy: {}, organization_intel: {} }, {}, pool).hasSubstance && !shapeStrategyResult("junk", {}, pool).hasSubstance && shaped.hasSubstance);
  }

  {
    // The REAL action, run offline against a fake client and a fake model.
    // Modules the action imports are stubbed in require.cache for the
    // duration of this section and restored after: the session client, Next's
    // cache/redirect helpers (which need a request context), the readiness
    // check (a database-heavy loader with its own tests) and the Anthropic
    // client's messages.create.
    const cache = require.cache as unknown as Record<string, unknown>;
    const touched = new Map<string, unknown>();
    const stub = (abs: string, exports: Record<string, unknown>) => {
      if (!touched.has(abs)) touched.set(abs, cache[abs]);
      cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
    };
    const actionsPath = require.resolve(join(root, "app/(dashboard)/prospects/[id]/strategy-actions.ts"));
    const intelPath = require.resolve(join(root, "lib/prospect-intelligence.ts"));
    const anthropicPath = require.resolve(join(root, "lib/ai/anthropic.ts"));
    const serverPath = require.resolve(join(root, "lib/supabase/server.ts"));
    const realIntel = require(intelPath);
    const { anthropic } = require(anthropicPath) as { anthropic: { messages: { create: unknown } } };
    const realCreate = anthropic.messages.create;

    let current: FakeDb = new FakeDb();
    let readiness: { ready: boolean; reason: string | null } = { ready: true, reason: null };
    const approvedIntel = {
      researchRunId: "90000000-0000-4000-8000-000000000001",
      version: 1,
      confirmedEin: null,
      withheld: [],
      claims: [
        { claimId: "c1", humanDecided: true, claimKey: "k1", claim: "Funds youth literacy programs in Texas.", reportingPeriod: "FY2024", advisory: false, limitation: null, humanOverride: false, overrideNote: null, sources: [] },
        { claimId: "c2", humanDecided: false, claimKey: "k2", claim: "Possibly prefers faith-based partners.", reportingPeriod: null, advisory: true, limitation: "single secondary source", humanOverride: false, overrideNote: null, sources: [] },
      ],
    };
    let modelCalls: { params: any; opts: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let modelBehavior: () => unknown = () => ({});

    stub(require.resolve("next/cache"), { revalidatePath() {} });
    stub(require.resolve("next/navigation"), {
      redirect(url: string) {
        throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
      },
    });
    stub(serverPath, { createClient: () => current });
    stub(intelPath, { ...realIntel, strategyReadiness: async () => readiness, loadApprovedIntelligence: async () => approvedIntel });
    (anthropic.messages as { create: unknown }).create = async (params: unknown, opts: unknown) => {
      current.log.push({ table: "__model_call__", op: "select", columns: "", filters: [] });
      modelCalls.push({ params, opts });
      return modelBehavior();
    };
    delete cache[actionsPath];

    try {
      const mod = require(actionsPath) as { reviseStrategyWithFeedback: (runId: string, feedback: string) => Promise<{ ok: true; runId: string } | { error: string }> };
      const revise = mod.reviseStrategyWithFeedback;

      const world = () => {
        const db = new FakeDb();
        db.seed("prospects", [{ id: P.due, name: "Due Soon Fund", channel: "foundation", stage: "outreach", location: null, funder_type: null, geographic_focus: null, typical_grant_size: null, focus_areas: null }]);
        db.seed("strategy_runs", [
          { id: SR.old, prospect_id: P.due, status: "ready_for_review", strategy: STRATEGY_FIXTURE, organization_intel: INTEL_FIXTURE, approved_strategy: null, findings: "OLD FINDINGS", evidence_item_ids: [], approved_intelligence_run_id: null, created_at: "2026-10-10T09:00:00.000Z" },
          {
            id: SR.ready,
            prospect_id: P.due,
            status: "ready_for_review",
            strategy: STRATEGY_FIXTURE,
            organization_intel: INTEL_FIXTURE,
            approved_strategy: null,
            findings: "The funder gives to youth literacy in Texas (stored findings).",
            evidence_item_ids: ["e-1"],
            approved_intelligence_run_id: "90000000-0000-4000-8000-000000000001",
            created_at: "2026-10-12T09:00:00.000Z",
          },
          { id: SR.approved, prospect_id: P.overdue, status: "ready_for_review", strategy: STRATEGY_FIXTURE, organization_intel: INTEL_FIXTURE, approved_strategy: STRATEGY_FIXTURE, findings: "", evidence_item_ids: [], approved_intelligence_run_id: null, created_at: "2026-10-11T09:00:00.000Z" },
          { id: SR.analyzing, prospect_id: P.later, status: "analyzing", strategy: null, organization_intel: null, approved_strategy: null, findings: null, evidence_item_ids: null, approved_intelligence_run_id: null, created_at: "2026-10-12T09:00:00.000Z" },
        ]);
        db.seed("prospects", [{ id: P.overdue, name: "Overdue Trust" }, { id: P.later, name: "Far Future Fund" }]);
        db.seed("evidence_items", [
          { id: "e-1", title: "Reading outcomes", description: "18% gain", type: "outcome", verified_at: "2026-01-01", permission: "approved" },
          { id: "e-2", title: "Case study", description: "A family", type: "story", verified_at: "2026-01-01", permission: "approved" },
          { id: "e-3", title: "Unverified", description: "x", type: "outcome", verified_at: null, permission: "approved" },
        ]);
        db.seed("org_profile", [{ id: "org-1", mission: "Close the literacy gap." }]);
        current = db;
        modelCalls = [];
        readiness = { ready: true, reason: null };
        return db;
      };
      const snapshot = (db: FakeDb, id: string) => JSON.stringify(db.rows("strategy_runs").find((r) => r.id === id));
      const nothingWritten = (db: FakeDb) => db.log.filter((l) => l.op === "insert" || l.op === "update" || l.op === "delete").length === 0 && db.rows("ai_runs").length === 0 && modelCalls.length === 0;
      const goodModel = () => ({
        model: "claude-test-model",
        usage: { input_tokens: 111, output_tokens: 22 },
        content: [
          {
            type: "tool_use",
            input: {
              organization_intel: { location: "Dallas, TX", funder_type: "Private foundation", geographic_focus: "Texas", typical_grant_size: "$10,000-$25,000", focus_areas: ["education"] },
              strategy: { ...STRATEGY_FIXTURE, ask_positioning: "A $15,000 first grant.", rationale: "Revised per feedback." },
              evidence_used: ["e-2", "invented-id", "e-3"],
            },
          },
        ],
      });

      // --- every refusal precedes the ledger birth and every insert -----------
      {
        const db = world();
        const r = await revise("70000000-0000-4000-8000-0000000000ff", "Lower the ask.");
        ok("refusal: run not found", "error" in r && /could not be found/.test(r.error) && nothingWritten(db));
      }
      {
        const db = world();
        const r = await revise(SR.analyzing, "Lower the ask.");
        ok("refusal: run not ready for review", "error" in r && /not waiting for review/.test(r.error) && nothingWritten(db));
      }
      {
        const db = world();
        const r = await revise(SR.approved, "Lower the ask.");
        ok("refusal: run already approved", "error" in r && /already been approved/.test(r.error) && nothingWritten(db));
      }
      {
        const db = world();
        const r = await revise(SR.old, "Lower the ask.");
        ok("refusal: run is not the prospect's latest", "error" in r && /not the prospect's latest/.test(r.error) && nothingWritten(db));
      }
      {
        const db = world();
        const empty = await revise(SR.ready, "   ");
        const long = await revise(SR.ready, "x".repeat(MAX_STRATEGY_FEEDBACK_CHARS + 1));
        ok("refusal: feedback empty, or over the named cap", "error" in empty && "error" in long && /feedback/i.test(empty.error + long.error) && nothingWritten(db));
      }
      {
        const db = world();
        readiness = { ready: false, reason: "No intelligence has been approved yet." };
        const r = await revise(SR.ready, "Lower the ask.");
        ok("refusal: the prospect is no longer strategy-ready (its own reason is returned)", "error" in r && r.error === "No intelligence has been approved yet." && nothingWritten(db));
      }
      {
        const db = world();
        db.auth = { getUser: async () => ({ data: { user: null as never } }) } as never;
        let digest = "";
        try {
          await revise(SR.ready, "Lower the ask.");
        } catch (err) {
          digest = String((err as { digest?: string }).digest ?? "");
        }
        ok("refusal: not signed in -> a redirect to /login, as the neighbouring actions do, and nothing written", /NEXT_REDIRECT.*\/login/.test(digest) && nothingWritten(db));
      }

      // --- the happy path: a NEW row, the original untouched ------------------
      {
        const db = world();
        const originalBefore = snapshot(db, SR.ready);
        const oldBefore = snapshot(db, SR.old);
        modelBehavior = goodModel;
        const r = await revise(SR.ready, "Lower the ask to $15,000 and open with the literacy outcomes.");
        ok("a valid revision returns the NEW run's id", "ok" in r && typeof r.runId === "string" && r.runId !== SR.ready);
        const newId = (r as { runId: string }).runId;
        const fresh = db.rows("strategy_runs").find((x) => x.id === newId)!;
        ok("it is a NEW strategy_runs row: ready for review, unapproved, carrying the revised strategy and intel", !!fresh && fresh.status === "ready_for_review" && !fresh.approved_strategy && fresh.strategy.ask_positioning === "A $15,000 first grant." && fresh.organization_intel.location === "Dallas, TX" && fresh.status_message === null, JSON.stringify(fresh));
        ok("the ORIGINAL row (and the one before it) are byte-for-byte unchanged", snapshot(db, SR.ready) === originalBefore && snapshot(db, SR.old) === oldBefore);
        ok("the new row copies findings, and records the intelligence run it actually read", fresh.findings === "The funder gives to youth literacy in Texas (stored findings)." && fresh.approved_intelligence_run_id === approvedIntel.researchRunId && fresh.created_by === USER);
        ok("cited evidence is validated against the pool: the invented id and the UNVERIFIED item are dropped", JSON.stringify(fresh.evidence_item_ids) === JSON.stringify(["e-2"]), JSON.stringify(fresh.evidence_item_ids));
        const insertAt = db.log.findIndex((l) => l.table === "strategy_runs" && l.op === "insert");
        const birthAt = db.log.findIndex((l) => l.table === "ai_runs" && l.op === "insert");
        const callAt = db.log.findIndex((l) => l.table === "__model_call__");
        const readyAt = db.log.findIndex((l) => l.table === "strategy_runs" && l.op === "update" && l.payload?.status === "ready_for_review");
        const finalizeAt = db.log.findIndex((l) => l.table === "ai_runs" && l.op === "update");
        ok("order: new row inserted, ledger row born, THEN the model is called, then the result is written, then the run is finalized", insertAt >= 0 && insertAt < birthAt && birthAt < callAt && callAt < readyAt && readyAt < finalizeAt, JSON.stringify({ insertAt, birthAt, callAt, readyAt, finalizeAt }));
        const insert = db.log[insertAt].payload;
        ok("the new row is born 'analyzing' with started_at set, so the panel's mount effect (unstarted 'researching' rows only) can never run a second strategy on it", insert.status === "analyzing" && typeof insert.started_at === "string" && /Revising/.test(insert.status_message));
        const run = db.rows("ai_runs")[0];
        ok("the ledger row: operation strategy_revise, pointing at the NEW run, finalized completed with the captured tokens and model", db.rows("ai_runs").length === 1 && run.operation === "strategy_revise" && run.source_table === "strategy_runs" && run.source_id === newId && run.outcome === "completed" && run.input_tokens === 111 && run.output_tokens === 22 && run.model === "claude-test-model");
        const req = modelCalls[0];
        const tools = req.params.tools as { name: string; type?: string }[];
        ok("one model call: a single forced tool, NO web search, bounded output, a 60 s timeout", modelCalls.length === 1 && tools.length === 1 && tools[0].name === "submit_strategy_revision" && !tools.some((t) => /web_search/.test(String(t.type ?? ""))) && req.params.tool_choice.name === "submit_strategy_revision" && req.params.max_tokens === 2000 && req.opts.timeout === 60_000);
        const prompt = String(req.params.messages[0].content);
        ok("the prompt carries the feedback, the CURRENT proposed strategy and intel, the stored findings and the confirmed intelligence", prompt.includes("Lower the ask to $15,000") && prompt.includes(STRATEGY_FIXTURE.ask_positioning) && prompt.includes(INTEL_FIXTURE.location) && prompt.includes("stored findings") && prompt.includes("Funds youth literacy programs in Texas."));
        ok("advisory context is labelled as unconfirmed and never as fact; unverified evidence is not offered", /Unconfirmed context \(NOT verified/.test(prompt) && prompt.includes("e-1:") && prompt.includes("e-2:") && !prompt.includes("e-3:"));
        ok("the prompt states that feedback never loosens the grounding rule and that nothing outside confirmed intelligence may be asserted", /feedback is never license to loosen it/.test(prompt) && /assert nothing about the funder that the confirmed intelligence below does not support/.test(prompt));
      }
      // --- failure paths: the new row goes to error, the ledger is finalized, nothing throws
      {
        const db = world();
        const before = snapshot(db, SR.ready);
        modelBehavior = () => {
          throw new Error("upstream timeout");
        };
        const r = await revise(SR.ready, "Lower the ask.");
        const fresh = db.rows("strategy_runs").find((x) => x.id !== SR.ready && x.id !== SR.old && x.id !== SR.approved && x.id !== SR.analyzing)!;
        ok("a model failure returns {error}, never throws, sets the new row to error with a plain message", "error" in r && /upstream timeout/.test(r.error) && fresh.status === "error" && /upstream timeout/.test(fresh.error_message));
        ok("... finalizes the ledger run failed, and leaves the original untouched", db.rows("ai_runs")[0].outcome === "failed" && snapshot(db, SR.ready) === before);
      }
      {
        const db = world();
        modelBehavior = () => ({ model: "m", usage: { input_tokens: 5, output_tokens: 1 }, content: [{ type: "tool_use", input: { strategy: { outreach_approach: " ", ask_positioning: "", rationale: "" }, organization_intel: {} } }] });
        const r = await revise(SR.ready, "Lower the ask.");
        const fresh = db.rows("strategy_runs").find((x) => x.status === "error");
        ok("a result with no substance is 'empty': the new row goes to error, the run is finalized empty, an error is returned", "error" in r && !!fresh && db.rows("ai_runs")[0].outcome === "empty");
      }
      {
        const db = world();
        db.insertErrors["ai_runs"] = { code: "42501", message: "ledger down" };
        modelBehavior = goodModel;
        const r = await revise(SR.ready, "Lower the ask.");
        ok("if the ledger birth fails, the model is NOT called and the new row goes to error (ruling 0026 clause 1)", "error" in r && modelCalls.length === 0 && db.rows("strategy_runs").some((x) => x.status === "error"));
      }
      {
        const db = world();
        modelBehavior = () => ({ model: "m", content: [{ type: "text", text: "no tool" }] });
        const r = await revise(SR.ready, "Lower the ask.");
        ok("a reply with no structured result is a failure, not a ready strategy (no new ready row appears)", "error" in r && db.rows("strategy_runs").filter((x) => x.status === "ready_for_review").length === 3 && db.rows("strategy_runs").some((x) => x.status === "error"));
      }
    } finally {
      (anthropic.messages as { create: unknown }).create = realCreate;
      for (const [abs, prev] of touched) {
        if (prev === undefined) delete cache[abs];
        else cache[abs] = prev;
      }
      delete cache[actionsPath];
    }
  }
  {
    // Source order: every refusal is above the first insert and the ledger birth.
    const src = read("app/(dashboard)/prospects/[id]/strategy-actions.ts");
    const start = src.indexOf("export async function reviseStrategyWithFeedback");
    const fn = src.slice(start);
    const refusals = [
      'redirect("/login")',
      "That strategy run could not be found.",
      "is not waiting for review",
      "has already been approved",
      "not the prospect's latest strategy",
      "Write the feedback the strategy should address",
      "Keep the feedback under",
      "await strategyReadiness(",
    ];
    const at = refusals.map((r) => fn.indexOf(r));
    const insertAt = fn.indexOf(".insert(");
    const birthAt = fn.indexOf("await beginRun(");
    const callAt = fn.indexOf("await anthropic.messages.create");
    ok("source: the seven refusals appear in the ruled order", at.every((i) => i >= 0) && at.every((v, i) => i === 0 || at[i - 1] < v), JSON.stringify(at));
    ok("source: every refusal precedes the first insert and the ledger birth", at.every((i) => i < insertAt) && insertAt < birthAt && birthAt < callAt, JSON.stringify({ at, insertAt, birthAt, callAt }));
    ok("source: the literal operation string sits at the birth call, and finalizeRun covers completed, empty and failed", /operation: "strategy_revise"/.test(fn) && /outcome: "completed"/.test(fn) && /failRun\(note, "empty"\)/.test(fn) && /failRun\(note, "failed"\)/.test(fn));
    ok("source: reviseStrategyWithFeedback is ADDED -- runStrategy, approveStrategy, retryStrategy and approveIntelligenceAndGenerateStrategy keep their signatures", ["export async function runStrategy(runId: string, prospectId: string)", "export async function approveStrategy(\n  runId: string,\n  prospectId: string,\n  approvedStrategy: Strategy,\n  approvedIntel: OrganizationIntel\n)", "export async function retryStrategy(prospectId: string)", "export async function approveIntelligenceAndGenerateStrategy("].every((sig) => src.includes(sig)));
    ok("strategy_revise is a member of AI_RUN_OPERATIONS", AI_RUN_OPERATIONS.includes("strategy_revise"));
  }

  // ===========================================================================
  section("14. source scans: one choke point, nothing reaches an entry point around it; migration 0081");

  {
    const abil = code("lib/assistant/abilities.ts");
    ok("abilities.ts: the ONLY thing a command or gate handler does is call runCommand (exactly one call site, in the shared builder)", (abil.match(/runCommand\(/g) ?? []).length === 1 && /handler: async \(args, ctx\) => runCommand\(def\.name, args as Record<string, unknown>, ctx\)/.test(abil));
    ok(
      "abilities.ts: names no entry point, no executor, no entry-point loader, no audit writer and no server action module",
      !/COMMAND_EXECUTORS|command-exec|command-entrypoints|insertCommandEvent|assistant_command_events|loadEntryPoints|entryPoints|createProspect|updateDraft|approveDraft|approveStrategy|unapproveDraft|reviseDraftWithFeedback|reviseStrategyWithFeedback|generateDraft|logInteraction|updateNextAction|updateAskAmount|logSupporterInteraction/.test(abil)
    );
    ok("abilities.ts: imports nothing from app/", importSpecifiers(abil).every((s) => !s.startsWith("@/app/")));

    const cmd = code("lib/assistant/command.ts");
    const idx = (needle: string) => cmd.indexOf(needle);
    const quoteAt = idx("verifyQuote(rawArgs");
    const firstUse = Math.min(...["COMMAND_EXECUTORS[", "insertCommandEvent(", "ctx.loadEntryPoints(", 'ctx.supabase\n', "ctx.supabase.from(", "prepared.effect(", "def.validate("].map(idx).filter((i) => i >= 0));
    ok("command.ts: the quote check is the FIRST thing runCommand does -- before any lookup, read, validation, audit write or effect", quoteAt > 0 && quoteAt < firstUse && /export async function runCommand\([^)]*\)[^{]*\{\s*(\/\/[^\n]*\n\s*)*const verdict = verifyQuote\(/.test(cmd), `${quoteAt} / ${firstUse}`);
    const order = [
      "verifyQuote(rawArgs",
      "if (!verdict.ok) return refused(",
      "ctx.commandsRun >= MAX_COMMANDS_PER_TURN",
      ".from(\"assistant_messages\")",
      "findDisplayedGateCard(m.cards",
      "def.validate(rawArgs",
      "ctx.remainingMs()",
      "await exec(args",
      "prepared.liveFingerprint !== displayedFingerprint",
      'event: "started"',
      "ctx.commandsRun += 1",
      "await ctx.loadEntryPoints()",
      "await prepared.effect(eps)",
      'terminal("executed"',
    ].map((n) => idx(n));
    ok("command.ts: the steps appear in the ruled order -- quote, cap, display, validate, time, guards, fingerprint, started row, effect, outcome", order.every((i) => i >= 0) && order.every((v, i) => i === 0 || order[i - 1] < v), JSON.stringify(order));
    ok("command.ts: the effect is called exactly once, only after the started row", (cmd.match(/prepared\.effect\(/g) ?? []).length === 1 && (cmd.match(/ctx\.loadEntryPoints\(/g) ?? []).length === 1);
    ok("command.ts: names the cap as an exported constant", /export const MAX_COMMANDS_PER_TURN = 3;/.test(cmd) && /export const MIN_QUOTE_CHARS = 4;/.test(cmd) && /export const TIME_MARGIN_MS = 10_000;/.test(cmd));
    ok("command.ts: gate cards are looked up by finalized_at BEFORE the user's message, excluding this turn's own row, completed assistant rows of this thread only", /\.eq\("thread_id", ctx\.threadId\)/.test(cmd) && /\.eq\("role", "assistant"\)/.test(cmd) && /\.eq\("status", "completed"\)/.test(cmd) && /\.lt\("finalized_at", ctx\.userMessageAt\)/.test(cmd) && /\.neq\("id", ctx\.messageId\)/.test(cmd));

    // Who may import what.
    const lib = walk(join(root, "lib")).map(rel);
    const app = walk(join(root, "app")).map(rel);
    const everyFile = [...lib, ...app];
    const importersOf = (re: RegExp) => everyFile.filter((f) => importSpecifiers(code(f)).some((s) => re.test(s))).sort();
    ok("command-exec.ts is imported by exactly one file: the choke point (command.ts)", JSON.stringify(importersOf(/(^|\/)command-exec$/)) === JSON.stringify(["lib/assistant/command.ts"]), importersOf(/command-exec$/).join(", "));
    ok("command-entrypoints.ts is imported by exactly one file, and only lazily: turn.ts, by dynamic import", JSON.stringify(importersOf(/command-entrypoints$/)) === JSON.stringify(["lib/assistant/turn.ts"]) && /await import\("\.\/command-entrypoints"\)/.test(code("lib/assistant/turn.ts")) && !/^import .*command-entrypoints/m.test(code("lib/assistant/turn.ts")));
    ok("the audit writer (audit.ts) is imported only by the choke point and the click-driven restore", JSON.stringify(importersOf(/(^|\/)audit$/)) === JSON.stringify(["lib/assistant/command.ts", "lib/assistant/restore.ts"]), importersOf(/audit$/).join(", "));
    ok("executors.ts (the click-approval path) is still imported by exactly one file", JSON.stringify(importersOf(/assistant\/executors$|^\.\/executors$/).filter((f) => f !== "lib/assistant/executors.ts")) === JSON.stringify(["app/(dashboard)/assistant/actions.ts"]));
    ok("restore.ts and command.ts and command-exec.ts import no server action (entry points arrive injected)", ["lib/assistant/restore.ts", "lib/assistant/command.ts", "lib/assistant/command-exec.ts", "lib/assistant/command-defs.ts", "lib/assistant/audit.ts", "lib/assistant/fingerprint.ts"].every((f) => importSpecifiers(code(f)).every((s) => !s.startsWith("@/app/"))));

    const ep = code("lib/assistant/command-entrypoints.ts");
    const epSpecs = importSpecifiers(ep).sort();
    ok(
      "command-entrypoints.ts imports exactly the five existing action modules and its own types",
      JSON.stringify(epSpecs) === JSON.stringify(["./types", "@/app/(dashboard)/prospects/[id]/draft-actions", "@/app/(dashboard)/prospects/[id]/strategy-actions", "@/app/(dashboard)/prospects/actions", "@/app/(dashboard)/revisit/actions", "@/app/(dashboard)/supporters/actions"].sort()),
      epSpecs.join(", ")
    );
    const named = [...ep.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/app\/[^"]+"/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean)).sort();
    ok(
      "... and from them names exactly the twelve functions on the list, none of which sends, moves a stage, decides a claim, deletes or records a gift",
      JSON.stringify(named) === JSON.stringify(["approveDraft", "approveStrategy", "createProspect", "generateDraft", "logInteraction", "logSupporterInteraction", "reviseDraftWithFeedback", "reviseStrategyWithFeedback", "unapproveDraft", "updateAskAmount", "updateDraft", "updateNextAction"].sort()),
      named.join(", ")
    );
    ok("the CommandEntryPoints type has exactly those twelve members", (() => {
      const t = read("lib/assistant/types.ts");
      const body = t.slice(t.indexOf("export type CommandEntryPoints"), t.indexOf("export type ToolContext"));
      return (body.match(/^\s{2}[a-zA-Z]+:/gm) ?? []).length === 12;
    })());

    // Whole-directory closure: nothing under lib/assistant or the assistant page reaches the send path, the admin client, stage moves or contact changes.
    const surface = ASSISTANT_SURFACE.filter((f) => f !== "lib/assistant/executors.ts");
    const BAD_IMPORT = /send-draft|draft-send|send-actions|supabase\/admin|pipeline\/actions|prospect-workflow|stage-change|moveProspectStage|network-actions|research-actions|outcome-actions|gift-actions/;
    const badImports = surface.flatMap((f) => importSpecifiers(code(f)).filter((s) => BAD_IMPORT.test(s)).map((s) => `${f}: ${s}`));
    ok("nothing under lib/assistant (or the assistant page and route) imports send-draft, send-actions, draft-send, the admin client, stage-change, research, outcome or gift code", badImports.length === 0, badImports.join("; "));
    ok("updateContact is referenced nowhere under the assistant (it sets the send recipient)", ASSISTANT_SURFACE.every((f) => !/updateContact|upsertContact|contact_email|contact_name/.test(code(f))));
    ok("no assistant file calls the send entry point or reads a send-attempt table", ASSISTANT_SURFACE.every((f) => !/sendApprovedDraft|draft_send_attempts|sendFunderEmail|isSendConfigured|sending_enabled/.test(code(f))));
    ok("no assistant file writes a stage: no `stage:` in an update payload and no stage_changes table", ASSISTANT_SURFACE.every((f) => !/stage_changes|\.update\(\{[^}]*stage/.test(code(f))));
    ok("the only `.from(...).insert(` writes under lib/assistant are the assistant's own tables (threads, messages, proposals, command events)", (() => {
      const bad: string[] = [];
      for (const f of ASSISTANT_LIB) {
        for (const m of code(f).matchAll(/\.from\(\s*(?:"([a-z_]+)"|([A-Za-z_]+))\s*\)\s*\.(insert|update|upsert|delete)\(/g)) {
          const table = m[1] ?? m[2];
          if (!["assistant_threads", "assistant_messages", "assistant_proposals", "assistant_command_events", "COMMAND_EVENTS_TABLE"].includes(table)) bad.push(`${f}: ${table}.${m[3]}`);
        }
      }
      return bad.length === 0 || (console.log(bad.join("\n")), false);
    })());
    ok("no assistant file builds a service-role client (the command path acts as the session user)", ASSISTANT_SURFACE.every((f) => !/createAdminClient|SERVICE_ROLE|supabase\/admin/.test(code(f))));
  }
  {
    // The turn hands the choke point the user's own message and the clock.
    const turn = code("lib/assistant/turn.ts");
    ok("turn.ts: the context's userMessage is the trimmed message the turn just stored, not anything from the model", /userMessage: message,/.test(turn) && /userMessageId,/.test(turn) && /userMessageAt: stamp,/.test(turn));
    ok("turn.ts: remainingMs starts closed (0) and the loop installs the real figure", /remainingMs: \(\) => 0,/.test(turn) && /input\.ctx\.remainingMs = \(\) =>/.test(code("lib/assistant/loop.ts")));
    const prompt = read("lib/assistant/prompt.ts");
    ok(
      "prompt: separates a question from a command, requires the VERBATIM quote, says a gate needs content shown first and the user's NEXT message, asks when ambiguous, and forbids claiming an action unless the result says done",
      /A QUESTION/.test(prompt) && /A COMMAND/.test(prompt) && /VERBATIM/.test(prompt) && /LATER message/.test(prompt) && /ambiguous/.test(prompt) && /unless the action tool's result says status \\"done\\"/.test(prompt) && /enforces every limit in code/.test(prompt)
    );
    const thread = read("app/(dashboard)/assistant/assistant-thread.tsx").replace(/\s+/g, " ");
    ok("surface: the disclosure says strategy and draft text is shared with the provider when asked about, and still never email addresses, phone numbers, notes or interaction text", /strategy or a draft, its full text/.test(thread) && /shared with that provider too/.test(thread) && /Email addresses, phone numbers, notes and interaction text are never sent/.test(thread));
    ok("surface: command-result cards show the user's quoted words and what was replaced, with a Restore button; refusals say what was not done", /On your words/.test(thread) && /What this replaced/.test(thread) && /restoreCommandPrevious/.test(thread) && /Not done/.test(thread));
    const actions = read("app/(dashboard)/assistant/actions.ts");
    ok("surface: restoreCommandPrevious is a click-driven server action: requireUser, assistant enabled, the restore core with the page's own updateDraft", /export async function restoreCommandPrevious/.test(actions) && /requireUser\(\)/.test(actions.slice(actions.indexOf("export async function restoreCommandPrevious"))) && /restoreCommandPreviousCore\(\{[^}]*updateDraft/.test(actions));
    ok("surface: no tool, ability or card builder names restoreCommandPrevious -- the model has no path to it", ASSISTANT_LIB.every((f) => !/\brestoreCommandPrevious\b/.test(code(f))));
  }

  // ===========================================================================
  section("14b. migration 0081, by text");

  {
    const sql = read("supabase/migrations/0081_assistant_commands.sql");
    const stmts = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").toLowerCase();
    const creates = [...stmts.matchAll(/create\s+table\s+([a-z_]+)/g)].map((m) => m[1]);
    ok("creates exactly one table: assistant_command_events", JSON.stringify(creates) === JSON.stringify(["assistant_command_events"]), creates.join(", "));
    ok("every ALTER TABLE targets the new table; no DROP, no ADD COLUMN, no rename, no column type change (ruling 0020: additive)", [...stmts.matchAll(/alter\s+table\s+([a-z_]+)/g)].every((m) => m[1] === "assistant_command_events") && !/\bdrop\b/.test(stmts) && !/add\s+column/.test(stmts) && !/\brename\b/.test(stmts) && !/alter\s+column/.test(stmts));
    ok("the ledger's own additivity check passes", additiveViolations(sql).length === 0, additiveViolations(sql).join("; "));
    ok("organization_id is not null, references organizations, defaults to my_organization_id() (hard rule 6)", /organization_id\s+uuid\s+not\s+null\s+references\s+organizations\s*\(id\)\s+default\s+my_organization_id\(\)/.test(stmts));
    ok("created_by defaults to auth.uid()", /created_by\s+uuid\s+not\s+null\s+default\s+auth\.uid\(\)\s+references\s+auth\.users/.test(stmts));
    ok("row level security is enabled", /alter\s+table\s+assistant_command_events\s+enable\s+row\s+level\s+security/.test(stmts));
    const kinds = [...stmts.matchAll(/for\s+(insert|select|update|delete|all)\b/g)].map((m) => m[1]).sort();
    ok("policies: INSERT and SELECT only -- no update policy, no delete policy, no 'for all'", JSON.stringify(kinds) === JSON.stringify(["insert", "select"]), kinds.join(","));
    const policies = [...stmts.matchAll(/create\s+policy[\s\S]*?;/g)].map((m) => m[0]);
    ok("both policies are scoped by organization AND author", policies.length === 2 && policies.every((p) => /organization_id\s*=\s*my_organization_id\(\)/.test(p) && /created_by\s*=\s*auth\.uid\(\)/.test(p)));
    ok("a BEFORE UPDATE trigger rejects every update for every role (append-only)", /create\s+trigger\s+assistant_command_events_append_only\s+before\s+update\s+on\s+assistant_command_events/.test(stmts) && /raise\s+exception\s+'assistant_command_events: the command record is append-only/.test(stmts));
    ok("a BEFORE INSERT trigger, security definer with a fixed search_path, checks the cross-table facts", /create\s+trigger\s+assistant_command_events_refs_match\s+before\s+insert/.test(stmts) && /language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*public/.test(stmts));
    ok("the trigger: thread, user message and assistant message share the organization and thread; the author owns the thread; a command needs a RUNNING turn; a terminal row needs its started row", /a_status\s+is\s+distinct\s+from\s+'running'/.test(stmts) && /new\.created_by\s+is\s+distinct\s+from\s+t_owner/.test(stmts) && /u_role\s+is\s+distinct\s+from\s+'user'/.test(stmts) && /a_role\s+is\s+distinct\s+from\s+'assistant'/.test(stmts) && /an executed or failed row must follow a started row of the same command/.test(stmts));
    ok("one started row and one terminal row per command (partial unique indexes)", /unique\s+index\s+\w+\s+on\s+assistant_command_events\s*\(command_id\)\s+where\s+event\s*=\s*'started'/.test(stmts) && /unique\s+index\s+\w+\s+on\s+assistant_command_events\s*\(command_id\)\s+where\s+event\s*<>\s*'started'/.test(stmts));
    ok("the event vocabulary is exactly started | executed | failed | refused", /event\s+in\s*\('started',\s*'executed',\s*'failed',\s*'refused'\)/.test(stmts));
    const abilities = (/assistant_command_events_ability_check\s+check\s*\(\s*ability\s+in\s*\(([^)]*)\)/.exec(stmts)?.[1] ?? "").split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean).sort();
    ok(
      "the ability vocabulary in the database is exactly the code's ten commands, two gates and the restore",
      JSON.stringify(abilities) === JSON.stringify([...COMMAND_DEFS.map((d) => d.name), RESTORE_ACTION_NAME].sort()) && COMMAND_DEFS.length === 12,
      abilities.join(", ")
    );
    ok("the table carries the quoted words, the exact payload, what was replaced, the result and the error", ["quote", "payload", "previous", "result", "error_note", "user_message_id", "assistant_message_id", "thread_id", "subject_table", "subject_id", "restores_command_id"].every((c) => new RegExp(`\\b${c}\\b`).test(stmts)));
    ok("a command row must carry a quotation; a click row must not, and must name what it restores", /origin\s*=\s*'command'\s+and\s+quote\s+is\s+not\s+null/.test(stmts) && /origin\s*=\s*'click'\s+and\s+quote\s+is\s+null\s+and\s+restores_command_id\s+is\s+not\s+null/.test(stmts));
    ok("`previous` lives on the started row only (born before the effect), and a started row carries no outcome", /event\s*=\s*'started'\s+and\s+result\s+is\s+null\s+and\s+error_note\s+is\s+null/.test(stmts) && /error_note\s+is\s+null\s+and\s+previous\s+is\s+null/.test(stmts));
    ok("the table name in code is the table name in SQL, and the setup message names migration 0081", /COMMAND_EVENTS_TABLE = "assistant_command_events"/.test(read("lib/assistant/audit.ts")) && /COMMAND_MIGRATION = "0081"/.test(read("lib/assistant/audit.ts")));
  }
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
