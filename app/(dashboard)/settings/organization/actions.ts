"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function saveOrgProfile(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const fields = {
    mission: (formData.get("mission") as string) || null,
    programs: (formData.get("programs") as string) || null,
    who_we_serve: (formData.get("who_we_serve") as string) || null,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase.from("org_profile").select("id").limit(1).maybeSingle();

  const { error } = existing
    ? await supabase.from("org_profile").update(fields).eq("id", existing.id)
    : await supabase.from("org_profile").insert(fields);

  if (error) throw new Error(error.message);

  revalidatePath("/settings/organization");
}
