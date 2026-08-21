"use client";

import { useState, useTransition } from "react";
import { updateAutoSearchSettings, type AutoSearchSettings } from "./auto-search-actions";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, cardStyle } from "@/lib/ui";

export default function AutoSearchForm({ settings }: { settings: AutoSearchSettings | null }) {
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [threshold, setThreshold] = useState(settings?.queue_threshold ?? 15);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div style={{ ...cardStyle, maxWidth: 480 }}>
      <h2 style={{ fontSize: 16 }}>Overnight Auto-Search</h2>
      <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
        When on, searches all channels once a night to keep this queue topped up -- stopping once
        it finds about 10 new candidates, or skipping the night entirely if your Strategies to
        Review queue is already at or above the threshold below (accepting a candidate triggers a
        deep-dive that lands there, so finding more candidates while that queue is backed up just
        adds more strain, not less). Nothing is ever accepted automatically; this only adds to the
        same review queue manual and AI-search candidates already land in.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: spacing.sm, marginTop: spacing.lg }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span style={{ fontSize: 14 }}>Enabled</span>
      </label>

      <label style={{ ...labelStyle, display: "block", marginTop: spacing.md, maxWidth: 240 }}>
        Skip the night's run if Strategies to Review already has at least
        <input
          type="number"
          min={1}
          value={threshold}
          onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
          style={fieldStyle}
        />
        waiting
      </label>

      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            await updateAutoSearchSettings(enabled, threshold);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          })
        }
        style={{ ...buttonPrimary, marginTop: spacing.md }}
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      {saved && <span style={{ marginLeft: spacing.sm, fontSize: 13, color: colors.success }}>✓ Saved</span>}
    </div>
  );
}
