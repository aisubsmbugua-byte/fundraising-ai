import type { SupabaseClient } from "@supabase/supabase-js";

export const RESEARCH_RUN_STATUSES = ["researching", "extracting", "ready", "error"] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export type ResearchClaimType = "fact" | "hypothesis";
export type ResearchConfidence = "high" | "medium" | "low";
export type ResearchVerificationStatus = "unverified" | "human_confirmed" | "human_disputed";

// The controlled vocabulary for research_claims.claim_key /
// research_expected_facts.claim_key -- this is the actual comparison key
// the evaluation protocol joins on (category is free-text grouping/display
// only, never a join key). Enforced at the strongest available layer: the
// extraction tool's own input schema (see lib/ai/research-extract.ts)
// declares claim_key as an enum built from this exact list, so the model
// structurally cannot emit a key outside it -- not just a shared-constant
// convention that could silently drift between the extraction prompt and
// wherever expected facts get hand-authored.
//
// Atomicity rule (v2, revised after the first real run bundled unrelated
// facts under one key): one key = one independently confirmable/disputable
// fact. If reviewing a claim would require checking more than one distinct
// piece of source evidence, split it into more keys. `application.process`
// and `funding.typical_grant_size` were removed for exactly this reason --
// each used to bundle several unrelated facts (invitation status,
// submission method, required documents, multi-year rules, and a phone
// number all lived under `application.process` alone). Old claim rows
// keep whatever claim_key they were written with (it's `text`, not a DB
// enum) and just fall back to category "Other" in the lookup below --
// no migration needed when this list changes.
export const RESEARCH_CLAIM_KEYS = [
  { key: "identity.location", category: "Identity", label: "Location", description: "City/state/country the funder is based in" },
  { key: "identity.ein", category: "Identity", label: "EIN", description: "The funder's IRS Employer Identification Number, if determinable" },
  { key: "identity.website", category: "Identity", label: "Website", description: "The funder's official website" },
  { key: "identity.phone", category: "Identity", label: "Phone", description: "A publicly listed phone number for the funder or its grants office" },
  { key: "funding.funder_type", category: "Funding profile", label: "Funder type", description: "e.g. private foundation, corporate giving program, family foundation, denominational fund, individual/DAF" },
  { key: "funding.geographic_focus", category: "Funding profile", label: "Geographic focus", description: "Where this funder typically gives, e.g. 'nationwide', 'California only'" },
  { key: "funding.grant_count_annual", category: "Funding profile", label: "Annual grant count", description: "Number of grants awarded in a specific, named reporting period, e.g. '160 grants in Tax Year 2024'" },
  { key: "funding.total_annual_giving", category: "Funding profile", label: "Total annual giving", description: "Total dollar amount given in a specific, named reporting period" },
  { key: "funding.median_grant_size", category: "Funding profile", label: "Median grant size", description: "The median individual grant/gift amount, with its reporting period if stated" },
  { key: "funding.grant_size_range", category: "Funding profile", label: "Grant size range", description: "The smallest-to-largest individual grant/gift amount publicly documented" },
  { key: "funding.multiyear_grant_stats", category: "Funding profile", label: "Multi-year grant stats", description: "Any grant statistic (count, total, median) that spans multiple years rather than one reporting period -- keep separate from single-period stats above" },
  { key: "funding.focus_areas", category: "Funding profile", label: "Focus areas", description: "Cause or program areas this funder typically supports -- list them together as one claim" },
  { key: "funding.recent_grants", category: "Funding profile", label: "Recent grants", description: "Examples of recent or typical grant recipients, if publicly listed" },
  { key: "application.accepts_unsolicited", category: "Application", label: "Accepts unsolicited applications", description: "Whether the funder accepts cold/unsolicited applications, or is invitation-only/referral-only" },
  { key: "application.submission_method", category: "Application", label: "Submission method", description: "How to submit an application once eligible -- online portal, LOI, mail, etc. -- not whether it's invitation-only (see accepts_unsolicited)" },
  { key: "application.required_documents", category: "Application", label: "Required documents", description: "What must be submitted with an application -- budget, financials, board list, etc." },
  { key: "application.multiyear_grant_rules", category: "Application", label: "Multi-year grant rules", description: "Any distinct process or eligibility rule that applies specifically to multi-year grants" },
  { key: "application.deadline", category: "Application", label: "Deadlines / windows", description: "Application windows or key dates, if publicly known" },
  { key: "application.restrictions", category: "Application", label: "Restrictions", description: "Stated exclusions or restrictions on what this funder will support" },
  { key: "people.key_contacts", category: "People", label: "Key contacts", description: "Named program officers, board members, or other relevant people found in research" },
] as const;

