"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addSuggestedFunder } from "./reference-suggestion-actions";
import { buttonPrimary, colors, spacing, type as typeScale } from "@/lib/ui";
import type { SuggestionSource } from "@/lib/funder-reference/suggestions";

export default function AddSuggestedButton({ ein, source, name }: { ein: string; source: SuggestionSource; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: spacing.xs }}>
      <button
        type="button"
        disabled={pending}
        aria-label={`Add ${name} to my candidates`}
        style={{ ...buttonPrimary, opacity: pending ? 0.6 : 1, boxSizing: "border-box" }}
        onClick={() =>
          start(async () => {
            setMessage(null);
            const result = await addSuggestedFunder(ein, source);
            if ("error" in result) setMessage(result.error);
            else router.refresh();
          })
        }
      >
        {pending ? "Adding…" : "Add to my candidates"}
      </button>
      {message && (
        <span role="alert" style={{ color: colors.danger, fontSize: typeScale.meta, maxWidth: 260, textAlign: "right" }}>
          {message}
        </span>
      )}
    </div>
  );
}
