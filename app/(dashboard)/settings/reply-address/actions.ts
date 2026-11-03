"use server";

// STATE item 106, rulings 0042/0043: set or clear the signed-in person's own reply
// address. Runs as the signed-in user through their own cookie client
// (auth.updateUser on the SESSION -- no admin or service-role client exists in
// this file), writes only the one metadata key, and returns its failure rather
// than throwing it (Next redacts a thrown message in a production build). The
// work is in lib/reply-address.ts so it can be tested against a fake.
//
// Ruling 0043: nothing here reads the platform's sending address -- a choice
// equal to it is valid (writing from and replying to the same mailbox).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { saveReplyAddressCore, clearReplyAddressCore, type ReplyAddressResult } from "@/lib/reply-address";

export async function saveReplyAddress(address: string): Promise<ReplyAddressResult> {
  try {
    await requireUser();
    const supabase = createClient();
    const result = await saveReplyAddressCore({ supabase, input: address });
    revalidatePath("/settings/reply-address");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save your reply address." };
  }
}

export async function clearReplyAddress(): Promise<ReplyAddressResult> {
  try {
    await requireUser();
    const supabase = createClient();
    const result = await clearReplyAddressCore({ supabase });
    revalidatePath("/settings/reply-address");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not clear your reply address." };
  }
}
