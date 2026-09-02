"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { upsertContact } from "@/lib/contacts";
import { requireUser } from "@/lib/auth";

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
// Open to any signed-in team member. It has to be: confirming the entity is
// a required step of the workflow whenever research finds several
// organizations sharing a name, and a mandatory step only a superadmin can
// take is a dead end for everyone else. RLS scopes the prospect row.
// The user's answer to "which organization is this?", given in the terms they
// actually have. Free text on purpose: a website, a city, a denomination, a
// program name and "the conference where I met them" are all useful and none
// of them fits a field we could have designed in advance.
//
// A clue that looks like a domain is also written to `website` when none is
// set, because domain matching is the strongest resolution signal we have --
// it short-circuits the whole ambiguity rather than merely narrowing a search.
export async function saveIdentityClue(
  prospectId: string,
  clue: string
): Promise<{ error: string } | { success: true }> {
  try {
    await requireUser();
    const supabase = createClient();
    const trimmed = clue.trim();
    if (!trimmed) return { error: "Add a detail first." };

    const { data: prospect } = await supabase.from("prospects").select("website").eq("id", prospectId).maybeSingle();

    // Bare domain or full URL, and nothing that is merely a sentence with a
    // dot in it -- a false positive here would overwrite a real website.
    const domainish = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\S*)?$/i);
    const website = !prospect?.website && domainish ? `https://${domainish[1]}` : undefined;

    const { error } = await supabase
      .from("prospects")
      .update({
        identity_hint: trimmed,
        ...(website ? { website } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId);
    if (error) return { error: error.message };

    revalidatePath(`/prospects/${prospectId}`);
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save that detail." };
  }
}

// Confirming an identity is a decision, and a decision a person cannot revise
// is a trap. Overseas Council International showed why: its EIN was confirmed
// before anyone knew the organization had merged, and once stored there was
// no route back -- the picker only appears when nothing is saved, so the
// prospect was pinned to a defunct entity by a click.
//
// Clearing is safe: the EIN is a pointer, and nothing that depends on it is
// deleted. The next run simply resolves from search again.
export async function clearProspectEin(prospectId: string) {
  await requireUser();
  const supabase = createClient();

  const { error } = await supabase
    .from("prospects")
    .update({ ein: null, predecessor_eins: null, updated_at: new Date().toISOString() })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/admin/research");
}

// predecessorEins is how a person says "these are the same organization at
// different times". The resolver cannot work that out -- a merged predecessor
// and an unrelated namesake look identical in search results -- so it is
// recorded from human knowledge rather than inferred. ein stays the single
// surviving entity, so nothing downstream has to learn about multiplicity.
export async function confirmProspectEin(prospectId: string, ein: string, predecessorEins: string[] = []) {
  await requireUser();
  const supabase = createClient();

  const normalize = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 9) throw new Error("An EIN must be 9 digits.");
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  };

  const normalized = normalize(ein);
  // Never lists the surviving entity as its own predecessor, however the
  // caller passes them.
  const predecessors = [...new Set(predecessorEins.map(normalize))].filter((e) => e !== normalized);

  const { error } = await supabase
    .from("prospects")
    .update({
      ein: normalized,
      predecessor_eins: predecessors.length ? predecessors : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/admin/research");
}

// Confirm WHICH ORGANIZATION this is, without claiming to know which
// registered entity it is.
//
// The two-layer rule in practice: a person can recognise their funder's own
// website at a glance and cannot be expected to recognise an EIN, so this is
// the confirmation most users are actually able to give. It deliberately does
// not write `ein` -- an operating confirmation is not evidence about a filing,
// and quietly promoting one to the other is exactly the conflation the layers
// exist to prevent.
//
// Writing `website` is not merely a record: it is the input the official-domain
// path needs. Once set, the NEXT run can resolve the EIN deterministically from
// a page on that host, so confirming the organization is what lets the system
// settle the legal identity by itself instead of asking again.
export async function confirmProspectOperatingIdentity(prospectId: string, domain: string, name?: string | null) {
  const user = await requireUser();
  const supabase = createClient();

  const host = domain.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) {
    return { error: "That does not look like a website address." };
  }

  // The confirmation is recorded as itself, not inferred from the website.
  // Writing only `website` meant confirming a prospect whose website was
  // already correct changed nothing at all, and the button read as broken.
  const { error } = await supabase
    .from("prospects")
    .update({
      website: `https://${host}`,
      operating_identity_domain: host,
      operating_identity_name: name ?? null,
      operating_identity_confirmed_at: new Date().toISOString(),
      operating_identity_confirmed_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId);
  // Server Actions must return the failure, never throw it -- Next redacts a
  // thrown message in production, so throwing here would show the user
  // "An error occurred in the Server Components render" and nothing else.
  if (error) return { error: error.message };

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/admin/research");
  return { error: null };
}

// The counterpart to clearProspectEin. A confirmation a person cannot revise
// is a trap, and this one is easier to get wrong than the EIN -- a plausible
// domain is much easier to click than a plausible nine-digit number.
export async function clearProspectOperatingIdentity(prospectId: string) {
  await requireUser();
  const supabase = createClient();

  const { error } = await supabase
    .from("prospects")
    .update({
      operating_identity_domain: null,
      operating_identity_name: null,
      operating_identity_confirmed_at: null,
      operating_identity_confirmed_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId);
  if (error) return { error: error.message };

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/admin/research");
  return { error: null };
}
