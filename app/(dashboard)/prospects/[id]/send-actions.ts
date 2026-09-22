"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { evaluateSendReadiness, buildInteractionSummary, type DraftSendAttempt } from "@/lib/draft-send";
import { sendFunderEmail, isSendConfigured } from "@/lib/send-draft";
import type { Draft } from "@/lib/drafts";

// Ruling 0029 clause 2: the ONE handler that sends funder-facing mail, and
// the ONE importer of lib/send-draft.ts. It takes an approved draft id and
// re-verifies EVERYTHING server-side, at send time, on rows it just read
// through the caller's own session client (so RLS scopes them to the
// caller's org): the draft exists, is an approved intro email, has never
// been sent, has no live or unconfirmed attempt, and the prospect has a
// real contact email. The payload it sends is built by the same
// evaluateSendReadiness the confirmation UI displayed -- exact recipient,
// subject and body, by construction, not by the UI promising to match.
//
// Birth before send (clause 4, the 0067 pattern): the attempt row -- with
// the full payload -- is written BEFORE the provider is called. If that
// insert fails, nothing is sent. This is also what makes the code safe to
// deploy ahead of migration 0069: with no draft_send_attempts table the
// birth insert fails (42P01) and the handler refuses without sending.
//
// Failure paths (clauses 4-5):
//   provider refused  -> the attempt finalizes 'failed', the human sees the
//                        provider's error and may click again on a NEW
//                        confirmation. Never an automatic retry.
//   no response       -> the attempt stays unfinalized. Attempted-
//                        unconfirmed stands; that draft can never be sent
//                        again (the DB's one-live-attempt index enforces
//                        it), because the message may have been delivered.
//
// Errors are returned, not thrown -- Next redacts thrown messages in
// production (see outcome-actions.ts).

export type SendDraftResult = { error: string } | { success: true; warning?: string };

export async function sendApprovedDraft(draftId: string, prospectId: string): Promise<SendDraftResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    // --- Re-verify at send time, server-side, from the database ---------
    const { data: draft, error: draftError } = await supabase
      .from("drafts")
      .select("*")
      .eq("id", draftId)
      .maybeSingle<Draft>();
    if (draftError) return { error: `Could not load the draft, so nothing was sent: ${draftError.message}` };
    if (!draft) return { error: "Draft not found in your organization. Nothing was sent." };
    if (draft.prospect_id !== prospectId) return { error: "That draft belongs to a different prospect. Nothing was sent." };

    const { data: prospect, error: prospectError } = await supabase
      .from("prospects")
      .select("id, contact_email")
      .eq("id", draft.prospect_id)
      .maybeSingle<{ id: string; contact_email: string | null }>();
    if (prospectError || !prospect) return { error: "Could not load the prospect, so nothing was sent." };

    const { data: attempts, error: attemptsError } = await supabase
      .from("draft_send_attempts")
      .select("*")
      .eq("draft_id", draftId)
      .returns<DraftSendAttempt[]>();
    if (attemptsError) {
      // Most likely 42P01: migration 0069 is not applied. The send ledger
      // is a precondition of sending, not an optional extra.
      return { error: `The send ledger is unavailable (is migration 0069 applied?), so nothing was sent: ${attemptsError.message}` };
    }

    const readiness = evaluateSendReadiness(draft, attempts ?? [], prospect.contact_email);
    if (!readiness.ok) return { error: readiness.reason };
    const payload = readiness.payload;

    if (!isSendConfigured()) {
      return { error: "Email sending is not configured on the server (RESEND_API_KEY / RESEND_FROM_EMAIL). Nothing was sent." };
    }

    // --- Birth before send: the attempt row carries the exact payload ---
    const { data: attempt, error: birthError } = await supabase
      .from("draft_send_attempts")
      .insert({
        draft_id: draftId,
        recipient_email: payload.to,
        subject: payload.subject,
        body: payload.body,
        attempted_by: user.id,
      })
      .select("id")
      .single();
    if (birthError || !attempt) {
      if (birthError?.code === "23505") {
        // The one-live-attempt index: another confirmation click got here
        // first. Its outcome, whatever it is, stands.
        return { error: "A send for this draft is already in flight or unresolved. It will not be sent twice." };
      }
      return { error: `Could not record the send attempt, so nothing was sent: ${birthError?.message ?? "unknown error"}` };
    }

    // --- The one provider call ------------------------------------------
    const result = await sendFunderEmail(payload);

    if (result.status === "unconfirmed") {
      // Leave the attempt unfinalized: attempted-unconfirmed stands, and
      // is visible on the draft. Nothing here retries.
      revalidateSendSurfaces(prospectId);
      return {
        error:
          `The email provider never confirmed the send (${result.message}). ` +
          "The message may or may not have been delivered, so this draft is locked against re-sending. " +
          "If it must go out, create a new draft.",
      };
    }

    if (result.status === "refused") {
      const { error: failError } = await supabase
        .from("draft_send_attempts")
        .update({ outcome: "failed", completed_at: new Date().toISOString(), error_note: result.message })
        .eq("id", attempt.id)
        .is("outcome", null);
      revalidateSendSurfaces(prospectId);
      return {
        error:
          `The email provider refused the message, so it was NOT delivered: ${result.message}. ` +
          "You can fix the cause and confirm a new send." +
          (failError ? ` (Also failed to record the refusal: ${failError.message})` : ""),
      };
    }

    // --- Confirmed sent: capture the provider's answer, then log --------
    const warnings: string[] = [];

    const { error: finalizeError } = await supabase
      .from("draft_send_attempts")
      .update({ outcome: "sent", completed_at: new Date().toISOString(), resend_message_id: result.providerMessageId })
      .eq("id", attempt.id)
      .is("outcome", null);
    if (finalizeError) warnings.push(`the attempt record could not be finalized (${finalizeError.message})`);

    const { error: sentError } = await supabase
      .from("drafts")
      .update({ sent_at: new Date().toISOString(), sent_by: user.id, resend_message_id: result.providerMessageId })
      .eq("id", draftId);
    if (sentError) warnings.push(`the draft could not be marked sent (${sentError.message})`);

    // The interaction row is logged automatically, from the SAME payload
    // that was sent -- captured, not retyped (clause 4).
    const { error: interactionError } = await supabase.from("interactions").insert({
      prospect_id: draft.prospect_id,
      kind: "email",
      summary: buildInteractionSummary(payload),
      occurred_at: new Date().toISOString().slice(0, 10),
      created_by: user.id,
    });
    if (interactionError) warnings.push(`the interaction could not be logged (${interactionError.message})`);

    revalidateSendSurfaces(prospectId);
    return warnings.length > 0
      ? { success: true, warning: `The email WAS sent, but ${warnings.join("; ")}.` }
      : { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not send the draft." };
  }
}

function revalidateSendSurfaces(prospectId: string) {
  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/revisit");
}
