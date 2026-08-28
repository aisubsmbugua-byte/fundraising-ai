import { createClient } from "@/lib/supabase/server";
import { colors, spacing, cardStyle, chipStyle, type as typeScale } from "@/lib/ui";
import ResearchPanel from "./research-panel";
import ClaimReview from "./claim-review";
import ConfirmEin from "./confirm-ein";

// Live data every load -- runs and claims change as soon as a research
// call finishes, same reasoning as /admin/organizations.
export const dynamic = "force-dynamic";

// runResearch is a server action invoked from this page, so it inherits
// this route's function duration. A' fetches and reads pages in full on
// top of searching, so the two calls' own timeouts (240s search + 150s
// extraction) now need ~390s of headroom -- 280 could kill a legitimately
// long run mid-flight. 450 matches the ceiling already in use by
// discovery/search, so it's known-good on this plan.
export const maxDuration = 450;

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

// Stage 4 (citation consistency) -- compares against the search step's own
// citation, not the live webpage. "drifted" is the one that should draw a
// reviewer's eye; "no_excerpt"/null (legacy pre-Stage-4 rows, or new rows
// where the evidence-first design makes this superseded) render nothing.
const CITATION_CONSISTENCY_TONE: Record<string, "teal" | "amber" | "red" | "neutral"> = {
  consistent: "teal",
  drifted: "red",
  unverifiable: "neutral",
};

// Entity-validation trust classification (evidence-first redesign) -- only
// entity_mismatch/unrelated_excluded sources have their evidence withheld
// from extraction; the rest stay usable but labeled here for the same
// reason they're labeled in the extraction prompt.
const ENTITY_STATUS_TONE: Record<string, "teal" | "amber" | "red" | "neutral"> = {
  ein_confirmed: "teal",
  official_domain_confirmed: "teal",
  legal_name_confirmed: "teal",
  different_entity_unverified_relation: "red",
  affiliate_related_entity: "red",
  identity_unresolved: "amber",
  entity_mismatch: "red",
  unrelated_excluded: "red",
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
  sources_insert_failed: "Saving retrieved sources failed.",
  evidence_insert_failed: "Saving captured evidence failed.",
  claim_sources_insert_failed: "Linking claims to their evidence failed.",
  coverage_insert_failed: "Saving the completeness report failed.",
  unknown_error: "Research failed for an unexpected reason.",
  research_failed: "Research failed for an unexpected reason.",
};

