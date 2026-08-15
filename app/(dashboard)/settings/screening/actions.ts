"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { Criterion } from "@/lib/screening";

function ruleFromForm(formData: FormData) {
  const criterion: Criterion = {
    field: formData.get("field") as Criterion["field"],
    operator: formData.get("operator") as Criterion["operator"],
    value: (formData.get("value") as string) || undefined,
  };

  return {
    label: formData.get("label") as string,
    description: (formData.get("description") as string) || null,
    channel: (formData.get("channel") as string) || null,
    weight: Number(formData.get("weight") ?? 1),
    criterion,
    active: formData.get("active") === "on",
  };
}

export async function createRule(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("screening_rules").insert({
    ...ruleFromForm(formData),
    created_by: user.id,
  });

  if (error) throw new Error(error.message);
  revalidatePath("/settings/screening");
  redirect("/settings/screening");
}

export async function updateRule(id: string, formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("screening_rules")
    .update({ ...ruleFromForm(formData), updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/settings/screening");
  redirect("/settings/screening");
}

export async function deleteRule(id: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("screening_rules").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/screening");
}
