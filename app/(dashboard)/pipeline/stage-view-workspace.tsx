"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  STAGES,
  channelColor,
  channelLabel,
  stageLabel,
  formatAmountCompact,
  computeHealthStatus,
  type Prospect,
} from "@/lib/prospects";
import { spacing, colors, radiusSm, sectionStyle, chipStyle, buttonSecondary } from "@/lib/ui";
import TierBadge from "@/components/TierBadge";
import HealthChip from "@/components/HealthChip";
import InitialsAvatar from "@/components/InitialsAvatar";
import NextActionPopover from "@/components/NextActionPopover";
import ContactPopover from "@/components/ContactPopover";
import EditableAskAmount from "@/components/EditableAskAmount";
import AdvanceStageButton from "@/app/(dashboard)/prospects/[id]/advance-stage-button";

// Same list+detail split-pane pattern as Follow-up/Donor Finder/
// Strategy Review, so a stage's queue works like the rest of the app
// instead of being a stack of Links out to each prospect's own page.
export default function StageViewWorkspace({
  stage,
  prospects,
  tierByProspect,
  daysInStageByProspect,
}: {
  stage: string;
  prospects: Prospect[];
  tierByProspect: Record<string, number>;
  daysInStageByProspect: Record<string, number>;
}) {
  const [movedIds, setMovedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const remaining = prospects.filter((p) => !movedIds.has(p.id));
  const selected = remaining.find((p) => p.id === selectedId) ?? remaining[0] ?? null;
  const stageIndex = STAGES.findIndex((s) => s.value === stage);
  const nextStage = STAGES[stageIndex + 1];

  return (
    <div style={{ marginTop: spacing.lg }}>
      <Link href="/pipeline" style={{ fontSize: 13, color: colors.textMuted, textDecoration: "none" }}>
        ← All stages
      </Link>
      <h2 style={{ fontSize: 16, marginTop: spacing.sm, marginBottom: spacing.md }}>
        {stageLabel(stage)} ({remaining.length})
      </h2>

      <div
        className="split-pane"
        style={{ display: "grid", gridTemplateColumns: "minmax(320px, 42%) 1fr", gap: spacing.lg }}
      >
        <div
          className={`split-pane-list${mobileDetailOpen ? " detail-active" : ""}`}
          style={{ minWidth: 0, display: "grid", gap: spacing.sm, alignContent: "start", maxHeight: "75vh", overflowY: "auto" }}
        >
          {remaining.map((p) => {
            const health = computeHealthStatus(p.next_action_due);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSelectedId(p.id);
                  setMobileDetailOpen(true);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  minWidth: 0,
                  boxSizing: "border-box",
                  background: selected?.id === p.id ? colors.teal100 : colors.surface,
                  border: `1px solid ${selected?.id === p.id ? colors.teal700 : colors.border}`,
                  borderLeft: `3px solid ${channelColor(p.channel)}`,
                  borderRadius: radiusSm,
                  padding: spacing.sm,
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
                  <strong style={{ fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </strong>
                  {tierByProspect[p.id] != null && <TierBadge tier={tierByProspect[p.id]} />}
                </div>
                <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                  {channelLabel(p.channel)}
                  {p.ask_amount != null ? ` · ${formatAmountCompact(p.ask_amount)}` : ""}
                  {` · ${Math.round(daysInStageByProspect[p.id] ?? 0)}d in stage`}
                </div>
                {p.next_action && (
                  <div
                    style={{
                      fontSize: 12,
                      color: colors.textFaint,
                      marginTop: 4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Next: {p.next_action}
                  </div>
                )}
                {health && (
                  <div style={{ marginTop: 6 }}>
                    <HealthChip status={health} />
                  </div>
                )}
              </button>
            );
          })}
          {remaining.length === 0 && (
            <p style={{ fontSize: 13, color: colors.textMuted, padding: spacing.sm }}>No prospects in this stage.</p>
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
            <div style={{ display: "grid", gap: spacing.lg }}>
              <div style={sectionStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
                  <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
                    <InitialsAvatar name={selected.name} size={44} />
                    <div style={{ minWidth: 0 }}>
                      <h2 style={{ fontSize: 17, overflowWrap: "break-word" }}>{selected.name}</h2>
                      <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                        {channelLabel(selected.channel)}
                        {selected.organization ? ` · ${selected.organization}` : ""}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: spacing.xs, marginTop: spacing.xs }}>
                        <span style={chipStyle("neutral")}>{stageLabel(selected.stage)}</span>
                        {tierByProspect[selected.id] != null && <TierBadge tier={tierByProspect[selected.id]} />}
                      </div>
                    </div>
                  </div>
                  <Link href={`/prospects/${selected.id}`} style={{ ...buttonSecondary, flexShrink: 0 }}>
                    Open prospect →
                  </Link>
                </div>
                {nextStage && (
                  <div style={{ marginTop: spacing.md }}>
                    <AdvanceStageButton
                      prospectId={selected.id}
                      currentStage={selected.stage}
                      nextStage={nextStage.value}
                      onMoved={() => setMovedIds((prev) => new Set(prev).add(selected.id))}
                    />
                  </div>
                )}
              </div>

              <EditableAskAmount prospectId={selected.id} askAmount={selected.ask_amount} />

              <div style={sectionStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ fontSize: 14, margin: 0 }}>Next action</h3>
                  <NextActionPopover
                    prospectId={selected.id}
                    currentAction={selected.next_action}
                    currentDue={selected.next_action_due}
                  />
                </div>
                {selected.next_action ? (
                  <div style={{ marginTop: spacing.sm }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{selected.next_action}</div>
                    {selected.next_action_due && (
                      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                        Due {new Date(selected.next_action_due + "T00:00:00").toLocaleDateString()}
                      </div>
                    )}
                  </div>
                ) : (
                  <p style={{ fontSize: 13, color: colors.textFaint, margin: 0, marginTop: spacing.sm }}>No next action set.</p>
                )}
              </div>

              <div style={sectionStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ fontSize: 14, margin: 0 }}>Key contact</h3>
                  <ContactPopover prospectId={selected.id} currentName={selected.contact_name} currentEmail={selected.contact_email} />
                </div>
                {selected.contact_name || selected.contact_email ? (
                  <div style={{ marginTop: spacing.sm }}>
                    {selected.contact_name && <div style={{ fontSize: 14, fontWeight: 600 }}>{selected.contact_name}</div>}
                    {selected.contact_email && (
                      <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>{selected.contact_email}</div>
                    )}
                  </div>
                ) : (
                  <p style={{ fontSize: 13, color: colors.textFaint, margin: 0, marginTop: spacing.sm }}>No contact identified yet.</p>
                )}
              </div>
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
              Select a prospect from the list to see details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
