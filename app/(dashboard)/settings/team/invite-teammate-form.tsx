"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { inviteTeammate } from "./actions";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, buttonPrimary } from "@/lib/ui";

const SUCCESS_DISPLAY_MS = 4000;

// Same reasoning as app/admin/organizations/create-org-form.tsx: a
// plain <form action={serverAction}> has no client-side handler, so a
// thrown error inside the action crashes the whole page instead of
// showing a message. Submitting via startTransition and checking the
// returned { error } | { success } instead -- and showing success
// explicitly too, since the form silently resetting on its own isn't
// a clear enough signal that the invite actually sent.
export default function InviteTeammateForm() {
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
          const result = await inviteTeammate(formData);
          if ("error" in result) setError(result.error);
          else {
            formRef.current?.reset();
            setSentTo(email);
          }
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
      {sentTo && (
        <p style={{ display: "flex", alignItems: "center", gap: 6, color: colors.teal700, fontSize: 13, margin: 0 }}>
          <Check size={14} /> Invite sent to {sentTo}
        </p>
      )}
    </form>
  );
}
