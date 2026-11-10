// STATE item 113, ruling 0048 clause 1: who may open the funder database screen.
//
// ONE rule, in ONE place. The screen's layout (app/(dashboard)/funders/layout.tsx)
// and the sidebar entry (app/(dashboard)/layout.tsx) both ask this function, so
// opening the screen to ordinary members later -- which needs its own ruling --
// changes this function and nothing else. Today: a signed-in profile marked
// superadmin.
//
// This is only the screen's door. The data permission is ruling 0045's and is not
// touched here: the reference tables are readable by any signed-in member and
// writable by nobody but the offline loader.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function canOpenFunderDatabase(supabase: SupabaseClient, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const { data } = await supabase.from("profiles").select("is_superadmin").eq("id", userId).maybeSingle();
  return data?.is_superadmin === true;
}
