"use client";

import { useRef, useState, useTransition } from "react";
import { createOrgAndInviteFirstUser } from "./actions";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, buttonPrimary } from "@/lib/ui";

// A plain <form action={serverAction}> turns any thrown error inside
// the action into a full page crash (no client-side handler to catch
// it) -- this wrapper submits via startTransition instead and checks
// the action's returned { error } | { success } so a real failure
// (e.g. Postmark misconfigured) shows as a message here, not a blank
// error page.
export default function CreateOrgForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const formData = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await createOrgAndInviteFirstUser(formData);
          if ("error" in result) setError(result.error);
          else formRef.current?.reset();
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
    </form>
  );
}
