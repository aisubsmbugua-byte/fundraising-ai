"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { stageLabel, type StageChange } from "@/lib/prospects";
import { interactionKindLabel, type Interaction } from "@/lib/interactions";
import LogInteractionForm from "@/components/LogInteractionForm";
import { logInteraction } from "@/app/(dashboard)/revisit/actions";
import { spacing, colors, sectionStyle, buttonSecondary } from "@/lib/ui";

export default function ActivityTab({
  history,
  interactions,
  prospectId,
  defaultLogOpen = false,
}: {
  history: StageChange[];
  interactions: Interaction[];
  prospectId: string;
  defaultLogOpen?: boolean;
}) {
  const [logOpen, setLogOpen] = useState(defaultLogOpen);

  return (
    <div style={{ display: "grid", gap: spacing.lg }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 14 }}>Interaction history ({interactions.length})</h3>
          <button
            type="button"
            onClick={() => setLogOpen((o) => !o)}
            style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px" }}
          >
            <Plus size={13} /> Log
          </button>
        </div>

        {logOpen && (
          <LogInteractionForm
            onLog={(kind, summary, occurredAt) => logInteraction(prospectId, kind, summary, occurredAt)}
            onDone={() => setLogOpen(false)}
          />
        )}

        {interactions.length > 0 ? (
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
            {interactions.map((i) => (
              <div key={i.id} style={{ fontSize: 13 }}>
                <div>{i.summary}</div>
                <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 1 }}>
                  {interactionKindLabel(i.kind)} · {new Date(i.occurred_at + "T00:00:00").toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: `${spacing.sm}px 0 0` }}>No interactions logged yet.</p>
        )}
      </div>

      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14 }}>Stage history</h3>
        {history.length === 0 ? (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: `${spacing.sm}px 0 0` }}>No stage changes yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
            {history.map((h) => (
              <li key={h.id} style={{ fontSize: 13, borderBottom: `1px solid ${colors.bgSubtle}`, paddingBottom: spacing.sm }}>
                <strong>
                  {/* STATE item 79: a prospect added directly at a stage (not moved
                      there) writes a row with from_stage === to_stage -- "X → X"
                      would misread as a move that never happened, so it is named
                      for what it actually is. */}
                  {h.from_stage === h.to_stage ? `Added directly at ${stageLabel(h.to_stage)}` : `${stageLabel(h.from_stage)} → ${stageLabel(h.to_stage)}`}
                </strong>
                <div style={{ color: colors.textMuted, fontSize: 12 }}>
                  {h.changed_by_email} · {new Date(h.created_at).toLocaleString()}
                </div>
                {h.note && <div style={{ marginTop: spacing.xs }}>{h.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
