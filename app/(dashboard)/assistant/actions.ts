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
// restoreCommandPrevious (STATE item 92, ruling 0038 clause 5) is likewise a
// USER decision -- the Restore button on a command-result card -- and not a
// command: the model has no tool that reaches it. It puts back the text a
// draft edit or revision replaced; the guards live in lib/assistant/restore.ts
// and the one entry point it calls (updateDraft, the same function the page's
// editor uses) is injected from here.
//
// Every action RETURNS its failure rather than throw it -- Next redacts a
// thrown message in a production build (see network-actions.ts).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { resolveAssistantAccess } from "@/lib/assistant/access";
import { executeProposal } from "@/lib/assistant/executors";
import { restoreCommandPreviousCore, type RestoreResult } from "@/lib/assistant/restore";
import { updateDraft } from "@/app/(dashboard)/prospects/[id]/draft-actions";
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

export async function restoreCommandPrevious(commandId: string): Promise<RestoreResult> {
  try {
    if (!isUuid(commandId)) return { error: "That action could not be found." };
    const user = await requireUser();
    const supabase = createClient();
    const access = await resolveAssistantAccess(supabase, user.id);
    if (!access.enabled) return { error: "The assistant is not switched on for your organization." };
    const result = await restoreCommandPreviousCore({ supabase, userId: user.id, commandId, updateDraft });
    revalidatePath("/assistant");
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not restore that text." };
  }
}
