"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth";
import { startResearch, retryResearch, runResearch, verifyRunClaims } from "@/app/(dashboard)/prospects/[id]/research-actions";
import type { ResearchDepth, ResearchEvalVerdict, ResearchVerificationStatus } from "@/lib/research";

type ActionResult = { error: string } | { success: true };

// Thin trigger for the admin Research Agent panel -- runs the dark,
// superadmin-only extraction path start-to-finish against a real prospect.
// previousRunId, when given, makes this a real retry (retry_of set,
// version chained) instead of an unrelated first run -- pass the
// prospect's most recent run id whenever one exists.
// Returns rather than throws: Next.js redacts a thrown Server Action
// error's message in production, so a real failure (e.g. the superadmin
// check) would otherwise show the button's caller nothing useful.
export async function triggerResearch(
  prospectId: string,
  previousRunId: string | null,
  // Optional override. Left undefined, depth follows the prospect's pipeline
  // stage; this panel is the evaluation surface, so it can force either depth
  // to compare them on the same prospect.
  depth?: ResearchDepth
): Promise<{ error: string } | { success: true; runId: string }> {
  try {
    const runId = previousRunId ? await retryResearch(prospectId, previousRunId) : await startResearch(prospectId);
    await runResearch(runId, prospectId, depth);
    revalidatePath("/admin/research");
    return { success: true, runId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to run research" };
  }
}

export async function submitClaimReview(
  claimId: string,
  researchRunId: string,
  verdict: ResearchEvalVerdict,
  notes: string
): Promise<ActionResult> {
  try {
    const user = await requireSuperadmin();
    const supabase = createClient();
    const { error } = await supabase.from("research_eval_reviews").insert({
      research_run_id: researchRunId,
      claim_id: claimId,
      verdict,
      reviewed_by: user.id,
      notes: notes.trim() || null,
    });
    if (error) return { error: error.message };
    revalidatePath("/admin/research");
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to save review" };
  }
}

export async function setClaimVerificationStatus(
  claimId: string,
  status: Extract<ResearchVerificationStatus, "human_confirmed" | "human_disputed">
): Promise<ActionResult> {
  try {
    const user = await requireSuperadmin();
    const supabase = createClient();
    const { error } = await supabase
      .from("research_claims")
      .update({ verification_status: status, verified_by: user.id, verified_at: new Date().toISOString() })
      .eq("id", claimId);
    if (error) return { error: error.message };
    revalidatePath("/admin/research");
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update verification status" };
  }
}

// Stage 5 trigger. Returns rather than throws for the same reason
// triggerResearch does: Next.js redacts a thrown Server Action error's
// message in production, and the useful failures here are ones the operator
// needs to read -- above all "this run's entity was never confirmed".
export async function triggerVerification(
  runId: string
): Promise<{ error: string } | { success: true; verified: number; verdicts: Record<string, number> }> {
  try {
    const result = await verifyRunClaims(runId);
    revalidatePath("/admin/research");
    return { success: true, ...result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Verification failed" };
  }
}
