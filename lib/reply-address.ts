// Rulings 0042/0043 / STATE item 106: writing the per-person reply address. Pure
// apart from the injected client, so scripts/test-reply-address.ts can run it
// against a fake that models how Supabase Auth merges user_metadata.
//
// The choice is stored on the person's OWN auth user metadata under one key
// (REPLY_TO_METADATA_KEY), written through the SESSION client's
// auth.updateUser -- never an admin or service-role client, never a table.
//
// How updateUser treats metadata (read in supabase/auth's
// internal/models/user.go, UpdateUserMetaData; the installed supabase-js only
// PUTs { data } to /user and does no merging itself): the keys in `data` are
// merged into the existing user_metadata one at a time at the TOP level, a key
// whose value is null is DELETED, and keys not mentioned are left alone. So
// writing { reply_to_email: "x" } never touches the person's other metadata,
// and { reply_to_email: null } removes only this key -- which is exactly
// "clear it, back to the sign-in address". Each call below therefore sends
// exactly ONE key and nothing else.
//
// Errors are returned, never thrown (Next redacts a thrown message in a
// production build).

import { isPlausibleChosenReplyAddress, REPLY_TO_METADATA_KEY } from "@/lib/draft-send";

export type ReplyAddressResult = { error: string } | { ok: true; address: string | null };

// The slice of the Supabase client these functions use. The real client's
// auth.updateUser satisfies it.
export type ReplyAddressClient = {
  auth: {
    updateUser(attributes: { data: Record<string, string | null> }): Promise<{ error: { message: string } | null }>;
  };
};

export const REPLY_ADDRESS_INVALID_MESSAGE =
  "That does not look like a single email address. Enter one address, like name@yourorganization.org.";

export async function saveReplyAddressCore(args: {
  supabase: ReplyAddressClient;
  input: unknown;
}): Promise<ReplyAddressResult> {
  try {
    if (typeof args.input !== "string" || args.input.trim() === "") {
      return { error: "Enter the email address replies should go to, or use your sign-in address instead." };
    }
    const address = args.input.trim();
    if (!isPlausibleChosenReplyAddress(address)) return { error: REPLY_ADDRESS_INVALID_MESSAGE };
    // Ruling 0043: no exclusion for the platform's sending address. A person
    // may write from and reply to the same mailbox, so this file neither knows
    // nor reads the sending address.

    const { error } = await args.supabase.auth.updateUser({ data: { [REPLY_TO_METADATA_KEY]: address } });
    if (error) return { error: `Could not save your reply address: ${error.message}` };
    return { ok: true, address };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save your reply address." };
  }
}

export async function clearReplyAddressCore(args: { supabase: ReplyAddressClient }): Promise<ReplyAddressResult> {
  try {
    const { error } = await args.supabase.auth.updateUser({ data: { [REPLY_TO_METADATA_KEY]: null } });
    if (error) return { error: `Could not clear your reply address: ${error.message}` };
    return { ok: true, address: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not clear your reply address." };
  }
}
