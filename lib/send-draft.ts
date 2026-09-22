// Server-only. Never import this into a client component -- RESEND_API_KEY
// must never reach the client bundle (hard rule 5).
//
// Ruling 0029 clause 1: this is the ONLY module in app/ or lib/ that calls
// the mail provider for anything funder-facing, and it has exactly ONE
// importer -- the confirmed-send handler in
// app/(dashboard)/prospects/[id]/send-actions.ts. The closed-set scan in
// scripts/test-send-draft.ts fails the suite the day a second provider
// call or a second importer appears. The teammate-invite path
// (lib/invite.ts) goes through Supabase Auth's own inviteUserByEmail and
// does not touch Resend or this module -- inviting a teammate is not
// funder-facing.
//
// One call, one message, one recipient (clause 5). There is no retry here,
// no batching parameter, no list of recipients, and no way to call this
// without a payload the human just confirmed -- the handler is the only
// importer and it only runs on that confirmation.

import { Resend } from "resend";
import type { SendPayload } from "@/lib/draft-send";

// The three provider answers the handler distinguishes (ruling 0029
// clauses 4-5), each with a different consequence for the attempt row the
// handler birthed BEFORE calling this:
//
//   sent        -- the provider confirmed and returned a message id. The id
//                  is CAPTURED from the response, never invented. The
//                  attempt finalizes 'sent'.
//   refused     -- the provider answered with an error, so the message was
//                  NOT delivered. The attempt finalizes 'failed'; the human
//                  may click again on a NEW confirmation.
//   unconfirmed -- no readable response ever arrived (network failure,
//                  timeout, or a success with no id to capture). The
//                  message MAY have been delivered, so the attempt stays
//                  unfinalized -- attempted-unconfirmed stands, and that
//                  draft can never be sent again.
export type SendOutcome =
  | { status: "sent"; providerMessageId: string }
  | { status: "refused"; message: string }
  | { status: "unconfirmed"; message: string };

// Checked by the handler BEFORE it births an attempt row: with no
// configuration there will be no request, so nothing should enter the
// attempt ledger.
export function isSendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY) && Boolean(process.env.RESEND_FROM_EMAIL);
}

// The platform address, for the handler to feed into evaluateSendReadiness
// as SenderIdentity.fromAddress. Address only, not a secret -- but reading
// it here keeps the handler out of the env entirely. The email PRESENTS as
// the organization ("{org name}" <this address>, built in
// evaluateSendReadiness); no user identity is hardwired (STATE item 57).
export function platformFromAddress(): string | null {
  return process.env.RESEND_FROM_EMAIL?.trim() || null;
}

export async function sendFunderEmail(payload: SendPayload): Promise<SendOutcome> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // No request was made, so "refused" is accurate: definitely not sent.
    return {
      status: "refused",
      message: "Email sending is not configured (RESEND_API_KEY). Nothing was sent.",
    };
  }

  const resend = new Resend(apiKey);
  try {
    // from and replyTo come from the SAME payload the confirmation
    // displayed and the attempt row captured -- nothing is assembled here.
    const { data, error } = await resend.emails.send({
      from: payload.from,
      replyTo: payload.replyTo,
      to: payload.to,
      subject: payload.subject,
      text: payload.body,
    });
    if (error) {
      return { status: "refused", message: error.message || String(error.name ?? "provider error") };
    }
    if (!data?.id) {
      // The provider claimed success but handed back no id to capture.
      // Clause 4 forbids asserting a sent fact we cannot attribute to the
      // provider's own response, so this stands as unconfirmed.
      return { status: "unconfirmed", message: "The provider reported success but returned no message id to capture." };
    }
    return { status: "sent", providerMessageId: data.id };
  } catch (err) {
    // The request may or may not have reached the provider before dying.
    // Never assume undelivered, never retry (clauses 4-5).
    return {
      status: "unconfirmed",
      message: err instanceof Error ? err.message : "No response from the email provider.",
    };
  }
}
