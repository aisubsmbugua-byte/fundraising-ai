"use server";

import { revalidatePath } from "next/cache";
import { startResearch, runResearch } from "@/app/(dashboard)/prospects/[id]/research-actions";

// Thin trigger for the admin Research Agent panel -- runs the dark,
// superadmin-only extraction path start-to-finish against a real prospect.
// Returns rather than throws: Next.js redacts a thrown Server Action
// error's message in production, so a real failure (e.g. the superadmin
// check) would otherwise show the button's caller nothing useful.
export async function triggerResearch(prospectId: string): Promise<{ error: string } | { success: true; runId: string }> {
  try {
    const runId = await startResearch(prospectId);
    await runResearch(runId, prospectId);
    revalidatePath("/admin/research");
    return { success: true, runId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to run research" };
  }
}
