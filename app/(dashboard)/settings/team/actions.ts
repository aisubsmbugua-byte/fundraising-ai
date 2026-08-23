"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendOrgInvite } from "@/lib/invite";

// Any signed-in org member can invite a teammate into their own
// organization -- no superadmin check needed, unlike app/admin. The
// org to invite into is read from the caller's own profile row
// server-side, never accepted as input, so a member can only ever
// invite into the org they're already in. Shares its invite mechanism
// with app/admin/organizations/actions.ts via lib/invite.ts's
// sendOrgInvite.
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
  const result = await sendOrgInvite(admin, email, caller.organization_id);
  if ("error" in result) return result;

  revalidatePath("/settings/team");
  return { success: true };
}
