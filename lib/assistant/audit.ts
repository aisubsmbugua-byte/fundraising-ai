// The command record (STATE item 92, ruling 0038 clause 5): an append-only
// event log, one `started` row born BEFORE a command's effect and one
// terminal row (executed | failed | refused) written after, tied by a
// command id. Migration 0081 enforces the shape -- insert and select only,
// no update or delete policy, a trigger that rejects every update for every
// role, and cross-table organization/author matching.
//
// Two rules live here, not in each caller:
//
//   * Born before the effect. insertStarted() is the only door to a command's
//     effect: runCommand calls the entry point only after it returned ok. A
//     failed or impossible write is a refusal -- never a command that ran
//     unrecorded.
//
//   * Absent table, nothing written. If the table is not in the database
//     (migration 0081 not applied; code deployed ahead of it) every function
//     here reports setup-pending and the caller refuses with a plain message.
//     Safe in both deploy orders.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelation } from "./access";

export const COMMAND_EVENTS_TABLE = "assistant_command_events";
export const COMMAND_MIGRATION = "0081";

export const COMMAND_SETUP_PENDING_MESSAGE = `Setup pending: the assistant's command record is not in the database yet, so nothing was done. The owner applies migration ${COMMAND_MIGRATION} (assistant commands) in the Supabase SQL editor, then commands work.`;

export type CommandEventKind = "started" | "executed" | "failed" | "refused";
export type CommandOrigin = "command" | "click";

export type CommandEventInsert = {
  command_id: string;
  event: CommandEventKind;
  origin: CommandOrigin;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  ability: string;
  subject_table: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  quote: string | null;
  previous: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_note: string | null;
  restores_command_id: string | null;
};

export type InsertEventResult = { ok: true } | { ok: false; setupPending: boolean; message: string };

export async function insertCommandEvent(supabase: SupabaseClient, row: CommandEventInsert): Promise<InsertEventResult> {
  try {
    const { error } = await supabase.from(COMMAND_EVENTS_TABLE).insert(row);
    if (error) {
      if (isMissingRelation(error)) return { ok: false, setupPending: true, message: COMMAND_SETUP_PENDING_MESSAGE };
      console.error(`[assistant] command event insert failed (${row.event} ${row.ability}):`, error.message);
      return { ok: false, setupPending: false, message: "The command could not be recorded." };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[assistant] command event insert threw (${row.event} ${row.ability}):`, err instanceof Error ? err.message : err);
    return { ok: false, setupPending: false, message: "The command could not be recorded." };
  }
}
