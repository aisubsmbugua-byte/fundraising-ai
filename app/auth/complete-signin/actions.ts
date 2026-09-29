"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfileForCurrentUser } from "@/lib/auth-callback";

// Called from app/auth/complete-signin/page.tsx once the browser has
// established the session via supabase.auth.setSession(...) (the
// hash-token path -- see app/auth/callback/route.ts and lib/invite.ts
// for why this path exists). By the time this action runs, setSession
// has already written the auth cookies, so createClient() here picks up
// the now-authenticated session and ensureProfileForCurrentUser runs as
// that user -- same shared logic the ?code= path uses.
//
// Reuses the exact error query params/messages already defined in
// app/login/page.tsx's CALLBACK_ERROR_MESSAGE.
export async function completeSignInAfterHashAuth(next: string): Promise<never> {
  const supabase = createClient();
  const result = await ensureProfileForCurrentUser(supabase);

  if (result.status === "no_organization") {
    redirect("/login?error=no_organization");
  }
  if (result.status === "error") {
    redirect("/login?error=auth");
  }

  redirect(next || "/pipeline");
}
