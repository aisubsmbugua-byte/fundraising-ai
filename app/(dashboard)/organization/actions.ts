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

  const causeAreas = formData.getAll("cause_areas") as string[];
  const geographicAreas = formData.getAll("geographic_areas") as string[];
  const outcomes = formData.getAll("outcomes") as string[];
  const orgValues = formData.getAll("org_values") as string[];
  const notableFundersRaw = formData.get("notable_funders") as string | null;
  const notableFunders = notableFundersRaw ? JSON.parse(notableFundersRaw) : [];

  const fields = {
    name: (formData.get("name") as string) || null,
    org_type: (formData.get("org_type") as string) || null,
    org_type_other: (formData.get("org_type_other") as string) || null,
    year_founded: formData.get("year_founded") ? Number(formData.get("year_founded")) : null,
    annual_budget: formData.get("annual_budget") ? Number(formData.get("annual_budget")) : null,
    funding_need: (formData.get("funding_need") as string) || null,
    problem_statement: (formData.get("problem_statement") as string) || null,
    mission: (formData.get("mission") as string) || null,
    vision: (formData.get("vision") as string) || null,
    programs: (formData.get("programs") as string) || null,
    cause_areas: causeAreas.length > 0 ? causeAreas : null,
    cause_area_other: (formData.get("cause_area_other") as string) || null,
    who_we_serve: (formData.get("who_we_serve") as string) || null,
    geographic_areas: geographicAreas.length > 0 ? geographicAreas : null,
    hq_location: (formData.get("hq_location") as string) || null,
    org_values: orgValues.length > 0 ? orgValues : null,
    outcomes: outcomes.length > 0 ? outcomes : null,
    notable_funders: notableFunders.length > 0 ? notableFunders : null,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase.from("org_profile").select("id").limit(1).maybeSingle();

  const { error } = existing
    ? await supabase.from("org_profile").update(fields).eq("id", existing.id)
    : await supabase.from("org_profile").insert(fields);

  if (error) throw new Error(error.message);

  revalidatePath("/organization");
  redirect("/organization?saved=1");
}
