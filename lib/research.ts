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
  { key: "identity.legal_name", category: "Identity", label: "Legal name", description: "The funder's full legal/incorporated name, if it differs from the common name it's known by, e.g. 'The Maclellan Foundation, Inc.'" },
  { key: "identity.location", category: "Identity", label: "Location", description: "City/state/country the funder is based in" },
  { key: "identity.ein", category: "Identity", label: "EIN", description: "The funder's IRS Employer Identification Number, if determinable" },
  { key: "identity.website", category: "Identity", label: "Website", description: "The funder's official website" },
  { key: "identity.phone", category: "Identity", label: "Phone", description: "A publicly listed phone number for the funder or its grants office" },
  { key: "funding.funder_type", category: "Funding profile", label: "Funder type", description: "e.g. private foundation, corporate giving program, family foundation, denominational fund, individual/DAF" },
  { key: "funding.geographic_focus", category: "Funding profile", label: "Geographic focus", description: "Domestic priority region(s) this funder gives to, e.g. 'primarily Tennessee, Georgia, and Florida' -- not whether it also funds internationally (see international_reach)" },
  { key: "funding.international_reach", category: "Funding profile", label: "International reach", description: "Whether/how this funder gives outside its home country -- a distinct fact from its domestic geographic priority" },
  { key: "funding.grant_count_annual", category: "Funding profile", label: "Annual grant count", description: "Number of grants awarded in a specific, named reporting period, e.g. '160 grants in Tax Year 2024'" },
  { key: "funding.total_annual_giving", category: "Funding profile", label: "Total annual giving (sum of listed grants)", description: "Total dollar amount of grants awarded/listed in a specific, named reporting period -- this is a sum of individual grants, NOT the same figure as charitable_disbursements (a filing-level total that can legitimately differ); never conflate the two into one generic figure" },
  { key: "funding.charitable_disbursements", category: "Funding profile", label: "Charitable disbursements", description: "The filing-level total charitable disbursements figure (e.g. from a 990-PF), for a specific named reporting period -- keep distinct from total_annual_giving (sum of listed grants); these can be different numbers reflecting different accounting categories" },
  { key: "funding.total_assets", category: "Funding profile", label: "Total assets", description: "Total assets reported for a specific, named reporting period -- if multiple sources disagree, submit one claim per source's figure (each low confidence, reason 'conflicting sources') rather than picking one" },
  { key: "funding.total_revenue", category: "Funding profile", label: "Total revenue", description: "Total revenue reported for a specific, named reporting period" },
  { key: "funding.total_expenses", category: "Funding profile", label: "Total expenses", description: "Total expenses reported for a specific, named reporting period" },
  { key: "funding.median_grant_size", category: "Funding profile", label: "Median grant size", description: "The median individual grant/gift amount, with its reporting period if stated" },
  { key: "funding.grant_size_range", category: "Funding profile", label: "Grant size range", description: "The smallest-to-largest individual grant/gift amount publicly documented" },
  { key: "funding.multiyear_grant_stats", category: "Funding profile", label: "Multi-year grant stats", description: "Any grant statistic (count, total, median) that spans multiple years rather than one reporting period -- keep separate from single-period stats above" },
  { key: "funding.focus_areas", category: "Funding profile", label: "Focus areas", description: "One cause or program area this funder supports -- submit ONE claim per distinct focus area, not a combined list; multiple claims may share this same key within one run" },
  { key: "funding.recent_grants", category: "Funding profile", label: "Recent grants", description: "One specific recent grant (recipient, amount, purpose, and year if known) -- submit ONE claim per individual grant, not a combined list; multiple claims may share this same key within one run" },
  { key: "application.accepts_unsolicited", category: "Application", label: "Accepts unsolicited applications", description: "Whether the funder accepts cold/unsolicited applications, or is invitation-only/referral-only" },
  { key: "application.invitation_mechanism", category: "Application", label: "Invitation mechanism", description: "For invitation-only funders: the specific mechanism by which an invited application actually begins, e.g. 'a direct application link sent by email' -- distinct from accepts_unsolicited (whether cold outreach works at all) and submission_method (how to submit once you have access)" },
  { key: "application.submission_method", category: "Application", label: "Submission method", description: "How to submit an application once eligible/invited -- online portal, LOI, mail, etc." },
  { key: "application.required_documents", category: "Application", label: "Required documents", description: "One specific document/material required with an application, e.g. 'a project budget using the funder's template' -- submit ONE claim per distinct required item, not a combined list; note if a requirement is specific to one related entity and shouldn't be generalized" },
  { key: "application.multiyear_grant_rules", category: "Application", label: "Multi-year grant rules", description: "Any distinct process or eligibility rule that applies specifically to multi-year grants" },
  { key: "application.deadline", category: "Application", label: "Deadlines / windows", description: "Application windows or key dates, if publicly known" },
  { key: "application.decision_timeframe", category: "Application", label: "Decision timeframe", description: "How long after submission a decision is typically made, e.g. 'approximately two months for complete proposals' -- distinct from application.deadline (when to apply, not how long the decision takes)" },
  { key: "application.eligible_org_types", category: "Application", label: "Eligible organization types", description: "What kind of organization/tax status is eligible, e.g. '501(c)(3) public charity, 509(a)(1) or 509(a)(2)'" },
  { key: "application.foreign_org_eligibility", category: "Application", label: "Foreign organization eligibility", description: "Specific rules for non-U.S. organizations, e.g. an equivalency-determination certificate requirement" },
  { key: "application.fiscal_sponsorship_rules", category: "Application", label: "Fiscal sponsorship rules", description: "Specific rules for organizations applying through a fiscal sponsor, e.g. who must submit the request" },
  { key: "application.mission_alignment_requirement", category: "Application", label: "Mission alignment requirement", description: "Any required alignment with the funder's own mission/values (e.g. an explicitly Christian mission requirement) -- distinct from org-type eligibility" },
  { key: "application.excluded_recipients", category: "Application", label: "Excluded/ineligible recipients", description: "One specific category of recipient or organization type explicitly excluded/ineligible, e.g. 'private foundations', 'for-profit organizations', 'individuals' -- submit ONE claim per excluded category, not a combined list" },
  { key: "application.prohibited_activities", category: "Application", label: "Prohibited activities", description: "One specific activity a grant cannot be used for, e.g. 'lobbying', 'political intervention', 'voter registration' -- submit ONE claim per distinct prohibited activity, not a combined list; distinct from excluded_recipients (who can't apply, not what a grant can't fund)" },
  { key: "people.key_contacts", category: "People", label: "Key contacts", description: "One named person and their role, e.g. 'Jane Doe, Executive Director' -- submit ONE claim per person, not a combined list; multiple claims may share this same key within one run" },
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
  confidence_reason: string | null;
  reporting_period: string | null;
  verification_status: ResearchVerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  recheck_at: string | null;
  created_at: string;
};

