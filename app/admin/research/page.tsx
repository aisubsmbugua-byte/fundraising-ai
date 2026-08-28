import { createClient } from "@/lib/supabase/server";
import { colors, spacing, cardStyle, chipStyle, type as typeScale } from "@/lib/ui";
import ResearchPanel from "./research-panel";
import ClaimReview from "./claim-review";

// Live data every load -- runs and claims change as soon as a research
// call finishes, same reasoning as /admin/organizations.
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "teal" | "amber" | "red" | "neutral"> = {
  ready: "teal",
  researching: "amber",
  extracting: "amber",
  error: "red",
};

const COVERAGE_TONE: Record<string, "teal" | "amber" | "red" | "neutral"> = {
  found: "teal",
  not_public: "neutral",
  not_found: "amber",
  conflicting: "amber",
  not_attempted: "red",
  extraction_failed: "red",
};

// Stable, safe-to-show text per error_code -- the full error_message
// (which can contain SDK/implementation detail, e.g. the real Maclellan
// v1 run's "X-Api-Key ... Authorization headers" text) moves into a
// <details> disclosure below instead of being the default visible text.
const SAFE_ERROR_MESSAGES: Record<string, string> = {
  prospect_not_found: "The prospect record could not be found.",
  search_failed: "The web search step failed.",
  extraction_failed: "The AI extraction step failed or returned an unusable result.",
  claims_insert_failed: "Saving extracted facts failed.",
  coverage_insert_failed: "Saving the completeness report failed.",
  unknown_error: "Research failed for an unexpected reason.",
  research_failed: "Research failed for an unexpected reason.",
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
      "id, prospect_id, version, retry_of, status, status_message, error_code, error_message, model, prompt_version, extraction_schema_version, input_tokens, output_tokens, cost_usd, latency_ms, completed_at, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(20);

  const runIds = (runs ?? []).map((r) => r.id);

  const { data: claims } = await supabase
    .from("research_claims")
    .select(
      "id, research_run_id, claim_key, category, claim, confidence, source_url, source_excerpt, retrieved_at, verification_status, verified_at, recheck_at"
    )
    .in("research_run_id", runIds)
    .order("claim_key");

  const { data: coverage } = await supabase
    .from("research_key_coverage")
    .select("id, research_run_id, claim_key, status, notes")
    .in("research_run_id", runIds);

  const claimsByRun = new Map<string, NonNullable<typeof claims>>();
  for (const c of claims ?? []) {
    const list = claimsByRun.get(c.research_run_id) ?? [];
    list.push(c);
    claimsByRun.set(c.research_run_id, list);
  }

  const coverageByRun = new Map<string, NonNullable<typeof coverage>>();
  for (const c of coverage ?? []) {
    const list = coverageByRun.get(c.research_run_id) ?? [];
    list.push(c);
    coverageByRun.set(c.research_run_id, list);
  }

  // First (most recent, since runs is already sorted desc) run per
  // prospect -- lets the trigger button retry properly (retry_of set,
  // version chained) instead of always starting an unrelated first run.
  const mostRecentRunByProspect: Record<string, string> = {};
  for (const run of runs ?? []) {
    if (!(run.prospect_id in mostRecentRunByProspect)) mostRecentRunByProspect[run.prospect_id] = run.id;
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

      <ResearchPanel prospects={prospects ?? []} mostRecentRunByProspect={mostRecentRunByProspect} />

      <div style={{ display: "grid", gap: spacing.md, marginTop: spacing.xxl }}>
        <h2 style={{ fontSize: typeScale.sectionTitle }}>Recent runs</h2>
        {(runs ?? []).map((run) => {
          const runClaims = claimsByRun.get(run.id) ?? [];
          const runCoverage = coverageByRun.get(run.id) ?? [];
          const coverageCounts = new Map<string, number>();
          for (const c of runCoverage) coverageCounts.set(c.status, (coverageCounts.get(c.status) ?? 0) + 1);

          return (
            <div key={run.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{prospectNames.get(run.prospect_id) ?? run.prospect_id}</strong>
                  <span style={{ color: colors.textMuted, fontSize: 13 }}>
                    {" "}
                    · v{run.version}
                    {run.retry_of ? " (retry)" : ""}
                  </span>
                </div>
                <span style={chipStyle(STATUS_TONE[run.status] ?? "neutral")}>{run.status}</span>
              </div>

              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>{run.status_message}</div>

              {run.status === "error" && (
                <div style={{ marginTop: spacing.xs }}>
                  <div style={{ fontSize: 13, color: colors.danger }}>
                    {SAFE_ERROR_MESSAGES[run.error_code ?? ""] ?? SAFE_ERROR_MESSAGES.unknown_error}
                    {run.error_code && (
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: colors.textFaint, marginLeft: spacing.xs }}>
                        ({run.error_code})
                      </span>
                    )}
                  </div>
                  {run.error_message && (
                    <details style={{ marginTop: spacing.xs }}>
                      <summary style={{ fontSize: 12, color: colors.textFaint, cursor: "pointer" }}>Raw error (superadmin only)</summary>
                      <div style={{ fontSize: 12, color: colors.textFaint, marginTop: spacing.xs, wordBreak: "break-word" }}>
                        {run.error_message}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {run.status === "ready" && (
                <div style={{ fontSize: 12.5, color: colors.textFaint, marginTop: spacing.xs }}>
                  {run.model} ({run.prompt_version}/{run.extraction_schema_version}) · {run.input_tokens ?? 0}+
                  {run.output_tokens ?? 0} tokens · ${run.cost_usd?.toFixed(4) ?? "0.0000"} ·{" "}
                  {run.latency_ms ? `${(run.latency_ms / 1000).toFixed(1)}s` : "--"}
                </div>
              )}

              {runCoverage.length > 0 && (
                <div style={{ display: "flex", gap: spacing.xs, flexWrap: "wrap", marginTop: spacing.sm }}>
                  {Array.from(coverageCounts.entries()).map(([status, count]) => (
                    <span key={status} style={chipStyle(COVERAGE_TONE[status] ?? "neutral")}>
                      {count} {status.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              )}

              {runClaims.length > 0 && (
                <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md }}>
                  {runClaims.map((claim) => (
                    <div key={claim.id} style={{ fontSize: 13.5, borderTop: `1px solid ${colors.border}`, paddingTop: spacing.sm }}>
                      <div>
                        <span style={{ fontFamily: "monospace", fontSize: 12, color: colors.textMuted }}>{claim.claim_key}</span>
                        <span style={{ marginLeft: spacing.sm, color: colors.textFaint, fontSize: 11 }}>[{claim.category}]</span>
                        <span style={{ marginLeft: spacing.sm }}>{claim.claim}</span>
                        <span style={{ marginLeft: spacing.sm, color: colors.textFaint, fontSize: 12 }}>({claim.confidence})</span>
                      </div>
                      <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 2 }}>
                        {claim.source_url ? (
                          <span style={{ wordBreak: "break-all" }}>{claim.source_url}</span>
                        ) : (
                          <span>no source url</span>
                        )}
                        {claim.source_excerpt && <div style={{ fontStyle: "italic", marginTop: 2 }}>&quot;{claim.source_excerpt}&quot;</div>}
                        <div style={{ marginTop: 2 }}>
                          checked {claim.retrieved_at ? new Date(claim.retrieved_at).toLocaleString() : "--"}
                          {claim.recheck_at && ` · recheck by ${new Date(claim.recheck_at).toLocaleDateString()}`}
                        </div>
                      </div>
                      <ClaimReview claimId={claim.id} researchRunId={run.id} currentVerificationStatus={claim.verification_status} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {(runs ?? []).length === 0 && <p style={{ color: colors.textMuted, fontSize: 14 }}>No research runs yet.</p>}
      </div>
    </div>
  );
}
