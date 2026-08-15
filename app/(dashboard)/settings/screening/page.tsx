import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { channelLabel, CHANNELS } from "@/lib/prospects";
import { OPERATORS, importanceLabel, summarizeByChannel, type ScreeningRule } from "@/lib/screening";
import DeleteRuleButton from "./delete-rule-button";

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1>Screening Rules</h1>
          <p style={{ color: "#64748b", fontSize: 14 }}>
            These rules drive the tier a prospect gets when someone clicks "Screen." Screening only
            classifies — it never moves a prospect's stage.
          </p>
        </div>
        <Link
          href="/settings/screening/new"
          style={{ padding: "8px 16px", background: "#0f172a", color: "#fff", borderRadius: 6, textDecoration: "none" }}
        >
          + New Rule
        </Link>
      </div>

      {error && <p style={{ color: "crimson" }}>Error loading rules: {error.message}</p>}

      {channelSummaries.length > 0 && (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: 12, marginBottom: 20, background: "#f8fafc" }}>
          <h2 style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>What it takes to hit each tier, right now</h2>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b" }}>
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

      <div style={{ display: "grid", gap: 8 }}>
        {rules?.map((r) => {
          const operatorLabel = OPERATORS.find((o) => o.value === r.criterion.operator)?.label ?? r.criterion.operator;
          return (
            <div key={r.id} style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <strong>{r.label}</strong>{" "}
                  <span style={{ fontSize: 12, color: r.active ? "#16a34a" : "#94a3b8" }}>
                    {r.active ? "Active" : "Inactive"}
                  </span>
                  <div style={{ fontSize: 13, color: "#334155", marginTop: 4 }}>
                    {r.criterion.field} {operatorLabel} {r.criterion.value ?? ""} — {importanceLabel(r.weight)} —{" "}
                    {r.channel ? channelLabel(r.channel) : "all channels"}
                  </div>
                  {r.description && <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{r.description}</div>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Link href={`/settings/screening/${r.id}`} style={{ fontSize: 13 }}>
                    Edit
                  </Link>
                  <DeleteRuleButton id={r.id} label={r.label} />
                </div>
              </div>
            </div>
          );
        })}
        {rules?.length === 0 && <p style={{ color: "#94a3b8" }}>No screening rules yet.</p>}
      </div>
    </div>
  );
}
