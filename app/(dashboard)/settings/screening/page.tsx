import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { channelLabel, CHANNELS } from "@/lib/prospects";
import { OPERATORS, importanceLabel, summarizeByChannel, type ScreeningRule } from "@/lib/screening";
import DeleteRuleButton from "./delete-rule-button";
import { spacing, colors, type as typeScale, radius, buttonPrimary, cardStyle, chipStyle } from "@/lib/ui";

export default async function ScreeningRulesPage() {
  const supabase = createClient();
  const { data: rules, error } = await supabase
    .from("screening_rules")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<ScreeningRule[]>();

  const channelSummaries = summarizeByChannel(
    rules ?? [],
    CHANNELS.map((c) => c.value)
  ).filter((s) => s.activeRuleCount > 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xl }}>
        <div>
          <h1 style={{ fontSize: typeScale.pageTitle }}>Screening Rules</h1>
          <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
            These rules drive the tier a prospect gets when someone clicks "Screen." Screening only
            classifies — it never moves a prospect's stage.
          </p>
        </div>
        <Link href="/settings/screening/new" style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
          <Plus size={15} /> New Rule
        </Link>
      </div>

      {error && <p style={{ color: "crimson" }}>Error loading rules: {error.message}</p>}

      {channelSummaries.length > 0 && (
        <div style={{ ...cardStyle, marginBottom: spacing.xl, background: colors.bgSubtle }}>
          <h2 style={{ fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm }}>
            What it takes to hit each tier, right now
          </h2>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: colors.textMuted }}>
                <th style={{ padding: "4px 8px" }}>Channel</th>
                <th style={{ padding: "4px 8px" }}>Active rules</th>
                <th style={{ padding: "4px 8px" }}>Max points</th>
                <th style={{ padding: "4px 8px" }}>Tier 1 needs</th>
                <th style={{ padding: "4px 8px" }}>Tier 2 needs</th>
              </tr>
            </thead>
            <tbody>
              {channelSummaries.map((s) => (
                <tr key={s.channel}>
                  <td style={{ padding: "4px 8px" }}>{channelLabel(s.channel)}</td>
                  <td style={{ padding: "4px 8px" }}>{s.activeRuleCount}</td>
                  <td style={{ padding: "4px 8px" }}>{s.maxPoints}</td>
                  <td style={{ padding: "4px 8px" }}>{s.tier1Threshold}+ points</td>
                  <td style={{ padding: "4px 8px" }}>{s.tier2Threshold}+ points</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "grid", gap: spacing.sm }}>
        {rules?.map((r) => {
          const operatorLabel = OPERATORS.find((o) => o.value === r.criterion.operator)?.label ?? r.criterion.operator;
          return (
            <div key={r.id} style={{ ...cardStyle, borderRadius: radius }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <span style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
                    <strong>{r.label}</strong>
                    <span style={chipStyle(r.active ? "teal" : "neutral")}>{r.active ? "Active" : "Inactive"}</span>
                  </span>
                  <div style={{ fontSize: 13, color: colors.text, marginTop: spacing.xs }}>
                    {r.criterion.field} {operatorLabel} {r.criterion.value ?? ""} — {importanceLabel(r.weight)} —{" "}
                    {r.channel ? channelLabel(r.channel) : "all channels"}
                  </div>
                  {r.description && (
                    <div style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.xs }}>{r.description}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: spacing.sm }}>
                  <Link href={`/settings/screening/${r.id}`} style={{ fontSize: 13 }}>
                    Edit
                  </Link>
                  <DeleteRuleButton id={r.id} label={r.label} />
                </div>
              </div>
            </div>
          );
        })}
        {rules?.length === 0 && <p style={{ color: colors.textFaint }}>No screening rules yet.</p>}
      </div>
    </div>
  );
}
