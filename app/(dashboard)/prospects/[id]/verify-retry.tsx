"use client";

import { useState, useTransition } from "react";
import { retryVerification } from "./research-actions";
import { buttonSecondary, colors, spacing } from "@/lib/ui";

// Retrying re-reads the stored evidence ledger; it never re-runs research.
// A failed check must not cost a dossier.
export default function VerifyRetry({
  runId,
  // "Retry check" is wrong the first time. A run whose verification was
  // SKIPPED (because the gate used to demand an EIN) has never been checked at
  // all, and offering to retry something that never happened reads as broken.
  label = "Retry check",
  pendingLabel = "Checking...",
}: {
  runId: string;
  label?: string;
  pendingLabel?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: spacing.xs }}>
      <button
        type="button"
        disabled={pending}
        style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12, opacity: pending ? 0.5 : 1 }}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await retryVerification(runId);
            if (result && "error" in result) setError(result.error);
          })
        }
      >
        {pending ? pendingLabel : label}
      </button>
      {error && <span style={{ fontSize: 12, color: colors.danger }}>{error}</span>}
    </span>
  );
}
