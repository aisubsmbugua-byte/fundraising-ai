import { createClient } from "@/lib/supabase/server";

// Shared by app/admin/organizations/actions.ts and any other superadmin-
// gated server action (e.g. the Research Agent's dark action) -- throws
// rather than returning a boolean, since every caller wants the same
// "stop right here" behavior on failure. Returns the user so a caller that
// needs their id (e.g. for created_by) doesn't have to re-fetch it.
export async function requireSuperadmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: profile } = await supabase.from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle();
  if (!profile?.is_superadmin) throw new Error("Not authorized");

  return user;
}
