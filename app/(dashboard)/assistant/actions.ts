"use server";

// Approving or dismissing an assistant proposal (STATE item 87, ruling 0037
// clause 2).
//
// approveProposal is the ONLY caller of lib/assistant/executors.ts anywhere in
// the codebase, and it runs only as the direct result of the user clicking
// Approve on a rendered proposal (assistant-thread.tsx in this folder). A
// model's tool call has no path here: the assistant's registry holds propose_
// entries that insert a pending row, and nothing that reaches this file.
//
// The sequence of checks (signed in, the user's own, enabled, pending,
// unexpired, claimed exactly once, subject still there, not stale, then the
// existing entry point with exactly the stored payload) lives in
// lib/assistant/decide.ts, where it is exercised offline; the executor is
// injected from HERE so that this file is the sole importer of executors.ts.
//
// Both actions RETURN their failure rather than throw it -- Next redacts a
// thrown message in a production build (see network-actions.ts).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { resolveAssistantAccess } from "@/lib/assistant/access";
import { executeProposal } from "@/lib/assistant/executors";
import { approveProposalCore, dismissProposalCore, type DecideResult } from "@/lib/assistant/decide";
import { isUuid } from "@/lib/assistant/validate";

const NOT_FOUND = "That proposal could not be found.";

export async function approveProposal(proposalId: string): Promise<DecideResult> {
  try {
    if (!isUuid(proposalId)) return { error: NOT_FOUND };
    const user = await requireUser();
    const supabase = createClient();
    const access = await resolveAssistantAccess(supabase, user.id);
    const result = await approveProposalCore({
      supabase,
      userId: user.id,
      proposalId,
      enabled: access.enabled,
      now: new Date(),
      execute: executeProposal,
    });
    revalidatePath("/assistant");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not approve that proposal." };
  }
}

export async function dismissProposal(proposalId: string): Promise<DecideResult> {
  try {
    if (!isUuid(proposalId)) return { error: NOT_FOUND };
    const user = await requireUser();
    const supabase = createClient();
    const result = await dismissProposalCore({ supabase, userId: user.id, proposalId, now: new Date() });
    revalidatePath("/assistant");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not dismiss that proposal." };
  }
}
