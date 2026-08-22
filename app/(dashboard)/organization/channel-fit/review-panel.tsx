"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { reviewChannelMatch } from "./actions";
import { channelLabel } from "@/lib/prospects";
import { colors, spacing, radiusSm, buttonPrimary, buttonSecondary, chipStyle, cardStyle } from "@/lib/ui";
import type { ChannelEvaluation } from "@/lib/channel-match";
import type { LucideIcon } from "lucide-react";

const CONFIDENCE_TONE: Record<ChannelEvaluation["confidence"], "teal" | "amber" | "neutral"> = {
  high: "teal",
  medium: "amber",
  low: "neutral",
};

export default function ReviewPanel({
  runId,
  evaluations,
  approvedChannels,
  icons,
  countByChannel,
}: {
  runId: string;
  evaluations: ChannelEvaluation[];
  approvedChannels: string[] | null;
  icons: Record<string, LucideIcon>;
  countByChannel: Map<string, number>;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(approvedChannels ?? evaluations.filter((e) => e.recommended).map((e) => e.channel))
  );
  const [isPending, startTransition] = useTransition();
  const isReviewed = approvedChannels !== null;

  function toggle(channel: string) {
    if (isReviewed) return;
    const next = new Set(selected);
    if (next.has(channel)) next.delete(channel);
    else next.add(channel);
    setSelected(next);
  }

  return (
    <div>
      <div style={{ display: "grid", gap: spacing.sm }}>
        {evaluations.map((e) => {
          const Icon = icons[e.channel];
          const count = countByChannel.get(e.channel) ?? 0;
          return (
            <div key={e.channel} style={{ ...cardStyle, display: "flex", alignItems: "flex-start", gap: spacing.sm }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: spacing.sm, flex: 1, minWidth: 0, cursor: isReviewed ? "default" : "pointer" }}>
                <input
                  type="checkbox"
                  checked={selected.has(e.channel)}
                  onChange={() => toggle(e.channel)}
                  disabled={isReviewed}
                  style={{ marginTop: 4, flexShrink: 0 }}
                />
                {Icon && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 28,
                      height: 28,
                      borderRadius: radiusSm,
                      background: colors.surfaceSubtle,
                      color: colors.navy500,
                      flexShrink: 0,
                    }}
                  >
                    <Icon size={15} />
                  </span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14 }}>{channelLabel(e.channel)}</strong>
                    <span style={chipStyle(CONFIDENCE_TONE[e.confidence])}>
                      {e.recommended ? "Recommended" : "Not recommended"} · {e.confidence} confidence
                    </span>
                  </div>
                  <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.xs, marginBottom: 0 }}>{e.rationale}</p>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.xs }}>
                    {count} {count === 1 ? "opportunity" : "opportunities"} already in the funnel for this channel
                  </div>
                </div>
              </label>
              <Link href="/discovery" prefetch={false} style={{ ...buttonSecondary, padding: "6px 12px", fontSize: 13, flexShrink: 0 }}>
                Explore
              </Link>
            </div>
          );
        })}
      </div>

      {!isReviewed ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(() => {
              reviewChannelMatch(runId, Array.from(selected));
            })
          }
          style={{ ...buttonPrimary, marginTop: spacing.lg }}
        >
          {isPending ? "Saving…" : "Confirm Selections"}
        </button>
      ) : (
        <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.md }}>
          ✓ Reviewed — {selected.size} channel{selected.size === 1 ? "" : "s"} confirmed.
        </p>
      )}
    </div>
  );
}
