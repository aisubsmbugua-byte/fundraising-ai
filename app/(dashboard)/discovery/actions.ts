"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { candidateDedupeKey, parseCsv, safeHostname } from "@/lib/candidates";
import { findExistingFunder, isUniqueViolation, isSameOrg, type ExistingFunder } from "@/lib/candidate-intake";
import { CHANNELS } from "@/lib/prospects";
import { upsertContact } from "@/lib/contacts";
import { allocateResearchRunVersion } from "@/lib/research";

async function getActiveRules(supabase: ReturnType<typeof createClient>) {
  const { data } = await supabase.from("screening_rules").select("*").eq("active", true);
  return (data ?? []) as ScreeningRule[];
}

export type CreateCandidateResult = { error: string } | { duplicate: ExistingFunder } | { ok: true; id: string };

// Returns rather than throws, and never redirects: a duplicate is a normal
// answer this form has to render (with the values still in the fields), not an
// error condition. Next redacts thrown messages in production, so throwing
// here would surface as a bare 500 with nothing to act on.
export async function createCandidate(formData: FormData): Promise<CreateCandidateResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session has expired. Sign in again." };

  const focusAreas = (formData.get("focus_areas") as string) || "";
  // Set by the "Add anyway" button, so the person can overrule the warning --
  // two genuinely different churches can share a name, and they would know.
  const confirmed = formData.get("confirm_duplicate") === "1";

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

  // Hand-entered rows had no dedupe_key at all, which is why nothing could
  // detect the Graceway repeats even in principle. A manual entry has no
  // source domain -- that part of the key is legitimately empty here.
  const dedupeKey = candidateDedupeKey({
    sourceDomain: candidate.website ? safeHostname(candidate.website) : null,
    funderName: candidate.name,
    name: candidate.name,
  });

  if (!confirmed) {
    const existing = await findExistingFunder(supabase, {
      name: candidate.name,
      organization: candidate.organization,
      dedupeKey,
    });
    if (existing) return { duplicate: existing };
  }

  const rules = await getActiveRules(supabase);
  const { tier } = screenProspect(candidate, rules);

  const { data: inserted, error } = await supabase
    .from("candidates")
    .insert({ ...candidate, dedupe_key: dedupeKey, suggested_tier: tier, status: "pending" })
    .select("id")
    .single();
  if (error) {
    // The constraint caught what the check raced past -- a double-submit. Say
    // what happened in the caller's terms; a database code helps nobody.
    if (isUniqueViolation(error)) return { error: "That funder is already in your discovery queue." };
    return { error: error.message };
  }

  await upsertContact(supabase, {
    name: candidate.contact_name,
    email: candidate.contact_email,
    organization: candidate.organization,
    candidateId: inserted.id,
    userId: user.id,
  });

  revalidatePath("/discovery");
  return { ok: true, id: inserted.id as string };
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

  // Every existing funder, read once. The import previously inserted its whole
  // batch in a single call with no duplicate check of any kind -- so a file
  // re-uploaded after a correction silently doubled the queue, and a file
  // containing the same funder twice inserted it twice.
  const [{ data: knownCandidates }, { data: knownProspects }] = await Promise.all([
    supabase.from("candidates").select("name, organization"),
    supabase.from("prospects").select("name, organization"),
  ]);
  const known = [...(knownCandidates ?? []), ...(knownProspects ?? [])] as { name: string; organization: string | null }[];

  const toInsert: Record<string, unknown>[] = [];
  let errorCount = 0;
  let duplicateCount = 0;

  for (const row of rows) {
    const name = row.name;
    const channel = row.channel;
    if (!name || !channel || !validChannels.has(channel)) {
      errorCount++;
      continue;
    }
    // Checked against rows already in the batch as well as rows already in the
    // database -- a file listing the same funder twice is the ordinary case,
    // and is exactly what a batch insert cannot catch on its own.
    const isDuplicate = known.some(
      (k) => isSameOrg(k.name, name) || (row.organization && k.organization && isSameOrg(k.organization, row.organization))
    );
    if (isDuplicate) {
      duplicateCount++;
      continue;
    }
    known.push({ name, organization: row.organization || null });
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
    toInsert.push({
      ...candidate,
      dedupe_key: candidateDedupeKey({
        sourceDomain: safeHostname(candidate.website),
        funderName: candidate.name,
        name: candidate.name,
      }),
      suggested_tier: tier,
      status: "pending",
    });
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
  // Duplicates are reported, never folded into the error count -- a skipped
  // duplicate is the import working, and a row that could not be read is the
  // import failing. Showing them as one number would hide both.
  redirect(`/discovery/import?imported=${toInsert.length}&errors=${errorCount}&duplicates=${duplicateCount}`);
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
  // Belt and braces: the queue already hides these, but acceptance takes an
  // id and must not be the one path that lets an unattributable candidate
  // through into the pipeline.
  if (candidate.capture_status === "source_missing") {
    throw new Error("This candidate could not be traced to a source the search actually visited, so it cannot be accepted.");
  }
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
      // Only a site believed to be the funder's own reaches the prospect,
      // and its status travels with it -- entity resolution consults a
      // prospect's domain before falling back on ambiguous filings, so a
      // third-party URL arriving here unlabelled would be read as the
      // organization speaking about itself.
      website_status: candidate.website_status ?? null,
      legal_name: candidate.funder_name ?? null,
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
