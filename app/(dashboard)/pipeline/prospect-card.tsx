import Link from "next/link";
import { STAGES, channelColor, computeHealthStatus, formatAmountCompact, type Prospect } from "@/lib/prospects";
import { colors } from "@/lib/ui";
import TierBadge from "@/components/TierBadge";
import HealthChip from "@/components/HealthChip";

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
        {tier != null && <TierBadge tier={tier} />}
      </div>
      {health && (
        <div style={{ marginTop: 6 }}>
          <HealthChip status={health} />
        </div>
      )}
    </Link>
  );
}
