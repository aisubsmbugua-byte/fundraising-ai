import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureProfileForCurrentUser } from "@/lib/auth-callback";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/pipeline";

  if (code) {
    const supabase = createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      const result = await ensureProfileForCurrentUser(supabase);
      if (result.status === "no_organization") {
        return NextResponse.redirect(`${origin}/login?error=no_organization`);
      }
      if (result.status === "error") {
        return NextResponse.redirect(`${origin}/login?error=auth`);
      }

      return NextResponse.redirect(`${origin}${next}`);
    }

    // code was present but the exchange itself failed (expired, already
    // used, etc.) -- a genuinely broken PKCE exchange, distinct from the
    // no-code case below, so it stays on the direct error message.
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  // No ?code= at all: this is the shape Supabase's verify endpoint
  // produces for a server-side-issued link (admin.auth.admin.inviteUserByEmail,
  // no PKCE challenge -- see lib/invite.ts). The session comes back as
  // tokens in the URL fragment, which never reaches this server-side
  // handler, but a fragment survives a redirect whose target specifies
  // none of its own -- so hand off to the client-side page that can read
  // it, preserving `next`.
  return NextResponse.redirect(`${origin}/auth/complete-signin?next=${encodeURIComponent(next)}`);
}
