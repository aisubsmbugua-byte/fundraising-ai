"use server";

// Deciding an approval link (STATE item 98, ruling 0039 clause 3).
//
// approveFromLink is the ONLY caller of lib/agent/approve-exec.ts and of
// lib/agent/approve-entrypoints.ts anywhere in the codebase, and it runs only
// as the direct result of the signed-in owner clicking Approve on the approval
// page (approve-button.tsx in this folder). An agent's call has no path here.
// The sequence of checks and the order of consume-then-record-then-effect live
// in lib/agent/approve-exec.ts, where they are exercised offline.
//
// Returns its failure rather than throwing it -- Next redacts a thrown message
// in a production build.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { approveFromRequestCore, type ApproveResult } from "@/lib/agent/approve-exec";
import { loadApprovalEntryPoints } from "@/lib/agent/approve-entrypoints";
import { isUuid } from "@/lib/assistant/validate";

export async function approveFromLink(requestId: string): Promise<ApproveResult> {
  try {
    if (!isUuid(requestId)) return { error: "That approval link could not be found." };
    const user = await requireUser();
    const supabase = createClient();
    const result = await approveFromRequestCore({
      supabase,
      userId: user.id,
      requestId,
      now: new Date(),
      loadEntryPoints: loadApprovalEntryPoints,
    });
    revalidatePath(`/approve/${requestId}`);
    revalidatePath("/settings/connections");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "That could not be approved." };
  }
}
