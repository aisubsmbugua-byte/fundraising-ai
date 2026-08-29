"use client";

import { useState, useTransition } from "react";
import { triggerVerification } from "./actions";
import { buttonSecondary, colors, spacing } from "@/lib/ui";

// Stage 5 is opt-in per run rather than automatic: it costs a model call, and
// a run whose entity was never confirmed cannot be meaningfully verified at
// all -- the action refuses those, and the reason belongs in front of the
// operator rather than in a log.
export default function VerifyButton({ runId, disabled, disabledReason }: { runId: string; disabled: boolean; disabledReason?: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ marginTop: spacing.xs, display: "flex", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" }}>
      <button
        type="button"
        disabled={pending || disabled}
        title={disabled ? disabledReason : undefined}
        style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12, opacity: pending || disabled ? 0.5 : 1 }}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            setMessage(null);
            const result = await triggerVerification(runId);
            if ("error" in result) setError(result.error);
            else {
              const summary = Object.entries(result.verdicts)
                .map(([v, n]) => `${n} ${v.replace(/_/g, " ")}`)
                .join(", ");
              setMessage(result.verified === 0 ? "No material claims to verify." : `Verified ${result.verified}: ${summary}`);
            }
          })
        }
      >
        {pending ? "Verifying..." : "Verify material claims"}
      </button>
      {message && <span style={{ fontSize: 12, color: colors.textMuted }}>{message}</span>}
      {error && <span style={{ fontSize: 12, color: colors.danger }}>{error}</span>}
    </div>
  );
}
