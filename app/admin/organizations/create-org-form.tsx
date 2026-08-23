"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { createOrgAndInviteFirstUser } from "./actions";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, buttonPrimary } from "@/lib/ui";

const SUCCESS_DISPLAY_MS = 4000;

// A plain <form action={serverAction}> turns any thrown error inside
// the action into a full page crash (no client-side handler to catch
// it) -- this wrapper submits via startTransition instead and checks
// the action's returned { error } | { success } so a real failure
// (e.g. Postmark misconfigured) shows as a message here, not a blank
// error page. Success also needs its own visible feedback -- the form
// just silently resetting is easy to miss, especially since the new
// org/invite it caused only shows up in the list below, off to the
// side of where the click happened.
export default function CreateOrgForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    if (!sentTo) return;
    const timer = setTimeout(() => setSentTo(null), SUCCESS_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [sentTo]);

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setSentTo(null);
        const formData = new FormData(e.currentTarget);
        const email = formData.get("email") as string;
        startTransition(async () => {
          const result = await createOrgAndInviteFirstUser(formData);
          if ("error" in result) setError(result.error);
          else {
            formRef.current?.reset();
            setSentTo(email);
          }
        });
      }}
      style={{ display: "grid", gap: spacing.md, marginTop: spacing.lg, ...sectionStyle }}
    >
      <label style={labelStyle}>
        Organization name
        <input name="name" required placeholder="e.g. Riverside Community Church" style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        First user's email
        <input name="email" type="email" required placeholder="you@org.com" style={fieldStyle} />
      </label>
      <button type="submit" disabled={isPending} style={{ ...buttonPrimary, justifySelf: "start" }}>
        {isPending ? "Creating…" : "Create organization & send invite"}
      </button>
      {error && <p style={{ color: colors.red600, fontSize: 13, margin: 0 }}>{error}</p>}
      {sentTo && (
        <p style={{ display: "flex", alignItems: "center", gap: 6, color: colors.teal700, fontSize: 13, margin: 0 }}>
          <Check size={14} /> Invite sent to {sentTo}
        </p>
      )}
    </form>
  );
}
