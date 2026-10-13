// Restoring what a command replaced (STATE item 92, ruling 0038 clause 5:
// "where a write replaced content, it holds what was replaced" and it can be
// undone).
//
// This is a USER decision, not a command: it runs only from the Restore
// button on a command-result card (the click-driven action in
// app/(dashboard)/assistant/actions.ts), never from a tool call, so the
// model has no way to reach it. It restores DRAFT TEXT only -- the subject
// and text an edit or a revision replaced, read back from the audit record.
//
// Guards, each re-checked here at click time:
//   * the record is the caller's own, an executed command whose ability
//     replaced draft text, with the previous text on its `started` row;
//   * it has not already been restored;
//   * the draft is still a draft, unsent -- an approved draft's text is
//     locked (the entry point refuses too);
//   * the draft is still what the command left. If the text has changed
//     since -- a person edited it again -- restoring would silently destroy
//     that later work, so it is refused and explained.
//
// It records its own audit events (origin 'click'), born before the write.
// The entry point is INJECTED by the click action, so this module imports no
// server action (decide.ts's shape).

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { COMMAND_EVENTS_TABLE, COMMAND_SETUP_PENDING_MESSAGE, insertCommandEvent } from "./audit";
import { isMissingRelation } from "./access";
import { RESTORE_ACTION_NAME } from "./command-defs";
import { draftFingerprint } from "./fingerprint";
import { isRedirectError } from "./redirect";
import { isUuid } from "./validate";

export type UpdateDraftFn = (
  draftId: string,
  prospectId: string,
  subject: string | null,
  content: string
) => Promise<{ ok: true } | { error: string }>;

export type RestoreResult = { ok: true; summary: string; href: string } | { error: string };

const RESTORABLE_ABILITIES = ["edit_draft", "revise_draft_with_feedback"];

type EventRow = {
  command_id: string;
  event: string;
  origin: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  ability: string;
  subject_table: string | null;
  subject_id: string | null;
  previous: { subject?: string | null; content?: string } | null;
  result: { afterFingerprint?: string } | null;
  created_by: string;
  restores_command_id: string | null;
};

export async function restoreCommandPreviousCore(input: {
  supabase: SupabaseClient;
  userId: string;
  commandId: string;
  updateDraft: UpdateDraftFn;
}): Promise<RestoreResult> {
  const { supabase, userId, commandId } = input;
  if (!isUuid(commandId)) return { error: "That action could not be found." };

  const columns =
    "command_id, event, origin, thread_id, user_message_id, assistant_message_id, ability, subject_table, subject_id, previous, result, created_by, restores_command_id";
  const [own, restores] = await Promise.all([
    supabase.from(COMMAND_EVENTS_TABLE).select(columns).eq("command_id", commandId),
    supabase.from(COMMAND_EVENTS_TABLE).select(columns).eq("restores_command_id", commandId),
  ]);
  const error = own.error ?? restores.error;
  if (error) {
    if (isMissingRelation(error)) return { error: COMMAND_SETUP_PENDING_MESSAGE };
    return { error: "The record of that action could not be read just now. Nothing was changed." };
  }
  const rows = [...((own.data ?? []) as unknown as EventRow[]), ...((restores.data ?? []) as unknown as EventRow[])];
  const started = rows.find((r) => r.command_id === commandId && r.event === "started");
  const executed = rows.find((r) => r.command_id === commandId && r.event === "executed");
  if (!started || started.created_by !== userId || started.origin !== "command") return { error: "That action could not be found." };
  if (!executed) return { error: "That action did not complete, so there is nothing to restore." };
  if (!RESTORABLE_ABILITIES.includes(started.ability) || started.subject_table !== "drafts" || !started.subject_id || !started.previous) {
    return { error: "Nothing about that action can be restored." };
  }
  if (rows.some((r) => r.restores_command_id === commandId && r.event === "executed")) {
    return { error: "That draft's text was already restored." };
  }
  const prevContent = started.previous.content;
  if (typeof prevContent !== "string") return { error: "The earlier text was not recorded, so it cannot be restored." };
  const prevSubject = typeof started.previous.subject === "string" ? started.previous.subject : null;

  const { data: draft, error: draftError } = await supabase
    .from("drafts")
    .select("id, prospect_id, kind, status, subject, content, sent_at")
    .eq("id", started.subject_id)
    .maybeSingle();
  if (draftError) return { error: "The draft could not be read just now. Nothing was changed." };
  if (!draft) return { error: "That draft no longer exists, or you cannot see it, so nothing was restored." };
  const d = draft as { id: string; prospect_id: string; kind: string; status: string; subject: string | null; content: string | null; sent_at: string | null };
  const href = `/prospects/${d.prospect_id}`;
  if (d.sent_at) return { error: "That draft has been delivered, so its text is fixed and was not restored." };
  if (d.status !== "draft") return { error: "That draft is approved, so its text is locked. Reopen it for editing first, then restore." };

  // Never silently destroy later work.
  const after = executed.result?.afterFingerprint;
  if (typeof after === "string") {
    const current = draftFingerprint({ kind: d.kind, subject: d.subject, content: d.content });
    if (current !== after) {
      return { error: "That draft has been changed again since the assistant changed it, so restoring would overwrite that later work. Nothing was changed." };
    }
  }

  const newCommandId = randomUUID();
  const common = {
    command_id: newCommandId,
    origin: "click" as const,
    thread_id: started.thread_id,
    user_message_id: started.user_message_id,
    assistant_message_id: started.assistant_message_id,
    ability: RESTORE_ACTION_NAME,
    subject_table: "drafts",
    subject_id: d.id,
    quote: null,
    restores_command_id: commandId,
  };
  const born = await insertCommandEvent(supabase, {
    ...common,
    event: "started",
    payload: { draft_id: d.id, restores: commandId },
    // What this restore is about to replace, so it too can be reversed by hand.
    previous: { subject: d.subject, content: d.content ?? "" },
    result: null,
    error_note: null,
  });
  if (!born.ok) return { error: born.setupPending ? COMMAND_SETUP_PENDING_MESSAGE : "That could not be recorded, so nothing was changed." };

  let res: { ok: true } | { error: string };
  try {
    res = await input.updateDraft(d.id, d.prospect_id, d.kind === "intro_email" ? prevSubject : null, prevContent);
  } catch (err) {
    res = { error: isRedirectError(err) ? "Your session is no longer signed in. Sign in and try again." : err instanceof Error && err.message ? err.message : "The text could not be restored." };
  }
  if ("error" in res) {
    await insertCommandEvent(supabase, { ...common, event: "failed", payload: { draft_id: d.id, restores: commandId }, previous: null, result: null, error_note: res.error.slice(0, 1000) });
    return { error: res.error };
  }
  await insertCommandEvent(supabase, { ...common, event: "executed", payload: { draft_id: d.id, restores: commandId }, previous: null, result: { draftId: d.id }, error_note: null });
  return { ok: true, summary: "Restored the draft's earlier text.", href };
}
