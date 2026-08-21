import Link from "next/link";
import { STAGES, channelColor, channelLabel, type Prospect } from "@/lib/prospects";
import { colors, cardStyle } from "@/lib/ui";
import TierBadge from "@/components/TierBadge";

// The fuller counterpart to ProspectCard -- used on the single-stage
// drill-down (/pipeline?stage=X), where there's only one column of
// content instead of six, so there's room to show what the compact
// board view has to truncate: the full name, organization, and
// contact, plus the stage dots spelled out as a day count.
export default function ProspectRow({ prospect, tier, daysInStage }: { prospect: Prospect; tier?: number; daysInStage: number }) {
  const stageIndex = STAGES.findIndex((s) => s.value === prospect.stage);

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
          {tier != null && <TierBadge tier={tier} />}
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
          {channelLabel(prospect.channel)}
          {prospect.organization ? ` · ${prospect.organization}` : ""}
          {prospect.contact_name ? ` · ${prospect.contact_name}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
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
      </div>
    </Link>
  );
}
