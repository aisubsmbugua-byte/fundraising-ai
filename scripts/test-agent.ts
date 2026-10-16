// The external-agent connector's permanent specs (STATE item 98, ruling 0039).
//
//   npx tsx scripts/test-agent.ts
//
// Offline: no database, no network, no Meta account. Everything runs against an
// in-memory Supabase fake and fake dependencies; the migration is checked by
// text. What it CANNOT show -- the live session exchange, the migration
// against a real database, the live Muse connection, the pages in a browser --
// is listed in the build report and was not claimed.
//
// Sections
//   1  tokens: shape, hash-only storage, never logged
//   2  verification: miss / revoked / expired / scope, against a fake RPC
//   3  the minting module: cache, concurrency, wrong-user, header-bound client
//   4  the request-scoped client override
//   5  MCP protocol shapes, negotiation, batches
//   6  the HTTP layer: 401 / 405 / 404-well-known / 413 / 429, never an HTML 500
//   7  the tool registry: exact set, scopes, schemas, forbidden semantics
//   8  reads: allowlists, report, size cap
//   9  acts: scope, write cap, record-before-effect, guards, adversarial args
//  10  approval links: request, single use, expiry, wrong user, changed content
//  11  restore of agent edits
//  12  scans: the credential, the override, the gates, forbidden references
//  13  the migration, by text

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";

import { generateToken, hashToken, parseBearer, isWellFormedToken, tokenDisplayPrefix } from "../lib/agent/token";
import { authenticate, TOKEN_INVALID_MESSAGE, TOKEN_REQUIRED_MESSAGE, type VerifyRpc, type Principal } from "../lib/agent/verify";
import { createMinter } from "../lib/agent/mint";
import { createClient as createCookieAwareClient, runWithAgentClient } from "../lib/supabase/server";
import { handleBody, handleMessage, shapeToolResult, countToolCalls, negotiateVersion, INSTRUCTIONS, RPC, type McpContext } from "../lib/agent/mcp";
import { handleMcpPost, safeHandle, defaultHttpDeps, type HttpDeps } from "../lib/agent/http";
import { AGENT_TOOLS, findTool, toolsForScope, runRead, sizeError, bytesOf, APPROVALS_NOTE } from "../lib/agent/tools";
import { AGENT_ACT_NAMES, parseAgentArgs, agentSchemaFor } from "../lib/agent/act-args";
import { runAgentAct, READ_TOKEN_REFUSAL } from "../lib/agent/act";
import { windowUsage, retryAfterSeconds, insertAgentEvent, compactArgs, type AgentEventInsert } from "../lib/agent/log";
import {
  runRequestApproval,
  evaluateApproval,
  APPROVAL_MESSAGES,
  type ApprovalRow,
  type LiveSubject,
} from "../lib/agent/approvals";
import { approveFromRequestCore, consumeRequest, APPROVED_ON_PLATFORM_NOTE } from "../lib/agent/approve-exec";
import { restoreAgentEditCore } from "../lib/agent/restore";
import { createTokenCore, revokeTokenCore } from "../lib/agent/tokens-admin";
import { buildFundraisingReport, renderReport, REPORT_ALLOWLIST } from "../lib/agent/report";
import { buildCallLines } from "../lib/agent/calls-view";
import * as LIMITS from "../lib/agent/limits";
import { isSetupPending } from "../lib/agent/setup";
import { collectKeys, enforceAllowlist } from "../lib/assistant/dispatch";
import { strategyFingerprint, draftFingerprint } from "../lib/assistant/fingerprint";
import { additiveViolations } from "./ledger-check";
import * as McpRoute from "../app/api/mcp/route";
import * as WellKnownAuthz from "../app/.well-known/oauth-authorization-server/[[...path]]/route";
import * as WellKnownResource from "../app/.well-known/oauth-protected-resource/[[...path]]/route";
import type { CommandEntryPoints } from "../lib/assistant/types";
import { COMMAND_EXECUTORS, type Executor } from "../lib/assistant/command-exec";

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

// --- source helpers (same shape as scripts/test-assistant.ts) ------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    if (name.startsWith(".") && name !== ".well-known") continue;
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

const AGENT_LIB = readdirSync(join(root, "lib/agent")).filter((f) => f.endsWith(".ts")).map((f) => `lib/agent/${f}`);
const APPROVE_ACTIONS = "app/(dashboard)/approve/[id]/actions.ts";
const NEW_SURFACE = [
  ...AGENT_LIB,
  "app/api/mcp/route.ts",
  "app/.well-known/oauth-authorization-server/[[...path]]/route.ts",
  "app/.well-known/oauth-protected-resource/[[...path]]/route.ts",
  "app/(dashboard)/approve/[id]/page.tsx",
  "app/(dashboard)/approve/[id]/approve-button.tsx",
  APPROVE_ACTIONS,
  "app/(dashboard)/settings/connections/page.tsx",
  "app/(dashboard)/settings/connections/connections-panel.tsx",
  "app/(dashboard)/settings/connections/actions.ts",
];

// --- a small in-memory Supabase fake (trimmed from scripts/test-assistant.ts) ---

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Err = { code?: string; message: string };
type LogEntry = { table: string; op: "select" | "insert" | "update" | "delete"; payload?: any; filters: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW_ISO = "2026-10-16T12:00:00.000Z";
const NOW = new Date(NOW_ISO);

class FakeDb {
  tables: Record<string, Row[]> = {};
  log: LogEntry[] = [];
  insertErrors: Record<string, Err> = {};
  selectErrors: Record<string, Err> = {};
  updateErrors: Record<string, Err> = {};
  blockUpdate = new Set<string>();
  // Called with (table, row) on every insert, before it lands: lets a spec
  // record the order of events across the log and the entry points.
  onInsert: ((table: string, row: Row) => void) | null = null;
  seq = 0;
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
    const base: Row = { id: this.uuid(), created_at: NOW_ISO };
    if (table.startsWith("agent_")) return { ...base, organization_id: ORG, user_id: USER, ...p };
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
  // "access.eq.read,event.in.(started,refused)" -- the only shapes the agent uses.
  or(expr: string) {
    const clauses: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of expr) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        clauses.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) clauses.push(cur);
    const tests = clauses.map((c) => {
      const [col, op, ...rest] = c.split(".");
      const val = rest.join(".");
      if (op === "eq") return (r: Row) => String(r[col]) === val;
      if (op === "in") {
        const set = val.replace(/^\(|\)$/g, "").split(",");
        return (r: Row) => set.includes(String(r[col]));
      }
      throw new Error(`fake or(): unsupported clause ${c}`);
    });
    return this.f(`or ${expr}`, (r) => tests.some((t) => t(r)));
  }
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
  then(resolve?: (v: any) => unknown, reject?: (e: unknown) => unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return Promise.resolve(this.run()).then(resolve, reject);
  }
  private run(): { data: any; error: Err | null; count?: number | null } { // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = this.db;
    db.log.push({ table: this.table, op: this.op, payload: this.payload, filters: this.filterDesc });
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
      for (const r of inserted) db.onInsert?.(this.table, r);
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

// --- fixtures ---------------------------------------------------------------------

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
const leaks = (text: string) =>
  Object.values(SECRET).map(String).concat(["REASON-SECRET", "STATUS-SECRET", "ERR-SECRET", "SOURCE-DETAIL-SECRET", "GIFT-NOTE-SECRET"]).filter((s) => text.includes(s));

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

const P = {
  due: "10000000-0000-4000-8000-000000000001",
  overdue: "10000000-0000-4000-8000-000000000002",
  never: "10000000-0000-4000-8000-000000000003",
  revisit: "10000000-0000-4000-8000-000000000004",
  later: "10000000-0000-4000-8000-000000000005",
  quiet: "10000000-0000-4000-8000-000000000006",
  noaction: "10000000-0000-4000-8000-000000000007",
};
const SR = { ready: "70000000-0000-4000-8000-000000000001", approved: "70000000-0000-4000-8000-000000000002" };
const DR = { draft: "80000000-0000-4000-8000-000000000001", approved: "80000000-0000-4000-8000-000000000002", sent: "80000000-0000-4000-8000-000000000003" };
const S = { priority: "20000000-0000-4000-8000-000000000001", light: "20000000-0000-4000-8000-000000000002", fresh: "20000000-0000-4000-8000-000000000003" };

function contaminatedDb(): FakeDb {
  const db = new FakeDb();
  const base = (id: string, name: string, extra: Row = {}): Row => ({
    id, name, channel: "foundation", stage: "outreach", ask_amount: 25000, next_action: null, next_action_due: null,
    contact_name: SECRET.prospectContact, contact_email: SECRET.prospectEmail, notes: SECRET.prospectNotes,
    website: "https://secret-funder.example", ein: "12-3456789", organization: "Secret Funder Org", ...extra,
  });
  db.seed("prospects", [
    base(P.due, "Due Soon Fund", { next_action: "Call the program officer", next_action_due: dayOffset(2) }),
    base(P.overdue, "Overdue Trust", { next_action: "Send the report", next_action_due: dayOffset(-10), stage: "proposal" }),
    base(P.never, "Closed Forever Foundation", { next_action: "Should not be offered", next_action_due: dayOffset(1) }),
    base(P.revisit, "Revisit Me Fund", { stage: "discovery" }),
    base(P.later, "Far Future Fund", { next_action: "Check in", next_action_due: dayOffset(20) }),
    base(P.quiet, "Gone Quiet Church", { stage: "stewardship" }),
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
    { id: SR.ready, prospect_id: P.due, status: "ready_for_review", approved_strategy: null, created_at: "2026-10-12T00:00:00Z" },
    { id: SR.approved, prospect_id: P.overdue, status: "ready_for_review", approved_strategy: { a: 1 }, created_at: "2026-10-11T00:00:00Z" },
  ]);
  db.seed("drafts", [
    { id: DR.draft, prospect_id: P.due, kind: "intro_email", status: "draft", subject: "Hello", content: "Hi there", sent_at: null, created_at: "2026-10-12T00:00:00Z" },
    { id: DR.approved, prospect_id: P.overdue, kind: "call_prep", status: "approved", subject: null, content: "Notes", sent_at: null, created_at: "2026-10-11T00:00:00Z" },
  ]);
  const sup = (id: string, name: string, extra: Row = {}): Row => ({
    id, name, email: SECRET.supporterEmail, phone: SECRET.supporterPhone, notes: SECRET.supporterNotes, source_type: "event",
    source_detail: "SOURCE-DETAIL-SECRET", pledged_amount: SECRET.pledgeAmount, pledged_frequency: "annual", ...extra,
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
  db.seed("org_profile", [{ id: "op1", name: "Harvest Mission" }]);
  db.seed("agent_tokens", [{ id: TOKEN_ID, name: "Muse on my laptop", scope: "act", expires_at: "2027-01-01T00:00:00.000Z", revoked_at: null, user_id: USER, organization_id: ORG }]);
  return db;
}

const principal = (scope: "read" | "act", over: Partial<Principal> = {}): Principal => ({
  tokenId: TOKEN_ID, userId: USER, organizationId: ORG, scope, expiresAt: "2027-01-01T00:00:00.000Z", ...over,
});

// Entry points that count their calls and, where the executors check the
// outcome in the database afterwards, make the change in the fake.
function fakeEps(db: FakeDb, calls: string[]): CommandEntryPoints {
  const rec = (n: string) => calls.push(n);
  return {
    createProspect: async (form: FormData) => {
      rec("createProspect");
      const id = db.uuid();
      db.seed("prospects", [{ id, name: form.get("name"), channel: form.get("channel"), stage: "discovery" }]);
      const e: any = new Error("NEXT_REDIRECT"); // eslint-disable-line @typescript-eslint/no-explicit-any
      e.digest = `NEXT_REDIRECT;push;/prospects/${id};307;`;
      throw e;
    },
    updateDraft: async (draftId, _p, subject, content) => {
      rec("updateDraft");
      const d = db.rows("drafts").find((r) => r.id === draftId);
      if (d) Object.assign(d, { subject, content });
      return { ok: true as const };
    },
    reviseDraftWithFeedback: async () => { rec("reviseDraftWithFeedback"); return { error: "not in this spec" }; },
    reviseStrategyWithFeedback: async (runId) => {
      rec("reviseStrategyWithFeedback");
      const old = db.rows("strategy_runs").find((r) => r.id === runId);
      const id = db.uuid();
      db.seed("strategy_runs", [{ ...old, id, created_at: "2026-10-16T12:00:05.000Z" }]);
      return { ok: true as const, runId: id };
    },
    generateDraft: async () => { rec("generateDraft"); },
    unapproveDraft: async (draftId) => {
      rec("unapproveDraft");
      const d = db.rows("drafts").find((r) => r.id === draftId);
      if (d) d.status = "draft";
      return { ok: true as const };
    },
    approveDraft: async (draftId) => {
      rec("approveDraft");
      const d = db.rows("drafts").find((r) => r.id === draftId);
      if (d) d.status = "approved";
    },
    approveStrategy: async (runId, _p, strategy) => {
      rec("approveStrategy");
      const r = db.rows("strategy_runs").find((x) => x.id === runId);
      if (r) r.approved_strategy = strategy;
    },
    logInteraction: async () => { rec("logInteraction"); },
    updateNextAction: async (prospectId, action, due) => {
      rec("updateNextAction");
      const p = db.rows("prospects").find((r) => r.id === prospectId);
      if (p) Object.assign(p, { next_action: action, next_action_due: due || null });
    },
    logSupporterInteraction: async () => { rec("logSupporterInteraction"); },
    updateAskAmount: async (prospectId, amount) => {
      rec("updateAskAmount");
      const p = db.rows("prospects").find((r) => r.id === prospectId);
      if (p) p.ask_amount = amount;
    },
  };
}

function mcpCtx(db: FakeDb, p: Principal, over: Partial<McpContext> = {}): McpContext & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    principal: p,
    protocolHeader: null,
    origin: "https://fundraising-ai.vercel.app",
    now: () => NOW,
    remainingMs: () => 280_000,
    loadEntryPoints: async () => { throw new Error("this spec did not provide entry points"); },
    getClient: async () => db.client(),
    logLine: (l) => lines.push(l),
    lines,
    ...over,
  };
}

async function call(ctx: McpContext, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; structured?: Record<string, unknown>; raw: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx);
  const r = res as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!r || r.error) return { isError: true, text: r?.error?.message ?? "(no response)", raw: r };
  return { isError: r.result.isError, text: r.result.content[0].text, structured: r.result.structuredContent, raw: r };
}

const UUID_X = "99999999-9999-4999-8999-999999999999";

function mcpCtxToolCtx(db: FakeDb, p: Principal = principal("read")) {
  return { supabase: db.client(), principal: p, now: NOW, remainingMs: () => 280_000, origin: "https://fundraising-ai.vercel.app", loadEntryPoints: async () => { throw new Error("no entry points"); } };
}

