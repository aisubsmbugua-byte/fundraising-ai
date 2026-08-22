import Link from "next/link";
import { DollarSign, Layers, Clock, CalendarDays, type LucideIcon } from "lucide-react";
import { channelLabel, stageLabel, type Prospect, type StageChange } from "@/lib/prospects";
import { tierLabel, type ScreeningResult } from "@/lib/screening";
import type { DeepDiveRun } from "@/lib/deep-dive";
import { spacing, colors, radiusSm, sectionStyle, buttonSecondary } from "@/lib/ui";
import TierBadge from "@/components/TierBadge";

const MS_PER_DAY = 86400000;

export default function OverviewTab({
  prospect,
  daysInStage,
  latestScreening,
  deepDiveRun,
  recentHistory,
}: {
  prospect: Prospect;
  daysInStage: number;
  latestScreening: ScreeningResult | null;
  deepDiveRun: DeepDiveRun | null;
  recentHistory: StageChange[];
}) {
  return (
    <div style={{ display: "grid", gap: spacing.xl }}>
      <div>
        <h3 style={{ fontSize: 14 }}>Opportunity summary</h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: spacing.md,
            marginTop: spacing.sm,
          }}
        >
          <SummaryTile
            icon={DollarSign}
            label="Potential"
            value={prospect.ask_amount != null ? `$${prospect.ask_amount.toLocaleString("en-US")}` : "—"}
          />
          <SummaryTile icon={Layers} label="Channel" value={channelLabel(prospect.channel)} />
          <SummaryTile
            icon={CalendarDays}
            label="Last updated"
            value={new Date(prospect.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          />
          <SummaryTile icon={Clock} label="In stage" value={`${Math.round(daysInStage)}d`} />
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 14 }}>Screening</h3>
          {latestScreening && <TierBadge tier={latestScreening.tier} />}
        </div>
        {latestScreening ? (
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 6, margin: 0 }}>
            {latestScreening.breakdown.rules.map((r) => (
              <li key={r.rule_id} style={{ fontSize: 13, display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: r.passed ? colors.success : colors.textFaint }}>
                  {r.passed ? "✓" : "✗"} {r.label}
                </span>
                <span style={{ color: colors.textMuted }}>weight {r.weight}</span>
              </li>
            ))}
            {latestScreening.breakdown.rules.length === 0 && (
              <li style={{ fontSize: 13, color: colors.textFaint }}>
                No active rules applied to this channel — defaulted to {tierLabel(latestScreening.tier)}.
              </li>
            )}
          </ul>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>Not screened yet.</p>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 14 }}>AI strategy</h3>
          <Link href={`/prospects/${prospect.id}?tab=strategy`} style={{ fontSize: 13 }}>
            {deepDiveRun?.approved_strategy ? "View full strategy →" : "View →"}
          </Link>
        </div>
        {deepDiveRun?.approved_strategy ? (
          <div>
            <div
              style={{
                display: "inline-block",
                ...chipRow,
                background: colors.teal100,
                color: colors.teal700,
              }}
            >
              Approved{deepDiveRun.approved_at ? ` ${new Date(deepDiveRun.approved_at).toLocaleDateString()}` : ""}
            </div>
            <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.sm }}>
              {deepDiveRun.approved_strategy.rationale}
            </p>
          </div>
        ) : deepDiveRun?.status === "ready_for_review" ? (
          <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
            AI proposed a strategy — waiting on your review in Strategy review.
          </p>
        ) : deepDiveRun?.status === "error" ? (
          <p style={{ fontSize: 13, color: colors.danger, margin: 0 }}>{deepDiveRun.status_message}</p>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>AI is still researching this prospect.</p>
        )}
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 14 }}>Recent activity</h3>
          <Link href={`/prospects/${prospect.id}?tab=activity`} style={{ fontSize: 13 }}>
            View all →
          </Link>
        </div>
        {recentHistory.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, marginTop: spacing.sm, display: "grid", gap: spacing.sm }}>
            {recentHistory.map((h) => (
              <li key={h.id} style={{ fontSize: 13 }}>
                <strong>
                  {stageLabel(h.from_stage)} → {stageLabel(h.to_stage)}
                </strong>
                <div style={{ color: colors.textMuted, fontSize: 12 }}>
                  {h.changed_by_email} · {new Date(h.created_at).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint, marginTop: spacing.sm }}>No activity yet.</p>
        )}
      </div>
    </div>
  );
}

const chipRow: React.CSSProperties = {
  padding: "2px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
};

function SummaryTile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div style={sectionStyle}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: radiusSm,
          background: colors.teal100,
          color: colors.teal700,
        }}
      >
        <Icon size={14} />
      </span>
      <div style={{ fontSize: 12, color: colors.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}
