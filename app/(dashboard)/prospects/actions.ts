"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { upsertContact } from "@/lib/contacts";
import { requireSuperadmin } from "@/lib/auth";

// Accepts what people actually type -- "58-2218044", "582218044", stray
// spaces -- and stores the canonical dashed form the research code compares
// against. Anything that isn't 9 digits is rejected rather than guessed at.
function normalizeEin(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 9) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

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
    // Authoritative identity. Once set, the Research Agent resolves this
    // prospect's entity deterministically instead of inferring it -- see
    // resolveRunEntity in lib/research.ts. Normalized to NN-NNNNNNN so it
    // compares equal to EINs detected in filings and URLs.
    ein: normalizeEin(formData.get("ein") as string),
    legal_name: (formData.get("legal_name") as string) || null,
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

// Scoped, non-redirecting updates for the quick-edit popovers -- unlike
// updateProspect (a full-row replace via fieldsFromForm, ending in a
// redirect), these touch only their own field(s) and leave the caller
// wherever it was, so "set a next action from a Pipeline card" doesn't
// have to leave the board.

export async function updateNextAction(prospectId: string, nextAction: string, nextActionDue: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("prospects")
    .update({
      next_action: nextAction.trim() || null,
      next_action_due: nextActionDue || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/revisit");
  revalidatePath("/dashboard");
}

export async function updateContact(prospectId: string, contactName: string, contactEmail: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prospect } = await supabase
    .from("prospects")
    .select("organization")
    .eq("id", prospectId)
    .single();

  const name = contactName.trim() || null;
  const email = contactEmail.trim() || null;

  const { error } = await supabase
    .from("prospects")
    .update({ contact_name: name, contact_email: email, updated_at: new Date().toISOString() })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  // Same directory sync updateProspect already does on the full form --
  // keeps Relationships in sync without a separate manual step there.
  await upsertContact(supabase, {
    name,
    email,
    organization: prospect?.organization ?? null,
    prospectId,
    userId: user.id,
  });

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/contacts");
}

export async function updateAskAmount(prospectId: string, askAmount: number | null) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("prospects")
    .update({ ask_amount: askAmount, updated_at: new Date().toISOString() })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/dashboard");
}

// Promotes a research run's proposed EIN onto the prospect record. This is
// deliberately a separate, human-triggered action rather than something
// runResearch does itself: an AI-derived identity written silently into the
// CRM would be AI output landing in a non-review state, which hard rule 3
// forbids. Once a human confirms it here, resolveRunEntity short-circuits to
// stored_ein and every later run of this prospect is deterministic.
//
// Superadmin-only, matching the rest of the (dark) Research Agent surface.
export async function confirmProspectEin(prospectId: string, ein: string) {
  await requireSuperadmin();
  const supabase = createClient();

  const digits = ein.replace(/\D/g, "");
  if (digits.length !== 9) throw new Error("An EIN must be 9 digits.");
  const normalized = `${digits.slice(0, 2)}-${digits.slice(2)}`;

  const { error } = await supabase
    .from("prospects")
    .update({ ein: normalized, updated_at: new Date().toISOString() })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/admin/research");
}
