// The agent call record (STATE item 98, ruling 0039 clause 4): an append-only
// event log in agent_call_log (migration 0082). A WRITE is a `started` row,
// born BEFORE its effect and holding the exact arguments and what the write is
// about to replace, then one terminal row (executed | failed); a call refused
// before its effect is one `refused` row; a READ is one compact terminal row.
//
// Rows are written through the user's own row-level-security client (the
// minted one for an agent call, the cookie one for a click), so RLS decides
// (organization AND user). Nothing here writes a token, and nothing here
// claims the user said anything: `agent_statement` is the agent's own,
// unverified statement.
//
// Two rules live here, not in each caller:
//   * Born before the effect. insertAgentEvent is the only door to an effect:
//     the act path calls the entry point only after the started row returned
//     ok. A failed or impossible write is a refusal -- never an effect that
//     ran unrecorded.
//   * Absent table, nothing written. If the table is not in the database every
//     function here reports setup-pending and the caller refuses plainly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENT_SETUP_PENDING_MESSAGE, isSetupPending } from "./setup";

export const AGENT_LOG_TABLE = "agent_call_log";

export type AgentEventKind = "started" | "executed" | "failed" | "refused";
export type AgentEventOrigin = "agent" | "user_click";
export type AgentAccess = "read" | "write";

export type AgentEventInsert = {
  call_id: string;
  token_id: string;
  event: AgentEventKind;
  origin: AgentEventOrigin;
  access: AgentAccess;
  tool: string;
  arguments: Record<string, unknown>;
  // The agent's own, UNVERIFIED statement. Null for everything else.
  agent_statement: string | null;
  subject_table: string | null;
  subject_id: string | null;
  previous: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_note: string | null;
  // Milliseconds the call took; written with a terminal row, null on a started one.
  duration_ms: number | null;
  restores_call_id: string | null;
};

export type InsertEventResult = { ok: true } | { ok: false; setupPending: boolean; message: string };

export async function insertAgentEvent(supabase: SupabaseClient, row: AgentEventInsert): Promise<InsertEventResult> {
  try {
    const { error } = await supabase.from(AGENT_LOG_TABLE).insert(row);
    if (error) {
      if (isSetupPending(error)) return { ok: false, setupPending: true, message: AGENT_SETUP_PENDING_MESSAGE };
      console.error(`[agent] call record insert failed (${row.event} ${row.tool}):`, error.message);
      return { ok: false, setupPending: false, message: "The call could not be recorded." };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[agent] call record insert threw (${row.event} ${row.tool}):`, err instanceof Error ? err.message : err);
    return { ok: false, setupPending: false, message: "The call could not be recorded." };
  }
}

// --- window counts (rate limit and write cap) -------------------------------------

export type WindowUsage = {
  count: number;
  // When the oldest counted row was written, or null when there is none.
  oldestAt: string | null;
};

export type UsageResult = { ok: true; usage: WindowUsage } | { ok: false; setupPending: boolean };

// How many of THIS token's agent calls fall in the window.
//   kind "calls":  every call -- a read's one row, a write's started row, and a
//                  refusal. (A write's terminal row is not a second call.)
//   kind "writes": started write rows only -- what actually reached an effect.
// A user's click (origin user_click) is never counted: it is the user, not the
// agent.
export async function windowUsage(
  supabase: SupabaseClient,
  tokenId: string,
  kind: "calls" | "writes",
  windowMs: number,
  now: Date
): Promise<UsageResult> {
  const since = new Date(now.getTime() - windowMs).toISOString();
  const base = () => {
    let q = supabase.from(AGENT_LOG_TABLE).select("created_at", { count: "exact" }).eq("token_id", tokenId).eq("origin", "agent").gte("created_at", since);
    q = kind === "writes" ? q.eq("access", "write").eq("event", "started") : q.or("access.eq.read,event.in.(started,refused)");
    return q;
  };
  try {
    const { data, count, error } = await base().order("created_at", { ascending: true }).limit(1);
    if (error) return { ok: false, setupPending: isSetupPending(error) };
    const oldest = ((data ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null;
    return { ok: true, usage: { count: count ?? 0, oldestAt: oldest } };
  } catch {
    return { ok: false, setupPending: false };
  }
}

// Seconds until the oldest counted row leaves the window (at least 1).
export function retryAfterSeconds(oldestAt: string | null, windowMs: number, now: Date): number {
  if (!oldestAt) return Math.ceil(windowMs / 1000);
  const free = Date.parse(oldestAt) + windowMs;
  return Math.max(1, Math.ceil((free - now.getTime()) / 1000));
}

export function describeWait(seconds: number): string {
  if (seconds < 90) return `about ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `about ${minutes} minutes` : `about ${Math.ceil(minutes / 60)} hours`;
}

export function stopwatch(): () => number {
  const t0 = Date.now();
  return () => Math.max(0, Date.now() - t0);
}

// The arguments as the log keeps them: the object itself when it is small
// enough to be worth keeping whole, otherwise a marker (a junk argument is not
// worth a megabyte of audit log).
export function compactArgs(raw: unknown, maxChars = 2000): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  try {
    return JSON.stringify(raw).length <= maxChars ? (raw as Record<string, unknown>) : { truncated: true };
  } catch {
    return {};
  }
}
