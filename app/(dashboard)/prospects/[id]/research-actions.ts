"use server";

import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth";
import { searchFunderWeb } from "@/lib/ai/funder-search";
import { extractResearchClaims } from "@/lib/ai/research-extract";
import { allocateResearchRunVersion, RESEARCH_CLAIM_KEYS, type ResearchKeyCoverageStatus } from "@/lib/research";

// Bump these when the extraction prompt or the tool's input schema shape
// changes -- they're recorded per-run so evaluation results stay
// interpretable after either one drifts. v2: split several compound claim
// keys into atomic ones and added the required per-key coverage report.
const PROMPT_VERSION = "v2";
const EXTRACTION_SCHEMA_VERSION = "v2";

// Approximate published Claude Sonnet pricing at the time this was written
// -- not read from a live source. Good enough for comparing runs to each
// other; re-check against current Anthropic pricing before trusting the
// dollar figure for anything else.
const COST_PER_INPUT_TOKEN_USD = 3 / 1_000_000;
const COST_PER_OUTPUT_TOKEN_USD = 15 / 1_000_000;

function estimateCostUsd(inputTokens: number, outputTokens: number) {
  return inputTokens * COST_PER_INPUT_TOKEN_USD + outputTokens * COST_PER_OUTPUT_TOKEN_USD;
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

    const { findings, usage: searchUsage } = await searchFunderWeb(prospect).catch((err) => {
      throw new ResearchError("search_failed", err instanceof Error ? err.message : "Web search step failed");
    });

    await supabase
      .from("research_runs")
      .update({
        status: "extracting",
        status_message: "Extracting structured facts from research findings...",
      })
      .eq("id", runId);

    const extraction = await extractResearchClaims({ prospectName: prospect.name, findings }).catch((err) => {
      throw new ResearchError("extraction_failed", err instanceof Error ? err.message : "Extraction call failed");
    });
    const { claims, model } = extraction;

    // Claim rows are inserted first, while status is still "extracting" --
    // the status flip to "ready" below is the LAST write. A consumer that
    // correctly gates on status = "ready" before trusting any claims never
    // observes a partial set: if either insert below fails partway, the
    // run never reaches "ready" -- it falls into the outer catch as
    // "error" instead. See docs/decisions/0002-research-agent.md.
    if (claims.length > 0) {
      const { error: claimsError } = await supabase.from("research_claims").insert(
        claims.map((c) => ({
          research_run_id: runId,
          prospect_id: prospectId,
          claim_type: c.claim_type,
          claim_key: c.claim_key,
          category: RESEARCH_CLAIM_KEYS.find((k) => k.key === c.claim_key)?.category ?? "Other",
          claim: c.claim,
          source_url: c.source_url || null,
          source_excerpt: c.source_excerpt || null,
          confidence: c.confidence,
        }))
      );
      if (claimsError) throw new ResearchError("claims_insert_failed", claimsError.message);
    }

    // Derive full per-key coverage server-side rather than trusting the
    // model's own coverage array as complete: a "found" entry with no
    // matching valid claim (dropped by the filter above) becomes
    // extraction_failed; any key the model's coverage array omitted
    // entirely becomes not_attempted. This is what keeps a key from
    // disappearing into a clean-looking result just because the model
    // skipped it or answered it in a shape validation rejected.
    const foundKeys = new Set(claims.map((c) => c.claim_key));
    const modelCoverageByKey = new Map(extraction.coverage.map((c) => [c.claim_key, c]));
    const coverageRows: { research_run_id: string; claim_key: string; status: ResearchKeyCoverageStatus; notes: string | null }[] = [];
    for (const { key } of RESEARCH_CLAIM_KEYS) {
      const modelEntry = modelCoverageByKey.get(key);
      let status: ResearchKeyCoverageStatus;
      if (modelEntry?.status === "found") {
        status = foundKeys.has(key) ? "found" : "extraction_failed";
      } else if (modelEntry) {
        status = modelEntry.status;
      } else {
        status = "not_attempted";
      }
      coverageRows.push({ research_run_id: runId, claim_key: key, status, notes: modelEntry?.notes ?? null });
    }
    const { error: coverageError } = await supabase.from("research_key_coverage").insert(coverageRows);
    if (coverageError) throw new ResearchError("coverage_insert_failed", coverageError.message);

    const inputTokens = searchUsage.inputTokens + extraction.usage.inputTokens;
    const outputTokens = searchUsage.outputTokens + extraction.usage.outputTokens;

    await supabase
      .from("research_runs")
      .update({
        status: "ready",
        status_message:
          claims.length > 0
            ? `Found ${claims.length} fact${claims.length === 1 ? "" : "s"}`
            : "Research completed, but found nothing extractable",
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