export type ResearchSourceType = "official_website" | "irs_filing" | "annual_report" | "secondary_source" | "other";

export type ResearchSource = {
  id: string;
  research_run_id: string;
  url: string;
  title: string | null;
  source_type: ResearchSourceType;
  page_age: string | null;
  search_time_excerpts: string[];
  retrieved_at: string;
  created_at: string;
};

// Stage 4 (Citation Consistency Validation) of the Research Department
// redesign -- deterministic, code-only, no model call. Compares an
// extraction claim's own source_excerpt against the SEARCH step's own
// citation text for that same source (real API-provided data, not
// model-typed). This proves the extraction step didn't drift from what
// was actually cited at search time -- it does NOT independently verify
// the live webpage still says that. See docs/decisions/0002-research-agent.md.
//
// Deliberately text, not a Postgres enum, per the same reasoning as the
// rest of the Research Department's still-evolving verification-state
// vocabulary: shared constant + app-level validation, not a rigid DB type,
// while this is still being worked out.
export const RESEARCH_CITATION_CONSISTENCY_STATUSES = ["consistent", "drifted", "unverifiable", "no_excerpt"] as const;
export type ResearchCitationConsistency = (typeof RESEARCH_CITATION_CONSISTENCY_STATUSES)[number];

function normalizeForCitationComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// Exact-or-substring only, deliberately -- a tunable fuzzy/word-overlap
// score would trade "exact and deterministic" for a heuristic, which isn't
// what this check is for. If exact/substring proves too strict against
// real data, that's a separate, later, explicitly-justified change.
export function assessCitationConsistency(
  claimExcerpt: string | null | undefined,
  sourceExcerpts: string[]
): ResearchCitationConsistency {
  if (!claimExcerpt || !claimExcerpt.trim()) return "no_excerpt";
  if (sourceExcerpts.length === 0) return "unverifiable";
  const normalizedClaim = normalizeForCitationComparison(claimExcerpt);
  for (const raw of sourceExcerpts) {
    const normalizedSource = normalizeForCitationComparison(raw);
    if (!normalizedSource) continue;
    if (normalizedClaim === normalizedSource) return "consistent";
    if (normalizedSource.includes(normalizedClaim) || normalizedClaim.includes(normalizedSource)) return "consistent";
  }
  return "drifted";
}

export type ResearchClaimSource = {
  id: string;
  claim_id: string;
  source_id: string;
  research_run_id: string;
  cited_text: string | null;
  supports_directly: boolean;
  citation_consistency: ResearchCitationConsistency | null;
  content_hash: string | null;
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
  retry_recommended: boolean;
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
  | "unsupported"
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
