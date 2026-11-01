// Shared test support for scripts/test-network.ts and scripts/test-network-import.ts
// (STATE item 103). Not a test: it only exports a small in-memory stand-in for
// the Supabase client, and a helper that stubs the modules a server action
// imports so the REAL action can be run offline (the technique
// scripts/test-assistant.ts section 13 uses).
//
// The fake models the two things that matter for this feature and are easy to
// get wrong:
//   * PostgREST's 1000-row response limit: a select with no range returns at
//     most 1000 rows, with no error and no marker; a range is capped the same;
//   * exact counts (select with { count: "exact", head: true }).
// It also logs every call, so a test can assert what was (and was NOT) sent --
// for example that an insert never carried organization_id.
//
// It does NOT model row-level security or the database's own constraints; the
// isolation suite (scripts/test-tenant-isolation.ts) is where those are run.

import { join } from "node:path";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type LogEntry = { table: string; op: "select" | "insert" | "update" | "delete"; payload?: unknown; filters: string[]; range?: [number, number]; head?: boolean };

export const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORG_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

export const POSTGREST_ROW_LIMIT = 1000;

// A PostgREST double-quoted value -> its text (undoing \" and \\).
function unquote(v: string): string {
  const inner = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  return inner.replace(/\\(["\\])/g, "$1");
}
// A SQL LIKE pattern (backslash escapes, % and _) -> a case-insensitive regex.
function likeToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

// Splits a PostgREST `or` string at top-level commas (commas inside a
// double-quoted value do not split), as PostgREST does.
function splitOr(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') inQ = false;
    } else if (ch === '"') {
      inQ = true;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export class FakeNetDb {
  tables: Record<string, Row[]> = {};
  log: LogEntry[] = [];
  seq = 0;
  // Fail the Nth insert call (1-based) on a table with this message.
  failInsert: Record<string, { onCall: number; message: string }> = {};
  insertCalls: Record<string, number> = {};
  auth = { getUser: async () => ({ data: { user: { id: USER_ID, email: "user@example.org" } } }) };

  seed(table: string, rows: Row[]) {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
  }
  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }
  uuid(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }
  from(table: string) {
    return new FakeQuery(this, table);
  }
  logOf(table: string, op: LogEntry["op"]) {
    return this.log.filter((l) => l.table === table && l.op === op);
  }
  applyDefaults(table: string, p: Row): Row {
    const now = "2026-10-31T12:00:00.000Z";
    if (table === "network_connections") return { id: this.uuid(), organization_id: ORG_ID, created_at: now, updated_at: now, ...p };
    if (table === "ai_runs") return { id: this.uuid(), organization_id: ORG_ID, outcome: null, ...p };
    if (table === "network_path_suggestions") return { id: this.uuid(), organization_id: ORG_ID, status: "suggested", created_at: now, ...p };
    return { id: this.uuid(), ...p };
  }
}

class FakeQuery {
  private op: LogEntry["op"] = "select";
  private payload: unknown;
  private filters: ((r: Row) => boolean)[] = [];
  private desc: string[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private head = false;
  private wantCount = false;
  private returning = false;
  private single_ = false;
  private maybeSingle_ = false;

  constructor(private db: FakeNetDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.head = !!opts?.head;
      this.wantCount = !!opts?.count;
    } else this.returning = true;
    return this;
  }
  insert(p: unknown) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  update(p: unknown) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  private f(d: string, fn: (r: Row) => boolean) {
    this.filters.push(fn);
    this.desc.push(d);
    return this;
  }
  eq(c: string, v: unknown) {
    return this.f(`eq ${c} ${String(v)}`, (r) => r[c] === v);
  }
  in(c: string, vs: unknown[]) {
    return this.f(`in ${c} (${vs.length})`, (r) => vs.includes(r[c]));
  }
  is(c: string, v: null) {
    return this.f(`is ${c}`, (r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v));
  }
  or(expr: string) {
    // person_name.ilike."%x%",affiliation.ilike."%x%"
    const clauses = splitOr(expr).map((part) => {
      const m = part.match(/^([a-z_]+)\.ilike\.(.*)$/s);
      if (!m) throw new Error(`FakeNetDb.or: unsupported clause ${part}`);
      const re = likeToRegex(unquote(m[2]));
      return (r: Row) => typeof r[m[1]] === "string" && re.test(r[m[1]]);
    });
    return this.f(`or ${expr}`, (r) => clauses.some((c) => c(r)));
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orders.push({ col, asc: o?.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  single() {
    this.single_ = true;
    return this;
  }
  returns() {
    return this;
  }
  maybeSingle() {
    this.maybeSingle_ = true;
    return this;
  }
  then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
    try {
      return Promise.resolve(this.run()).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  }

  private run() {
    const db = this.db;
    const all = db.tables[this.table] ?? (db.tables[this.table] = []);
    const entry: LogEntry = { table: this.table, op: this.op, payload: this.payload, filters: this.desc, head: this.head };
    if (this.rangeFrom !== null) entry.range = [this.rangeFrom, this.rangeTo as number];
    db.log.push(entry);

    if (this.op === "insert") {
      db.insertCalls[this.table] = (db.insertCalls[this.table] ?? 0) + 1;
      const fail = db.failInsert[this.table];
      if (fail && fail.onCall === db.insertCalls[this.table]) return { data: null, error: { message: fail.message }, count: null };
      const incoming = Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row];
      const created = incoming.map((p) => db.applyDefaults(this.table, p));
      all.push(...created);
      if (!this.returning) return { data: null, error: null, count: null };
      return this.single_ ? { data: created[0], error: null, count: null } : { data: created, error: null, count: null };
    }

    const matches = all.filter((r) => this.filters.every((fn) => fn(r)));
    if (this.op === "update") {
      for (const r of matches) Object.assign(r, this.payload);
      return { data: this.returning ? matches : null, error: null, count: null };
    }
    if (this.op === "delete") {
      db.tables[this.table] = all.filter((r) => !matches.includes(r));
      return { data: this.returning ? matches : null, error: null, count: null };
    }

    // select
    let rows = [...matches];
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const { col, asc } = this.orders[i];
      rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    const count = this.wantCount ? matches.length : null;
    if (this.head) return { data: null, error: null, count };
    if (this.maybeSingle_) return { data: rows[0] ?? null, error: null, count };
    const from = this.rangeFrom ?? 0;
    const want = this.rangeTo !== null ? this.rangeTo - from + 1 : POSTGREST_ROW_LIMIT;
    rows = rows.slice(from, from + Math.min(want, POSTGREST_ROW_LIMIT));
    return { data: rows, error: null, count };
  }
}

// Stubs modules in require.cache for the duration of a test and restores them.
export function makeStubber(root: string) {
  const cache = require.cache as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-require-imports
  const touched = new Map<string, unknown>();
  return {
    resolve: (rel: string) => require.resolve(join(root, rel)),
    stub(abs: string, exports: Record<string, unknown>) {
      if (!touched.has(abs)) touched.set(abs, cache[abs]);
      cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
    },
    forget(abs: string) {
      if (!touched.has(abs)) touched.set(abs, cache[abs]);
      delete cache[abs];
    },
    restore() {
      for (const [abs, prev] of touched) {
        if (prev === undefined) delete cache[abs];
        else cache[abs] = prev;
      }
      touched.clear();
    },
  };
}
