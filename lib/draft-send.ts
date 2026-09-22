// Ruling 0029, the construction half of "the confirmation shows the exact
// recipient, subject and body that will be sent": ONE pure function builds
// the send payload, and BOTH the confirmation UI (draft-panel.tsx) and the
// send handler (send-actions.ts) call it on the same stored rows. The two
// can't drift because neither assembles a payload of its own.
//
// This module is pure and secret-free -- safe to import from client
// components. The provider call lives in lib/send-draft.ts (server-only)
// and nowhere else.

import type { Draft } from "@/lib/drafts";

export type SendPayload = {
  to: string;
  subject: string;
  body: string;
};

// Mirrors draft_send_attempts (migration 0069). outcome null is
// attempted-unconfirmed -- the provider's response never arrived, the
// message may or may not have been delivered, and the system never
// re-sends (ruling 0029 clauses 4-5).
export type DraftSendAttempt = {
  id: string;
  draft_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  attempted_by: string;
  attempted_at: string;
  outcome: "sent" | "failed" | null;
  completed_at: string | null;
  error_note: string | null;
  resend_message_id: string | null;
  organization_id: string;
};

export type SendReadiness =
  | { ok: true; payload: SendPayload }
  | { ok: false; code: SendBlockCode; reason: string };

export type SendBlockCode =
  | "not_email"
  | "not_approved"
  | "already_sent"
  | "attempt_unconfirmed"
  | "no_recipient"
  | "empty_subject"
  | "empty_body";

// Deliberately loose: the point is catching "there is no address here at
// all" (blank, a name, a note), not RFC validation -- Resend rejects a
// malformed address itself, and that refusal is recorded as a failed
// attempt the human sees.
const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;

type SendableDraftFields = Pick<Draft, "kind" | "subject" | "content" | "status"> & {
  // Present once migration 0069 is applied; undefined before it. Both mean
  // the same thing here: no confirmed send on record.
  sent_at?: string | null;
};

// The single evaluation the send path trusts. The UI calls it to decide
// whether Send is offered and what the confirmation displays; the handler
// calls it again server-side, at send time, on rows it just re-read
// (ruling 0029 clause 2). Order matters: facts about the draft first, then
// the send history, then the recipient -- the reason shown is the first
// thing the human must fix.
export function evaluateSendReadiness(
  draft: SendableDraftFields,
  attempts: DraftSendAttempt[],
  contactEmail: string | null | undefined
): SendReadiness {
  if (draft.kind !== "intro_email") {
    return { ok: false, code: "not_email", reason: "Only an email draft can be sent. Call prep notes are for a human-led call." };
  }
  if (draft.status !== "approved") {
    return { ok: false, code: "not_approved", reason: "Only an approved draft can be sent. Approve it first." };
  }
  if (draft.sent_at) {
    return { ok: false, code: "already_sent", reason: "This draft has already been sent. Sending again requires a new draft." };
  }
  if (attempts.some((a) => a.outcome === "sent")) {
    return { ok: false, code: "already_sent", reason: "This draft has already been sent. Sending again requires a new draft." };
  }
  if (attempts.some((a) => a.outcome === null)) {
    return {
      ok: false,
      code: "attempt_unconfirmed",
      reason:
        "A send was attempted and the provider never confirmed the outcome -- the email may or may not have been delivered. " +
        "The system will not risk sending it twice: if it needs to go out, create a new draft.",
    };
  }
  const to = (contactEmail ?? "").trim();
  if (!to || !EMAIL_SHAPE.test(to)) {
    return {
      ok: false,
      code: "no_recipient",
      reason: "This prospect has no contact email. Add one on the Contacts tab (or edit the prospect), then come back to send.",
    };
  }
  const subject = (draft.subject ?? "").trim();
  if (!subject) {
    return { ok: false, code: "empty_subject", reason: "The draft has no subject line. Add one before sending." };
  }
  const body = draft.content.trim();
  if (!body) {
    return { ok: false, code: "empty_body", reason: "The draft has no body. There is nothing to send." };
  }
  return { ok: true, payload: { to, subject, body } };
}

// The interaction row is logged from the SAME payload that was sent
// (ruling 0029 clause 4: captured, not retyped). This is the only place
// that turns a payload into an interaction summary.
export function buildInteractionSummary(payload: SendPayload): string {
  return `Sent "${payload.subject}" to ${payload.to}`;
}
