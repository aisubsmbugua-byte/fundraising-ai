"use client";

import { useState, useTransition } from "react";
import { retryVerification } from "./research-actions";
import { buttonSecondary, colors, spacing } from "@/lib/ui";

// Retrying re-reads the stored evidence ledger; it never re-runs research.
// A failed check must not cost a dossier.
export default function VerifyRetry({ runId }: { runId: string }) {
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
        {pending ? "Checking..." : "Retry check"}
      </button>
      {error && <span style={{ fontSize: 12, color: colors.danger }}>{error}</span>}
    </span>
  );
}
