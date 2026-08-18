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

  const candidate = {
    name: formData.get("name") as string,
    channel: formData.get("channel") as string,
    organization: (formData.get("organization") as string) || null,
    website: (formData.get("website") as string) || null,
    contact_name: (formData.get("contact_name") as string) || null,
    contact_email: (formData.get("contact_email") as string) || null,
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

  const { error: insertError } = await supabase.from("prospects").insert({
    name: candidate.name,
    channel: candidate.channel,
    organization: candidate.organization,
    contact_name: candidate.contact_name,
    contact_email: candidate.contact_email,
    website: candidate.website,
    owner_id: user.id,
    stage: "discovery",
  });
  if (insertError) throw new Error(insertError.message);

  const { error: updateError } = await supabase
    .from("candidates")
    .update({ status: "accepted", reviewed_by: user.id })
    .eq("id", candidateId);
  if (updateError) throw new Error(updateError.message);

  revalidatePath("/discovery");
  revalidatePath("/prospects");
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
