"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function requireSuperadmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: profile } = await supabase.from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle();
  if (!profile?.is_superadmin) throw new Error("Not authorized");
}

// Creates a brand-new organization and invites its first user into it.
// organizations has zero RLS policies for "authenticated" (see
// 0032_multi_tenant_foundation.sql), so both the insert and the invite
// have to go through the service-role admin client -- but only after
// re-verifying superadmin status here, server-side, even though the
// page itself is already gated by app/admin/layout.tsx. Two separate
// admin calls are required: inviteUserByEmail's own `data` option
// writes to user_metadata, which is client-writable later via
// updateUser -- app_metadata is not, so organization_id has to be set
// in a second call for it to be trustworthy in the RLS policy that
// creates the profile row on first login.
export async function createOrgAndInviteFirstUser(formData: FormData) {
  await requireSuperadmin();
  const name = (formData.get("name") as string)?.trim();
  const email = (formData.get("email") as string)?.trim();
  if (!name || !email) throw new Error("Organization name and email are required");

  const admin = createAdminClient();

  const { data: org, error: orgError } = await admin.from("organizations").insert({ name }).select("id").single();
  if (orgError) throw new Error(orgError.message);

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/pipeline`,
  });
  if (inviteError) throw new Error(inviteError.message);

  const { error: metadataError } = await admin.auth.admin.updateUserById(invited.user.id, {
    app_metadata: { organization_id: org.id },
  });
  if (metadataError) throw new Error(metadataError.message);

  revalidatePath("/admin/organizations");
}

// Every table org-scoped by 0033_multi_tenant_rls.sql -- kept in sync
// with that migration by hand, since there's no single source of
// truth to derive it from at runtime.
const ORG_SCOPED_TABLES = [
  "prospects",
  "screening_rules",
  "screening_results",
  "stage_changes",
  "org_profile",
  "channel_match_runs",
  "candidates",
  "deep_dive_runs",
  "org_documents",
  "drafts",
  "discovery_search_runs",
  "auto_search_settings",
  "contacts",
  "evidence_items",
  "interactions",
] as const;

// Deliberately narrow: only ever deletes an organization that has zero
// rows in every CRM table (a throwaway test org someone just created)
// and never one containing a superadmin (structurally protects the
// bootstrap org and guarantees at least one superadmin always exists).
// Real orgs with real data are never deletable through this -- that's
// intentional, not a limitation to work around.
export async function deleteOrganization(organizationId: string) {
  await requireSuperadmin();
  const admin = createAdminClient();

  const { data: members } = await admin
    .from("profiles")
    .select("id, is_superadmin")
    .eq("organization_id", organizationId);
  if ((members ?? []).some((m) => m.is_superadmin)) {
    throw new Error("Can't delete an organization that has a superadmin in it.");
  }

  for (const table of ORG_SCOPED_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    if (error) throw new Error(`Failed to check ${table}: ${error.message}`);
    if (count && count > 0) {
      throw new Error(`Can't delete: this organization still has data in "${table}". Only empty test organizations can be deleted.`);
    }
  }

  // profiles.id references auth.users(id) on delete cascade, so
  // removing the auth user also removes their profile row -- and
  // frees up the email to be invited again later.
  for (const member of members ?? []) {
    const { error } = await admin.auth.admin.deleteUser(member.id);
    if (error) throw new Error(`Failed to remove member ${member.id}: ${error.message}`);
  }

  const { error: deleteError } = await admin.from("organizations").delete().eq("id", organizationId);
  if (deleteError) throw new Error(deleteError.message);

  revalidatePath("/admin/organizations");
}
