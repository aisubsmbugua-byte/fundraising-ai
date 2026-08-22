import Link from "next/link";
import { STAGES, channelColor, channelLabel, computeHealthStatus, formatAmountCompact, type Prospect } from "@/lib/prospects";
import { colors, cardStyle } from "@/lib/ui";
import TierBadge from "@/components/TierBadge";
import HealthChip from "@/components/HealthChip";
import NextActionPopover from "@/components/NextActionPopover";

// The fuller counterpart to ProspectCard -- used on the single-stage
// drill-down (/pipeline?stage=X), where there's only one column of
// content instead of six, so there's room to show what the compact
// board view has to truncate: the full name, organization, and
// contact, plus the stage dots spelled out as a day count.
export default function ProspectRow({ prospect, tier, daysInStage }: { prospect: Prospect; tier?: number; daysInStage: number }) {
  const stageIndex = STAGES.findIndex((s) => s.value === prospect.stage);
  const health = computeHealthStatus(prospect.next_action_due);

  return (
    <Link
      href={`/prospects/${prospect.id}`}
      style={{
        ...cardStyle,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        borderLeft: `4px solid ${channelColor(prospect.channel)}`,
        textDecoration: "none",
        color: colors.text,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>{prospect.name}</strong>
          {prospect.ask_amount != null && (
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.textMuted }}>
              {formatAmountCompact(prospect.ask_amount)}
            </span>
          )}
          {tier != null && <TierBadge tier={tier} />}
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
          {channelLabel(prospect.channel)}
          {prospect.organization ? ` · ${prospect.organization}` : ""}
          {prospect.contact_name ? ` · ${prospect.contact_name}` : ""}
        </div>
        {prospect.next_action && (
          <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 2 }}>
            Next: {prospect.next_action}
            {prospect.next_action_due &&
              ` (${new Date(prospect.next_action_due + "T00:00:00").toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })})`}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {health && <HealthChip status={health} />}
        <div style={{ display: "flex", gap: 3 }}>
          {STAGES.map((s, i) => (
            <span
              key={s.value}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: i <= stageIndex ? colors.primary : colors.border,
              }}
            />
          ))}
        </div>
        <span style={{ fontSize: 12, color: colors.textFaint, whiteSpace: "nowrap" }}>
          {Math.round(daysInStage)}d in stage
        </span>
        <NextActionPopover
          prospectId={prospect.id}
          currentAction={prospect.next_action}
          currentDue={prospect.next_action_due}
          variant="icon"
        />
      </div>
    </Link>
  );
}
