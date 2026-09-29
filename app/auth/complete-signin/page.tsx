"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { colors } from "@/lib/ui";
import { parseHashTokens } from "@/lib/auth-callback";
import { completeSignInAfterHashAuth } from "./actions";

// Reachable only via app/auth/callback/route.ts's no-?code= redirect
// (the hash-token path taken after an admin-issued invite/magic link --
// see lib/invite.ts). Supabase's verify redirect attaches
// #access_token=...&refresh_token=... to the URL the browser is
// actually on; that fragment is never sent to a server, but it DOES
// survive route.ts's redirect here because that redirect's own target
// carries no fragment of its own. This page picks it up client-side.
export default function CompleteSignInPage() {
  return (
    <Suspense>
      <CompleteSignIn />
    </Suspense>
  );
}

function CompleteSignIn() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/pipeline";

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const tokens = parseHashTokens(window.location.hash);
      if (!tokens) {
        // No hash tokens at all (stale bookmark, direct navigation,
        // whatever) -- same auth error state as any other failed
        // sign-in, not a crash.
        if (!cancelled) router.replace("/login?error=auth");
        return;
      }

      const supabase = createClient();
      const { error } = await supabase.auth.setSession(tokens);
      if (error) {
        if (!cancelled) router.replace("/login?error=auth");
        return;
      }

      // Cookies are written; the server action below runs against the
      // now-authenticated session and redirects on to `next` (or to the
      // shared error routes) itself.
      await completeSignInAfterHashAuth(next);
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [next, router]);

  return (
    <main style={{ maxWidth: 360, margin: "120px auto", padding: 24 }}>
      <p style={{ color: colors.textMuted }}>Signing you in…</p>
    </main>
  );
}
