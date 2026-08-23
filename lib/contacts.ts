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
// (case-insensitive, via the table's unique constraint) when present.
// Name-only contacts have no such key, so the same person turning up
// again with no email (e.g. the same org's contact found across
// several search runs) is matched by name + organization instead --
// same idiom discovery/search/actions.ts already uses for candidates.
export async function upsertContact(
  supabase: SupabaseClient,
  input: {
    name: string | null;
    email: string | null;
    organization: string | null;
    prospectId?: string;
    candidateId?: string;
    userId?: string;
    // Only needed when supabase is the service-role admin client (the
    // overnight auto-search cron path) -- organization_id has no
    // auth.uid() to default from there, and the existing-contact
    // lookups below would otherwise match across every org's contacts
    // instead of just the caller's own. The normal session-client
    // callers leave this unset and rely on RLS + the column default,
    // same as everywhere else in the app.
    organizationId?: string;
  }
) {
  const email = input.email?.trim().toLowerCase() || null;
  // Organization ranks above email as a fallback so a contact with no
  // known person name reads as "National Community Church", not as
  // its own raw email/URL string sitting where a name belongs.
  const name = input.name?.trim() || input.organization?.trim() || email;
  if (!name) return;

  if (email) {
    const { error } = await supabase.from("contacts").upsert(
      {
        name,
        email,
        organization: input.organization,
        source_prospect_id: input.prospectId ?? null,
        source_candidate_id: input.candidateId ?? null,
        created_by: input.userId ?? null,
        updated_at: new Date().toISOString(),
        ...(input.organizationId ? { organization_id: input.organizationId } : {}),
      },
      // Always the org-scoped constraint -- 0033_multi_tenant_rls.sql
      // drops the old global "email unique" constraint entirely, so
      // this is the only one that exists post-migration regardless of
      // which caller this is.
      { onConflict: "organization_id,email" }
    );
    if (error) console.error("[upsertContact]", error.message);
    return;
  }

  let existingQuery = supabase.from("contacts").select("id").ilike("name", name).is("email", null);
  existingQuery = input.organization
    ? existingQuery.eq("organization", input.organization)
    : existingQuery.is("organization", null);
  if (input.organizationId) existingQuery = existingQuery.eq("organization_id", input.organizationId);
  const { data: existing } = await existingQuery.maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("contacts")
      .update({
        source_prospect_id: input.prospectId,
        source_candidate_id: input.candidateId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) console.error("[upsertContact]", error.message);
    return;
  }

  const { error } = await supabase.from("contacts").insert({
    name,
    email: null,
    organization: input.organization,
    source_prospect_id: input.prospectId ?? null,
    source_candidate_id: input.candidateId ?? null,
    created_by: input.userId ?? null,
    ...(input.organizationId ? { organization_id: input.organizationId } : {}),
  });
  // Non-critical side effect of the candidate/prospect save that
  // triggered it -- log and move on rather than failing the caller.
  if (error) console.error("[upsertContact]", error.message);
}
