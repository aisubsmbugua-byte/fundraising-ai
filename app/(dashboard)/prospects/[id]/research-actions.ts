"use server";

import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth";
import { searchFunderWeb } from "@/lib/ai/funder-search";
import { extractResearchClaims, buildIndexedSources } from "@/lib/ai/research-extract";
import { allocateResearchRunVersion, RESEARCH_CLAIM_KEYS, type ResearchKeyCoverageStatus, type ResearchSourceType } from "@/lib/research";

// Bump these when the extraction prompt or the tool's input schema shape
// changes -- they're recorded per-run so evaluation results stay
// interpretable after either one drifts. v3: real citation-backed sources
// (source_indices resolved against actually-retrieved pages, no more
// model-typed URLs), confidence_reason, reporting_period, further atomic
// key splits.
const PROMPT_VERSION = "v3";
const EXTRACTION_SCHEMA_VERSION = "v3";

// Approximate published Claude Sonnet pricing at the time this was written
// -- not read from a live source. Good enough for comparing runs to each
// other; re-check against current Anthropic pricing before trusting the
// dollar figure for anything else.
const COST_PER_INPUT_TOKEN_USD = 3 / 1_000_000;
const COST_PER_OUTPUT_TOKEN_USD = 15 / 1_000_000;

function estimateCostUsd(inputTokens: number, outputTokens: number) {
  return inputTokens * COST_PER_INPUT_TOKEN_USD + outputTokens * COST_PER_OUTPUT_TOKEN_USD;
}

// Cheap, deterministic heuristic -- no extra model round-trip. A model
// override could be added later if this proves too coarse; not needed yet.
function classifySourceType(url: string, prospectWebsite: string | null): ResearchSourceType {
  const lower = url.toLowerCase();
  if (/propublica\.org|guidestar\.org|irs\.gov|990finder|candid\.org/.test(lower)) return "irs_filing";
  if (/annualreport|annual-report/.test(lower)) return "annual_report";
  if (prospectWebsite) {
    try {
      const prospectHost = new URL(prospectWebsite).hostname.replace(/^www\./, "");
      const urlHost = new URL(url).hostname.replace(/^www\./, "");
      if (urlHost === prospectHost) return "official_website";
    } catch {
      // malformed prospect.website or url -- fall through
    }
  }
  return "secondary_source";
}

// Tags a thrown Error with a stable, safe-to-display code (stored in
// research_runs.error_code) separately from its full message (stored in
// error_message, DB/logs-only -- see SAFE_ERROR_MESSAGES in
// app/admin/research/page.tsx). Keeps SDK/implementation detail (header
// names, auth internals -- the exact thing the real v1 Maclellan error
// leaked) out of the default UI text without losing it for debugging.
class ResearchError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Shared by startResearch and retryResearch -- the only difference between
// a first run and a retry is whether retryOfRunId is set.
async function createResearchRun(prospectId: string, retryOfRunId: string | null): Promise<string> {
  const user = await requireSuperadmin();
  const supabase = createClient();

  const { data: prospect } = await supabase.from("prospects").select("name").eq("id", prospectId).single();
  if (!prospect) throw new Error("Prospect not found");

  return allocateResearchRunVersion(supabase, prospectId, retryOfRunId, user.id, `Researching ${prospect.name}...`);
}

export async function startResearch(prospectId: string): Promise<string> {
  return createResearchRun(prospectId, null);
}

export async function retryResearch(prospectId: string, previousRunId: string): Promise<string> {
  return createResearchRun(prospectId, previousRunId);
}

