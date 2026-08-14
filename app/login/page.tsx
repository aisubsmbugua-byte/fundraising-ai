"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/pipeline` },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main style={{ maxWidth: 360, margin: "120px auto", padding: 24 }}>
      <h1 style={{ fontSize: 22 }}>Fundraising AI</h1>
      <p style={{ color: "#666" }}>Sign in to continue.</p>
      {sent ? (
        <p>Check your email for a sign-in link.</p>
      ) : (
        <>
          <input
            type="email"
            placeholder="you@org.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: 10, marginBottom: 10 }}
          />
          <button onClick={handleLogin} style={{ width: "100%", padding: 10 }}>
            Send sign-in link
          </button>
          {error && <p style={{ color: "crimson" }}>{error}</p>}
        </>
      )}
    </main>
  );
}
