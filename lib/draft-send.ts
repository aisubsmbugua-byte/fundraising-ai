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
  // The full RFC-style from identity: `"{org display name}" <platform address>`.
  // The email presents as the ORGANIZATION -- the display name is captured
  // from the org's own profile record, never typed here, and the address is
  // platform infrastructure (RESEND_FROM_EMAIL). No user identity is
  // hardwired anywhere in the send path (STATE item 57).
  from: string;
  // The authenticated human who clicked send. A funder's reply goes to that
  // person, never to the platform address.
  replyTo: string;
  to: string;
  subject: string;
  body: string;
};

// The three identity facts evaluateSendReadiness needs to build `from` and
// `replyTo`. Both call sites source them the same way, which is what keeps
// confirmation payload = send payload true for the new fields (ruling 0029
// clause 2): orgName from the caller's org_profile row (RLS-scoped),
// fromAddress from RESEND_FROM_EMAIL (server-side only -- the page and the
// send module are the only readers), userEmail from the authenticated
// session's user.
export type SenderIdentity = {
  orgName: string | null | undefined;
  fromAddress: string | null | undefined;
  userEmail: string | null | undefined;
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
  | "empty_body"
  | "no_org_name"
  | "send_not_configured"
  | "no_sender_email"
  | "sending_not_enabled";

export const SENDING_NOT_ENABLED_MESSAGE =
  "Sending is not switched on for your organization yet. It is switched on per organization by the platform owner.";

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
// the send history, then the recipient, then the sender identity -- the
// reason shown is the first thing the human must fix.
export function evaluateSendReadiness(
  draft: SendableDraftFields,
  attempts: DraftSendAttempt[],
  contactEmail: string | null | undefined,
  sender: SenderIdentity,
  // Ruling 0032: the per-organization enablement fact, read by the caller
  // from org_sending_enablement. FAIL CLOSED: only an explicit `true`
  // enables sending -- null, undefined, or anything else (a missing row, an
  // unreadable or not-yet-created table) is "not enabled". Required, so a
  // caller that forgets to pass it does not compile.
  sendingEnabled: boolean | null | undefined
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
  // Ruling 0032 clause 3: refuse in plain words BEFORE any attempt is born.
  // The database refuses the attempt birth too (migration 0076); this is the
  // earlier, explained refusal.
  if (sendingEnabled !== true) {
    return { ok: false, code: "sending_not_enabled", reason: SENDING_NOT_ENABLED_MESSAGE };
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
  // Sender identity (STATE item 57). Each missing fact refuses with what to
  // fix -- never a silent fall back to a bare platform identity.
  // The display name is the org's own record, normalized only as far as a
  // mail header requires: quotes would end the quoted-string early and a
  // newline would start a new header, so both are replaced, nothing else is.
  const orgName = (sender.orgName ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim();
  if (!orgName) {
    return {
      ok: false,
      code: "no_org_name",
      reason:
        "Your organization profile has no name, so the email cannot say who it is from. " +
        "Add your organization's name on the Organization page, then come back to send.",
    };
  }
  const fromAddress = (sender.fromAddress ?? "").trim();
  if (!fromAddress || !EMAIL_SHAPE.test(fromAddress)) {
    return {
      ok: false,
      code: "send_not_configured",
      reason: "Email sending is not configured on the server (RESEND_FROM_EMAIL). Nothing can be sent until it is.",
    };
  }
  const replyTo = (sender.userEmail ?? "").trim();
  if (!replyTo || !EMAIL_SHAPE.test(replyTo)) {
    return {
      ok: false,
      code: "no_sender_email",
      reason:
        "Your signed-in account has no email address, so a funder's reply would have nowhere to go. " +
        "Fix your account's email, then come back to send.",
    };
  }
  const from = `"${orgName}" <${fromAddress}>`;
  return { ok: true, payload: { from, replyTo, to, subject, body } };
}

// The interaction row is logged from the SAME payload that was sent
// (ruling 0029 clause 4: captured, not retyped). This is the only place
// that turns a payload into an interaction summary.
export function buildInteractionSummary(payload: SendPayload): string {
  return `Sent "${payload.subject}" to ${payload.to}`;
}
