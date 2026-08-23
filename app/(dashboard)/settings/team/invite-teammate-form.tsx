"use client";

import { useRef, useState, useTransition } from "react";
import { inviteTeammate } from "./actions";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, buttonPrimary } from "@/lib/ui";

// Same reasoning as app/admin/organizations/create-org-form.tsx: a
// plain <form action={serverAction}> has no client-side handler, so a
// thrown error inside the action crashes the whole page instead of
// showing a message. Submitting via startTransition and checking the
// returned { error } | { success } instead.
export default function InviteTeammateForm() {
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
          const result = await inviteTeammate(formData);
          if ("error" in result) setError(result.error);
          else formRef.current?.reset();
        });
      }}
      style={{ display: "grid", gap: spacing.sm, marginTop: spacing.xl, ...sectionStyle }}
    >
      <div style={{ display: "flex", gap: spacing.sm }}>
        <label style={{ ...labelStyle, flex: 1 }}>
          Invite a teammate by email
          <input name="email" type="email" required placeholder="teammate@org.com" style={fieldStyle} />
        </label>
        <button type="submit" disabled={isPending} style={{ ...buttonPrimary, alignSelf: "flex-end" }}>
          {isPending ? "Sending…" : "Send invite"}
        </button>
      </div>
      {error && <p style={{ color: colors.red600, fontSize: 13, margin: 0 }}>{error}</p>}
    </form>
  );
}
