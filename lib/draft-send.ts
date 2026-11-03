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
  // Where a funder's reply goes: the address the human who clicked send
  // chose for themselves, or their account email (ruling 0042). Always from
  // resolveReplyTo below; never the platform address.
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
// send module are the only readers), replyToAddress from resolveReplyTo
// (ruling 0042) -- the ONE function both call sites run on the authenticated
// session's user. Neither call site hands the account email to this type.
export type SenderIdentity = {
  orgName: string | null | undefined;
  fromAddress: string | null | undefined;
  replyToAddress: string | null | undefined;
};

// Ruling 0042 / STATE item 106. The key on the person's OWN auth user
// metadata (auth.users.raw_user_meta_data, read as user.user_metadata) that
// holds the address they chose for funders' replies. Stored with the person,
// not the organization: another person's choice never changes whose replies
// go where.
export const REPLY_TO_METADATA_KEY = "reply_to_email";

export type ReplyToSource = "chosen" | "account";
export type ResolvedReplyTo = {
  // null only when there is no usable address at all (no chosen address and
  // no account email); evaluateSendReadiness then refuses with
  // no_sender_email, exactly as it did before this choice existed.
  address: string | null;
  source: ReplyToSource;
};

// The shape a CHOSEN reply address must have. It is the file's EMAIL_SHAPE
// (ruling 0042 clause 2, kept by 0043: "checked for shape") plus three
// narrowings that only apply to a value a person typed, because EMAIL_SHAPE
// alone would let "a@b.org,c@d.org" through as one string: exactly one
// address (no comma, semicolon, angle bracket or quote, and exactly one @),
// and a length a mail header can carry. Used by resolveReplyTo (read side)
// AND by the settings action (write side), so the two cannot disagree about
// what is acceptable. The platform cannot verify the person controls it.
export function isPlausibleChosenReplyAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 254) return false;
  if (!EMAIL_SHAPE.test(v)) return false;
  if (/[,;<>"]/.test(v)) return false;
  if (v.split("@").length !== 2) return false;
  return true;
}

// Rulings 0042/0043 clause 3: the ONE function that turns the authenticated
// user into the reply address. The prospect page (building the confirmation)
// and the send handler BOTH call it, on the same user object, so the address
// the person reads is the address that is sent -- by construction, not by two
// call sites agreeing. Pure: no env, no database.
//
//   chosen  -- metadata[reply_to_email] is a string that passes
//              isPlausibleChosenReplyAddress. It is used as typed (trimmed).
//   account -- everything else: unset, empty, not a string, or implausible.
//              The fallback is the account email, trimmed; null if none.
//
// There is deliberately NO exclusion for the platform's sending address, and
// the function takes no from-address at all (ruling 0043, superseding the
// exclusion in 0042): an organization may send as one of its own people's real
// mailboxes, so a chosen reply address equal to the sending address is the
// valid arrangement of writing from and replying to the same mailbox. Refusing
// or substituting it would silently send that person's funders' replies to
// their sign-in address, the opposite of their choice. The protection the
// exclusion aimed at comes from the address only ever being the person's own
// (never one the platform supplies) and from the confirmation showing it
// before every send. Nothing is deleted or rewritten here -- a bad stored
// value is simply not used.
export function resolveReplyTo(input: {
  accountEmail: string | null | undefined;
  metadata: unknown;
}): ResolvedReplyTo {
  const md = input.metadata;
  const raw =
    md !== null && typeof md === "object" && !Array.isArray(md)
      ? (md as Record<string, unknown>)[REPLY_TO_METADATA_KEY]
      : undefined;
  if (isPlausibleChosenReplyAddress(raw)) {
    return { address: raw.trim(), source: "chosen" };
  }
  const account = typeof input.accountEmail === "string" ? input.accountEmail.trim() : "";
  return { address: account || null, source: "account" };
}

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
  const replyTo = (sender.replyToAddress ?? "").trim();
  if (!replyTo || !EMAIL_SHAPE.test(replyTo)) {
    return {
      ok: false,
      code: "no_sender_email",
      reason:
        "Your signed-in account has no email address, so a funder's reply would have nowhere to go. " +
        "Fix your account's email, or choose a reply address under Settings, then come back to send.",
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
