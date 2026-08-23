"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { colors, buttonPrimary } from "@/lib/ui";

const CALLBACK_ERROR_MESSAGE: Record<string, string> = {
  no_organization:
    "This email hasn't been invited to an organization yet. Ask your team admin for an invite.",
  auth: "Something went wrong signing you in. Try requesting a new link.",
};

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/pipeline`,
      },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main style={{ maxWidth: 360, margin: "120px auto", padding: 24 }}>
      <h1 style={{ fontSize: 22 }}>Fundraising AI</h1>
      <p style={{ color: colors.textMuted }}>Sign in to continue.</p>
      {sent ? (
        <p>Check your email for a sign-in link.</p>
      ) : (
        <>
          <input
            type="email"
            placeholder="you@org.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              width: "100%",
              padding: 10,
              marginBottom: 10,
              boxSizing: "border-box",
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 6,
            }}
          />
          <button onClick={handleLogin} style={{ ...buttonPrimary, width: "100%", boxSizing: "border-box" }}>
            Send sign-in link
          </button>
          {error && <p style={{ color: "crimson" }}>{error}</p>}
          {!error && callbackError && (
            <p style={{ color: "crimson" }}>
              {CALLBACK_ERROR_MESSAGE[callbackError] ?? CALLBACK_ERROR_MESSAGE.auth}
            </p>
          )}
        </>
      )}
    </main>
  );
}
