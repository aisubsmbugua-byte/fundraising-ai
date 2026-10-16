"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { approveFromLink } from "./actions";
import { spacing, colors, buttonPrimary, buttonSecondary } from "@/lib/ui";

// Approve and Cancel for one approval link. Approve is the owner's decision;
// Cancel just leaves (the link stays unused until it expires).
export default function ApproveButton({ requestId, cancelHref }: { requestId: string; cancelHref: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ summary: string; href: string; warning?: string } | null>(null);

  if (done) {
    return (
      <div style={{ display: "grid", gap: spacing.sm }}>
        <p style={{ margin: 0, color: colors.teal700, fontWeight: 600 }}>{done.summary}</p>
        {done.warning && <p style={{ margin: 0, color: colors.amber700, fontSize: 13 }}>{done.warning}</p>}
        <div>
          <Link href={done.href} style={buttonSecondary}>
            Open the prospect
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={isPending}
          style={buttonPrimary}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await approveFromLink(requestId);
              if ("error" in result) setError(result.error);
              else setDone({ summary: result.summary, href: result.href, warning: result.warning });
            });
          }}
        >
          {isPending ? "Approving…" : "Approve"}
        </button>
        <Link href={cancelHref} style={buttonSecondary}>
          Cancel
        </Link>
      </div>
      {error && <p style={{ margin: 0, color: colors.red600, fontSize: 13 }}>{error}</p>}
    </div>
  );
}
