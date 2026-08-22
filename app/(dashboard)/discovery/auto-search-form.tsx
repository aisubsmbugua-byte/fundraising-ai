"use client";

import { useState, useTransition } from "react";
import { updateAutoSearchSettings, type AutoSearchSettings } from "./auto-search-actions";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

export default function AutoSearchForm({ settings }: { settings: AutoSearchSettings | null }) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [threshold, setThreshold] = useState(settings?.queue_threshold ?? 15);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={buttonSecondary}>
        Auto-Search
        <span
          title={enabled ? "Enabled" : "Disabled"}
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: "50%",
            marginLeft: spacing.sm,
            background: enabled ? colors.success : colors.borderStrong,
          }}
        />
      </button>

      {open && (
        <>
          <div
            role="presentation"
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              width: 320,
              background: "#fff",
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              padding: spacing.lg,
              boxShadow: "0 10px 40px rgba(0,0,0,0.15)",
              zIndex: 41,
            }}
          >
            <h3 style={{ fontSize: 15 }}>Overnight Auto-Search</h3>
            <p style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.xs }}>
              When on, searches all channels once a night to keep this queue topped up -- stopping
              once it finds about 10 new candidates, or skipping the night entirely if your
              Strategies to Review queue is already at or above the threshold below. Nothing is
              ever accepted automatically.
            </p>

            <label style={{ display: "flex", alignItems: "center", gap: spacing.sm, marginTop: spacing.md }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span style={{ fontSize: 14 }}>Enabled</span>
            </label>

            <label style={{ ...labelStyle, display: "block", marginTop: spacing.md }}>
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

            <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, marginTop: spacing.md }}>
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
                style={buttonPrimary}
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              {saved && <span style={{ fontSize: 13, color: colors.success }}>✓ Saved</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
