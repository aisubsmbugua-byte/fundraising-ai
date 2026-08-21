import type { SupabaseClient } from "@supabase/supabase-js";

export type Contact = {
  id: string;
  name: string;
  email: string | null;
  organization: string | null;
  source_candidate_id: string | null;
  source_prospect_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// Called from every place a candidate or prospect's contact_name /
// contact_email gets saved (see the People page) so the directory
// stays in sync without a separate manual step. Dedupes by email
// (case-insensitive) when present; name-only contacts have no stable
// key to dedupe on and are inserted as their own row each time.
export async function upsertContact(
  supabase: SupabaseClient,
  input: {
    name: string | null;
    email: string | null;
    organization: string | null;
    prospectId?: string;
    candidateId?: string;
    userId?: string;
  }
) {
  if (!input.name && !input.email) return;
  const email = input.email?.trim().toLowerCase() || null;

  const { error } = await supabase.from("contacts").upsert(
    {
      name: input.name || email!,
      email,
      organization: input.organization,
      source_prospect_id: input.prospectId ?? null,
      source_candidate_id: input.candidateId ?? null,
      created_by: input.userId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email" }
  );

  // Non-critical side effect of the candidate/prospect save that
  // triggered it -- log and move on rather than failing the caller.
  if (error) console.error("[upsertContact]", error.message);
}
