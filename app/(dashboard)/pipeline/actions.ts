"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function moveProspectStage(
  prospectId: string,
  fromStage: string,
  toStage: string,
  note?: string
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: updated, error: updateError } = await supabase
    .from("prospects")
    .update({ stage: toStage, updated_at: new Date().toISOString() })
    .eq("id", prospectId)
    .eq("stage", fromStage)
    .select("id")
    .single();

  if (updateError || !updated) {
    throw new Error("This prospect's stage changed since the page loaded. Refresh and try again.");
  }

  const { error: logError } = await supabase.from("stage_changes").insert({
    prospect_id: prospectId,
    from_stage: fromStage,
    to_stage: toStage,
    changed_by: user.id,
    changed_by_email: user.email,
    note: note || null,
  });

  if (logError) throw new Error(logError.message);

  revalidatePath("/pipeline");
  revalidatePath(`/prospects/${prospectId}`);
}
