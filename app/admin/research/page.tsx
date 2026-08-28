import { createClient } from "@/lib/supabase/server";
import { colors, spacing, cardStyle, chipStyle, type as typeScale } from "@/lib/ui";
import ResearchPanel from "./research-panel";

// Live data every load -- runs and claims change as soon as a research
// call finishes, same reasoning as /admin/organizations.
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "teal" | "amber" | "red" | "neutral"> = {
  ready: "teal",
  researching: "amber",
  extracting: "amber",
  error: "red",
};

export default async function AdminResearchPage() {
  const supabase = createClient();

  const { data: prospects } = await supabase
    .from("prospects")
    .select("id, name, organization")
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: runs } = await supabase
    .from("research_runs")
    .select(
      "id, prospect_id, version, status, status_message, error_message, model, input_tokens, output_tokens, cost_usd, latency_ms, completed_at, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(20);

  const runIds = (runs ?? []).map((r) => r.id);
  const { data: claims } = await supabase
    .from("research_claims")
    .select("id, research_run_id, claim_key, category, claim, confidence, source_url")
    .in("research_run_id", runIds)
    .order("claim_key");

  const claimsByRun = new Map<string, NonNullable<typeof claims>>();
  for (const c of claims ?? []) {
    const list = claimsByRun.get(c.research_run_id) ?? [];
    list.push(c);
    claimsByRun.set(c.research_run_id, list);
  }

  const prospectNames = new Map((prospects ?? []).map((p) => [p.id, p.organization ? `${p.name} (${p.organization})` : p.name]));

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Research Agent</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Superadmin-only, dark evaluation tool for Build 1&apos;s Research Agent -- runs the extraction-only path in
        parallel to the live deep-dive workflow and never touches it. See{" "}
        <code style={{ fontSize: 13 }}>docs/decisions/0002-research-agent.md</code>.
      </p>

      <ResearchPanel prospects={prospects ?? []} />

      <div style={{ display: "grid", gap: spacing.md, marginTop: spacing.xxl }}>
        <h2 style={{ fontSize: typeScale.sectionTitle }}>Recent runs</h2>
        {(runs ?? []).map((run) => (
          <div key={run.id} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
              <div style={{ minWidth: 0 }}>
                <strong>{prospectNames.get(run.prospect_id) ?? run.prospect_id}</strong>
                <span style={{ color: colors.textMuted, fontSize: 13 }}> · v{run.version}</span>
              </div>
              <span style={chipStyle(STATUS_TONE[run.status] ?? "neutral")}>{run.status}</span>
            </div>

            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
              {run.status_message}
              {run.error_message ? ` -- ${run.error_message}` : ""}
            </div>

            {run.status === "ready" && (
              <div style={{ fontSize: 12.5, color: colors.textFaint, marginTop: spacing.xs }}>
                {run.model} · {run.input_tokens ?? 0}+{run.output_tokens ?? 0} tokens · $
                {run.cost_usd?.toFixed(4) ?? "0.0000"} · {run.latency_ms ? `${(run.latency_ms / 1000).toFixed(1)}s` : "--"}
              </div>
            )}

            {(claimsByRun.get(run.id) ?? []).length > 0 && (
              <div style={{ display: "grid", gap: spacing.xs, marginTop: spacing.md }}>
                {(claimsByRun.get(run.id) ?? []).map((claim) => (
                  <div key={claim.id} style={{ fontSize: 13.5, borderTop: `1px solid ${colors.border}`, paddingTop: spacing.xs }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: colors.textMuted }}>{claim.claim_key}</span>
                    <span style={{ marginLeft: spacing.sm }}>{claim.claim}</span>
                    <span style={{ marginLeft: spacing.sm, color: colors.textFaint, fontSize: 12 }}>({claim.confidence})</span>
                    {claim.source_url && (
                      <div style={{ fontSize: 12, color: colors.textFaint, wordBreak: "break-all" }}>{claim.source_url}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {(runs ?? []).length === 0 && <p style={{ color: colors.textMuted, fontSize: 14 }}>No research runs yet.</p>}
      </div>
    </div>
  );
}
