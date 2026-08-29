"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { channelLabel, type Prospect } from "@/lib/prospects";
import StrategyPanel from "../[id]/strategy-panel";
import { spacing, colors, radiusSm } from "@/lib/ui";
import type { StrategyRun } from "@/lib/strategy";

type Item = { prospect: Prospect; run: StrategyRun };

export default function StrategyReviewWorkspace({ items }: { items: Item[] }) {
  // Approving is tracked locally so the item drops out of the queue
  // immediately (no full reload) -- StrategyPanel's onApproved fires
  // right after approveStrategy succeeds.
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const remaining = items.filter((i) => !approvedIds.has(i.prospect.id));
  const selected = remaining.find((i) => i.prospect.id === selectedId) ?? remaining[0] ?? null;

  return (
    <div
      className="split-pane"
      style={{ display: "grid", gridTemplateColumns: "minmax(320px, 42%) 1fr", gap: spacing.lg, marginTop: spacing.lg }}
    >
      <div
        className={`split-pane-list${mobileDetailOpen ? " detail-active" : ""}`}
        style={{ minWidth: 0, display: "grid", gap: spacing.sm, alignContent: "start", maxHeight: "75vh", overflowY: "auto" }}
      >
        {remaining.map(({ prospect, run }) => (
          <button
            key={prospect.id}
            type="button"
            onClick={() => {
              setSelectedId(prospect.id);
              setMobileDetailOpen(true);
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: selected?.prospect.id === prospect.id ? colors.teal100 : colors.surface,
              border: `1px solid ${selected?.prospect.id === prospect.id ? colors.teal700 : colors.border}`,
              borderRadius: radiusSm,
              padding: spacing.sm,
              cursor: "pointer",
              boxSizing: "border-box",
            }}
          >
            <strong style={{ fontSize: 14 }}>{prospect.name}</strong>
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
              {channelLabel(prospect.channel)}
              {prospect.organization ? ` · ${prospect.organization}` : ""}
            </div>
            {run.strategy?.rationale && (
              <p
                style={{
                  fontSize: 12,
                  color: colors.textFaint,
                  marginTop: 4,
                  marginBottom: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {run.strategy.rationale}
              </p>
            )}
          </button>
        ))}
        {remaining.length === 0 && (
          <p style={{ fontSize: 13, color: colors.textFaint, padding: spacing.sm }}>
            Nothing waiting on review right now.
          </p>
        )}
      </div>

      <div className={`split-pane-detail${mobileDetailOpen ? " detail-active" : ""}`}>
        <button
          type="button"
          onClick={() => setMobileDetailOpen(false)}
          className="split-pane-back-button"
          style={{
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            color: colors.textMuted,
            fontSize: 13,
            cursor: "pointer",
            padding: 0,
            marginBottom: spacing.sm,
          }}
        >
          <ArrowLeft size={14} /> Back to list
        </button>
        {selected ? (
          <div>
            <h2 style={{ fontSize: 19, margin: 0 }}>{selected.prospect.name}</h2>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
              {channelLabel(selected.prospect.channel)}
              {selected.prospect.organization ? ` · ${selected.prospect.organization}` : ""}
            </div>
            <StrategyPanel
              key={selected.prospect.id}
              prospectId={selected.prospect.id}
              initialRun={selected.run}
              onApproved={() => setApprovedIds((prev) => new Set(prev).add(selected.prospect.id))}
            />
          </div>
        ) : (
          <div
            style={{
              border: `1px dashed ${colors.border}`,
              borderRadius: radiusSm,
              padding: spacing.xxl,
              textAlign: "center",
              color: colors.textFaint,
              fontSize: 14,
            }}
          >
            Select a prospect from the list to review its strategy.
          </div>
        )}
      </div>
    </div>
  );
}
