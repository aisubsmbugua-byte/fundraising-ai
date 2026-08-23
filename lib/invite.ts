import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

// Shared by app/admin/organizations/actions.ts (superadmin inviting an
// org's first user) and app/(dashboard)/settings/team/actions.ts (a
// member inviting a teammate) -- same invite + app_metadata-linking
// mechanism either way, just a different organizationId source.
//
// Self-healing against the exact failure that motivated this: an
// earlier invite attempt (e.g. before Postmark's SMTP was configured
// correctly) can create the auth.users row and then fail to actually
// deliver the email -- inviteUserByEmail then permanently refuses to
// re-invite that address ("already registered"), even though the
// person never completed onboarding. Since /login has
// shouldCreateUser: false, the *only* way an auth.users row can exist
// with no profiles row in this app is exactly that stale-invite case
// -- so it's safe to detect, delete, and retry automatically rather
// than leaving the email permanently stuck.
export async function sendOrgInvite(
  admin: AdminClient,
  email: string,
  organizationId: string
): Promise<{ error: string } | { success: true }> {
  const redirectTo = `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/pipeline`;
  const attempt = () => admin.auth.admin.inviteUserByEmail(email, { redirectTo });

  let { data: invited, error: inviteError } = await attempt();

  if (inviteError) {
    const alreadyExists =
      inviteError.code === "email_exists" || /already.*(registered|exists|invited)/i.test(inviteError.message ?? "");

    if (!alreadyExists) {
      console.error("[sendOrgInvite] invite failed:", inviteError);
      return { error: `Failed to send invite: [${inviteError.status ?? "?"}] ${inviteError.message || inviteError.code || "no detail"}` };
    }

    // Real, already-onboarded member somewhere -- don't silently
    // reassign them, that's a decision a human should make explicitly.
    const { data: existingProfile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (existingProfile) {
      return { error: `${email} is already a member of an organization. Remove them from it first to re-invite them elsewhere.` };
    }

    const { data: usersPage, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) {
      console.error("[sendOrgInvite] listUsers failed:", listError);
      return { error: `Failed to look up the existing invite for ${email}: ${listError.message}` };
    }
    const staleUser = usersPage.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!staleUser) {
      return { error: `${email} appears to already have an invite, but it couldn't be found to clear. Try again in a moment.` };
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(staleUser.id);
    if (deleteError) {
      console.error("[sendOrgInvite] failed to remove stale invite:", deleteError);
      return { error: `Failed to clear the old invite for ${email}: ${deleteError.message}` };
    }

    const retry = await attempt();
    invited = retry.data;
    inviteError = retry.error;
    if (inviteError) {
      console.error("[sendOrgInvite] retry after clearing stale invite still failed:", inviteError);
      return { error: `Failed to send invite (after clearing an old one): ${inviteError.message}` };
    }
  }

  if (!invited?.user) return { error: "Invite succeeded but returned no user -- please try again." };

  const { error: metadataError } = await admin.auth.admin.updateUserById(invited.user.id, {
    app_metadata: { organization_id: organizationId },
  });
  if (metadataError) {
    console.error("[sendOrgInvite] metadata update failed:", metadataError);
    return { error: `Invite sent but failed to link it to the organization: ${metadataError.message}` };
  }

  return { success: true };
}
