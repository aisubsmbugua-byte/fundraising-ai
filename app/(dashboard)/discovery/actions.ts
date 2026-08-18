"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { parseCsv } from "@/lib/candidates";
import { CHANNELS } from "@/lib/prospects";

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

  const { error } = await supabase
    .from("candidates")
    .insert({ ...candidate, suggested_tier: tier, status: "pending" });
  if (error) throw new Error(error.message);

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
  }

  revalidatePath("/discovery");
  redirect(`/discovery/import?imported=${toInsert.length}&errors=${errorCount}`);
}

export async function acceptCandidate(candidateId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: candidate, error: fetchError } = await supabase
    .from("candidates")
    .select("*")
    .eq("id", candidateId)
    .single();
  if (fetchError || !candidate) throw new Error("Candidate not found");

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

  const { error: updateError } = await supabase
    .from("candidates")
    .update({ status: "accepted", reviewed_by: user.id })
    .eq("id", candidateId);
  if (updateError) throw new Error(updateError.message);

  // Accepting is a commitment to pursue this prospect -- create the
  // deep-dive run row now (fast, just an insert). The actual research
  // is deliberately NOT triggered from here: this component is about
  // to unmount as we navigate to the prospect page, and an in-flight
  // request from an unmounting component risks getting cancelled by
  // the browser. The destination page's DeepDivePanel triggers the
  // real work on mount instead, since it stays alive for the duration.
  const { data: run, error: runError } = await supabase
    .from("deep_dive_runs")
    .insert({
      prospect_id: prospect.id,
      status: "researching",
      status_message: `Researching ${candidate.name} and drafting a strategy...`,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (runError || !run) throw new Error(runError?.message ?? "Failed to start deep dive");

  revalidatePath("/discovery");
  revalidatePath("/prospects");

  return { prospectId: prospect.id as string, runId: run.id as string };
}

export async function dismissCandidate(candidateId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("candidates")
    .update({ status: "dismissed", reviewed_by: user.id })
    .eq("id", candidateId);
  if (error) throw new Error(error.message);

  revalidatePath("/discovery");
}