// The heavy-lifting call. Dark/superadmin-only -- this is evaluation
// infrastructure, not a feature soft-launched to real tenant users, so the
// authorization boundary is enforced here structurally, not just by the
// absence of a UI entry point. started_at acts as a claim-lock, same
// pattern as runDeepDive, so a duplicate trigger (e.g. a page refresh
// mid-run) can't start the same run twice.
export async function runResearch(runId: string, prospectId: string) {
  await requireSuperadmin();
  const supabase = createClient();

  const { data: claimed } = await supabase
    .from("research_runs")
    .update({ started_at: new Date().toISOString() })
    .eq("id", runId)
    .is("started_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return;

  const startedAt = Date.now();

  try {
    const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
    if (!prospect) throw new ResearchError("prospect_not_found", "Prospect not found");

    const { findings, usage: searchUsage, citedSources, searchedSources } = await searchFunderWeb(prospect).catch((err) => {
      throw new ResearchError("search_failed", err instanceof Error ? err.message : "Web search step failed");
    });

    await supabase
      .from("research_runs")
      .update({
        status: "extracting",
        status_message: "Extracting structured facts from research findings...",
      })
      .eq("id", runId);

    const indexedSources = buildIndexedSources(citedSources, searchedSources);

    // Written first, before extraction's own writes -- captures what was
    // actually searched even if extraction fails afterward, and answers
    // "what sources were checked" for research_key_coverage rows that end
    // up not_found/not_public regardless of what gets extracted.
    let sourceIds: string[] = [];
    if (indexedSources.length > 0) {
      const { data: sourceRows, error: sourcesError } = await supabase
        .from("research_sources")
        .insert(
          indexedSources.map((s) => ({
            research_run_id: runId,
            url: s.url,
            title: s.title,
            source_type: classifySourceType(s.url, prospect.website),
            page_age: s.pageAge,
          }))
        )
        .select("id");
      if (sourcesError) throw new ResearchError("sources_insert_failed", sourcesError.message);
      sourceIds = (sourceRows ?? []).map((r) => r.id as string);
    }

    const extraction = await extractResearchClaims({ prospectName: prospect.name, findings, sources: indexedSources }).catch((err) => {
      throw new ResearchError("extraction_failed", err instanceof Error ? err.message : "Extraction call failed");
    });
    const { claims, model } = extraction;

    // Claim rows are inserted next, while status is still "extracting" --
    // the status flip to "ready" below is the LAST write. A consumer that
    // correctly gates on status = "ready" before trusting any claims never
    // observes a partial set: if any insert below fails partway, the run
    // never reaches "ready" -- it falls into the outer catch as "error"
    // instead. See docs/decisions/0002-research-agent.md.
    let insertedClaimIds: string[] = [];
    if (claims.length > 0) {
      const { data: claimRows, error: claimsError } = await supabase
        .from("research_claims")
        .insert(
          claims.map((c) => {
            const firstSourceIdx = c.source_indices[0];
            const firstSource = firstSourceIdx !== undefined ? indexedSources[firstSourceIdx] : undefined;
            return {
              research_run_id: runId,
              prospect_id: prospectId,
              claim_type: c.claim_type,
              claim_key: c.claim_key,
              category: RESEARCH_CLAIM_KEYS.find((k) => k.key === c.claim_key)?.category ?? "Other",
              claim: c.claim,
              // Legacy single-source display fields, now always populated
              // from a REAL captured source (never model-typed) -- the
              // full multi-source list lives in research_claim_sources.
              source_url: firstSource?.url ?? null,
              source_excerpt: c.source_excerpt ?? null,
              confidence: c.confidence,
              confidence_reason: c.confidence_reason ?? null,
              reporting_period: c.reporting_period ?? null,
            };
          })
        )
        .select("id");
      if (claimsError) throw new ResearchError("claims_insert_failed", claimsError.message);
      insertedClaimIds = (claimRows ?? []).map((r) => r.id as string);

      const claimSourceRows = claims.flatMap((c, i) => {
        const claimId = insertedClaimIds[i];
        return c.source_indices
          .map((idx) => sourceIds[idx])
          .filter((sourceId): sourceId is string => !!sourceId)
          .map((sourceId) => ({
            claim_id: claimId,
            source_id: sourceId,
            research_run_id: runId,
            cited_text: c.source_excerpt ?? null,
            supports_directly: c.supports_directly,
            content_hash: c.source_excerpt ? createHash("sha256").update(c.source_excerpt).digest("hex") : null,
          }));
      });
      if (claimSourceRows.length > 0) {
        const { error: claimSourcesError } = await supabase.from("research_claim_sources").insert(claimSourceRows);
        if (claimSourcesError) throw new ResearchError("claim_sources_insert_failed", claimSourcesError.message);
      }
    }

    // Derive full per-key coverage server-side rather than trusting the
    // model's own coverage array as complete: a "found" entry with no
    // matching valid claim (dropped by the filter above) becomes
    // extraction_failed; any key the model's coverage array omitted
    // entirely (and that has no matching claim either) becomes
    // not_attempted. This is what keeps a key from disappearing into a
    // clean-looking result just because the model skipped it or answered
    // it in a shape validation rejected.
    //
    // "found" is always derived from whether a valid claim actually
    // exists for that key, never from the model's separate self-reported
    // coverage entry -- the claim itself is the stronger, harder-to-fake
    // signal.
    const foundKeys = new Set(claims.map((c) => c.claim_key));
    const modelCoverageByKey = new Map(extraction.coverage.map((c) => [c.claim_key, c]));
    const coverageRows: {
      research_run_id: string;
      claim_key: string;
      status: ResearchKeyCoverageStatus;
      notes: string | null;
      retry_recommended: boolean;
    }[] = [];
    for (const { key } of RESEARCH_CLAIM_KEYS) {
      const modelEntry = modelCoverageByKey.get(key);
      let status: ResearchKeyCoverageStatus;
      if (foundKeys.has(key)) {
        status = "found";
      } else if (modelEntry) {
        status = modelEntry.status === "found" ? "extraction_failed" : modelEntry.status;
      } else {
        status = "not_attempted";
      }
      // Never silently false: a key with no model-authored coverage entry
      // (not_attempted) or a malformed one (extraction_failed) defaults to
      // retry-recommended, since there was no real attempt to trust either way.
      const retryRecommended = status === "found" ? true : modelEntry?.retry_recommended ?? true;
      coverageRows.push({ research_run_id: runId, claim_key: key, status, notes: modelEntry?.notes ?? null, retry_recommended: retryRecommended });
    }
    const { error: coverageError } = await supabase.from("research_key_coverage").insert(coverageRows);
    if (coverageError) throw new ResearchError("coverage_insert_failed", coverageError.message);

    const inputTokens = searchUsage.inputTokens + extraction.usage.inputTokens;
    const outputTokens = searchUsage.outputTokens + extraction.usage.outputTokens;

    const statusMessage = !extraction.sourcesAvailable
      ? "Research completed, but the search step returned no citable sources this run -- claims below have no verifiable source."
      : claims.length > 0
        ? `Found ${claims.length} fact${claims.length === 1 ? "" : "s"}`
        : "Research completed, but found nothing extractable";

    await supabase
      .from("research_runs")
      .update({
        status: "ready",
        status_message: statusMessage,
        findings,
        model,
        prompt_version: PROMPT_VERSION,
        extraction_schema_version: EXTRACTION_SCHEMA_VERSION,
        code_version: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateCostUsd(inputTokens, outputTokens),
        latency_ms: Date.now() - startedAt,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (err) {
    await supabase
      .from("research_runs")
      .update({
        status: "error",
        status_message: "Research failed",
        error_code: err instanceof ResearchError ? err.code : "unknown_error",
        error_message: err instanceof Error ? err.message : "Something went wrong during research",
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  }
}
