"use server";

// Connect Muse: making and revoking a token, and restoring text an agent
// replaced (STATE item 98, ruling 0039). All three run as the signed-in user
// through their own cookie client; this page is the only place a token can be
// made. Each returns its failure rather than throwing it (Next redacts a thrown
// message in a production build).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { createTokenCore, revokeTokenCore, type CreateTokenResult } from "@/lib/agent/tokens-admin";
import { restoreAgentEditCore, type RestoreResult } from "@/lib/agent/restore";
import { updateDraft } from "@/app/(dashboard)/prospects/[id]/draft-actions";
import { isUuid } from "@/lib/assistant/validate";

export async function createAgentToken(input: { name: string; scope: string; days: number }): Promise<CreateTokenResult> {
  try {
    await requireUser();
    const supabase = createClient();
    const result = await createTokenCore({ supabase, name: input.name, scope: input.scope, days: input.days });
    revalidatePath("/settings/connections");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The token could not be created." };
  }
}

export async function revokeAgentToken(tokenId: string): Promise<{ ok: true } | { error: string }> {
  try {
    await requireUser();
    const supabase = createClient();
    const result = await revokeTokenCore({ supabase, tokenId });
    revalidatePath("/settings/connections");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The token could not be revoked." };
  }
}

export async function restoreAgentEdit(callId: string): Promise<RestoreResult> {
  try {
    if (!isUuid(callId)) return { error: "That call could not be found." };
    const user = await requireUser();
    const supabase = createClient();
    const result = await restoreAgentEditCore({ supabase, userId: user.id, callId, updateDraft });
    revalidatePath("/settings/connections");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not restore that text." };
  }
}
