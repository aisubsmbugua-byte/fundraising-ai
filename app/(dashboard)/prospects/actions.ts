"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { upsertContact } from "@/lib/contacts";

function fieldsFromForm(formData: FormData) {
  const focusAreas = (formData.get("focus_areas") as string) || "";
  return {
    name: formData.get("name") as string,
    channel: formData.get("channel") as string,
    organization: (formData.get("organization") as string) || null,
    contact_name: (formData.get("contact_name") as string) || null,
    contact_email: (formData.get("contact_email") as string) || null,
    website: (formData.get("website") as string) || null,
    notes: (formData.get("notes") as string) || null,
    location: (formData.get("location") as string) || null,
    funder_type: (formData.get("funder_type") as string) || null,
    geographic_focus: (formData.get("geographic_focus") as string) || null,
    typical_grant_size: (formData.get("typical_grant_size") as string) || null,
    focus_areas: focusAreas
      ? focusAreas
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    ask_amount: (() => {
      const raw = formData.get("ask_amount") as string;
      return raw ? Number(raw) : null;
    })(),
    next_action: (formData.get("next_action") as string) || null,
    next_action_due: (formData.get("next_action_due") as string) || null,
  };
}

export async function createProspect(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const fields = fieldsFromForm(formData);
  const { data, error } = await supabase
    .from("prospects")
    .insert({ ...fields, owner_id: user.id })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  await upsertContact(supabase, {
    name: fields.contact_name,
    email: fields.contact_email,
    organization: fields.organization,
    prospectId: data.id,
    userId: user.id,
  });

  revalidatePath("/pipeline");
  redirect(`/prospects/${data.id}`);
}

export async function updateProspect(id: string, formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const fields = fieldsFromForm(formData);
  const { error } = await supabase
    .from("prospects")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);

  await upsertContact(supabase, {
    name: fields.contact_name,
    email: fields.contact_email,
    organization: fields.organization,
    prospectId: id,
    userId: user.id,
  });

  revalidatePath("/pipeline");
  revalidatePath(`/prospects/${id}`);
  redirect(`/prospects/${id}`);
}

export async function screenProspectAction(prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prospect, error: prospectError } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", prospectId)
    .single();
  if (prospectError || !prospect) throw new Error("Prospect not found");

  const { data: rules, error: rulesError } = await supabase
    .from("screening_rules")
    .select("*")
    .eq("active", true);
  if (rulesError) throw new Error(rulesError.message);

  const { tier, score, breakdown } = screenProspect(prospect, (rules ?? []) as ScreeningRule[]);

  const { error: insertError } = await supabase.from("screening_results").insert({
    prospect_id: prospectId,
    tier,
    score,
    breakdown,
    screened_by: user.id,
  });
  if (insertError) throw new Error(insertError.message);

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/pipeline");
}

export async function deleteProspect(id: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("prospects").delete().eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/pipeline");
  redirect("/pipeline?view=list");
}
