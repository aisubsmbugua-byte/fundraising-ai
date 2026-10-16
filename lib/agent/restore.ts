// Restoring draft text an agent replaced (STATE item 98, ruling 0039 clause 4:
// "text a write replaced can be restored by the user's click").
//
// A USER decision, not an agent call: it runs only from the Restore button on
// the Connect Muse page's call list (app/(dashboard)/settings/connections/
// actions.ts), never from a tool. It reuses nothing from the assistant's
// restore.ts because that one reads the assistant's own thread-bound record;
// this one reads agent_call_log, but keeps every one of its guards:
//
//   * the call is the caller's own, an agent edit_draft that executed, with the
//     previous text on its `started` row;
//   * it has not already been restored;
//   * the draft is still a draft, unsent -- an approved draft's text is locked;
//   * the draft is still exactly what the agent left (its fingerprint equals
//     the one recorded at the terminal row). If anyone edited it since,
//     restoring would silently destroy that later work, so it is refused.
//
// The restore records itself as a user_click, born before the write. The entry
// point (updateDraft) is injected so this module imports no server action.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { draftFingerprint } from "@/lib/assistant/fingerprint";
import { isRedirectError } from "@/lib/assistant/redirect";
import { isUuid } from "@/lib/assistant/validate";
import { AGENT_LOG_TABLE, insertAgentEvent, stopwatch } from "./log";
import { AGENT_SETUP_PENDING_MESSAGE, isSetupPending } from "./setup";

export type UpdateDraftFn = (
  draftId: string,
  prospectId: string,
  subject: string | null,
  content: string
) => Promise<{ ok: true } | { error: string }>;

export type RestoreResult = { ok: true; summary: string; href: string } | { error: string };

type Row = {
  call_id: string;
  token_id: string;
  event: string;
  origin: string;
  tool: string;
  subject_table: string | null;
  subject_id: string | null;
  previous: { subject?: string | null; content?: string } | null;
  result: { afterFingerprint?: string } | null;
  user_id: string;
  restores_call_id: string | null;
};

export async function restoreAgentEditCore(input: {
  supabase: SupabaseClient;
  userId: string;
  callId: string;
  updateDraft: UpdateDraftFn;
  log?: typeof insertAgentEvent;
}): Promise<RestoreResult> {
  const { supabase, userId, callId } = input;
  const log = input.log ?? insertAgentEvent;
  const elapsed = stopwatch();
  if (!isUuid(callId)) return { error: "That call could not be found." };

  const columns = "call_id, token_id, event, origin, tool, subject_table, subject_id, previous, result, user_id, restores_call_id";
  const [own, restores] = await Promise.all([
    supabase.from(AGENT_LOG_TABLE).select(columns).eq("call_id", callId),
    supabase.from(AGENT_LOG_TABLE).select(columns).eq("restores_call_id", callId),
  ]);
  const error = own.error ?? restores.error;
  if (error) {
    if (isSetupPending(error)) return { error: AGENT_SETUP_PENDING_MESSAGE };
    return { error: "The record of that call could not be read just now. Nothing was changed." };
  }
  const rows = [...((own.data ?? []) as unknown as Row[]), ...((restores.data ?? []) as unknown as Row[])];
  const started = rows.find((r) => r.call_id === callId && r.event === "started");
  const executed = rows.find((r) => r.call_id === callId && r.event === "executed");
  if (!started || started.user_id !== userId || started.origin !== "agent") return { error: "That call could not be found." };
  if (!executed) return { error: "That call did not complete, so there is nothing to restore." };
  if (started.tool !== "edit_draft" || started.subject_table !== "drafts" || !started.subject_id || !started.previous) {
    return { error: "Nothing about that call can be restored." };
  }
  if (rows.some((r) => r.restores_call_id === callId && r.event === "executed")) return { error: "That draft's text was already restored." };
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
  if (typeof after !== "string") return { error: "What the agent left was not recorded, so restoring cannot be checked safely. Nothing was changed." };
  if (draftFingerprint({ kind: d.kind, subject: d.subject, content: d.content }) !== after) {
    return { error: "That draft has been changed again since the agent changed it, so restoring would overwrite that later work. Nothing was changed." };
  }

  const common = {
    call_id: randomUUID(),
    token_id: started.token_id,
    origin: "user_click" as const,
    access: "write" as const,
    tool: "restore_draft_text",
    subject_table: "drafts",
    subject_id: d.id,
    agent_statement: null,
    restores_call_id: callId,
  };
  const payload = { draft_id: d.id, restores: callId };
  const born = await log(supabase, {
    ...common,
    event: "started",
    arguments: payload,
    // What this restore is about to replace, so it too can be reversed by hand.
    previous: { subject: d.subject, content: d.content ?? "" },
    result: null,
    error_note: null,
    duration_ms: null,
  });
  if (!born.ok) return { error: born.setupPending ? AGENT_SETUP_PENDING_MESSAGE : "That could not be recorded, so nothing was changed." };

  let res: { ok: true } | { error: string };
  try {
    res = await input.updateDraft(d.id, d.prospect_id, d.kind === "intro_email" ? prevSubject : null, prevContent);
  } catch (err) {
    res = { error: isRedirectError(err) ? "Your session is no longer signed in. Sign in and try again." : err instanceof Error && err.message ? err.message : "The text could not be restored." };
  }
  if ("error" in res) {
    await log(supabase, { ...common, event: "failed", arguments: payload, previous: null, result: null, error_note: res.error.slice(0, 1000), duration_ms: elapsed() });
    return { error: res.error };
  }
  await log(supabase, { ...common, event: "executed", arguments: payload, previous: null, result: { draftId: d.id }, error_note: null, duration_ms: elapsed() });
  return { ok: true, summary: "Restored the draft's earlier text.", href };
}
