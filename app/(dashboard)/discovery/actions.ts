"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { parseCsv } from "@/lib/candidates";
import { CHANNELS } from "@/lib/prospects";
import { upsertContact } from "@/lib/contacts";
import { allocateResearchRunVersion } from "@/lib/research";

async function getActiveRules(supabase: ReturnType<typeof createClient>) {
  const { data } = await supabase.from("screening_rules").select("*").eq("active", true);
  return (data ?? []) as ScreeningRule[];
}

export async function createCandidate(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const focusAreas = (formData.get("focus_areas") as string) || "";

  const candidate = {
    name: formData.get("name") as string,
    channel: formData.get("channel") as string,
    organization: (formData.get("organization") as string) || null,
    website: (formData.get("website") as string) || null,
    contact_name: (formData.get("contact_name") as string) || null,
    contact_email: (formData.get("contact_email") as string) || null,
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
    source: "manual",
    raw: null,
  };

  const rules = await getActiveRules(supabase);
  const { tier } = screenProspect(candidate, rules);

  const { data: inserted, error } = await supabase
    .from("candidates")
    .insert({ ...candidate, suggested_tier: tier, status: "pending" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await upsertContact(supabase, {
    name: candidate.contact_name,
    email: candidate.contact_email,
    organization: candidate.organization,
    candidateId: inserted.id,
    userId: user.id,
  });

  revalidatePath("/discovery");
  redirect("/discovery");
}

export async function importCandidatesCsv(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) throw new Error("Choose a CSV file to upload");

  const text = await file.text();
  const rows = parseCsv(text);
  const validChannels = new Set<string>(CHANNELS.map((c) => c.value));
  const rules = await getActiveRules(supabase);

  const toInsert: Record<string, unknown>[] = [];
  let errorCount = 0;

  for (const row of rows) {
    const name = row.name;
    const channel = row.channel;
    if (!name || !channel || !validChannels.has(channel)) {
      errorCount++;
      continue;
    }
    const candidate = {
      name,
      channel,
      organization: row.organization || null,
      website: row.website || null,
      contact_name: row.contact_name || null,
      contact_email: row.contact_email || null,
      location: row.location || null,
      funder_type: row.funder_type || null,
      geographic_focus: row.geographic_focus || null,
      typical_grant_size: row.typical_grant_size || null,
      focus_areas: row.focus_areas
        ? row.focus_areas
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      source: "csv_import",
      raw: row,
    };
    const { tier } = screenProspect(candidate, rules);
    toInsert.push({ ...candidate, suggested_tier: tier, status: "pending" });
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("candidates").insert(toInsert);
    if (error) throw new Error(error.message);

    // No per-row id back from a batch insert, so contacts imported
    // this way aren't linked to a source_candidate_id -- name/email/
    // organization is still enough for the directory to be useful.
    for (const c of toInsert) {
      await upsertContact(supabase, {
        name: c.contact_name as string | null,
        email: c.contact_email as string | null,
        organization: c.organization as string | null,
        userId: user.id,
      });
    }
  }

  revalidatePath("/discovery");
  redirect(`/discovery/import?imported=${toInsert.length}&errors=${errorCount}`);
}

export async function acceptCandidate(candidateId: string) {
  // Temporary timing instrumentation -- the client's isPending state
  // was observed staying stuck for 8+ seconds after Accept, and it
  // wasn't clear whether that's this function genuinely being slow or
  // something in the client's transition handling. Remove once
  // diagnosed.
  const t0 = Date.now();
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  console.log(`[accept-candidate] auth done at +${Date.now() - t0}ms`);

  const { data: candidate, error: fetchError } = await supabase
    .from("candidates")
    .select("*")
    .eq("id", candidateId)
    .single();
  if (fetchError || !candidate) throw new Error("Candidate not found");
  console.log(`[accept-candidate] candidate fetched at +${Date.now() - t0}ms`);

  const { data: prospect, error: insertError } = await supabase
    .from("prospects")
    .insert({
      name: candidate.name,
      channel: candidate.channel,
      organization: candidate.organization,
      contact_name: candidate.contact_name,
      contact_email: candidate.contact_email,
      website: candidate.website,
      location: candidate.location,
      funder_type: candidate.funder_type,
      geographic_focus: candidate.geographic_focus,
      typical_grant_size: candidate.typical_grant_size,
      focus_areas: candidate.focus_areas,
      owner_id: user.id,
      stage: "discovery",
    })
    .select("id")
    .single();
  if (insertError || !prospect) throw new Error(insertError?.message ?? "Failed to create prospect");
  console.log(`[accept-candidate] prospect inserted at +${Date.now() - t0}ms`);

  // Re-points this contact's link from nowhere (candidates have no
  // detail page) to the prospect that now exists for them -- upsert
  // updates the existing row by email rather than creating a new one.
  await upsertContact(supabase, {
    name: candidate.contact_name,
    email: candidate.contact_email,
    organization: candidate.organization,
    prospectId: prospect.id,
    userId: user.id,
  });

  const { error: updateError } = await supabase
    .from("candidates")
    .update({ status: "accepted", reviewed_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (updateError) throw new Error(updateError.message);
  console.log(`[accept-candidate] candidate status updated at +${Date.now() - t0}ms`);

  // Accepting is a commitment to pursue this prospect, so RESEARCH starts
  // here -- not a strategy. A strategy is written from intelligence a person
  // has reviewed and approved, which cannot exist yet at the moment of
  // acceptance; generating one now would produce a confident-looking plan
  // grounded in nothing but the model's own search.
  //
  // Only the row is created here (fast, just an insert). The run itself is
  // triggered by the caller, fire-and-forget, right after this returns --
  // the Discovery page stays mounted (Accept no longer navigates away), so
  // there's no unmounting-component risk of the browser cancelling it.
  // Through the shared allocator rather than a direct insert: version
  // numbering and its retry-on-collision handling live in one place, and a
  // second insert path would be the one that eventually gets them wrong.
  const runId = await allocateResearchRunVersion(supabase, prospect.id as string, null, user.id, `Researching ${candidate.name}...`);
  console.log(`[accept-candidate] research_run inserted at +${Date.now() - t0}ms`);

  revalidatePath("/discovery");
  revalidatePath("/pipeline");
  console.log(`[accept-candidate] revalidated, returning at +${Date.now() - t0}ms`);

  return { prospectId: prospect.id as string, runId };
}

export async function dismissCandidate(candidateId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("candidates")
    .update({ status: "dismissed", reviewed_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (error) throw new Error(error.message);

  revalidatePath("/discovery");
}

// "Not now, but don't lose it" -- distinct from dismiss (not
// interested) and pending (still needs a first look).
export async function saveCandidateForLater(candidateId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("candidates")
    .update({ status: "saved", reviewed_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (error) throw new Error(error.message);

  revalidatePath("/discovery");
}

// Moves a saved (or dismissed) candidate back to pending -- e.g. "I
// changed my mind" from the Saved or Dismissed tab.
export async function restoreCandidateToPending(candidateId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("candidates")
    .update({ status: "pending", reviewed_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (error) throw new Error(error.message);

  revalidatePath("/discovery");
}
