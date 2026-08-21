import { createServerClient } from "@supabase/ssr";
import { createClient as createServiceRoleClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

// Build-phase only: the sole real account in this single-tenant app
// today, used below to auto-establish a session when DISABLE_AUTH is
// set. Revisit this whole mechanism once real multi-user sign-in
// exists for Beta -- see CLAUDE.md.
const DEV_USER_EMAIL = "kanjii@kijijiagency.com";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response = NextResponse.next({ request });
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  let {
    data: { user },
  } = await supabase.auth.getUser();

  const isDashboard = request.nextUrl.pathname.startsWith("/(dashboard)") ||
    [
      "/dashboard",
      "/pipeline",
      "/prospects",
      "/settings",
      "/discovery",
      "/evidence",
      "/revisit",
      "/organization",
      "/contacts",
    ].some((p) => request.nextUrl.pathname.startsWith(p));

  if (isDashboard && !user && process.env.DISABLE_AUTH === "true") {
    // Mints a real session for the one known dev account via the
    // admin API instead of skipping the login gate outright -- that
    // keeps RLS ("to authenticated") and every created_by/reviewed_by
    // attribution working exactly as they do with real sign-in, and
    // never sends an email, so it doesn't touch the rate limit that
    // prompted this. generateLink alone doesn't create a session; it
    // has to be redeemed via verifyOtp, which is what actually sets
    // the cookies through the client above.
    const admin = createServiceRoleClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: link } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: DEV_USER_EMAIL,
    });
    if (link?.properties?.hashed_token) {
      const { data: verified } = await supabase.auth.verifyOtp({
        token_hash: link.properties.hashed_token,
        type: "magiclink",
      });
      user = verified.user;
    }
  }

  if (isDashboard && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
