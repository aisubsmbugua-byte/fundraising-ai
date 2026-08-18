"use client";

import { useState, useTransition } from "react";
import { reviewChannelMatch } from "./actions";
import { channelLabel } from "@/lib/prospects";
import { colors, buttonPrimary, cardStyle } from "@/lib/ui";
import type { ChannelEvaluation } from "@/lib/channel-match";

export default function ReviewPanel({
  runId,
  evaluations,
  approvedChannels,
}: {
  runId: string;
  evaluations: ChannelEvaluation[];
  approvedChannels: string[] | null;
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
      <div style={{ display: "grid", gap: 12 }}>
        {evaluations.map((e) => (
          <div key={e.channel} style={cardStyle}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: isReviewed ? "default" : "pointer" }}>
              <input
                type="checkbox"
                checked={selected.has(e.channel)}
                onChange={() => toggle(e.channel)}
                disabled={isReviewed}
                style={{ marginTop: 4 }}
              />
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{channelLabel(e.channel)}</strong>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: e.recommended ? "#dcfce7" : "#f1f5f9",
                      color: e.recommended ? "#166534" : colors.textMuted,
                    }}
                  >
                    AI: {e.recommended ? "Recommended" : "Not recommended"} ({e.confidence} confidence)
                  </span>
                </div>
                <p style={{ fontSize: 13, color: colors.text, marginTop: 4 }}>{e.rationale}</p>
              </div>
            </label>
          </div>
        ))}
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
          style={{ ...buttonPrimary, marginTop: 16 }}
        >
          {isPending ? "Saving…" : "Confirm Selections"}
        </button>
      ) : (
        <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 12 }}>
          ✓ Reviewed — {selected.size} channel{selected.size === 1 ? "" : "s"} confirmed.
        </p>
      )}
    </div>
  );
}
