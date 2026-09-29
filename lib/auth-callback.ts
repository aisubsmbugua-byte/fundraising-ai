import type { SupabaseClient } from "@supabase/supabase-js";

// Shared by both auth-completion paths: app/auth/callback/route.ts (the
// ?code= PKCE exchange, self-serve signInWithOtp) and
// app/auth/complete-signin/actions.ts (the hash-token path taken after
// admin.auth.admin.inviteUserByEmail -- see lib/invite.ts for why that
// path carries no ?code=). One copy of "does this signed-in user have a
// profile yet, and if not, can we create one" -- capture, don't retype.
//
// Requires a server-side Supabase client that is ALREADY authenticated
// (session established via exchangeCodeForSession or setSession) so that
// supabase.auth.getUser() and the profiles insert below run as that user.
export type EnsureProfileResult =
  | { status: "ok" }
  | { status: "no_organization" }
  | { status: "error"; error: string };

export async function ensureProfileForCurrentUser(
  supabase: SupabaseClient
): Promise<EnsureProfileResult> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return { status: "error", error: userError?.message ?? "no authenticated user" };
  }
  const user = userData.user;

  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (existingProfile) {
    return { status: "ok" };
  }

  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    // Signed in successfully but was never invited into an
    // organization -- app_metadata is only ever set by the invite
    // actions (app/admin, settings/team), never by the user
    // themselves, so this means the account exists but has no org to
    // land in.
    return { status: "no_organization" };
  }

  // The insert policy on profiles re-validates organizationId against
  // this same app_metadata claim server-side, so this can't be spoofed
  // even though it's read from the session here.
  const { error: profileError } = await supabase.from("profiles").insert({
    id: user.id,
    organization_id: organizationId,
    email: user.email,
  });
  if (profileError) {
    return { status: "error", error: profileError.message };
  }

  return { status: "ok" };
}

// Parses the URL fragment Supabase's verify redirect attaches for a
// server-side-issued link (#access_token=...&refresh_token=...). Pure
// and framework-free so it's unit-testable without a browser -- used by
// app/auth/complete-signin/page.tsx. Not a valid Next.js page export
// itself, which is why it lives here rather than in page.tsx.
export function parseHashTokens(
  hash: string
): { access_token: string; refresh_token: string } | null {
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(cleaned);
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return null;
  return { access_token, refresh_token };
}
