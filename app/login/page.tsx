"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { colors, buttonPrimary } from "@/lib/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/pipeline` },
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
        </>
      )}
    </main>
  );
}
