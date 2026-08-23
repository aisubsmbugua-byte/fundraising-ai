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
