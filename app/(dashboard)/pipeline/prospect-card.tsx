import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { STAGES, channelColor, computeHealthStatus, formatAmountCompact, type Prospect } from "@/lib/prospects";
import { colors, spacing } from "@/lib/ui";
import TierBadge from "@/components/TierBadge";
import HealthChip from "@/components/HealthChip";
import NextActionPopover from "@/components/NextActionPopover";

// Deliberately light -- no inline stage control here anymore (that
// moved to the prospect detail page, see MoveStageControl there).
// The 6-dot track is the one distinctive touch: a pipeline is
// fundamentally about progression, so the card shows progression at
// a glance instead of just a static bucket label.
export default function ProspectCard({
  prospect,
  tier,
  daysInStage,
}: {
  prospect: Prospect;
  tier?: number;
  daysInStage: number;
}) {
  const stageIndex = STAGES.findIndex((s) => s.value === prospect.stage);
  const health = computeHealthStatus(prospect.next_action_due);

  return (
    <Link
      href={`/prospects/${prospect.id}`}
      style={{
        display: "block",
        minWidth: 0,
        boxSizing: "border-box",
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${channelColor(prospect.channel)}`,
        borderRadius: 6,
        padding: "8px 10px",
        textDecoration: "none",
        color: colors.text,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {prospect.name}
      </div>
      {prospect.ask_amount != null && (
        <div style={{ fontSize: 12, fontWeight: 600, color: colors.textMuted, marginTop: 2 }}>
          {formatAmountCompact(prospect.ask_amount)}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 6,
        }}
      >
        <div style={{ display: "flex", gap: 3 }} title={`${Math.round(daysInStage)}d in stage`}>
          {STAGES.map((s, i) => (
            <span
              key={s.value}
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: i <= stageIndex ? colors.primary : colors.border,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: spacing.xs, flexShrink: 0 }}>
          {tier != null && <TierBadge tier={tier} />}
          <NextActionPopover
            prospectId={prospect.id}
            currentAction={prospect.next_action}
            currentDue={prospect.next_action_due}
            variant="icon"
          />
        </div>
      </div>
      {health && (
        <div style={{ marginTop: 6 }}>
          <HealthChip status={health} />
        </div>
      )}
      {prospect.next_action && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            marginTop: 6,
            fontSize: 11,
            color: colors.textMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <CalendarClock size={11} style={{ flexShrink: 0 }} />
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{prospect.next_action}</span>
          {prospect.next_action_due && (
            <span style={{ flexShrink: 0 }}>
              · {new Date(prospect.next_action_due + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
