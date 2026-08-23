import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/pipeline";

  if (code) {
    const supabase = createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      const { data: existingProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", data.user.id)
        .maybeSingle();

      if (!existingProfile) {
        const organizationId = data.user.app_metadata?.organization_id as string | undefined;
        if (!organizationId) {
          // Signed in successfully but was never invited into an
          // organization -- app_metadata is only ever set by the
          // invite actions (app/admin, settings/team), never by the
          // user themselves, so this means the account exists but
          // has no org to land in.
          return NextResponse.redirect(`${origin}/login?error=no_organization`);
        }
        // The insert policy on profiles re-validates organizationId
        // against this same app_metadata claim server-side, so this
        // can't be spoofed even though it's read from the session here.
        const { error: profileError } = await supabase.from("profiles").insert({
          id: data.user.id,
          organization_id: organizationId,
          email: data.user.email,
        });
        if (profileError) {
          return NextResponse.redirect(`${origin}/login?error=auth`);
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
