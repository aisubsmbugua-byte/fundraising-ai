"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { EvidencePermission, EvidenceType } from "@/lib/evidence";

export async function createEvidenceItem(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("evidence_items").insert({
    title: formData.get("title") as string,
    description: formData.get("description") as string,
    type: formData.get("type") as EvidenceType,
    program: (formData.get("program") as string) || null,
    geography: (formData.get("geography") as string) || null,
    source_document_id: (formData.get("source_document_id") as string) || null,
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/evidence");
}

export async function updateEvidenceItem(id: string, formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("evidence_items")
    .update({
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      type: formData.get("type") as EvidenceType,
      program: (formData.get("program") as string) || null,
      geography: (formData.get("geography") as string) || null,
      source_document_id: (formData.get("source_document_id") as string) || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/evidence");
}

// Sets verified_at/verified_by/permission together in one step --
// permission is meaningless before an item has actually been reviewed,
// and 'approved' is what gates entry into an AI prompt (see
// strategy-actions.ts), so this is the one action that opens that
// gate, not a silent default.
export async function verifyEvidenceItem(id: string, permission: EvidencePermission) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("evidence_items")
    .update({
      permission,
      verified_at: new Date().toISOString(),
      verified_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/evidence");
}

export async function deleteEvidenceItem(id: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("evidence_items").delete().eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/evidence");
}