async function main() {
  // =========================================================================
  section("1. tokens: shape, hash-only storage, never logged");
  {
    const t = generateToken();
    ok("a token is the fixed prefix plus 43 base64url characters (32 random bytes)", t.startsWith(LIMITS.TOKEN_PREFIX) && t.length === 47 && isWellFormedToken(t), t.length.toString());
    ok("two tokens differ", generateToken() !== generateToken());
    const fixed = generateToken(() => Buffer.alloc(32, 7));
    ok("the random source is injectable and the token is exactly prefix + base64url(bytes)", fixed === `fai_${Buffer.alloc(32, 7).toString("base64url")}`);
    ok("hashToken is the sha256 hex of the token (64 hex chars)", /^[0-9a-f]{64}$/.test(hashToken(t)) && hashToken(t) === hashToken(t) && hashToken(t) !== hashToken(generateToken()));
    ok("the display prefix is the first 8 characters", tokenDisplayPrefix(t) === t.slice(0, 8));
    ok("parseBearer: missing header", JSON.stringify(parseBearer(null)) === JSON.stringify({ ok: false, reason: "missing" }) && (parseBearer("   ") as any).reason === "missing");
    ok("parseBearer: a wrong scheme, a short token and a wrong prefix are malformed", ["Basic abc", `Bearer ${t.slice(0, 20)}`, `Bearer xxx_${t.slice(4)}`, `Bearer ${t} extra`, "Bearer"].every((h) => (parseBearer(h) as any).reason === "malformed"));
    ok("parseBearer: a well-formed token is accepted, scheme case-insensitive", (parseBearer(`Bearer ${t}`) as any).token === t && (parseBearer(`bearer ${t}`) as any).token === t);

    // Creation: only the hash reaches storage.
    const db = new FakeDb();
    const random = () => Buffer.alloc(32, 9);
    const made = await createTokenCore({ supabase: db.client(), name: "  Muse   on my laptop ", scope: "act", days: undefined, now: NOW, random });
    const inserts = db.log.filter((l) => l.table === "agent_tokens" && l.op === "insert");
    ok("creating a token inserts exactly one row", inserts.length === 1 && "ok" in made);
    const payloadText = JSON.stringify(inserts[0]?.payload ?? {});
    const token = "ok" in made ? made.token : "";
    ok("the token is returned to the caller once", token === `fai_${Buffer.alloc(32, 9).toString("base64url")}`);
    ok("ONLY the hash and the display prefix are handed to storage -- the token itself appears nowhere in the insert payload", !payloadText.includes(token) && inserts[0]?.payload.token_hash === hashToken(token) && inserts[0]?.payload.token_prefix === token.slice(0, 8), payloadText);
    ok("the payload carries name (whitespace-collapsed), scope and an expiry of 90 days by default", inserts[0]?.payload.name === "Muse on my laptop" && inserts[0]?.payload.scope === "act" && inserts[0]?.payload.expires_at === new Date(NOW.getTime() + 90 * 86400000).toISOString());
    ok("the payload names no column called token", !Object.keys(inserts[0]?.payload ?? {}).includes("token"));
    const bad = async (o: Record<string, unknown>) => createTokenCore({ supabase: new FakeDb().client(), name: "n", scope: "read", days: 30, now: NOW, ...o });
    ok("an expiry over a year is refused", "error" in (await bad({ days: 366 })));
    ok("an expiry of exactly a year is allowed", "ok" in (await bad({ days: 365 })));
    ok("zero, fractional and non-numeric expiries are refused", ["error" in (await bad({ days: 0 })), "error" in (await bad({ days: 1.5 })), "error" in (await bad({ days: "soon" }))].every(Boolean));
    ok("a blank, over-long or non-string name is refused", ["error" in (await bad({ name: "   " })), "error" in (await bad({ name: "x".repeat(81) })), "error" in (await bad({ name: 5 }))].every(Boolean));
    ok("a scope other than read or act is refused", ["error" in (await bad({ scope: "admin" })), "error" in (await bad({ scope: undefined }))].every(Boolean));
    const db2 = new FakeDb();
    db2.insertErrors["agent_tokens"] = { code: "42P01", message: "relation does not exist" };
    const pending = await createTokenCore({ supabase: db2.client(), name: "n", scope: "read", days: 30 });
    ok("with the table absent, creating a token says setup is pending and returns no token", "error" in pending && /Setup pending/.test(pending.error) && !("token" in pending));

    // Revocation.
    const dbr = new FakeDb();
    dbr.seed("agent_tokens", [{ id: TOKEN_ID, revoked_at: null }]);
    const r1 = await revokeTokenCore({ supabase: dbr.client(), tokenId: TOKEN_ID, now: NOW });
    ok("revoking sets revoked_at", "ok" in r1 && dbr.rows("agent_tokens")[0].revoked_at === NOW_ISO);
    const r2 = await revokeTokenCore({ supabase: dbr.client(), tokenId: TOKEN_ID, now: NOW });
    ok("revoking twice is refused (the update is conditional on revoked_at being null)", "error" in r2);
    ok("revoking a non-uuid is refused without a query", "error" in (await revokeTokenCore({ supabase: dbr.client(), tokenId: "x" })));

    // Never logged: no console call in lib/agent can carry the token or its hash.
    const offenders: string[] = [];
    for (const f of [...AGENT_LIB, ...NEW_SURFACE.filter((x) => x.startsWith("app/"))]) {
      for (const m of code(f).matchAll(/console\.\w+\(([^;]*?)\);/gs)) {
        const arg = m[1];
        const interpolations = [...arg.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(" ");
        const bare = arg.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, "");
        if (/\b(token|presented|bearer|authorization|hash|rawToken)\b/i.test(interpolations + " " + bare)) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    ok("no console call in the connector names a token, a bearer, an authorization header or a hash as a value", offenders.length === 0, offenders.join("; "));
    ok("the connector's per-call line carries exactly tool, status, bytes, duration and token id", /logLine\(\{ evt: "agent_call", tool: tool\.name, status: payload\.isError \? "error" : "ok", bytes, durationMs: Date\.now\(\) - started, tokenId: ctx\.principal\.tokenId \}\)/.test(code("lib/agent/mcp.ts")));
  }

  // =========================================================================
  section("2. verification: miss, revoked, expired, scope -- against a fake RPC");
  {
    const t = generateToken();
    const seenHashes: string[] = [];
    const live = (scope: string, expires = "2027-01-01T00:00:00.000Z"): VerifyRpc => async (h) => {
      seenHashes.push(h);
      return { data: [{ token_id: TOKEN_ID, user_id: USER, organization_id: ORG, scope, expires_at: expires }], error: null };
    };
    const miss: VerifyRpc = async (h) => { seenHashes.push(h); return { data: [], error: null }; };
    const a = await authenticate(`Bearer ${t}`, live("act"), NOW);
    ok("a live act token yields the principal (token, user, organization, scope, expiry)", a.ok && a.principal.scope === "act" && a.principal.userId === USER && a.principal.tokenId === TOKEN_ID && a.principal.organizationId === ORG);
    const r = await authenticate(`Bearer ${t}`, live("read"), NOW);
    ok("a live read token is a read principal", r.ok && r.principal.scope === "read");
    ok("ONLY the hash of the token is passed to the database", seenHashes.length === 2 && seenHashes.every((h) => h === hashToken(t) && !h.includes(t)));
    const m = await authenticate(`Bearer ${t}`, miss, NOW);
    ok("a miss (unknown, revoked or expired -- the function returns no row for all three) is 401 token_invalid with a plain message", !m.ok && m.status === 401 && m.code === "token_invalid" && m.message === TOKEN_INVALID_MESSAGE && /revoked/.test(m.message) && /expired/.test(m.message));
    const e = await authenticate(`Bearer ${t}`, live("act", "2026-10-01T00:00:00.000Z"), NOW);
    ok("defence in depth: a row whose expiry is already past is refused even if the database returned it", !e.ok && e.status === 401);
    const weird = await authenticate(`Bearer ${t}`, async () => ({ data: [{ token_id: "nope", user_id: USER, organization_id: ORG, scope: "act", expires_at: "2027-01-01T00:00:00.000Z" }], error: null }), NOW);
    ok("a malformed row (bad id) is refused", !weird.ok && weird.status === 401);
    const badScope = await authenticate(`Bearer ${t}`, live("admin"), NOW);
    ok("an unknown scope value is refused", !badScope.ok);
    let called = 0;
    const counting: VerifyRpc = async () => { called++; return { data: [], error: null }; };
    const none = await authenticate(null, counting, NOW);
    ok("no header: 401 token_required, and the database is never asked", !none.ok && none.code === "token_required" && none.message === TOKEN_REQUIRED_MESSAGE && called === 0);
    const mal = await authenticate("Bearer not-a-token", counting, NOW);
    ok("a malformed token: 401 token_invalid, and the database is never asked", !mal.ok && mal.code === "token_invalid" && called === 0);
    const gone = await authenticate(`Bearer ${t}`, async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.verify_agent_token" } }), NOW);
    ok("with the function absent (migration not applied): 503 setup_pending naming migration 0082", !gone.ok && gone.status === 503 && gone.code === "setup_pending" && /0082/.test(gone.message));
    const boom = await authenticate(`Bearer ${t}`, async () => { throw new Error("network down"); }, NOW);
    ok("an rpc that throws is a 500 verify_failed, not a thrown exception", !boom.ok && boom.status === 500 && boom.code === "verify_failed");
    const err = await authenticate(`Bearer ${t}`, async () => ({ data: null, error: { code: "XX000", message: "boom" } }), NOW);
    ok("any other database error is a 500 verify_failed", !err.ok && err.status === 500);
    ok("isSetupPending recognises missing tables and functions only", isSetupPending({ code: "42P01" }) && isSetupPending({ code: "PGRST205" }) && isSetupPending({ code: "42883" }) && isSetupPending({ code: "PGRST202" }) && !isSetupPending({ code: "23505", message: "dup" }) && !isSetupPending(null));
  }

  // =========================================================================
  section("3. the minting module: cache, concurrency, wrong user, a header-bound client");
  {
    function fakeMint(over: { userId?: string; sessionUser?: string; email?: string | null; expiresInS?: number } = {}) {
      const c = { getUserById: 0, generateLink: 0, verifyOtp: 0 };
      let n = 0;
      let nowMs = Date.parse(NOW_ISO);
      const deps = {
        url: "https://project.supabase.co",
        anonKey: "sb_publishable_test",
        serviceKey: "sb_secret_test",
        now: () => nowMs,
        makeAdmin: () => ({
          auth: {
            admin: {
              getUserById: async (id: string) => { c.getUserById++; await new Promise((r) => setTimeout(r, 5)); return { data: { user: { id, email: over.email === undefined ? "owner@example.org" : over.email } }, error: null }; },
              generateLink: async () => { c.generateLink++; return { data: { properties: { hashed_token: "hashed" } }, error: null }; },
            },
          },
        }),
        makeAnon: () => ({
          auth: {
            verifyOtp: async () => {
              c.verifyOtp++;
              n++;
              return { data: { user: { id: over.sessionUser ?? over.userId ?? USER }, session: { access_token: `jwt-${n}`, expires_at: Math.floor(nowMs / 1000) + (over.expiresInS ?? 3600) } }, error: null };
            },
          },
        }),
      };
      return { deps, c, advance: (ms: number) => { nowMs += ms; } };
    }
    const f1 = fakeMint();
    const minter = createMinter(f1.deps);
    const [t1, t2] = await Promise.all([minter.accessTokenFor(USER), minter.accessTokenFor(USER)]);
    ok("two concurrent calls for one user share ONE mint (one generate-link, one verify-otp)", t1 === t2 && f1.c.generateLink === 1 && f1.c.verifyOtp === 1, JSON.stringify(f1.c));
    const f2 = fakeMint();
    const m2 = createMinter(f2.deps);
    const many = await Promise.all(Array.from({ length: 12 }, () => m2.accessTokenFor(USER)));
    ok("twelve parallel tool calls perform exactly one session mint", new Set(many).size === 1 && f2.c.generateLink === 1 && f2.c.verifyOtp === 1 && f2.c.getUserById === 1, JSON.stringify(f2.c));
    await m2.accessTokenFor(USER);
    ok("a later call within the cache window reuses the session (still one mint)", f2.c.verifyOtp === 1);
    f2.advance(LIMITS.MINT_CACHE_MS - 1000);
    await m2.accessTokenFor(USER);
    ok("just inside the cache window it is still reused", f2.c.verifyOtp === 1);
    f2.advance(2000);
    const after = await m2.accessTokenFor(USER);
    ok("past the 45-minute cache window a fresh session is minted", f2.c.verifyOtp === 2 && after === "jwt-2");
    ok("the cache window is well under a session's life (45 minutes of ~60)", LIMITS.MINT_CACHE_MS === 45 * 60 * 1000);
    const f3 = fakeMint({ expiresInS: 600 });
    const m3 = createMinter(f3.deps);
    await m3.accessTokenFor(USER);
    f3.advance(6 * 60 * 1000);
    await m3.accessTokenFor(USER);
    ok("a session about to expire (within the margin) is not served from cache", f3.c.verifyOtp === 2);
    const fw = fakeMint({ sessionUser: OTHER_USER });
    let wrong = "";
    try { await createMinter(fw.deps).accessTokenFor(USER); } catch (e2) { wrong = e2 instanceof Error ? e2.message : ""; }
    ok("a session for anyone other than the verified owner is refused", /could not be started/.test(wrong), wrong);
    let noEmail = "";
    try { await createMinter(fakeMint({ email: null }).deps).accessTokenFor(USER); } catch (e2) { noEmail = e2 instanceof Error ? e2.message : ""; }
    ok("an owner who cannot be found (no email) is refused", /could not be found/.test(noEmail), noEmail);
    let unconfigured = "";
    try { await createMinter({ ...f1.deps, serviceKey: "" }).accessTokenFor(USER); } catch (e2) { unconfigured = e2 instanceof Error ? e2.message : ""; }
    ok("with the privileged credential unset, minting refuses plainly", /not fully configured/.test(unconfigured), unconfigured);

    // The REAL supabase-js client with a recording fetch: a header-bound client
    // authenticates getUser() and queries as the token's user.
    const seen: { url: string; auth: string | null; apikey: string | null }[] = [];
    let mintN = 0;
    const real = fakeMint();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      seen.push({ url, auth: headers.get("authorization"), apikey: headers.get("apikey") });
      const bearer = headers.get("authorization");
      if (url.includes("/rest/v1/denied_once") && mintN === 0) {
        mintN++;
        return new Response(JSON.stringify({ message: "JWT expired" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/auth/v1/user")) return new Response(JSON.stringify({ id: USER, aud: "authenticated", email: "owner@example.org", app_metadata: {}, user_metadata: {}, created_at: NOW_ISO }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json", "content-range": "*/0" }, ...(bearer ? {} : {}) });
    };
    const minterReal = createMinter({ ...real.deps, fetchImpl });
    const client = await minterReal.clientFor(USER);
    const who = await client.auth.getUser();
    ok("auth.getUser() on a header-bound client answers with the token's user (the exact call every existing action makes)", who.data.user?.id === USER && !who.error, JSON.stringify(who.error));
    const userCall = seen.find((s) => s.url.includes("/auth/v1/user"));
    ok("getUser() sent the minted access token as its bearer and the publishable key as apikey", userCall?.auth === "Bearer jwt-1" && userCall?.apikey === "sb_publishable_test", JSON.stringify(userCall));
    await client.from("prospects").select("id");
    const rest = seen.find((s) => s.url.includes("/rest/v1/prospects"));
    ok("a table query goes through the same bearer (row-level security applies as that user), never the service key", rest?.auth === "Bearer jwt-1" && !seen.some((s) => (s.auth ?? "").includes("sb_secret") || (s.apikey ?? "").includes("sb_secret")), JSON.stringify(rest));
    await client.from("denied_once").select("id");
    const retried = seen.filter((s) => s.url.includes("/rest/v1/denied_once"));
    ok("on a 401 the cached session is dropped, a fresh one minted, and the request retried once with it", retried.length === 2 && retried[0].auth === "Bearer jwt-1" && retried[1].auth === "Bearer jwt-2" && real.c.verifyOtp === 2, JSON.stringify(retried));
  }

  // =========================================================================
  section("4. the request-scoped client override");
  {
    const src = read("lib/supabase/server.ts");
    const fake = { marker: "override" } as unknown as SupabaseClient;
    const inside = runWithAgentClient(fake, () => createCookieAwareClient());
    ok("inside runWithAgentClient, createClient() returns the override client", (inside as unknown) === fake);
    let outsideThrew = "";
    try { createCookieAwareClient(); } catch (e) { outsideThrew = e instanceof Error ? e.message : String(e); }
    ok("with no override entered, createClient() takes the original cookie path (outside a request that is Next's own 'cookies called outside a request scope' error -- exactly as before)", /cookies/.test(outsideThrew), outsideThrew);
    const after = await runWithAgentClient(fake, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return createCookieAwareClient();
    });
    ok("the override survives awaits inside the run", (after as unknown) === fake);
    const other = { marker: "other" } as unknown as SupabaseClient;
    const [x, y] = await Promise.all([
      runWithAgentClient(fake, async () => { await new Promise((r) => setTimeout(r, 10)); return createCookieAwareClient(); }),
      runWithAgentClient(other, async () => { await new Promise((r) => setTimeout(r, 2)); return createCookieAwareClient(); }),
    ]);
    ok("two concurrent runs each see only their own client", (x as unknown) === fake && (y as unknown) === other);
    let leaked = "";
    try { createCookieAwareClient(); } catch (e) { leaked = e instanceof Error ? e.message : String(e); }
    ok("after a run ends the override is gone again", /cookies/.test(leaked));
    const original = `function createCookieClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // called from a Server Component; safe to ignore when middleware refreshes sessions
          }
        },
      },
    }
  );
}`;
    ok("the cookie-reading factory body is byte-for-byte what it was before this change", src.includes(original));
    ok("the store lives on globalThis under a Symbol.for key (one store even if the bundler instantiates the module twice)", /Symbol\.for\("fundraising-ai\.agentClientStore"\)/.test(src) && /globalThis as StoreHolder/.test(src));
  }

  // =========================================================================
  section("5. MCP protocol shapes, negotiation and batches");
  {
    const db = contaminatedDb();
    const ctx = mcpCtx(db, principal("act"));
    const init = async (v: unknown, id: unknown = 1) => (await handleMessage({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "muse", version: "1" } } }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const r = await init(v);
      ok(`initialize echoes the client's supported version ${v}`, r.result.protocolVersion === v && r.id === 1 && r.jsonrpc === "2.0");
    }
    const unknownV = await init("1999-01-01");
    ok("an unsupported version is answered with the latest supported one (2025-06-18)", unknownV.result.protocolVersion === "2025-06-18" && negotiateVersion(undefined) === "2025-06-18");
    const full = await init("2025-06-18", "abc");
    ok("initialize: capabilities are exactly tools with listChanged:false; serverInfo and instructions present; string ids echo", JSON.stringify(full.result.capabilities) === JSON.stringify({ tools: { listChanged: false } }) && full.result.serverInfo.name === "fundraising-ai" && typeof full.result.serverInfo.version === "string" && full.id === "abc" && typeof full.result.instructions === "string");
    ok("the instructions say approvals are the owner's, by link, never the agent's -- and that nothing is delivered to a funder", /never by the agent/.test(INSTRUCTIONS) && /link/.test(INSTRUCTIONS) && /request_approval/.test(INSTRUCTIONS) && /funder/.test(INSTRUCTIONS));
    const noParams = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize" }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("initialize without a protocolVersion is -32602", noParams.error.code === RPC.invalidParams);
    ok("notifications/initialized is acknowledged with no response entry", (await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)) === null);
    const initBody = await handleBody({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx);
    ok("as a whole request, a lone notification is a 202 with no body", initBody.status === 202 && initBody.body === null);
    const ping = (await handleMessage({ jsonrpc: "2.0", id: 7, method: "ping" }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("ping answers {} with the request's id", JSON.stringify(ping.result) === "{}" && ping.id === 7);
    const nf = (await handleMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("an unknown method is -32601", nf.error.code === RPC.methodNotFound && nf.id === 8);
    ok("an unknown NOTIFICATION is ignored, not answered", (await handleMessage({ jsonrpc: "2.0", method: "notifications/whatever" }, ctx)) === null);
    const notRpc = (await handleMessage({ id: 1, method: "ping" }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("a message without jsonrpc:'2.0' is -32600", notRpc.error.code === RPC.invalidRequest);
    const str = (await handleMessage("ping", ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("a non-object message is -32600", str.error.code === RPC.invalidRequest);
    ok("a client's own response message is acknowledged silently", (await handleMessage({ jsonrpc: "2.0", id: 3, result: {} }, ctx)) === null);
    const noMethod = (await handleMessage({ jsonrpc: "2.0", id: 3 }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("a request with an id and no method is -32600", noMethod.error.code === RPC.invalidRequest);

    const list = (await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/list" }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const names: string[] = list.result.tools.map((t: any) => t.name); // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("tools/list returns name, title, description, inputSchema and annotations for every tool", list.result.tools.every((t: any) => t.name && t.title && t.description && t.inputSchema?.type === "object" && t.annotations)); // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("an act token lists reads, acts and request_approval (19 tools)", names.length === 19 && names.includes("request_approval") && names.includes("edit_draft") && names.includes("whoami"), String(names.length));
    const rlist = (await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/list" }, mcpCtx(db, principal("read")))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rnames: string[] = rlist.result.tools.map((t: any) => t.name); // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("a READ token lists only the 10 read tools -- no act, no request_approval", rnames.length === 10 && rnames.every((n) => findTool(n)?.scope === "read") && !rnames.includes("request_approval"), rnames.join(","));

    const unknownTool = (await handleMessage({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "approve_strategy", arguments: {} } }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("tools/call of approve_strategy is an unknown tool (-32602): there is no such tool", unknownTool.error.code === RPC.invalidParams);
    const unknown2 = (await handleMessage({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "approve_draft", arguments: {} } }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("and neither is approve_draft", unknown2.error.code === RPC.invalidParams);
    const noName = (await handleMessage({ jsonrpc: "2.0", id: 10, method: "tools/call", params: {} }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("tools/call without a name is -32602", noName.error.code === RPC.invalidParams);
    const badArgs = await call(ctx, "get_dashboard_summary", { surprise: 1 });
    ok("a tool failure is a TOOL RESULT with isError:true and a plain message, not a transport error", badArgs.isError && badArgs.raw.result?.isError === true && /Unknown argument/.test(badArgs.text));
    const arrArgs = (await handleMessage({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "whoami", arguments: [1] } }, ctx)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("non-object arguments are a tool error", arrArgs.result.isError === true);

    // Batches
    const batch = await handleBody(
      [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      ctx
    );
    ok("a batch is answered entry by entry; the notification produces no entry", batch.status === 200 && Array.isArray(batch.body) && (batch.body as any[]).length === 2 && (batch.body as any[])[0].id === 1 && (batch.body as any[])[1].id === 2); // eslint-disable-line @typescript-eslint/no-explicit-any
    const allNotes = await handleBody([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", method: "notifications/cancelled" }], ctx);
    ok("a batch of only notifications is a 202 with no body", allNotes.status === 202 && allNotes.body === null);
    const empty = await handleBody([], ctx);
    ok("an empty batch is -32600 / 400", empty.status === 400 && (empty.body as any).error.code === RPC.invalidRequest); // eslint-disable-line @typescript-eslint/no-explicit-any
    const huge = await handleBody(Array.from({ length: LIMITS.MAX_BATCH_MESSAGES + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })), ctx);
    ok("a batch over the limit is refused", huge.status === 400);
    const mixed = await handleBody([{ jsonrpc: "2.0", id: 1, method: "ping" }, "junk"], ctx);
    ok("a bad entry inside a batch gets its own -32600 entry and does not spoil the others", mixed.status === 200 && (mixed.body as any[]).length === 2 && (mixed.body as any[])[1].error.code === RPC.invalidRequest); // eslint-disable-line @typescript-eslint/no-explicit-any
    ok("countToolCalls counts tools/call requests (not notifications) in single and batch bodies", countToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/call" }) === 1 && countToolCalls([{ id: 1, method: "tools/call" }, { id: 2, method: "tools/call" }, { method: "tools/call" }, { id: 3, method: "ping" }]) === 2 && countToolCalls({ id: 1, method: "ping" }) === 0);
  }

  // =========================================================================
  section("6. the HTTP layer: 401 / 405 / 404 / 413 / 429, and never an HTML 500");
  {
    const t = generateToken();
    const db = contaminatedDb();
    const depsFor = (over: Partial<HttpDeps> = {}): HttpDeps => ({
      verifyRpc: async () => ({ data: [{ token_id: TOKEN_ID, user_id: USER, organization_id: ORG, scope: "act", expires_at: "2027-01-01T00:00:00.000Z" }], error: null }),
      mint: async () => db.client(),
      usage: async () => ({ ok: true, usage: { count: 0, oldestAt: null } }),
      loadEntryPoints: async () => { throw new Error("no entry points in this spec"); },
      enter: runWithAgentClient,
      handleBody,
      origin: "https://fundraising-ai.vercel.app",
      now: () => NOW,
      nowMs: () => Date.parse(NOW_ISO),
      logLine: () => {},
      ...over,
    });
    const post = (body: string | object, headers: Record<string, string> = {}, token: string | null = t) =>
      new Request("https://fundraising-ai.vercel.app/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const isJsonRpcError = async (res: Response) => {
      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      let parsed: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { parsed = JSON.parse(text); } catch { /* not json */ }
      return { json: /application\/json/.test(ct) && !!parsed, error: parsed?.error, body: parsed, text, html: /<html|<!DOCTYPE/i.test(text) };
    };

    const noTok = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, null), depsFor());
    const noTokBody = await isJsonRpcError(noTok);
    ok("no token: 401 with WWW-Authenticate: Bearer realm=\"fundraising-ai\" and a plain JSON error naming the token as required", noTok.status === 401 && noTok.headers.get("www-authenticate") === 'Bearer realm="fundraising-ai"' && noTokBody.json && /token is required/.test(noTokBody.error.message));
    const badTok = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "fai_" + "x".repeat(43)), depsFor({ verifyRpc: async () => ({ data: [], error: null }) }));
    const badBody = await isJsonRpcError(badTok);
    ok("an unknown/revoked/expired token: 401, the same challenge, and a message naming all three", badTok.status === 401 && badTok.headers.get("www-authenticate") === 'Bearer realm="fundraising-ai"' && /revoked/.test(badBody.error.message) && /expired/.test(badBody.error.message));
    const setup = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "ping" }), depsFor({ verifyRpc: async () => ({ data: null, error: { code: "PGRST202", message: "x" } }) }));
    const setupBody = await isJsonRpcError(setup);
    ok("migration not applied: a plain 503 'setup pending -- apply migration 0082'", setup.status === 503 && /0082/.test(setupBody.error.message));
    const revokedMid = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "ping" }), depsFor({ verifyRpc: async () => ({ data: [], error: null }) }));
    ok("revocation takes effect on the very next call: the same token that worked is 401 once the function stops returning it", revokedMid.status === 401);

    const okPing = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "ping" }), depsFor());
    ok("a valid ping is 200 JSON", okPing.status === 200 && (await okPing.json()).result !== undefined);
    const note = await handleMcpPost(post({ jsonrpc: "2.0", method: "notifications/initialized" }), depsFor());
    ok("notifications/initialized over HTTP is 202 with no body", note.status === 202 && (await note.text()) === "");
    const badJson = await handleMcpPost(post("{not json"), depsFor());
    const badJsonBody = await isJsonRpcError(badJson);
    ok("invalid JSON is HTTP 400 with JSON-RPC -32700", badJson.status === 400 && badJsonBody.error.code === RPC.parse);
    const tooBig = await handleMcpPost(post("x".repeat(LIMITS.MAX_REQUEST_BODY_CHARS + 1)), depsFor());
    ok("an over-large body is 413 and is not parsed", tooBig.status === 413);
    const badVer = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" }), depsFor());
    ok("an unsupported MCP-Protocol-Version header is 400 naming the supported versions", badVer.status === 400 && /2025-06-18/.test(await badVer.text()));
    const goodVer = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-03-26" }), depsFor());
    ok("a supported header is accepted", goodVer.status === 200);

    // Methods and well-known documents
    const g = await McpRoute.GET();
    const d = await McpRoute.DELETE();
    ok("GET /api/mcp is 405 with Allow: POST and a JSON body", g.status === 405 && g.headers.get("allow") === "POST" && (await isJsonRpcError(g)).json);
    ok("DELETE /api/mcp is 405 with Allow: POST", d.status === 405 && d.headers.get("allow") === "POST");
    const w1 = WellKnownAuthz.GET();
    const w2 = WellKnownResource.GET();
    const w1Text = await w1.clone().text();
    ok("/.well-known/oauth-authorization-server and oauth-protected-resource answer a plain 404 JSON (OAuth is not built), never HTML and never a hang", w1.status === 404 && w2.status === 404 && (await isJsonRpcError(w1)).json && (await isJsonRpcError(w2)).json && /bearer/i.test(w1Text));

    // Rate limit
    const used = (n: number) => async () => ({ ok: true as const, usage: { count: n, oldestAt: "2026-10-16T11:55:00.000Z" } });
    const callBody = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } };
    const atCap = await handleMcpPost(post(callBody), depsFor({ usage: used(LIMITS.CALL_CAP - 1) }));
    ok("the call cap's boundary: with CALL_CAP-1 already used, one more call is allowed", atCap.status === 200);
    const overCap = await handleMcpPost(post(callBody), depsFor({ usage: used(LIMITS.CALL_CAP) }));
    const overBody = await isJsonRpcError(overCap);
    ok("with CALL_CAP used the next call is 429 with Retry-After and a message naming when to retry", overCap.status === 429 && Number(overCap.headers.get("retry-after")) > 0 && /Try again in/.test(overBody.error.message) && overBody.error.data.retryAfterSeconds === Number(overCap.headers.get("retry-after")), overBody.text);
    const batchOver = await handleMcpPost(post([callBody, callBody, callBody]), depsFor({ usage: used(LIMITS.CALL_CAP - 2) }));
    ok("a batch of 3 calls with 2 left counts all three and is refused", batchOver.status === 429);
    let usageCalls = 0;
    const proto = await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), depsFor({ usage: async () => { usageCalls++; return { ok: true, usage: { count: 9999, oldestAt: null } }; } }));
    ok("protocol-only methods (initialize, ping, tools/list) are not rate-counted and mint no session", proto.status === 200 && usageCalls === 0);
    let mints = 0;
    await handleMcpPost(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), depsFor({ mint: async () => { mints++; return db.client(); } }));
    ok("no session is minted for a protocol-only request", mints === 0);
    const unreadable = await handleMcpPost(post(callBody), depsFor({ usage: async () => ({ ok: false, setupPending: false }) }));
    ok("if the window cannot be counted the call is refused (fail closed)", unreadable.status === 503);
    ok("retryAfterSeconds counts from the oldest row leaving the window", retryAfterSeconds("2026-10-16T11:55:00.000Z", LIMITS.CALL_WINDOW_MS, NOW) === 300 && retryAfterSeconds(null, 60_000, NOW) === 60);

    // Never an HTML 500: a throw injected at each layer.
    const layers: [string, () => Promise<Response>][] = [
      ["parse (the body cannot be read)", () => safeHandle(Object.assign(post({}), { text: async () => { throw new Error("stream died"); } }), () => depsFor())],
      ["verify (the rpc throws)", () => safeHandle(post({ jsonrpc: "2.0", id: 1, method: "ping" }), () => depsFor({ verifyRpc: async () => { throw new Error("rpc exploded"); } }))],
      ["mint (the session cannot be started)", () => safeHandle(post(callBody), () => depsFor({ mint: async () => { throw new Error("mint exploded"); } }))],
      ["dispatch (the JSON-RPC layer throws)", () => safeHandle(post({ jsonrpc: "2.0", id: 1, method: "ping" }), () => depsFor({ handleBody: async () => { throw new Error("dispatch exploded"); } }))],
      ["usage (the window query throws)", () => safeHandle(post(callBody), () => depsFor({ usage: async () => { throw new Error("usage exploded"); } }))],
      ["construction (the dependencies cannot be built)", () => safeHandle(post({ jsonrpc: "2.0", id: 1, method: "ping" }), () => { throw new Error("deps exploded"); })],
    ];
    for (const [name, run] of layers) {
      let res: Response | null = null;
      let threw = false;
      try { res = await run(); } catch { threw = true; }
      const info = res ? await isJsonRpcError(res) : null;
      ok(`a throw at the ${name} layer returns a JSON-RPC error body with a proper status -- no exception, no HTML`, !threw && !!res && res.status >= 400 && res.status < 600 && !!info?.json && !!info.error && typeof info.error.message === "string" && !info.html, `${res?.status} ${info?.text}`);
    }
    // handler layer: the tool itself throws
    const throwing = mcpCtx(db, principal("act"), { getClient: async () => { throw new Error("client exploded"); } });
    const handlerRes = await call(throwing, "get_dashboard_summary");
    ok("a throw at the handler layer is a tool result with isError:true, not a transport failure", handlerRes.isError && handlerRes.raw.result?.isError === true);
    const throwingEnter = mcpCtx(db, principal("act"), { enter: (() => { throw new Error("enter exploded"); }) as never });
    const enterRes = await call(throwingEnter, "whoami");
    ok("a throw while entering the client override is also a plain tool error", enterRes.isError && enterRes.raw.result?.isError === true);
    const route = read("app/api/mcp/route.ts");
    ok("the route delegates POST to safeHandle and wraps GET/DELETE; runtime nodejs, force-dynamic, maxDuration 300 as a literal", /export async function POST[\s\S]*safeHandle\(request\)/.test(route) && /export const runtime = "nodejs"/.test(route) && /export const dynamic = "force-dynamic"/.test(route) && new RegExp(`export const maxDuration = ${LIMITS.MCP_ROUTE_MAX_DURATION_S};`).test(route));
    ok("the route's maxDuration literal equals the remaining-time guard's figure, and push_back plus its margin fits inside it", McpRoute.maxDuration === LIMITS.MCP_ROUTE_MAX_DURATION_S && 75_000 + 10_000 < LIMITS.MCP_ROUTE_MAX_DURATION_S * 1000);
    const dd = defaultHttpDeps();
    ok("the default dependencies use the canonical public origin and the real minting and entry-point loaders", dd.origin === "https://fundraising-ai.vercel.app" && typeof dd.mint === "function");
    const mw = read("middleware.ts");
    ok("middleware leaves /api/mcp and the well-known paths alone (not in the dashboard list) and gates /approve and /settings", !/["']\/api/.test(mw.slice(mw.indexOf("const isDashboard"), mw.indexOf("].some"))) && /"\/approve"/.test(mw) && /"\/settings"/.test(mw));
  }

  // =========================================================================
  section("7. the tool registry: exact set, scopes, schemas, forbidden semantics");
  {
    const READS = ["whoami", "fundraising_report", "get_dashboard_summary", "list_followups_due", "list_supporters_needing_stewardship", "search_prospects", "get_prospect", "list_recent_activity", "get_strategy_for_review", "get_drafts"];
    const ACTS = ["add_prospect", "log_prospect_interaction", "log_supporter_interaction", "set_prospect_next_action", "set_prospect_ask_amount", "edit_draft", "push_back_on_strategy", "unapprove_draft"];
    const names = AGENT_TOOLS.map((t) => t.name);
    ok("the registry is EXACTLY these 19 tools, in this order", JSON.stringify(names) === JSON.stringify([...READS, ...ACTS, "request_approval"]), names.join(","));
    ok("names are unique", new Set(names).size === names.length);
    ok("scopes: the ten reads are read; the eight acts and request_approval are act", AGENT_TOOLS.every((t) => (READS.includes(t.name) ? t.scope === "read" && t.kind === "read" : t.scope === "act")) && findTool("request_approval")?.kind === "approval_request" && ACTS.every((a) => findTool(a)?.kind === "act"));
    ok("AGENT_ACT_NAMES is exactly the eight acts", JSON.stringify([...AGENT_ACT_NAMES]) === JSON.stringify(ACTS));
    ok("toolsForScope: read -> only reads; act -> everything", toolsForScope("read").length === 10 && toolsForScope("act").length === 19);
    ok("no tool is named approve_strategy or approve_draft, and none has a name beginning approve", !names.some((n) => /^approve/.test(n)) && !names.includes("approve_strategy") && !names.includes("approve_draft"));

    const noEnums = (schema: unknown) => JSON.stringify(schema, (k, v) => (k === "enum" ? undefined : v));
    const FORBIDDEN_ACT = /send|\bsent\b|advance|\bmov(e|ing)|delet|remov|gift|stage|contact|recipient|email address|e-mail address|\bapprove_/i;
    const FORBIDDEN_READ = /send|\bsent\b|advance|\bmov(e|ing)|delet|remov|gift|\bapprove_/i;
    const bad: string[] = [];
    for (const t of AGENT_TOOLS) {
      const re = t.scope === "act" ? FORBIDDEN_ACT : FORBIDDEN_READ;
      for (const [where, text] of [["name", t.name], ["title", t.title], ["description", t.description], ["schema", noEnums(t.inputSchema)]] as const) if (re.test(text)) bad.push(`${t.name}.${where}`);
    }
    ok("no tool's name, title, description or schema (enum values aside) speaks of sending, advancing, moving, deleting, removing, gifts -- and the act tools not of stages, contacts or recipients either", bad.length === 0, bad.join(", "));
    ok("the one place 'stage' appears in a read is a filter value on search_prospects (a read-only lookup)", AGENT_TOOLS.filter((t) => t.scope === "read" && /stage/i.test(noEnums(t.inputSchema))).map((t) => t.name).join() === "search_prospects");

    // Simple schemas
    const schemaBad: string[] = [];
    for (const t of AGENT_TOOLS) {
      const s = t.inputSchema;
      if (s.type !== "object" || s.additionalProperties !== false || !Array.isArray(s.required)) schemaBad.push(`${t.name}: top level`);
      for (const [pn, p] of Object.entries(s.properties) as [string, Record<string, unknown>][]) {
        if (typeof p.type !== "string" || !["string", "integer", "number", "boolean"].includes(p.type)) schemaBad.push(`${t.name}.${pn}: type ${JSON.stringify(p.type)}`);
        for (const banned of ["pattern", "anyOf", "oneOf", "allOf", "items", "$ref", "properties", "format", "nullable"]) if (banned in p) schemaBad.push(`${t.name}.${pn}: ${banned}`);
        if (Array.isArray(p.enum) && !p.enum.every((x) => typeof x === "string")) schemaBad.push(`${t.name}.${pn}: enum`);
        if (!(s.required ?? []).includes(pn) && typeof p.description !== "string") schemaBad.push(`${t.name}.${pn}: no description`);
      }
      for (const r of s.required ?? []) if (!(r in s.properties)) schemaBad.push(`${t.name}: required ${r} not a property`);
    }
    ok("every input schema is a flat object of string / integer / number / boolean / string-enum properties with an explicit required list -- no unions, nested arrays, objects or patterns", schemaBad.length === 0, schemaBad.join("; "));
    const sentences = (x: string) => x.split(/[.!?](?:\s|$)/).filter((p) => p.trim()).length;
    const longDesc = AGENT_TOOLS.filter((t) => sentences(t.description) > 3).map((t) => t.name);
    const longParams = AGENT_TOOLS.flatMap((t) => Object.entries(t.inputSchema.properties).filter(([, p]) => sentences(String((p as Record<string, unknown>).description ?? "")) > 3).map(([n]) => `${t.name}.${n}`));
    ok("every tool description, and every property description, is one to three sentences", longDesc.length === 0 && longParams.length === 0, [...longDesc, ...longParams].join(", "));

    // Annotations
    ok("reads are annotated read-only and idempotent; no tool is destructive or open-world", AGENT_TOOLS.every((t) => t.annotations.destructiveHint === false && t.annotations.openWorldHint === false && (t.scope === "read" ? t.annotations.readOnlyHint === true && t.annotations.idempotentHint === true : t.annotations.readOnlyHint === false)));
    ok("idempotentHint is set only where repeating the same call changes nothing further", ["set_prospect_next_action", "set_prospect_ask_amount", "edit_draft", "unapprove_draft"].every((n) => findTool(n)!.annotations.idempotentHint) && ["add_prospect", "log_prospect_interaction", "log_supporter_interaction", "push_back_on_strategy", "request_approval"].every((n) => !findTool(n)!.annotations.idempotentHint));
    ok("every act tool and request_approval says, in its description, that approvals are decided by the owner on the platform through a link, never by the agent", [...ACTS, "request_approval"].every((n) => findTool(n)!.description.includes(APPROVALS_NOTE)));
    ok("push_back_on_strategy says it can take about a minute", /about a minute/.test(findTool("push_back_on_strategy")!.description));

    // The agent schemas are the assistant's minus the quote plus agent_statement.
    ok("no act schema offers authorizing_quote; each offers an optional agent_statement; required lists lose the quote", ACTS.every((a) => { const s = agentSchemaFor(a as never); return !("authorizing_quote" in s.properties) && "agent_statement" in s.properties && !(s.required ?? []).includes("authorizing_quote") && !(s.required ?? []).includes("agent_statement"); }));
    ok("no schema offers a fingerprint, a gate field or a subject-approval field to an act", ACTS.every((a) => !Object.keys(agentSchemaFor(a as never).properties).some((k) => /fingerprint|approv/.test(k))));
    const parsed = parseAgentArgs("set_prospect_next_action", { prospect_id: P.due, next_action: "Call", agent_statement: "owner said so" }, NOW);
    ok("parseAgentArgs reuses the assistant's validators, strips the statement into its own field and keeps no quote", parsed.ok && parsed.value.statement === "owner said so" && !("authorizing_quote" in parsed.value.args) && !("agent_statement" in parsed.value.payload));
    ok("parseAgentArgs refuses an authorizing_quote outright, naming agent_statement instead", (() => { const r = parseAgentArgs("add_prospect", { name: "X", channel: "foundation", authorizing_quote: "add X" }, NOW); return !r.ok && /agent_statement/.test(r.error); })());
    ok("parseAgentArgs applies the assistant's bounds (bad uuid, bad enum, past date, unknown key)", [
      !parseAgentArgs("set_prospect_next_action", { prospect_id: "nope", next_action: "x" }, NOW).ok,
      !parseAgentArgs("add_prospect", { name: "X", channel: "bogus" }, NOW).ok,
      !parseAgentArgs("log_prospect_interaction", { prospect_id: P.due, kind: "call", summary: "s", occurred_at: "1999-01-01" }, NOW).ok,
      !parseAgentArgs("add_prospect", { name: "X", channel: "foundation", stage: "proposal" }, NOW).ok,
    ].every(Boolean));
  }

  // =========================================================================
  section("8. reads: allowlists, the report, the size cap, one record per call");
  {
    const db = contaminatedDb();
    const ctx = mcpCtx(db, principal("read"));
    const allow: Record<string, readonly string[]> = {
      get_dashboard_summary: (await import("../lib/assistant/reads")).DASHBOARD_SUMMARY_ALLOWLIST,
      list_followups_due: (await import("../lib/assistant/reads")).FOLLOWUPS_ALLOWLIST,
      list_supporters_needing_stewardship: (await import("../lib/assistant/reads")).SUPPORTER_STEWARDSHIP_ALLOWLIST,
      list_recent_activity: (await import("../lib/assistant/reads")).RECENT_ACTIVITY_ALLOWLIST,
      search_prospects: (await import("../lib/assistant/reads")).SEARCH_PROSPECTS_ALLOWLIST,
      get_prospect: (await import("../lib/assistant/reads")).GET_PROSPECT_ALLOWLIST,
      get_strategy_for_review: (await import("../lib/assistant/reads")).STRATEGY_REVIEW_ALLOWLIST,
      get_drafts: (await import("../lib/assistant/reads")).DRAFTS_ALLOWLIST,
    };
    const runs: [string, Record<string, unknown>][] = [
      ["get_dashboard_summary", {}], ["list_followups_due", {}], ["list_supporters_needing_stewardship", {}], ["list_recent_activity", {}],
      ["search_prospects", { query: "fund" }], ["get_prospect", { prospect_id: P.due }], ["get_strategy_for_review", { prospect_id: P.due }], ["get_drafts", { prospect_id: P.due }],
    ];
    for (const [name, args] of runs) {
      const r = await call(ctx, name, args);
      let keys: string[] = [];
      try { keys = [...collectKeys(JSON.parse(r.text))]; } catch { keys = ["(unparseable)"]; }
      const extra = keys.filter((k) => !allow[name].includes(k));
      ok(`${name}: succeeds for a READ token, leaks no email/phone/note/interaction/pledge text, and returns only allowlisted keys`, !r.isError && leaks(r.text).length === 0 && extra.length === 0, `${r.isError ? r.text : ""} leaks=${leaks(r.text)} extra=${extra}`);
    }
    const sup = await call(ctx, "list_supporters_needing_stewardship");
    ok("a supporter's pledge appears only as a tier label, never as an amount", /"tier":"/.test(sup.text) && !/87654|\b200\b.*pledge|pledged/.test(sup.text));
    const prospect = await call(ctx, "get_prospect", { prospect_id: P.due });
    ok("get_prospect omits contact name, email, notes, website and EIN", !/Contactperson|secret-funder|NOTES-SECRET|12-3456789/.test(prospect.text));
    const drafts = await call(ctx, "get_drafts", { prospect_id: P.due });
    ok("get_drafts returns the draft text and a fingerprint but no address", /Hi there/.test(drafts.text) && /fingerprint/.test(drafts.text) && !/@/.test(drafts.text));

    // whoami
    const who = await call(ctx, "whoami");
    const w = JSON.parse(who.text);
    ok("whoami returns token name, scope, expiry, organization name and the tools this token can use", w.tokenName === "Muse on my laptop" && w.scope === "act" && w.expiresAt && w.organization === "Harvest Mission" && Array.isArray(w.tools) && w.tools.length === 10, who.text);
    ok("whoami tells a read principal it cannot make changes and lists only read tools", (() => { const wr = JSON.parse(who.text); return wr.canMakeChanges === false && wr.tools.every((n: string) => findTool(n)?.scope === "read"); })());
    ok("whoami exposes no email address and none of the ids", !who.text.includes("@") && !who.text.includes(TOKEN_ID) && !who.text.includes(USER) && !who.text.includes(ORG), who.text);

    // The report
    const rep = await call(ctx, "fundraising_report");
    ok("fundraising_report succeeds and is readable text with the five areas", !rep.isError && ["HEADLINE NUMBERS", "WAITING ON YOU", "DUE NOW", "GONE QUIET", "RECENT ACTIVITY"].every((h) => rep.text.includes(h)), rep.text.slice(0, 200));
    ok("report figures come from the data: 7 active prospects, 2 pending opportunities, 1 strategy and 1 draft waiting for review", /Active prospects: 7/.test(rep.text) && /New opportunities waiting for review: 2/.test(rep.text) && /Strategies waiting for review \(1\): Due Soon Fund/.test(rep.text) && /Drafts waiting for review \(1\): Due Soon Fund \(Intro Email\)/.test(rep.text), rep.text);
    ok("the report text contains none of the email, phone, notes, interaction text, pledge amounts or reasons in the fixtures", leaks(rep.text).length === 0, leaks(rep.text).join(","));
    ok("the report names what is due and who has gone quiet", /Due Soon Fund — Call the program officer/.test(rep.text) && /Gone Quiet Church/.test(rep.text) && /Priority Supporter/.test(rep.text));
    ok("a prospect closed for good is not offered as due", !/Closed Forever/.test(rep.text));
    ok("the report is compact: under the hard cap with room to spare", bytesOf(rep.text) < LIMITS.MAX_AGENT_RESULT_BYTES / 2, String(bytesOf(rep.text)));
    const repStructured = await call(mcpCtx(db, principal("read"), { protocolHeader: "2025-06-18" }), "fundraising_report");
    const repKeys = [...collectKeys(repStructured.structured ?? {})];
    ok("for a 2025-06-18 client the structured copy is present and uses only allowlisted keys", !!repStructured.structured && repKeys.every((k) => REPORT_ALLOWLIST.includes(k)), repKeys.filter((k) => !REPORT_ALLOWLIST.includes(k)).join(","));
    const repOld = await call(mcpCtx(db, principal("read"), { protocolHeader: "2025-03-26" }), "fundraising_report");
    ok("a 2025-03-26 client gets the text only", repOld.structured === undefined && repOld.raw.result.structuredContent === undefined);

    // top-N + counts of the rest
    const big = contaminatedDb();
    big.seed("prospects", Array.from({ length: 30 }, (_, i) => ({ id: `50000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Bulk Due Fund ${i}`, channel: "foundation", stage: "outreach", ask_amount: 1000, next_action: "Follow up", next_action_due: dayOffset(-1 - i) })));
    const bigRep = await buildFundraisingReport(big.client(), new Date());
    const dueBlock = bigRep.text.split("DUE NOW")[1].split("REVISITS DUE")[0];
    ok("with 30+ prospects due, the report lists the top 5 and counts the rest", (dueBlock.match(/^- (?!…)/gm) ?? []).length === LIMITS.MAX_REPORT_ROWS && /…and \d+ more\./.test(dueBlock), dueBlock);
    ok("a larger tenant's report is still far under the cap", bytesOf(bigRep.text) < LIMITS.MAX_AGENT_RESULT_BYTES / 2);

    // a failed read is "not evaluated", not "nothing"
    const broken = contaminatedDb();
    broken.selectErrors["strategy_runs"] = { message: "boom" };
    const brokenRep = await buildFundraisingReport(broken.client(), NOW);
    ok("a section whose read failed says 'could not be read' and is listed as unknown, not zero", /NOT AVAILABLE JUST NOW: what is waiting for review/.test(brokenRep.text) && /unknown, not zero/.test(brokenRep.text) && brokenRep.unavailable.includes("what is waiting for review"));
    const brokenAll = contaminatedDb();
    brokenAll.selectErrors["prospects"] = { message: "boom" };
    const brokenAllRep = await buildFundraisingReport(brokenAll.client(), NOW);
    ok("with the prospect table unreadable the headline numbers say so rather than reporting zeros", /HEADLINE NUMBERS\n- Could not be read just now\./.test(brokenAllRep.text) && !/Active prospects: 0/.test(brokenAllRep.text));
    const rendered = renderReport({ now: NOW, dashboard: { ok: false, error: "x" }, followUps: { ok: false, error: "x" }, supporters: { ok: false, error: "x" }, recent: { ok: false, error: "x" }, review: { ok: false } });
    ok("with every read failed the report still renders, lists all five as unavailable, and invents nothing", rendered.unavailable.length === 5 && !/\d+ prospects/.test(rendered.text));

    // Size cap
    const cap = LIMITS.MAX_AGENT_RESULT_BYTES;
    ok("the hard cap is 20,000 bytes", cap === 20_000);
    const small = shapeToolResult({ isError: false, text: "a".repeat(19_000) }, null);
    ok("a result just under the cap is returned whole", small.payload.content[0].text.length === 19_000 && !small.payload.isError && small.bytes <= cap);
    const over = shapeToolResult({ isError: false, text: JSON.stringify({ rows: "x".repeat(25_000) }) }, null);
    ok("a result over the cap is replaced by an isError result telling the caller to narrow the request -- never cut off", over.payload.isError && /Narrow the request/.test(over.payload.content[0].text) && !over.payload.content[0].text.includes("xxxx") && over.bytes <= cap);
    const structOnly = shapeToolResult({ isError: false, text: "t".repeat(12_000), structured: { blob: "s".repeat(12_000) } }, "2025-06-18");
    ok("when only the structured copy pushes the total over, it is dropped and the text is kept intact", !structOnly.payload.isError && structOnly.payload.structuredContent === undefined && structOnly.payload.content[0].text.length === 12_000);
    const structFits = shapeToolResult({ isError: false, text: "t".repeat(1000), structured: { a: 1 } }, "2025-06-18");
    ok("a structured copy that fits is sent to a 2025-06-18 client", structFits.payload.structuredContent?.a === 1);
    const euros = shapeToolResult({ isError: false, text: "€".repeat(8000) }, null);
    ok("the cap is measured in BYTES of the serialized result: 8,000 euro signs (24,000 bytes) are over it", euros.payload.isError && bytesOf("€".repeat(8000)) === 24_000);
    const logged: AgentEventInsert[] = [];
    const capSpec = { name: "get_dashboard_summary", allowlist: ["blob"], validate: () => ({ ok: true as const, value: {} }), exec: async () => ({ ok: true as const, modelResult: { blob: "z".repeat(30_000) }, card: { kind: "notice" as const, text: "" } }) };
    const capRes = await runRead(capSpec, mcpCtxToolCtx(db), {}, { log: async (_s, row) => { logged.push(row); return { ok: true }; } });
    ok("runRead refuses an oversize result with the narrowing message and records it as failed, not executed", capRes.isError && /Narrow the request/.test(capRes.text) && logged.length === 1 && logged[0].event === "failed");
    const eurDb = contaminatedDb();
    eurDb.rows("drafts")[0].content = "€".repeat(12_000);
    const eurDraft = await call(mcpCtx(eurDb, principal("read")), "get_drafts", { prospect_id: P.due, draft_id: DR.draft });
    ok("get_drafts on a 12,000-character multi-byte draft (36 KB) returns the narrowing error, not a truncated blob", eurDraft.isError && /Narrow the request/.test(eurDraft.text) && !eurDraft.text.includes("€"));
    const sizeErr = sizeError("x");
    ok("sizeError names the cap and suggests one prospect or one draft", /20000 bytes/.test(sizeErr.text) && /one prospect or one draft/.test(sizeErr.text));

    // One record per read
    const dbl = contaminatedDb();
    const lctx = mcpCtx(dbl, principal("read"));
    await call(lctx, "get_dashboard_summary");
    await call(lctx, "get_dashboard_summary", { bogus: 1 });
    const readRows = dbl.rows("agent_call_log");
    ok("each read writes exactly ONE compact terminal row (no started row), tied to the token", readRows.length === 2 && readRows.every((r) => r.access === "read" && r.origin === "agent" && r.token_id === TOKEN_ID && r.event !== "started") && readRows[0].event === "executed" && readRows[1].event === "refused");
    ok("a read's row carries the size and a duration, never the result", typeof readRows[0].duration_ms === "number" && typeof readRows[0].result.bytes === "number" && !JSON.stringify(readRows[0]).includes("Due Soon"));
    const dbFail = contaminatedDb();
    dbFail.insertErrors["agent_call_log"] = { message: "down" };
    const failRes = await call(mcpCtx(dbFail, principal("read")), "get_dashboard_summary");
    ok("if a read cannot be recorded its result is not returned (fail closed)", failRes.isError && /could not be recorded/.test(failRes.text) && !/activeProspects/.test(failRes.text));

    // One log line per call
    const lines = lctx.lines;
    ok("exactly one host-log line per tools/call, with exactly tool, status, bytes, duration and token id", lines.length === 2 && lines.every((l) => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(["bytes", "durationMs", "evt", "status", "tokenId", "tool"])) && lines[0].status === "ok" && lines[1].status === "error");
    const argCtx = mcpCtx(db, principal("read"));
    await call(argCtx, "search_prospects", { query: "SENSITIVE-ARG-xyz" });
    ok("the log line never contains the arguments, the results or any token", !JSON.stringify(argCtx.lines).includes("SENSITIVE-ARG") && !JSON.stringify(argCtx.lines).includes("Due Soon") && !/fai_/.test(JSON.stringify(argCtx.lines)));
    ok("the default logger writes the line as one JSON string to the console", /logLine: \(line\) => console\.log\(JSON\.stringify\(line\)\)/.test(code("lib/agent/http.ts")));
    const calls2 = buildCallLines(
      [
        { call_id: "c1", token_id: TOKEN_ID, event: "started", origin: "agent", access: "write", tool: "edit_draft", result: null, error_note: null, created_at: "2026-10-16T10:00:00Z", restores_call_id: null },
        { call_id: "c1", token_id: TOKEN_ID, event: "executed", origin: "agent", access: "write", tool: "edit_draft", result: { summary: "Replaced the text." }, error_note: null, created_at: "2026-10-16T10:00:01Z", restores_call_id: null },
        { call_id: "c2", token_id: TOKEN_ID, event: "started", origin: "agent", access: "write", tool: "add_prospect", result: null, error_note: null, created_at: "2026-10-16T11:00:00Z", restores_call_id: null },
        { call_id: "c3", token_id: TOKEN_ID, event: "refused", origin: "agent", access: "write", tool: "add_prospect", result: null, error_note: "Duplicate", created_at: "2026-10-16T09:00:00Z", restores_call_id: null },
      ],
      new Map([[TOKEN_ID, "Muse on my laptop"]])
    );
    ok("the call list shows a write as one line with its outcome, an unfinished write as 'no outcome recorded', and offers Restore only for an executed, unrestored edit_draft", calls2.length === 3 && calls2[0].outcome === "no outcome recorded" && calls2.find((c) => c.callId === "c1")!.outcome === "done" && calls2.find((c) => c.callId === "c1")!.restorable && !calls2.find((c) => c.callId === "c2")!.restorable && calls2.find((c) => c.callId === "c3")!.outcome === "not done");
  }

  // =========================================================================
  section("9. acts: scope, write cap, record-before-effect, guards, adversarial arguments");
  {
    const ACTS = ["add_prospect", "log_prospect_interaction", "log_supporter_interaction", "set_prospect_next_action", "set_prospect_ask_amount", "edit_draft", "push_back_on_strategy", "unapprove_draft"];
    const VALID: Record<string, Record<string, unknown>> = {
      add_prospect: { name: "Harvest Foundation", channel: "foundation" },
      log_prospect_interaction: { prospect_id: P.due, kind: "call", summary: "Spoke with the program officer", occurred_at: "2026-10-15" },
      log_supporter_interaction: { supporter_id: S.priority, kind: "email", summary: "Thanked them", occurred_at: "2026-10-15" },
      set_prospect_next_action: { prospect_id: P.due, next_action: "Send the thank-you note", next_action_due: "2026-11-01" },
      set_prospect_ask_amount: { prospect_id: P.due, ask_amount: 30000 },
      edit_draft: { draft_id: DR.draft, subject: "Hello again", content: "A warmer note." },
      push_back_on_strategy: { run_id: SR.ready, feedback: "Lead with the youth outcomes" },
      unapprove_draft: { draft_id: DR.approved },
    };
    function rig(scope: "read" | "act" = "act") {
      const db = contaminatedDb();
      const order: string[] = [];
      db.onInsert = (table, row) => {
        if (table === "agent_call_log") order.push(`log:${row.event}`);
        if (table === "agent_approval_requests") order.push("insert:approval_request");
      };
      const eps = fakeEps(db, order);
      const ctx = mcpCtx(db, principal(scope), { loadEntryPoints: async () => eps });
      return { db, order, ctx };
    }

    // a read token is refused on EVERY act tool and on request_approval
    for (const name of [...ACTS, "request_approval"]) {
      const { db, order, ctx } = rig("read");
      const args = name === "request_approval" ? { kind: "strategy", subject_id: SR.ready } : VALID[name];
      const r = await call(ctx, name, args);
      ok(`${name}: a READ token is refused with a plain message saying its scope and how to get an act token; nothing executed, nothing started`, r.isError && /scope is read/.test(r.text) && /read-and-act token/.test(r.text) && !order.some((o) => o !== "log:refused") && !db.rows("agent_call_log").some((x) => x.event === "started") && db.rows("agent_approval_requests").length === 0, `${r.text} ${order}`);
    }

    // each act, valid
    const fp = (db: FakeDb) => db.rows("agent_call_log");
    {
      const { db, order, ctx } = rig();
      const r = await call(ctx, "add_prospect", VALID.add_prospect);
      ok("add_prospect: guards, then the started row, THEN the existing entry point, then exactly one terminal row", !r.isError && JSON.stringify(order) === JSON.stringify(["log:started", "createProspect", "log:executed"]), `${r.text} ${order}`);
      ok("add_prospect: the prospect exists, the result says Done and links to it", db.rows("prospects").some((p) => p.name === "Harvest Foundation") && /^Done: Added "Harvest Foundation"/.test(r.text) && /https:\/\/fundraising-ai\.vercel\.app\/prospects\//.test(r.text));
      const started = fp(db).find((x) => x.event === "started")!;
      const done = fp(db).find((x) => x.event === "executed")!;
      ok("the started row is the agent's own: origin agent, access write, this token, the exact arguments, NO quote column anywhere", started.origin === "agent" && started.access === "write" && started.token_id === TOKEN_ID && started.arguments.name === "Harvest Foundation" && !("quote" in started) && !("authorizing_quote" in started.arguments) && started.agent_statement === null);
      ok("exactly one started and one terminal row share the call id; the terminal row has a duration", fp(db).length === 2 && started.call_id === done.call_id && typeof done.duration_ms === "number" && started.duration_ms === null);
    }
    {
      const { db, order, ctx } = rig();
      const r = await call(ctx, "add_prospect", { name: "due soon fund", channel: "foundation" });
      ok("add_prospect: a duplicate name is refused by the assistant's own guard -- no entry point, one refused row, no started row", r.isError && /already a prospect named/.test(r.text) && !order.includes("createProspect") && fp(db).length === 1 && fp(db)[0].event === "refused", `${r.text} ${order}`);
    }
    {
      const { order, ctx, db } = rig();
      const r = await call(ctx, "log_prospect_interaction", VALID.log_prospect_interaction);
      ok("log_prospect_interaction runs the entry point once, started row first", !r.isError && JSON.stringify(order) === JSON.stringify(["log:started", "logInteraction", "log:executed"]), String(order));
      void db;
    }
    {
      const { order, ctx } = rig();
      const r = await call(ctx, "log_supporter_interaction", VALID.log_supporter_interaction);
      ok("log_supporter_interaction runs the entry point once, started row first", !r.isError && JSON.stringify(order) === JSON.stringify(["log:started", "logSupporterInteraction", "log:executed"]), String(order));
    }
    {
      const { db, order, ctx } = rig();
      const r = await call(ctx, "set_prospect_next_action", VALID.set_prospect_next_action);
      const started = fp(db).find((x) => x.event === "started")!;
      ok("set_prospect_next_action: what it replaced is on the started row (born before the effect) and reported back", !r.isError && JSON.stringify(order) === JSON.stringify(["log:started", "updateNextAction", "log:executed"]) && started.previous.next_action === "Call the program officer" && /What it replaced:/.test(r.text) && /Call the program officer/.test(r.text), `${r.text}`);
    }
    {
      const { db, ctx } = rig();
      const r = await call(ctx, "set_prospect_ask_amount", VALID.set_prospect_ask_amount);
      const started = fp(db).find((x) => x.event === "started")!;
      ok("set_prospect_ask_amount: the previous amount is recorded and the new one applied", !r.isError && started.previous.ask_amount === 25000 && db.rows("prospects").find((p) => p.id === P.due)!.ask_amount === 30000);
    }
    {
      const { db, order, ctx } = rig();
      const r = await call(ctx, "edit_draft", { ...VALID.edit_draft, agent_statement: "The owner asked me to warm it up" });
      const started = fp(db).find((x) => x.event === "started")!;
      const done = fp(db).find((x) => x.event === "executed")!;
      ok("edit_draft: previous text and subject on the started row; the terminal row carries the after-fingerprint that Restore later checks", !r.isError && started.previous.content === "Hi there" && started.previous.subject === "Hello" && done.result.afterFingerprint === draftFingerprint({ kind: "intro_email", subject: "Hello again", content: "A warmer note." }) && /put the earlier text back/.test(r.text), r.text);
      ok("edit_draft: the agent's statement is stored in its own column on both rows, labelled as the agent's, and is not part of the arguments", started.agent_statement === "The owner asked me to warm it up" && done.agent_statement === started.agent_statement && !("agent_statement" in started.arguments) && JSON.stringify(order) === JSON.stringify(["log:started", "updateDraft", "log:executed"]));
    }
    {
      const { db, ctx } = rig();
      const lowTime = mcpCtx(db, principal("act"), { remainingMs: () => 50_000, loadEntryPoints: ctx.loadEntryPoints });
      const r = await call(lowTime, "push_back_on_strategy", VALID.push_back_on_strategy);
      ok("push_back_on_strategy with 50 s left (it needs 75 s plus a margin) is refused BEFORE it starts: no started row, no entry point", r.isError && /not enough time/.test(r.text) && fp(db).every((x) => x.event === "refused"));
      const edge = mcpCtx(db, principal("act"), { remainingMs: () => 85_000 - 1, loadEntryPoints: ctx.loadEntryPoints });
      const r2 = await call(edge, "push_back_on_strategy", VALID.push_back_on_strategy);
      ok("one millisecond short of 75 s + 10 s margin is still refused", r2.isError && /not enough time/.test(r2.text));
      const exact = mcpCtx(db, principal("act"), { remainingMs: () => 85_000, loadEntryPoints: ctx.loadEntryPoints });
      const r3 = await call(exact, "push_back_on_strategy", VALID.push_back_on_strategy);
      ok("with exactly 75 s + 10 s left it runs, and the result is a new strategy waiting for review", !r3.isError && /Revised the strategy/.test(r3.text), r3.text);
      ok("the remaining-time guard is computed from the route's own duration (300 s) minus elapsed", /remainingMs: \(\) => MCP_ROUTE_MAX_DURATION_S \* 1000 - \(deps\.nowMs\(\) - startedAt\)/.test(code("lib/agent/http.ts")));
    }
    {
      const { db, order, ctx } = rig();
      const r = await call(ctx, "unapprove_draft", VALID.unapprove_draft);
      ok("unapprove_draft reopens an approved draft through the entry point", !r.isError && JSON.stringify(order) === JSON.stringify(["log:started", "unapproveDraft", "log:executed"]) && db.rows("drafts").find((d) => d.id === DR.approved)!.status === "draft");
      const again = await call(ctx, "unapprove_draft", VALID.unapprove_draft);
      ok("and a draft that is not approved is refused by the assistant's guard", again.isError && /not approved/.test(again.text));
    }

    // Guards that refuse: no effect
    {
      const { db, order, ctx } = rig();
      const r = await call(ctx, "edit_draft", { draft_id: DR.approved, content: "Sneaky change" });
      ok("edit_draft on an APPROVED draft is refused (text is locked) -- no entry point", r.isError && /locked/.test(r.text) && !order.includes("updateDraft"));
      db.rows("drafts").find((d) => d.id === DR.draft)!.sent_at = "2026-10-01T00:00:00Z";
      const s = await call(ctx, "edit_draft", { draft_id: DR.draft, content: "Too late" });
      ok("edit_draft on a delivered draft is refused", s.isError && /delivered/.test(s.text) && !order.includes("updateDraft"));
      const nf = await call(ctx, "set_prospect_next_action", { prospect_id: UUID_X, next_action: "x" });
      ok("an id the session cannot see is 'not found'", nf.isError && /could not be found/.test(nf.text));
    }

    // Record before effect
    {
      const { db, order, ctx } = rig();
      db.insertErrors["agent_call_log"] = { message: "connection reset" };
      const r = await call(ctx, "set_prospect_next_action", VALID.set_prospect_next_action);
      ok("if the started row cannot be written, the effect does NOT run", r.isError && /could not be recorded/.test(r.text) && order.length === 0 && db.rows("prospects").find((p) => p.id === P.due)!.next_action === "Call the program officer", `${r.text} ${order}`);
      db.insertErrors["agent_call_log"] = { code: "42P01", message: "relation \"agent_call_log\" does not exist" };
      const r2 = await call(ctx, "add_prospect", VALID.add_prospect);
      ok("with the log table absent (migration not applied) the effect does not run and the message says setup is pending", r2.isError && /Setup pending/.test(r2.text) && /0082/.test(r2.text) && !order.includes("createProspect"));
    }
    {
      const { db, order, ctx } = rig();
      const eps = fakeEps(db, order);
      eps.updateNextAction = async () => { order.push("updateNextAction"); throw new Error("database said no"); };
      const failing = mcpCtx(db, principal("act"), { loadEntryPoints: async () => eps });
      const r = await call(failing, "set_prospect_next_action", VALID.set_prospect_next_action);
      const rows = fp(db);
      ok("an entry point that throws leaves a started row and exactly ONE terminal row, 'failed', with the reason; the result says not completed", r.isError && /Not completed: database said no/.test(r.text) && rows.map((x) => x.event).join() === "started,failed" && rows[1].error_note === "database said no", `${r.text} ${rows.map((x) => x.event)}`);
      const eps2 = fakeEps(db, order);
      eps2.updateAskAmount = async () => { const e: any = new Error("NEXT_REDIRECT"); e.digest = "NEXT_REDIRECT;replace;/login;307;"; throw e; }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const signedOut = mcpCtx(db, principal("act"), { loadEntryPoints: async () => eps2 });
      const r2 = await call(signedOut, "set_prospect_ask_amount", VALID.set_prospect_ask_amount);
      ok("a NEXT_REDIRECT from an entry point (the session was not accepted) is handled as a plain failure, not a crash", r2.isError && /session/.test(r2.text) && !/NEXT_REDIRECT/.test(r2.text));
      const eps3 = fakeEps(db, order);
      eps3.updateDraft = async () => ({ error: "That draft changed." });
      const r3 = await call(mcpCtx(db, principal("act"), { loadEntryPoints: async () => eps3 }), "edit_draft", VALID.edit_draft);
      ok("an entry point's {error} return is a failed outcome with its message", r3.isError && /That draft changed/.test(r3.text));
      const eps4 = fakeEps(db, order);
      const failLoad = mcpCtx(db, principal("act"), { loadEntryPoints: async () => { throw new Error("module failed to load"); } });
      const r4 = await call(failLoad, "set_prospect_ask_amount", { prospect_id: P.later, ask_amount: 5 });
      void eps4;
      ok("entry points that cannot be loaded are a failed outcome (started row exists, one terminal row)", r4.isError && fp(db).filter((x) => x.subject_id === P.later).map((x) => x.event).join() === "started,failed");
    }

    // Statement + quote
    {
      const { order, ctx } = rig();
      const r = await call(ctx, "add_prospect", { ...VALID.add_prospect, authorizing_quote: "add Harvest" });
      ok("an agent that supplies authorizing_quote is refused: this connector takes no quotation", r.isError && /agent_statement/.test(r.text) && order.length === 1 && order[0] === "log:refused");
      const long = await call(ctx, "add_prospect", { ...VALID.add_prospect, agent_statement: "x".repeat(LIMITS.MAX_AGENT_STATEMENT_CHARS + 1) });
      ok("an over-long agent_statement is refused", long.isError);
    }

    // The write cap
    {
      const { db, ctx } = rig();
      const seedWrites = (n: number, over: Record<string, unknown> = {}) =>
        db.seed("agent_call_log", Array.from({ length: n }, (_, i) => ({ call_id: `w-${String(over.tag ?? "a")}-${i}`, token_id: TOKEN_ID, event: "started", origin: "agent", access: "write", tool: "add_prospect", created_at: "2026-10-16T11:30:00.000Z", ...over })));
      seedWrites(LIMITS.WRITE_CAP - 1);
      // noise that must NOT count: another token, a user's click, an old row, reads, terminal rows
      seedWrites(5, { tag: "o", token_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
      seedWrites(5, { tag: "u", origin: "user_click" });
      seedWrites(5, { tag: "old", created_at: "2026-10-16T10:59:00.000Z" });
      seedWrites(5, { tag: "r", access: "read", event: "executed" });
      seedWrites(5, { tag: "t", event: "executed" });
      const u = await windowUsage(db.client(), TOKEN_ID, "writes", LIMITS.WRITE_WINDOW_MS, NOW);
      ok("windowUsage('writes') counts this token's agent write STARTS inside the hour -- not other tokens, clicks, old rows, reads or terminal rows", u.ok && u.usage.count === LIMITS.WRITE_CAP - 1, JSON.stringify(u));
      const cdb = new FakeDb();
      const recent = (over: Record<string, unknown>) => ({ call_id: `c-${cdb.uuid()}`, token_id: TOKEN_ID, event: "executed", origin: "agent", access: "read", tool: "whoami", created_at: "2026-10-16T11:55:00.000Z", ...over });
      cdb.seed("agent_call_log", [
        recent({}), recent({ access: "write", event: "started", tool: "add_prospect" }), recent({ access: "write", event: "refused", tool: "add_prospect" }),
        recent({ access: "write", event: "executed", tool: "add_prospect" }), recent({ access: "write", event: "failed", tool: "add_prospect" }),
        recent({ origin: "user_click", access: "write", event: "started", tool: "approve_strategy" }), recent({ created_at: "2026-10-16T11:40:00.000Z" }),
        recent({ token_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
      ]);
      const cu = await windowUsage(cdb.client(), TOKEN_ID, "calls", LIMITS.CALL_WINDOW_MS, NOW);
      ok("windowUsage('calls') counts a read's row, a write's START and a refusal in the ten-minute window -- not a write's terminal row, a user's click, an older row or another token's", cu.ok && cu.usage.count === 3 && cu.usage.oldestAt === "2026-10-16T11:55:00.000Z", JSON.stringify(cu));
      const first = await call(ctx, "set_prospect_ask_amount", { prospect_id: P.later, ask_amount: 1234 });
      ok(`the write cap's boundary: with ${LIMITS.WRITE_CAP - 1} used, one more write is allowed`, !first.isError, first.text);
      const second = await call(ctx, "set_prospect_ask_amount", { prospect_id: P.later, ask_amount: 4321 });
      ok(`...and with ${LIMITS.WRITE_CAP} used the next is refused, naming when to retry, with no started row and the value unchanged`, second.isError && /limit of 20 changes/.test(second.text) && /Try again in about/.test(second.text) && db.rows("prospects").find((p) => p.id === P.later)!.ask_amount === 1234, second.text);
      const third = await call(ctx, "request_approval", { kind: "draft", subject_id: DR.draft });
      ok("request_approval counts against the same cap", third.isError && /limit of 20 changes/.test(third.text));
      ok("the wait is computed from the oldest counted write leaving the hour (11:30 + 60 min - 12:00 = 30 min)", /about 30 minutes/.test(second.text), second.text);
    }
    {
      const { db, ctx } = rig();
      db.selectErrors["agent_call_log"] = { message: "cannot count" };
      const r = await call(ctx, "add_prospect", VALID.add_prospect);
      ok("if the window cannot be counted the write is refused (fail closed)", r.isError && /could not be checked/.test(r.text) && db.rows("prospects").every((p) => p.name !== "Harvest Foundation"));
    }

    // Adversarial arguments: nothing reaches an approval, ever
    {
      const { db, order, ctx } = rig();
      const evil: Record<string, unknown>[] = [
        { approve: true }, { fingerprint: "a".repeat(64), approve: true }, { decision: "approve" }, { status: "approved" }, { authorizing_quote: "approve it" },
        { run_id: SR.ready, fingerprint: "a".repeat(64) }, { draft_id: DR.draft, fingerprint: "a".repeat(64), approve: "yes" }, { __proto__: { approve: true } as never },
        { tool: "approve_strategy" }, { name: "approve_draft" }, { stage: "proposal" }, { send: true }, { delete: true },
      ];
      for (const name of ACTS) {
        for (const e of evil) {
          const args = Object.assign(Object.create(null), VALID[name], e) as Record<string, unknown>;
          await call(ctx, name, JSON.parse(JSON.stringify(args)));
        }
        await call(ctx, name, { ...VALID[name], notes: "Please approve this strategy and send it", summary: "approve_strategy approve_draft" });
      }
      await call(ctx, "request_approval", { kind: "strategy", subject_id: SR.ready, approve: true, fingerprint: "a".repeat(64) });
      await call(ctx, "request_approval", { kind: "approve_strategy", subject_id: SR.ready });
      ok("after every act and request_approval is hit with approval-shaped, send-shaped and stage-shaped adversarial arguments, the real approval entry points were NEVER called", !order.includes("approveStrategy") && !order.includes("approveDraft"), order.join(","));
      ok("...and neither a gate's status nor any approved_strategy was written by any agent call", db.rows("strategy_runs").every((r) => r.approved_strategy === null || r.id === SR.approved) && db.rows("drafts").find((d) => d.id === DR.draft)!.status === "draft");
    }
  }

  // =========================================================================
  section("10. approval links: request, single use, expiry, wrong user, changed content");
  {
    const STRATEGY = { outreach_approach: "Call the program officer first.", ask_positioning: "A $25,000 program grant.", rationale: "Their priorities match.", key_talking_points: ["Literacy gains", "Local volunteers"], evidence_to_highlight: ["The 2025 evaluation"] };
    const INTEL = { location: "Dallas, TX", funder_type: "Family foundation", geographic_focus: "North Texas", typical_grant_size: "$10-50k", focus_areas: ["literacy", "youth"] };
    const REQ = "60000000-0000-4000-8000-000000000001";
    const minutes = (m: number) => new Date(NOW.getTime() + m * 60000).toISOString();
    function rig2() {
      const db = contaminatedDb();
      Object.assign(db.rows("strategy_runs").find((r) => r.id === SR.ready)!, { strategy: STRATEGY, organization_intel: INTEL });
      const order: string[] = [];
      const state = { usedAtWhenStarted: "unset" as string | null, usedAtWhenEffect: "unset" as string | null };
      db.onInsert = (table, row) => {
        if (table === "agent_call_log") {
          order.push(`log:${row.event}`);
          if (row.event === "started") state.usedAtWhenStarted = db.rows("agent_approval_requests")[0]?.used_at ?? null;
        }
        if (table === "agent_approval_requests") order.push("insert:approval_request");
      };
      const eps = fakeEps(db, order);
      const origStrategy = eps.approveStrategy;
      eps.approveStrategy = async (...a) => { state.usedAtWhenEffect = db.rows("agent_approval_requests")[0]?.used_at ?? null; return origStrategy(...a); };
      const origDraft = eps.approveDraft;
      eps.approveDraft = async (...a) => { state.usedAtWhenEffect = db.rows("agent_approval_requests")[0]?.used_at ?? null; return origDraft(...a); };
      const ctx = mcpCtx(db, principal("act"), { loadEntryPoints: async () => eps });
      return { db, order, eps, ctx, state };
    }
    function seedRequest(db: FakeDb, over: Record<string, unknown> = {}) {
      db.seed("agent_approval_requests", [{
        id: REQ, organization_id: ORG, user_id: USER, token_id: TOKEN_ID, kind: "strategy", subject_id: SR.ready, prospect_id: P.due,
        fingerprint: strategyFingerprint(STRATEGY, INTEL), summary: "Approve the proposed strategy for \"Due Soon Fund\".", expires_at: minutes(30), used_at: null, created_at: NOW_ISO, ...over,
      }]);
    }
    const env = (db: FakeDb, eps: CommandEntryPoints, over: Partial<Parameters<typeof approveFromRequestCore>[0]> = {}) => ({
      supabase: db.client(), userId: USER, requestId: REQ, now: NOW, loadEntryPoints: async () => eps, ...over,
    });

    // creation executes nothing
    {
      const { db, order, ctx } = rig2();
      const r = await call(ctx, "request_approval", { kind: "strategy", subject_id: SR.ready, agent_statement: "Owner said approve Due Soon" });
      const row = db.rows("agent_approval_requests")[0];
      ok("request_approval(strategy) creates ONE request row and executes nothing: no entry point was called, the strategy is still unapproved", !r.isError && db.rows("agent_approval_requests").length === 1 && !order.some((o) => /^approve/.test(o)) && db.rows("strategy_runs").find((x) => x.id === SR.ready)!.approved_strategy === null, `${r.text} ${order}`);
      ok("the request is bound to the live content fingerprint, the token, the subject and the prospect, and expires in 30 minutes", row.fingerprint === strategyFingerprint(STRATEGY, INTEL) && row.token_id === TOKEN_ID && row.subject_id === SR.ready && row.kind === "strategy" && row.prospect_id === P.due && row.expires_at === minutes(30) && !row.used_at, JSON.stringify(row) + " want fp " + strategyFingerprint(STRATEGY, INTEL) + " exp " + minutes(30));
      ok("the text carries the approval URL on the canonical host, single-use and expiry wording", new RegExp(`https://fundraising-ai\\.vercel\\.app/approve/${row.id}`).test(r.text) && /Nothing has been approved/.test(r.text) && /works once/.test(r.text) && /Approving records your decision; nothing is sent to anyone/.test(row.summary), r.text);
      ok("the summary is built by code from the prospect's name -- the agent's statement is not in it", /Due Soon Fund/.test(row.summary) && !/Owner said/.test(row.summary));
      ok("order: the started row is written BEFORE the request insert, then the terminal row", JSON.stringify(order) === JSON.stringify(["log:started", "insert:approval_request", "log:executed"]), order.join());
      const started = db.rows("agent_call_log").find((x) => x.event === "started")!;
      ok("the record names request_approval, the subject and the agent's own unverified statement", started.tool === "request_approval" && started.subject_table === "strategy_runs" && started.agent_statement === "Owner said approve Due Soon");
      const withStructured = await call(mcpCtx(db, principal("act"), { protocolHeader: "2025-06-18", loadEntryPoints: ctx.loadEntryPoints }), "request_approval", { kind: "strategy", subject_id: SR.ready });
      ok("for a 2025-06-18 client the structured result has approvalUrl, fingerprint, expiresAt, whatWillBeApproved and nothingApproved:true", !!withStructured.structured && typeof withStructured.structured.approvalUrl === "string" && withStructured.structured.fingerprint === strategyFingerprint(STRATEGY, INTEL) && typeof withStructured.structured.expiresAt === "string" && typeof withStructured.structured.whatWillBeApproved === "string" && withStructured.structured.nothingApproved === true);
    }
    {
      const { db, ctx } = rig2();
      const r = await call(ctx, "request_approval", { kind: "draft", subject_id: DR.draft });
      const row = db.rows("agent_approval_requests")[0];
      ok("request_approval(draft): pinned to the draft's fingerprint; the summary says approving a draft does not send it", !r.isError && row.fingerprint === draftFingerprint({ kind: "intro_email", subject: "Hello", content: "Hi there" }) && /does not send it/.test(row.summary), row?.summary);
    }
    {
      const { db, ctx } = rig2();
      const refusals: [string, Record<string, unknown>, RegExp][] = [
        ["an already-approved draft", { kind: "draft", subject_id: DR.approved }, /not waiting for review/],
        ["a strategy that is already approved", { kind: "strategy", subject_id: SR.approved }, /already been approved|no proposed|not waiting|newer/],
        ["an unknown strategy", { kind: "strategy", subject_id: UUID_X }, /could not be found/],
        ["an unknown draft", { kind: "draft", subject_id: UUID_X }, /could not be found/],
        ["a non-uuid subject", { kind: "draft", subject_id: "nope" }, /id/],
        ["an unknown kind", { kind: "claim", subject_id: DR.draft }, /one of/],
        ["an extra argument", { kind: "draft", subject_id: DR.draft, fingerprint: "a".repeat(64) }, /Unknown argument/],
      ];
      for (const [label, args, re] of refusals) {
        const r = await call(ctx, "request_approval", args);
        ok(`request_approval refuses ${label}, creating no link`, r.isError && re.test(r.text) && db.rows("agent_approval_requests").length === 0, r.text);
      }
      db.rows("drafts").find((d) => d.id === DR.draft)!.sent_at = "2026-10-01T00:00:00Z";
      const sent = await call(ctx, "request_approval", { kind: "draft", subject_id: DR.draft });
      ok("request_approval refuses a delivered draft", sent.isError && db.rows("agent_approval_requests").length === 0);
    }

    // the link: happy path and ordering
    {
      const { db, order, eps, state } = rig2();
      seedRequest(db);
      const calls: string[] = [];
      void calls;
      const r = await approveFromRequestCore(env(db, eps));
      ok("approving through the link succeeds and calls the existing approveStrategy exactly once", "ok" in r && order.filter((o) => o === "approveStrategy").length === 1 && db.rows("strategy_runs").find((x) => x.id === SR.ready)!.approved_strategy !== null, JSON.stringify(r));
      ok("ORDER: the request is consumed BEFORE the started record, and the started record BEFORE the effect, then the terminal record", JSON.stringify(order) === JSON.stringify(["log:started", "approveStrategy", "log:executed"]) && state.usedAtWhenStarted !== null && state.usedAtWhenEffect !== null && state.usedAtWhenStarted === NOW_ISO, `${order} ${state.usedAtWhenStarted} ${state.usedAtWhenEffect}`);
      const rows = db.rows("agent_call_log");
      ok("the record is the USER's click, not an agent call: origin user_click, tool approve_strategy, the request id and fingerprint, and 'approved by the user on the platform'", rows.length === 2 && rows.every((x) => x.origin === "user_click" && x.tool === "approve_strategy" && x.token_id === TOKEN_ID) && rows[1].result.note === APPROVED_ON_PLATFORM_NOTE && rows[0].arguments.request_id === REQ && rows[0].arguments.fingerprint === strategyFingerprint(STRATEGY, INTEL) && rows[0].agent_statement === null);
      const again = await approveFromRequestCore(env(db, eps));
      ok("a second open is refused: 'already been used' -- the entry point is not called again", "error" in again && /already been used/.test(again.error) && order.filter((o) => o === "approveStrategy").length === 1, JSON.stringify(again));
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db, { kind: "draft", subject_id: DR.draft, fingerprint: draftFingerprint({ kind: "intro_email", subject: "Hello", content: "Hi there" }) });
      const r = await approveFromRequestCore(env(db, eps));
      ok("a draft link approves the draft through approveDraft, and the result says approving is not sending", "ok" in r && order.includes("approveDraft") && db.rows("drafts").find((d) => d.id === DR.draft)!.status === "approved" && /not sending/.test(r.summary), JSON.stringify(r));
      ok("...recorded as a user_click approve_draft with the platform note", db.rows("agent_call_log").every((x) => x.tool === "approve_draft" && x.origin === "user_click") && db.rows("agent_call_log")[1].result.note === APPROVED_ON_PLATFORM_NOTE);
    }
    // refusals: nothing approved, and where it matters nothing consumed
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      const r = await approveFromRequestCore(env(db, eps, { userId: OTHER_USER }));
      ok("WRONG USER: a request that is not the caller's is 'not found for your account'; not consumed, not approved", "error" in r && /could not be found for your account/.test(r.error) && db.rows("agent_approval_requests")[0].used_at === null && !order.includes("approveStrategy"));
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      const r = await approveFromRequestCore(env(db, eps, { now: new Date(NOW.getTime() + 31 * 60000) }));
      ok("EXPIRED: after the 30 minutes the link is refused, unconsumed, unapproved", "error" in r && /expired/.test(r.error) && db.rows("agent_approval_requests")[0].used_at === null && !order.includes("approveStrategy"));
      const edge = await approveFromRequestCore(env(db, eps, { now: new Date(NOW.getTime() + 30 * 60000) }));
      ok("...and exactly at the expiry instant it is already expired", "error" in edge && /expired/.test(edge.error));
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      Object.assign(db.rows("strategy_runs").find((x) => x.id === SR.ready)!, { strategy: { ...STRATEGY, ask_positioning: "A $250,000 program grant." } });
      const r = await approveFromRequestCore(env(db, eps));
      ok("CHANGED CONTENT: the live fingerprint differs from the link's, so nothing is approved and the link is not consumed", "error" in r && /has changed since/.test(r.error) && db.rows("agent_approval_requests")[0].used_at === null && !order.includes("approveStrategy") && db.rows("agent_call_log").length === 0, JSON.stringify(r));
    }
    {
      // The executor's OWN recompute (a second, independent read) is checked too: even if the page's read matched, a fingerprint the guards
      // recompute at the moment of approval that differs from the link's approves nothing and consumes nothing.
      const { db, order, eps } = rig2();
      seedRequest(db);
      const drifting: Record<string, Executor> = {
        ...COMMAND_EXECUTORS,
        approve_strategy: async (a, e) => {
          const res = await COMMAND_EXECUTORS.approve_strategy(a, e);
          return "prepared" in res ? { prepared: { ...res.prepared, liveFingerprint: "f".repeat(64) } } : res;
        },
      };
      const r = await approveFromRequestCore(env(db, eps, { executors: drifting }));
      ok("the guards' own recomputed fingerprint is compared again at the moment of approval: a drift between the page's read and the guards' read approves nothing and burns nothing", "error" in r && /has changed since/.test(r.error) && db.rows("agent_approval_requests")[0].used_at === null && !order.includes("approveStrategy"));
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db, { kind: "draft", subject_id: DR.draft, fingerprint: draftFingerprint({ kind: "intro_email", subject: "Hello", content: "Hi there" }) });
      db.rows("drafts").find((d) => d.id === DR.draft)!.content = "Edited after the link was made.";
      const r = await approveFromRequestCore(env(db, eps));
      ok("CHANGED DRAFT: an edited draft cannot be approved by an older link", "error" in r && /has changed since/.test(r.error) && !order.includes("approveDraft") && db.rows("drafts").find((d) => d.id === DR.draft)!.status === "draft");
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      db.rows("agent_tokens")[0].revoked_at = "2026-10-16T11:00:00.000Z";
      const r = await approveFromRequestCore(env(db, eps));
      ok("a link made by a token that has since been revoked no longer works", "error" in r && /revoked/.test(r.error) && !order.includes("approveStrategy") && db.rows("agent_approval_requests")[0].used_at === null);
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      Object.assign(db.rows("strategy_runs").find((x) => x.id === SR.ready)!, { approved_strategy: { already: true } });
      const r = await approveFromRequestCore(env(db, eps));
      ok("a strategy already decided elsewhere is 'no longer waiting for your decision'; not consumed", "error" in r && /no longer waiting/.test(r.error) && db.rows("agent_approval_requests")[0].used_at === null && !order.includes("approveStrategy"));
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      db.blockUpdate.add(`agent_approval_requests:${REQ}`);
      const r = await approveFromRequestCore(env(db, eps));
      ok("a lost race (the atomic consume updates zero rows) approves nothing", "error" in r && /already been used/.test(r.error) && !order.includes("approveStrategy"));
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      db.insertErrors["agent_call_log"] = { message: "down" };
      const r = await approveFromRequestCore(env(db, eps));
      ok("if the started record cannot be written, the approval does not run (the link is burned and the page says to ask for a fresh one)", "error" in r && /never taken unrecorded/.test(r.error) && !order.includes("approveStrategy") && db.rows("agent_approval_requests")[0].used_at !== null);
    }
    {
      const { db, order, eps } = rig2();
      seedRequest(db);
      eps.approveStrategy = async () => { order.push("approveStrategy"); throw new Error("database said no"); };
      const r = await approveFromRequestCore(env(db, eps));
      ok("an entry point that throws leaves a failed terminal row and a plain message; the link stays used", "error" in r && /database said no/.test(r.error) && db.rows("agent_call_log").map((x) => x.event).join() === "started,failed");
    }
    {
      const { db, eps } = rig2();
      ok("a non-uuid link and an absent link are 'not found' without approving", ["error" in (await approveFromRequestCore(env(db, eps, { requestId: "nope" }))), "error" in (await approveFromRequestCore(env(db, eps, { requestId: UUID_X })))].every(Boolean));
      db.selectErrors["agent_approval_requests"] = { code: "42P01", message: "does not exist" };
      const pending = await approveFromRequestCore(env(db, eps));
      ok("with the table absent the approve path says setup is pending", "error" in pending && /Setup pending/.test(pending.error));
    }
    {
      const { db } = rig2();
      seedRequest(db);
      const row = db.rows("agent_approval_requests")[0] as unknown as ApprovalRow;
      const c = await consumeRequest(db.client(), row, NOW);
      const upd = db.log.filter((l) => l.table === "agent_approval_requests" && l.op === "update").pop();
      ok("consume is ONE conditional update: used_at set only where it is still null and the request has not expired", "ok" in c && upd?.filters.includes("is used_at") === true && upd.filters.includes("gt expires_at") && upd.payload.used_at === NOW_ISO, JSON.stringify(upd));
    }
    // evaluateApproval table
    {
      const row: ApprovalRow = { id: REQ, user_id: USER, token_id: TOKEN_ID, kind: "strategy", subject_id: SR.ready, prospect_id: P.due, fingerprint: "f".repeat(64), summary: "s", expires_at: minutes(30), used_at: null, created_at: NOW_ISO };
      const live: LiveSubject = { kind: "strategy", prospectId: P.due, prospectName: "X", status: "ready_for_review", approved: false, fingerprint: "f".repeat(64), strategy: null, intel: null };
      const v = (o: Partial<Parameters<typeof evaluateApproval>[0]> = {}) => evaluateApproval({ row, userId: USER, now: NOW, live, tokenRevoked: false, ...o }).state;
      ok("evaluateApproval: ready only when everything lines up", v() === "ready");
      ok("evaluateApproval: no row / wrong user -> not_found", v({ row: null }) === "not_found" && v({ userId: OTHER_USER }) === "not_found");
      ok("evaluateApproval: used, expired, revoked token, vanished subject", v({ row: { ...row, used_at: NOW_ISO } }) === "used" && v({ now: new Date(NOW.getTime() + 31 * 60000) }) === "expired" && v({ tokenRevoked: true }) === "token_revoked" && v({ live: null }) === "subject_gone");
      ok("evaluateApproval: a different fingerprint -> changed; a strategy not waiting -> not_waiting", v({ live: { ...live, fingerprint: "e".repeat(64) } }) === "changed" && v({ live: { ...live, status: "error" } }) === "not_waiting" && v({ live: { ...live, approved: true } }) === "not_waiting");
      ok("evaluateApproval: a kind mismatch is 'changed'", v({ row: { ...row, kind: "draft" } }) === "changed");
      ok("every refusal has a plain sentence", Object.values(APPROVAL_MESSAGES).every((m) => m.length > 20 && /\.$/.test(m)));
    }
    // the page
    {
      const page = read("app/(dashboard)/approve/[id]/page.tsx");
      ok("the approval page shows the strategy in full and says approving a draft is not sending", /Outreach approach/.test(page) && /Ask positioning/.test(page) && /Key talking points/.test(page) && /Evidence to highlight/.test(page) && /It is not sending/.test(page) && /Cancel/.test(read("app/(dashboard)/approve/[id]/approve-button.tsx")));
      ok("the page reads the request through the signed-in user's own client and redirects the signed-out", /createClient\(\)/.test(page) && /redirect\("\/login"\)/.test(page) && /evaluateApproval/.test(page));
    }
  }

  // =========================================================================
  section("11. restoring text an agent replaced");
  {
    function restoreRig() {
      const db = contaminatedDb();
      const draft = db.rows("drafts").find((d) => d.id === DR.draft)!;
      Object.assign(draft, { subject: "Hello again", content: "A warmer note." });
      const CALL = "90000000-0000-4000-8000-000000000001";
      const after = draftFingerprint({ kind: "intro_email", subject: "Hello again", content: "A warmer note." });
      db.seed("agent_call_log", [
        { call_id: CALL, token_id: TOKEN_ID, event: "started", origin: "agent", access: "write", tool: "edit_draft", subject_table: "drafts", subject_id: DR.draft, previous: { subject: "Hello", content: "Hi there" }, result: null, user_id: USER, restores_call_id: null, created_at: "2026-10-16T11:00:00Z" },
        { call_id: CALL, token_id: TOKEN_ID, event: "executed", origin: "agent", access: "write", tool: "edit_draft", subject_table: "drafts", subject_id: DR.draft, previous: null, result: { afterFingerprint: after }, user_id: USER, restores_call_id: null, created_at: "2026-10-16T11:00:01Z" },
      ]);
      const order: string[] = [];
      db.onInsert = (table, row) => { if (table === "agent_call_log") order.push(`log:${row.tool}:${row.event}`); };
      const updateDraft = async (id: string, _p: string, subject: string | null, content: string) => { order.push("updateDraft"); Object.assign(db.rows("drafts").find((d) => d.id === id)!, { subject, content }); return { ok: true as const }; };
      return { db, order, updateDraft, CALL };
    }
    {
      const { db, order, updateDraft, CALL } = restoreRig();
      const r = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      const d = db.rows("drafts").find((x) => x.id === DR.draft)!;
      ok("Restore puts the earlier subject and text back through updateDraft", "ok" in r && d.content === "Hi there" && d.subject === "Hello", JSON.stringify(r));
      ok("the restore is recorded as the user's click, born before the write: started, then updateDraft, then executed", JSON.stringify(order) === JSON.stringify(["log:restore_draft_text:started", "updateDraft", "log:restore_draft_text:executed"]) && db.rows("agent_call_log").filter((x) => x.tool === "restore_draft_text").every((x) => x.origin === "user_click" && x.restores_call_id === CALL));
      const again = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      ok("restoring twice is refused", "error" in again && /already restored/.test(again.error));
    }
    {
      const { db, order, updateDraft, CALL } = restoreRig();
      db.rows("drafts").find((x) => x.id === DR.draft)!.content = "Someone edited this since.";
      const r = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      ok("if the draft was changed again since the agent's edit, restore refuses rather than destroy that work", "error" in r && /changed again/.test(r.error) && !order.includes("updateDraft"));
    }
    {
      const { db, order, updateDraft, CALL } = restoreRig();
      db.rows("drafts").find((x) => x.id === DR.draft)!.status = "approved";
      const r = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      ok("an approved draft's text is locked, so restore refuses", "error" in r && /approved/.test(r.error) && !order.includes("updateDraft"));
      db.rows("drafts").find((x) => x.id === DR.draft)!.status = "draft";
      db.rows("drafts").find((x) => x.id === DR.draft)!.sent_at = "2026-10-01T00:00:00Z";
      const s = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      ok("a delivered draft is never restored", "error" in s && /delivered/.test(s.error));
    }
    {
      const { db, order, updateDraft, CALL } = restoreRig();
      const r = await restoreAgentEditCore({ supabase: db.client(), userId: OTHER_USER, callId: CALL, updateDraft });
      ok("another user's call is 'not found'", "error" in r && /could not be found/.test(r.error) && !order.includes("updateDraft"));
      const bad = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: "nope", updateDraft });
      ok("a non-uuid call id is refused", "error" in bad);
    }
    {
      const { db, order, updateDraft, CALL } = restoreRig();
      db.rows("agent_call_log").forEach((x) => (x.tool = "set_prospect_ask_amount"));
      const r = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      ok("only an edit_draft call is restorable", "error" in r && /Nothing about that call/.test(r.error) && !order.includes("updateDraft"));
    }
    {
      const { db, order, updateDraft, CALL } = restoreRig();
      db.insertErrors["agent_call_log"] = { message: "down" };
      const r = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      ok("if the restore's own started record cannot be written, nothing is changed", "error" in r && !order.includes("updateDraft") && db.rows("drafts").find((x) => x.id === DR.draft)!.content === "A warmer note.");
    }
    {
      const { db, order, updateDraft, CALL } = restoreRig();
      db.rows("agent_call_log").find((x) => x.event === "executed")!.result = {};
      const r = await restoreAgentEditCore({ supabase: db.client(), userId: USER, callId: CALL, updateDraft });
      ok("an edit whose after-fingerprint was not recorded cannot be restored safely", "error" in r && !order.includes("updateDraft"));
    }
    ok("restore reports which machinery it used: its own agent-specific core (the assistant's reads a thread-bound table)", !/restoreCommandPreviousCore|assistant_command_events/.test(code("lib/agent/restore.ts")));
  }

  // =========================================================================
  section("12. scans: the credential, the override, the gates, forbidden references");
  {
    const everyFile = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components")), join(root, "middleware.ts")].map(rel);
    const importersOf = (re: RegExp) => everyFile.filter((f) => importSpecifiers(code(f)).some((s) => re.test(s))).sort();

    // the privileged credential
    const namers = everyFile.filter((f) => /SUPABASE_SERVICE_ROLE_KEY/.test(code(f)) && (f.startsWith("lib/agent/") || NEW_SURFACE.includes(f)));
    ok("the privileged credential is named in exactly ONE file of the connector: lib/agent/mint.ts", JSON.stringify(namers) === JSON.stringify(["lib/agent/mint.ts"]), namers.join(", "));
    ok("...and nowhere else in the connector's surface, pages and routes included", NEW_SURFACE.filter((f) => f !== "lib/agent/mint.ts").every((f) => !/SUPABASE_SERVICE_ROLE_KEY|createAdminClient|supabase\/admin|service_role/i.test(code(f))));
    const mint = code("lib/agent/mint.ts");
    ok("the minting module touches no data: no .from( , .rpc( , .storage or .insert(", !/\.from\(|\.rpc\(|\.storage\b|\.insert\(|\.update\(|\.upsert\(/.test(mint) && !/\)\s*\.delete\(/.test(mint), (mint.match(/\.from\(|\.rpc\(|\.storage\b|\.insert\(|\.update\(|\.upsert\(/) ?? []).join());
    ok("the minting module does exactly the exchange: getUserById, generateLink, verifyOtp -- and checks the session is the owner's", /getUserById/.test(mint) && /generateLink/.test(mint) && /verifyOtp/.test(mint) && /!== userId/.test(mint));
    ok("the only module importing the minting module is the HTTP layer", JSON.stringify(importersOf(/(^|\/)mint$/)) === JSON.stringify(["lib/agent/http.ts"]), importersOf(/mint$/).join());

    // the override
    const overrideFiles = everyFile.filter((f) => /runWithAgentClient/.test(code(f)));
    ok("runWithAgentClient is named in exactly: its definition, the JSON-RPC layer that enters it, and the HTTP layer that passes it in", JSON.stringify(overrideFiles) === JSON.stringify(["lib/agent/http.ts", "lib/agent/mcp.ts", "lib/supabase/server.ts"]), overrideFiles.join());
    const directCalls = everyFile.filter((f) => f !== "lib/supabase/server.ts" && /runWithAgentClient\(/.test(code(f)));
    ok("nothing calls runWithAgentClient( directly outside its definition", directCalls.length === 0, directCalls.join());
    ok("the override is ENTERED in exactly one place: one `enter(` call in lib/agent/mcp.ts, around a single tool execution", (code("lib/agent/mcp.ts").match(/\benter\(/g) ?? []).length === 1 && /outcome = await enter\(client, \(\) =>\s*tool\.run\(/.test(code("lib/agent/mcp.ts")) && !/\benter\(/.test(code("lib/agent/http.ts")));
    ok("the store itself is referenced only inside lib/supabase/server.ts", everyFile.filter((f) => /agentClientStore/.test(code(f))).join() === "lib/supabase/server.ts");

    // the gates
    const GATE_NAMING = /(?<![A-Za-z])(?:approve_strategy|approve_draft|approveStrategy|approveDraft)/;
    const gateNamers = AGENT_LIB.filter((f) => GATE_NAMING.test(code(f))).sort();
    ok("the approve names appear only in approvals.ts (prepare-only guards), approve-exec.ts (the click) and act-entrypoints.ts (the throwing stubs)", JSON.stringify(gateNamers) === JSON.stringify(["lib/agent/act-entrypoints.ts", "lib/agent/approvals.ts", "lib/agent/approve-exec.ts"]), gateNamers.join());
    ok("approve-exec.ts is imported by exactly one file: the approval page's server action", JSON.stringify(importersOf(/(^|\/)approve-exec$/)) === JSON.stringify([APPROVE_ACTIONS]), importersOf(/approve-exec$/).join());
    ok("approve-entrypoints.ts is imported by exactly one file: the same action", JSON.stringify(importersOf(/(^|\/)approve-entrypoints$/)) === JSON.stringify([APPROVE_ACTIONS]), importersOf(/approve-entrypoints$/).join());
    const reach = ["tools.ts", "act.ts", "act-args.ts", "mcp.ts", "http.ts", "report.ts", "log.ts", "verify.ts", "token.ts", "limits.ts"].map((f) => `lib/agent/${f}`);
    ok("no tool handler, choke point or protocol module imports approve-exec or approve-entrypoints, or names an approve entry point", reach.every((f) => !GATE_NAMING.test(code(f)) && !importSpecifiers(code(f)).some((s) => /approve-exec|approve-entrypoints/.test(s))), reach.filter((f) => GATE_NAMING.test(code(f))).join());
    ok("the module graph from a tool: tools.ts imports approvals.ts (links only), not approve-exec", importSpecifiers(code("lib/agent/tools.ts")).includes("./approvals") && !importSpecifiers(code("lib/agent/approvals.ts")).some((s) => /approve-exec|entrypoints/.test(s)));
    const effectCallers = AGENT_LIB.filter((f) => /\.effect\(/.test(code(f))).sort();
    ok("`.effect(` is called in exactly two files: act.ts (everyday acts) and approve-exec.ts (the owner's click) -- approvals.ts only ever PREPARES", JSON.stringify(effectCallers) === JSON.stringify(["lib/agent/act.ts", "lib/agent/approve-exec.ts"]), effectCallers.join());
    ok("act.ts runs only a closed table of the eight acts: its executor table is built from AGENT_ACT_NAMES", /for \(const name of AGENT_ACT_NAMES\) out\[name\] = COMMAND_EXECUTORS\[name\]/.test(code("lib/agent/act.ts")));
    ok("the assistant's command-entrypoints is loaded (dynamically) only by turn.ts and the two connector loaders", JSON.stringify(importersOf(/command-entrypoints$/)) === JSON.stringify(["lib/agent/act-entrypoints.ts", "lib/agent/approve-entrypoints.ts", "lib/assistant/turn.ts"]), importersOf(/command-entrypoints$/).join());
    const stub = code("lib/agent/act-entrypoints.ts");
    ok("the act path's entry points replace BOTH gate actions with stubs that throw", /approveStrategy: async \(\) => \{\s*throw new Error\(GATE_REFUSAL\)/.test(stub) && /approveDraft: async \(\) => \{\s*throw new Error\(GATE_REFUSAL\)/.test(stub) && /\.\.\.DEFAULT_COMMAND_ENTRY_POINTS,/.test(stub));
    ok("only the act path's loader is wired into the HTTP layer", /loadAgentActEntryPoints/.test(code("lib/agent/http.ts")) && !/loadApprovalEntryPoints/.test(code("lib/agent/http.ts")));

    // forbidden references anywhere in the new surface
    const FORBIDDEN = /sendApprovedDraft|send-draft|draft-send|send-actions|["']resend["']|@anthropic-ai|lib\/ai\/anthropic|moveProspectStage|stage-change|prospect-workflow|deleteProspect|deleteInteraction|bulkDelete|logProspectGift|logSupporterGift|importProspectGifts|decideClaim|submitClaimReview|setClaimVerificationStatus|retractProspectOutcome|updateContact|confirmProspectEin|setOrganizationSendingEnabled|generateDraft\b|runStrategy|extractResearchClaims/;
    const forbiddenHits = NEW_SURFACE.filter((f) => FORBIDDEN.test(code(f)));
    ok("nothing in the connector's new code references sending, a stage move, claim decisions, deletion, gifts, contact changes or a model call", forbiddenHits.length === 0, forbiddenHits.map((f) => `${f}: ${code(f).match(FORBIDDEN)?.[0]}`).join("; "));
    const importsApp = AGENT_LIB.filter((f) => importSpecifiers(code(f)).some((s) => s.startsWith("@/app/")));
    ok("no lib/agent file imports a server action from app/ (entry points arrive injected or dynamically through the assistant's wiring)", importsApp.length === 0, importsApp.join());
    const writes: string[] = [];
    for (const f of AGENT_LIB) {
      for (const m of code(f).matchAll(/\.(insert|update|upsert|delete)\(/g)) {
        const before = code(f).slice(Math.max(0, (m.index ?? 0) - 90), m.index);
        if (!/\.from\(/.test(before)) continue; // not a database call (a Map, a hash)
        if (!/\.from\((AGENT_LOG_TABLE|APPROVAL_TABLE|TOKEN_TABLE|"agent_[a-z_]+")\)\s*$/.test(before.trimEnd() + "") && !/\.from\((AGENT_LOG_TABLE|APPROVAL_TABLE|TOKEN_TABLE|"agent_[a-z_]+")\)[\s\S]{0,80}$/.test(before)) writes.push(`${f}: ${m[1]}`);
      }
    }
    ok("every database write in lib/agent targets one of the connector's own three tables (tokens, call log, approval requests)", writes.length === 0, writes.join("; "));
    ok("no write in lib/agent targets agent_call_log except insert (it is append-only)", !AGENT_LIB.some((f) => /\.from\(AGENT_LOG_TABLE\)\s*\.(update|delete|upsert)\(/.test(code(f))));
    ok("authorizing_quote appears in lib/agent only in act-args.ts (where it is refused and where a validation placeholder is injected)", AGENT_LIB.filter((f) => /authorizing_quote/.test(code(f))).join() === "lib/agent/act-args.ts" || AGENT_LIB.filter((f) => /authorizing_quote/.test(code(f))).sort().join() === "lib/agent/act-args.ts,lib/agent/approvals.ts");
    const clientBundles = everyFile.filter((f) => /^\s*["']use client["']/.test(read(f)) && importSpecifiers(code(f)).some((s) => /lib\/agent|lib\/assistant|supabase\/server/.test(s)));
    ok("no 'use client' file imports anything under lib/agent (no key, minting, executor or gate reaches a bundle)", clientBundles.length === 0, clientBundles.join());
    ok("the Connect Muse and approve pages use the shared ui tokens (box-sizing border-box fieldStyle), not one-off field styles", /fieldStyle/.test(read("app/(dashboard)/settings/connections/connections-panel.tsx")) && /sectionStyle/.test(read("app/(dashboard)/approve/[id]/page.tsx")));
    ok("the Settings page links to Connect Muse", /href="\/settings\/connections"/.test(read("app/(dashboard)/settings/page.tsx")));
    const connect = read("app/(dashboard)/settings/connections/page.tsx");
    ok("the Connect Muse page states the canonical endpoint with no redirect, the bearer scheme, the steps, what each scope can see and that Meta holds what it receives under its own terms", /Endpoint address/.test(connect) && /no redirect/.test(connect) && /Add custom connector/.test(connect) && /whoami/.test(connect) && /ask before it takes actions/.test(connect) && /refresh the connector/.test(connect) && /Meta holds what it receives under its own terms/.test(connect) && /does not read and cannot enforce/.test(connect) && /secure credential prompt/.test(connect));
    ok("the endpoint address is derived from the canonical-origin setting, not from request headers", /publicOrigin\(\)/.test(connect) && !/headers\(\)/.test(connect) && LIMITS.publicOrigin({}) === "https://fundraising-ai.vercel.app" && LIMITS.publicOrigin({ AGENT_PUBLIC_ORIGIN: "https://app.example.org/" }) === "https://app.example.org" && LIMITS.publicOrigin({ AGENT_PUBLIC_ORIGIN: "not a url" }) === "https://fundraising-ai.vercel.app");
    ok(".env.example documents AGENT_PUBLIC_ORIGIN and names the single module that uses the service key", /AGENT_PUBLIC_ORIGIN=/.test(read(".env.example")) && /lib\/agent\/mint\.ts/.test(read(".env.example")));
    ok("docs/connecting-muse.md exists and covers the steps", existsSync(join(root, "docs/connecting-muse.md")) && /whoami/.test(read("docs/connecting-muse.md")) && /ask before actions/.test(read("docs/connecting-muse.md")) && /refresh/i.test(read("docs/connecting-muse.md")));
    ok("scripts/mcp-smoke.ts exists, documents itself, never prints the token and refuses without MCP_URL/MCP_TOKEN", existsSync(join(root, "scripts/mcp-smoke.ts")) && /MCP_URL/.test(read("scripts/mcp-smoke.ts")) && /MCP_TOKEN is not set/.test(read("scripts/mcp-smoke.ts")) && /process\.exit\(2\)/.test(read("scripts/mcp-smoke.ts")));
  }

  // =========================================================================
  section("13. migration 0082, by text");
  {
    const files = readdirSync(join(root, "supabase/migrations")).filter((f) => /^\d{4}_/.test(f)).sort();
    ok("0082_agent_delegation.sql is the highest migration, directly after 0081", files[files.length - 1] === "0082_agent_delegation.sql" && files[files.length - 2] === "0081_assistant_commands.sql", files.slice(-3).join());
    const sql = read("supabase/migrations/0082_agent_delegation.sql");
    const stmts = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").toLowerCase();
    const creates = [...stmts.matchAll(/create\s+table\s+([a-z_]+)/g)].map((m) => m[1]).sort();
    ok("creates exactly three tables: agent_approval_requests, agent_call_log, agent_tokens", JSON.stringify(creates) === JSON.stringify(["agent_approval_requests", "agent_call_log", "agent_tokens"]), creates.join());
    const alters = [...stmts.matchAll(/alter\s+table\s+([a-z_]+)/g)].map((m) => m[1]);
    ok("every ALTER TABLE targets one of the three new tables (ruling 0020: additive)", alters.length > 0 && alters.every((t) => creates.includes(t)));
    ok("no DROP, no ADD COLUMN, no rename, no column type change", !/\bdrop\b/.test(stmts) && !/add\s+column/.test(stmts) && !/\brename\b/.test(stmts) && !/alter\s+column/.test(stmts));
    ok("the ledger's own additivity check passes", additiveViolations(sql).length === 0, additiveViolations(sql).join("; "));
    ok("each table has organization_id uuid not null references organizations default my_organization_id() (hard rule 6)", (stmts.match(/organization_id\s+uuid\s+not\s+null\s+references\s+organizations\s*\(id\)\s+default\s+my_organization_id\(\)/g) ?? []).length === 3);
    ok("each table has user_id defaulting to auth.uid() referencing auth.users", (stmts.match(/user_id\s+uuid\s+not\s+null\s+default\s+auth\.uid\(\)\s+references\s+auth\.users/g) ?? []).length === 3);
    ok("row level security is enabled on all three", creates.every((t) => new RegExp(`alter\\s+table\\s+${t}\\s+enable\\s+row\\s+level\\s+security`).test(stmts)));
    const kinds = [...stmts.matchAll(/create\s+policy[\s\S]*?\bfor\s+(insert|select|update|delete|all)\b/g)].map((m) => m[1]);
    ok("there is NO delete policy and no 'for all' policy", !kinds.includes("delete") && !kinds.includes("all") && !/for\s+delete/.test(stmts));
    ok("policy census: tokens insert+select+update; call log insert+select; approvals insert+select+update (8 policies)", kinds.length === 8 && kinds.filter((k) => k === "insert").length === 3 && kinds.filter((k) => k === "select").length === 3 && kinds.filter((k) => k === "update").length === 2, kinds.join());
    const policies = [...stmts.matchAll(/create\s+policy[\s\S]*?;/g)].map((m) => m[0]);
    ok("every policy is scoped by organization AND user", policies.length === 8 && policies.every((p) => /organization_id\s*=\s*my_organization_id\(\)/.test(p) && /user_id\s*=\s*auth\.uid\(\)/.test(p)));
    ok("agent_call_log has no update policy and a BEFORE UPDATE trigger that raises for every role", !/on\s+agent_call_log\s+for\s+update/.test(stmts) && /create\s+trigger\s+agent_call_log_append_only\s+before\s+update\s+on\s+agent_call_log/.test(stmts) && /agent_call_log: the agent call record is append-only/.test(stmts));
    ok("column-level grants: a signed-in user may update only revoked_at on a token and only used_at on a request, and nothing on the log", /revoke\s+update\s+on\s+agent_tokens\s+from\s+authenticated/.test(stmts) && /grant\s+update\s*\(revoked_at\)\s+on\s+agent_tokens\s+to\s+authenticated/.test(stmts) && /grant\s+update\s*\(used_at\)\s+on\s+agent_approval_requests\s+to\s+authenticated/.test(stmts) && /revoke\s+update\s+on\s+agent_call_log\s+from\s+authenticated/.test(stmts) && /revoke\s+all\s+on\s+agent_tokens\s+from\s+anon/.test(stmts));
    ok("a BEFORE UPDATE trigger pins every token column but revoked_at, makes revocation permanent, and bars users from last_used_at", /create\s+trigger\s+agent_tokens_guard_update\s+before\s+update/.test(stmts) && ["token_hash", "scope", "expires_at", "user_id", "organization_id", "name"].every((c) => new RegExp(`new\\.${c}\\s+is\\s+distinct\\s+from\\s+old\\.${c}`).test(stmts)) && /old\.revoked_at\s+is\s+not\s+null\s+and\s+new\.revoked_at\s+is\s+distinct\s+from\s+old\.revoked_at/.test(stmts) && /current_user\s+in\s*\('authenticated',\s*'anon'\)/.test(stmts));
    ok("a token is born live, unused, and expires within 366 days (trigger)", /agent_tokens_guard_insert/.test(stmts) && /interval\s+'366 days'/.test(stmts));
    ok("the token column is a hash: token_hash text with a 64-hex check and a unique index; no column called token", /token_hash\s+text\s+not\s+null/.test(stmts) && /token_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'/.test(stmts) && /create\s+unique\s+index\s+agent_tokens_hash_idx\s+on\s+agent_tokens\s*\(token_hash\)/.test(stmts) && !/\n\s+token\s+text/.test(stmts));
    ok("scope is closed to read|act in the database", /scope\s+in\s*\('read',\s*'act'\)/.test(stmts));
    ok("verify_agent_token: security definer, fixed search_path, takes only a hash, returns the five columns", /create\s+function\s+verify_agent_token\(p_hash\s+text\)\s+returns\s+table\s*\(token_id\s+uuid,\s*user_id\s+uuid,\s*organization_id\s+uuid,\s*scope\s+text,\s*expires_at\s+timestamptz\)[\s\S]*?security\s+definer\s+set\s+search_path\s*=\s*public/.test(stmts));
    ok("verify_agent_token matches only a live token (not revoked, not expired) and stamps last_used_at", /where\s+t\.token_hash\s*=\s*p_hash\s+and\s+t\.revoked_at\s+is\s+null\s+and\s+t\.expires_at\s*>\s*now\(\)/.test(stmts) && /set\s+last_used_at\s*=\s*now\(\)/.test(stmts));
    ok("verify_agent_token: execute is revoked from public and granted explicitly to anon and authenticated only", /revoke\s+all\s+on\s+function\s+verify_agent_token\(text\)\s+from\s+public/.test(stmts) && /grant\s+execute\s+on\s+function\s+verify_agent_token\(text\)\s+to\s+anon,\s*authenticated/.test(stmts));
    ok("the log's tool vocabulary in SQL equals the tools in code plus the three click-only names", (() => {
      const m = /agent_call_log_tool_check\s+check\s*\(\s*tool\s+in\s*\(([\s\S]*?)\)\s*\)/.exec(stmts);
      const inSql = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((x) => x.replace(/'/g, "")).sort();
      const inCode = [...AGENT_TOOLS.map((t) => t.name), "approve_strategy", "approve_draft", "restore_draft_text"].sort();
      return JSON.stringify(inSql) === JSON.stringify(inCode);
    })());
    ok("the database refuses an agent-origin row for an approval or a restore, and a click-origin row for anything else", /origin\s*=\s*'agent'\s+and\s+tool\s+not\s+in\s*\('approve_strategy',\s*'approve_draft',\s*'restore_draft_text'\)/.test(stmts) && /origin\s*=\s*'user_click'\s+and\s+tool\s+in\s*\('approve_strategy',\s*'approve_draft',\s*'restore_draft_text'\)/.test(stmts));
    ok("a read is one terminal row (never 'started'); one started and one terminal row per call (partial unique indexes)", /access\s*=\s*'write'\s+or\s+event\s+in\s*\('executed',\s*'failed',\s*'refused'\)/.test(stmts) && /unique\s+index\s+agent_call_log_one_started_idx\s+on\s+agent_call_log\s*\(call_id\)\s+where\s+event\s*=\s*'started'/.test(stmts) && /unique\s+index\s+agent_call_log_one_terminal_idx\s+on\s+agent_call_log\s*\(call_id\)\s+where\s+event\s*<>\s*'started'/.test(stmts));
    ok("the log's insert trigger (security definer, fixed search_path) checks org, user, and that only a live ACT token can start an agent write", /create\s+function\s+enforce_agent_call_log\(\)[\s\S]*?security\s+definer\s+set\s+search_path\s*=\s*public/.test(stmts) && /a read-scope token cannot start a write/.test(stmts) && /a revoked or expired token cannot start a write/.test(stmts) && /an executed or failed write must follow a started row/.test(stmts));
    ok("approval requests: born unused and within the hour from a live act token; only used_at may change, once, before expiry", /enforce_agent_approval_insert/.test(stmts) && /interval\s+'1 hour'/.test(stmts) && /only a live act-scope token can ask for an approval link/.test(stmts) && /an approval request can only move from unused to used/.test(stmts) && /that approval request has expired/.test(stmts) && /that approval request was already used/.test(stmts));
    ok("the agent's statement is documented in SQL as the agent's own, UNVERIFIED statement", /agent_statement/.test(sql) && /UNVERIFIED/.test(sql) && /cannot see what the user said/i.test(sql));
    ok("the call log records a duration on terminal rows", /duration_ms\s+integer/.test(stmts));
    ok("the table name in code is the table name in SQL, and the setup message names migration 0082", /AGENT_LOG_TABLE = "agent_call_log"/.test(read("lib/agent/log.ts")) && /APPROVAL_TABLE = "agent_approval_requests"/.test(read("lib/agent/approvals.ts")) && /TOKEN_TABLE = "agent_tokens"/.test(read("lib/agent/tokens-admin.ts")) && /AGENT_MIGRATION = "0082"/.test(read("lib/agent/setup.ts")));
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
