"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Any signed-in org member can invite a teammate into their own
// organization -- no superadmin check needed, unlike app/admin. The
// org to invite into is read from the caller's own profile row
// server-side, never accepted as input, so a member can only ever
// invite into the org they're already in. Same two-call invite
// pattern as app/admin/organizations/actions.ts (app_metadata has to
// be set in a follow-up call, not via inviteUserByEmail's own `data`
// option, since only app_metadata is safe for the profiles insert
// policy to trust).
export async function inviteTeammate(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const email = (formData.get("email") as string)?.trim();
  if (!email) throw new Error("Email is required");

  const { data: caller } = await supabase.from("profiles").select("organization_id").eq("id", user.id).single();
  if (!caller) throw new Error("No organization found for your account");

  const admin = createAdminClient();

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/pipeline`,
  });
  if (inviteError) throw new Error(inviteError.message);

  const { error: metadataError } = await admin.auth.admin.updateUserById(invited.user.id, {
    app_metadata: { organization_id: caller.organization_id },
  });
  if (metadataError) throw new Error(metadataError.message);

  revalidatePath("/settings/team");
}