export default async function AdminResearchPage() {
  const supabase = createClient();

  const { data: prospects } = await supabase
    .from("prospects")
    .select("id, name, organization, ein")
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: runs } = await supabase
    .from("research_runs")
    .select(
      "id, prospect_id, version, retry_of, status, status_message, error_code, error_message, model, prompt_version, extraction_schema_version, input_tokens, output_tokens, cost_usd, latency_ms, completed_at, created_at, confirmed_ein, entity_resolution_method, entity_classification_version, dossier_confirmed"
    )
    .order("created_at", { ascending: false })
    .limit(20);

  const runIds = (runs ?? []).map((r) => r.id);

  const { data: claims } = await supabase
    .from("research_claims")
    .select(
      "id, research_run_id, claim_key, category, claim, confidence, confidence_reason, reporting_period, source_url, source_excerpt, retrieved_at, verification_status, verified_at, recheck_at"
    )
    .in("research_run_id", runIds)
    .order("claim_key");

  const { data: coverage } = await supabase
    .from("research_key_coverage")
    .select("id, research_run_id, claim_key, status, notes, retry_recommended")
    .in("research_run_id", runIds);

  const { data: sources } = await supabase
    .from("research_sources")
    .select("id, research_run_id, url, title, source_type, page_age, entity_validation_status, source_ein, retrieved_at")
    .in("research_run_id", runIds);

  const { data: claimSources } = await supabase
    .from("research_claim_sources")
    .select("id, claim_id, cited_text, supports_directly, citation_consistency, research_sources(url, title, source_type, retrieved_at)")
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

  const sourcesByRun = new Map<string, NonNullable<typeof sources>>();
  for (const s of sources ?? []) {
    const list = sourcesByRun.get(s.research_run_id) ?? [];
    list.push(s);
    sourcesByRun.set(s.research_run_id, list);
  }

  const sourcesByClaim = new Map<string, NonNullable<typeof claimSources>>();
  for (const cs of claimSources ?? []) {
    const list = sourcesByClaim.get(cs.claim_id) ?? [];
    list.push(cs);
    sourcesByClaim.set(cs.claim_id, list);
  }

  // First (most recent, since runs is already sorted desc) run per
  // prospect -- lets the trigger button retry properly (retry_of set,
  // version chained) instead of always starting an unrelated first run.
  const mostRecentRunByProspect: Record<string, string> = {};
  for (const run of runs ?? []) {
    if (!(run.prospect_id in mostRecentRunByProspect)) mostRecentRunByProspect[run.prospect_id] = run.id;
  }

  const prospectNames = new Map((prospects ?? []).map((p) => [p.id, p.organization ? `${p.name} (${p.organization})` : p.name]));
  const prospectEins = new Map((prospects ?? []).map((p) => [p.id, p.ein as string | null]));

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
          const runSources = sourcesByRun.get(run.id) ?? [];
          const nonFoundCoverage = runCoverage.filter((c) => c.status !== "found");
          const foundCount = runCoverage.length - nonFoundCoverage.length;

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

              {run.status === "ready" && run.entity_resolution_method && !run.dossier_confirmed && (
                <div style={{ marginTop: spacing.xs, fontSize: 13, color: colors.danger }}>
                  Identity unresolved — candidate intelligence only. This run cannot be treated as a confirmed
                  dossier or advance into Strategy/Outreach until the entity is confirmed.
                </div>
              )}

              <ConfirmEin
                prospectId={run.prospect_id}
                proposedEin={run.confirmed_ein ?? null}
                method={run.entity_resolution_method ?? null}
                savedEin={prospectEins.get(run.prospect_id) ?? null}
              />

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

              {runSources.length > 0 && (
                <details style={{ marginTop: spacing.sm }}>
                  <summary style={{ fontSize: 12.5, color: colors.textMuted, cursor: "pointer" }}>
                    Sources checked this run ({runSources.length})
                  </summary>
                  <div style={{ display: "grid", gap: 2, marginTop: spacing.xs }}>
                    {runSources.map((s) => (
                      <div key={s.id} style={{ fontSize: 12, color: colors.textFaint }}>
                        [{s.source_type}]{" "}
                        <a href={s.url} target="_blank" rel="noreferrer" style={{ color: colors.focus, wordBreak: "break-all" }}>
                          {s.title || s.url}
                        </a>
                        {s.page_age && ` · ${s.page_age}`}
                        {s.entity_validation_status && (
                          <span style={{ ...chipStyle(ENTITY_STATUS_TONE[s.entity_validation_status] ?? "neutral"), marginLeft: 4 }}>
                            {s.entity_validation_status.replace(/_/g, " ")}
                            {s.source_ein ? ` · ${s.source_ein}` : ""}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {runCoverage.length > 0 && (
                <div style={{ marginTop: spacing.sm }}>
                  <div style={{ display: "flex", gap: spacing.xs, flexWrap: "wrap" }}>
                    <span style={chipStyle("teal")}>{foundCount} found</span>
                    {Object.entries(
                      nonFoundCoverage.reduce<Record<string, number>>((acc, c) => {
                        acc[c.status] = (acc[c.status] ?? 0) + 1;
                        return acc;
                      }, {})
                    ).map(([status, count]) => (
                      <span key={status} style={chipStyle(COVERAGE_TONE[status] ?? "neutral")}>
                        {count} {status.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                  {nonFoundCoverage.length > 0 && (
                    <div style={{ display: "grid", gap: 4, marginTop: spacing.xs }}>
                      {nonFoundCoverage.map((c) => (
                        <div key={c.id} style={{ fontSize: 12, color: colors.textFaint }}>
                          <span style={{ fontFamily: "monospace" }}>{c.claim_key}</span> — <strong>{c.status.replace(/_/g, " ")}</strong>
                          {c.notes && <span>: {c.notes}</span>}
                          {(c.status === "not_found" || c.status === "not_public" || c.status === "conflicting") && (
                            <span> · retry {c.retry_recommended ? "may help" : "unlikely to help"}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {runClaims.length > 0 && (
                <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md }}>
                  {runClaims.map((claim) => {
                    const linkedSources = sourcesByClaim.get(claim.id) ?? [];
                    return (
                      <div key={claim.id} style={{ fontSize: 13.5, borderTop: `1px solid ${colors.border}`, paddingTop: spacing.sm }}>
                        <div>
                          <span style={{ fontFamily: "monospace", fontSize: 12, color: colors.textMuted }}>{claim.claim_key}</span>
                          <span style={{ marginLeft: spacing.sm, color: colors.textFaint, fontSize: 11 }}>[{claim.category}]</span>
                          <span style={{ marginLeft: spacing.sm }}>{claim.claim}</span>
                          <span style={{ marginLeft: spacing.sm, color: colors.textFaint, fontSize: 12 }}>
                            ({claim.confidence}
                            {claim.confidence_reason ? `: ${claim.confidence_reason}` : ""})
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 2 }}>
                          {linkedSources.length > 0 ? (
                            <div style={{ display: "grid", gap: 2 }}>
                              {linkedSources.map((cs) => {
                                const src = Array.isArray(cs.research_sources) ? cs.research_sources[0] : cs.research_sources;
                                return (
                                  <div key={cs.id}>
                                    <a href={src?.url} target="_blank" rel="noreferrer" style={{ color: colors.focus, wordBreak: "break-all" }}>
                                      {src?.title || src?.url}
                                    </a>{" "}
                                    <span>
                                      [{src?.source_type}
                                      {cs.supports_directly ? "" : ", inference"}]
                                    </span>
                                    {cs.citation_consistency && cs.citation_consistency !== "no_excerpt" && (
                                      <span
                                        style={{ ...chipStyle(CITATION_CONSISTENCY_TONE[cs.citation_consistency] ?? "neutral"), marginLeft: 4 }}
                                        title="Compares against the search step's own citation, not the live webpage"
                                      >
                                        citation: {cs.citation_consistency}
                                      </span>
                                    )}
                                    {cs.cited_text && <div style={{ fontStyle: "italic" }}>&quot;{cs.cited_text}&quot;</div>}
                                  </div>
                                );
                              })}
                            </div>
                          ) : claim.source_url ? (
                            <span style={{ wordBreak: "break-all" }}>{claim.source_url}</span>
                          ) : (
                            <span>no source captured</span>
                          )}
                          <div style={{ marginTop: 2 }}>
                            checked {claim.retrieved_at ? new Date(claim.retrieved_at).toLocaleString() : "--"}
                            {claim.reporting_period && ` · reporting period: ${claim.reporting_period}`}
                            {claim.recheck_at && ` · recheck by ${new Date(claim.recheck_at).toLocaleDateString()}`}
                          </div>
                        </div>
                        <ClaimReview claimId={claim.id} researchRunId={run.id} currentVerificationStatus={claim.verification_status} />
                      </div>
                    );
                  })}
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
