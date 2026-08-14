"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

function fieldsFromForm(formData: FormData) {
  return {
    name: formData.get("name") as string,
    channel: formData.get("channel") as string,
    organization: (formData.get("organization") as string) || null,
    contact_name: (formData.get("contact_name") as string) || null,
    contact_email: (formData.get("contact_email") as string) || null,
    website: (formData.get("website") as string) || null,
    notes: (formData.get("notes") as string) || null,
  };
}

export async function createProspect(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase
    .from("prospects")
    .insert({ ...fieldsFromForm(formData), owner_id: user.id })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/prospects");
  redirect(`/prospects/${data.id}`);
}

export async function updateProspect(id: string, formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("prospects")
    .update({ ...fieldsFromForm(formData), updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);

  revalidatePath("/prospects");
  revalidatePath(`/prospects/${id}`);
  redirect(`/prospects/${id}`);
}
