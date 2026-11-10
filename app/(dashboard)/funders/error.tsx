"use client";

import { buttonSecondary, colors, spacing, type as typeScale } from "@/lib/ui";

export default function FundersError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Funder database</h1>
      <p style={{ color: colors.textMuted, fontSize: typeScale.body, marginTop: spacing.sm }}>
        Something went wrong while reading the funder database. Nothing was changed; this screen only reads.
      </p>
      <button type="button" onClick={reset} style={{ ...buttonSecondary, marginTop: spacing.lg }}>
        Try again
      </button>
    </div>
  );
}
