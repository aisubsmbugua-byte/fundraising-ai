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
//
// Returns a result object instead of throwing: a thrown Error's
// message is redacted to a generic string on the client in production
// builds, and a plain <form action={...}> with no client-side handler
// turns any thrown error into a full page crash rather than a visible
// message -- see the near-identical fix in app/admin/organizations.
export async function inviteTeammate(formData: FormData): Promise<{ error: string } | { success: true }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const email = (formData.get("email") as string)?.trim();
  if (!email) return { error: "Email is required" };

  const { data: caller } = await supabase.from("profiles").select("organization_id").eq("id", user.id).single();
  if (!caller) return { error: "No organization found for your account" };

  const admin = createAdminClient();

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/pipeline`,
  });
  if (inviteError) {
    console.error("[inviteTeammate] invite failed:", inviteError);
    return { error: `Failed to send invite: [${inviteError.status ?? "?"}] ${inviteError.message || inviteError.code || "no detail"}` };
  }

  const { error: metadataError } = await admin.auth.admin.updateUserById(invited.user.id, {
    app_metadata: { organization_id: caller.organization_id },
  });
  if (metadataError) {
    console.error("[inviteTeammate] metadata update failed:", metadataError);
    return { error: `Invite sent but failed to link it to your organization: ${metadataError.message}` };
  }

  revalidatePath("/settings/team");
  return { success: true };
}
