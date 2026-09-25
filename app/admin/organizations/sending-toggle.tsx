"use client";

import { useState, useTransition } from "react";
import { setOrganizationSendingEnabled } from "./actions";
import { spacing, colors, buttonPrimary, buttonSecondary } from "@/lib/ui";

// Ruling 0032: shows whether funder-facing sending is switched on for an
// organization and lets a superadmin flip it. The server action re-verifies
// superadmin itself; this control is convenience, not the gate.
export default function SendingToggle({ organizationId, enabled }: { organizationId: string; enabled: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ marginTop: spacing.sm }}>
      <span style={{ fontSize: 13, color: enabled ? colors.success : colors.textMuted, marginRight: spacing.sm }}>
        Sending: {enabled ? "on" : "off"}
      </span>
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await setOrganizationSendingEnabled(organizationId, !enabled);
            if ("error" in result) setError(result.error);
          })
        }
        style={enabled ? buttonSecondary : buttonPrimary}
      >
        {isPending ? "Saving…" : enabled ? "Switch off" : "Switch on"}
      </button>
      {error && <p style={{ color: colors.danger, fontSize: 12, marginTop: spacing.xs }}>{error}</p>}
    </div>
  );
}
