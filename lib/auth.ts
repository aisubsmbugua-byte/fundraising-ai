import { createClient } from "@/lib/supabase/server";

// The ordinary bar for a server action: signed in. Org isolation is NOT
// this function's job and never should be -- every table these actions
// touch carries organization_id with an RLS policy scoped by it, so a
// signed-in user reaching another org's row is prevented in the database
// rather than by a check a new action could forget to call.
//
// Returns the user for the same reason requireSuperadmin does: callers
// need their id for created_by/decided_by.
export async function requireUser() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return user;
}

// Shared by app/admin/organizations/actions.ts and any other superadmin-
// gated server action -- throws rather than returning a boolean, since
// every caller wants the same "stop right here" behavior on failure.
// Returns the user so a caller that needs their id (e.g. for created_by)
// doesn't have to re-fetch it.
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