export type ResearchClaimKey = (typeof RESEARCH_CLAIM_KEYS)[number]["key"];

export type ResearchRun = {
  id: string;
  prospect_id: string;
  version: number;
  retry_of: string | null;
  status: ResearchRunStatus;
  status_message: string | null;
  findings: string | null;
  model: string | null;
  prompt_version: string | null;
  extraction_schema_version: string | null;
  code_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
};

export type ResearchClaim = {
  id: string;
  research_run_id: string;
  prospect_id: string;
  claim_type: ResearchClaimType;
  claim_key: string;
  category: string;
  claim: string;
  source_url: string | null;
  source_excerpt: string | null;
  retrieved_at: string;
  confidence: ResearchConfidence;
  verification_status: ResearchVerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  recheck_at: string | null;
  created_at: string;
};

// Per-key completeness record for one run -- 'found'/'not_public'/
// 'not_found'/'conflicting' are model-authored; 'not_attempted' and
// 'extraction_failed' are always SERVER-derived (see runResearch), never
// trusted to model self-reporting, so a key the model silently skipped or
// answered with a malformed shape can't disappear into a clean-looking
// result. Only written for runs that reach 'ready' -- an 'error' run's own
// status already means "extraction failed" at the run level.
export type ResearchKeyCoverageStatus =
  | "found"
  | "not_public"
  | "not_found"
  | "conflicting"
  | "not_attempted"
  | "extraction_failed";

export type ResearchKeyCoverage = {
  id: string;
  research_run_id: string;
  claim_key: string;
  status: ResearchKeyCoverageStatus;
  notes: string | null;
  created_at: string;
};

export type ResearchExpectedFact = {
  id: string;
  prospect_id: string;
  claim_key: string;
  category: string;
  expected_claim: string;
  source: string | null;
  source_url: string | null;
  authored_by: string;
  valid_as_of: string;
  notes: string | null;
};

export type ResearchEvalVerdict =
  | "match"
  | "partial"
  | "miss"
  | "contradicted"
  | "plausible"
  | "hallucinated"
  | "unclear"
  | "outdated";

export type ResearchEvalReview = {
  id: string;
  research_run_id: string;
  expected_fact_id: string | null;
  claim_id: string | null;
  verdict: ResearchEvalVerdict;
  reviewed_by: string;
  reviewed_at: string;
  notes: string | null;
};

// Shared by the real "use server" action (research-actions.ts, with a
// request-scoped cookie client) and scripts/test-research-concurrency.mjs
// (with a service-role client) -- parameterized by an already-constructed
// Supabase client so this same read-max/insert/retry-on-conflict logic is
// callable outside a Next.js request too. Version is computed in the same
// round-trip as the insert; unique(prospect_id, version) is the real
// backstop, not the optimistic read -- a 23505 (unique_violation) means
// another run raced ahead, so this re-reads the max and retries rather
// than surfacing a spurious error to a request that did nothing wrong.
export async function allocateResearchRunVersion(
  supabase: SupabaseClient,
  prospectId: string,
  retryOfRunId: string | null,
  createdBy: string,
  statusMessage: string
): Promise<string> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: last } = await supabase
      .from("research_runs")
      .select("version")
      .eq("prospect_id", prospectId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (last?.version ?? 0) + 1;

    const { data: run, error } = await supabase
      .from("research_runs")
      .insert({
        prospect_id: prospectId,
        version: nextVersion,
        retry_of: retryOfRunId,
        status: "researching",
        status_message: statusMessage,
        created_by: createdBy,
      })
      .select("id")
      .single();

    if (!error && run) return run.id as string;

    // 23505 = unique_violation. Anything else is a real failure -- surface it.
    if (error?.code !== "23505") throw new Error(error?.message ?? "Failed to create research run");
  }
  throw new Error("Failed to allocate a research run version after several attempts -- try again.");
}
