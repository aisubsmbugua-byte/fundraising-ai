import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RESEARCH_INFORMATION_SECTIONS,
  type ResearchConfidence,
  type ResearchEntityValidationStatus,
} from "@/lib/research";

// How a claim should be READ by a person, collapsing several separate
// machine-level signals into the one question a fundraiser actually has:
// can I rely on this?
//
//   verified   supported by its evidence, from the confirmed entity
//   partial    the evidence backs part of it -- the wording reaches further
//   interpretation the run reasoned to it rather than reading it
//   unverified     research finished but Stage 5 has not judged this claim
//   evidence_not_captured
//                  the run believes it but captured nothing citable. The
//                  fact may well be true -- this run simply has no support
//                  for it, which is a different statement from "no evidence
//                  exists".
//   conflict   another claim for the same key disagrees
//
// Deliberately not the same vocabulary as the verification verdicts: those
// answer "does the evidence support the wording", which is a narrower
// question than "should I act on this".
export type IntelligenceReviewState = "verified" | "partial" | "interpretation" | "unverified" | "evidence_not_captured" | "conflict";

export type IntelligenceClaim = {
  id: string;
  claimKey: string;
  claim: string;
  confidence: ResearchConfidence;
  confidenceReason: string | null;
  reportingPeriod: string | null;
  periodUnverified: boolean;
  reviewState: IntelligenceReviewState;
  reviewReason: string | null;
  sources: { url: string; title: string | null; citedText: string | null }[];
};

export type IntelligenceSection = {
  section: string;
  label: string;
  claims: IntelligenceClaim[];
  missing: boolean;
};

export type ProspectIntelligence = {
  runId: string;
  version: number;
  depth: string | null;
  completedAt: string | null;
  // blocked | ready_for_review
  state: string | null;
  verificationState: string | null;
  identityConfirmed: boolean;
  confirmedEin: string | null;
  resolutionMethod: string | null;
  // Competing organizations this run saw, for the disambiguation prompt.
  candidates: { ein: string; label: string; sourceCount: number; status: ResearchEntityValidationStatus | null }[];
  sections: IntelligenceSection[];
  missingSections: string[];
  // Operational, shown only where it explains a gap a user can see.
  retrieval: { searches: number | null; fetches: number | null; fetchFailures: number | null; missingSourceClasses: string[] };
};

// Loads the most recent completed research run for a prospect and shapes it
// for a person rather than for debugging.
//
// Returns null when no research has run, which is the common case today --
// the Research Agent is still a dark path, so most prospects have only the
// legacy deep-dive.
export async function loadProspectIntelligence(
  supabase: SupabaseClient,
  prospectId: string
): Promise<ProspectIntelligence | null> {
  const { data: run } = await supabase
    .from("research_runs")
    .select(
      "id, version, depth, status, completed_at, verification_state, completion_state, missing_information, missing_source_classes, confirmed_ein, entity_resolution_method, dossier_confirmed, searches_used, fetch_attempts, fetch_failures"
    )
    .eq("prospect_id", prospectId)
    .eq("status", "ready")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return null;

  const [{ data: claims }, { data: links }, { data: verifications }, { data: sources }] = await Promise.all([
    supabase
      .from("research_claims")
      .select("id, claim_key, claim, claim_type, confidence, confidence_reason, reporting_period, evidence_missing")
      .eq("research_run_id", run.id),
    supabase
      .from("research_claim_sources")
      .select("claim_id, cited_text, research_sources(url, title)")
      .eq("research_run_id", run.id),
    supabase
      .from("research_claim_verifications")
      .select("claim_id, verdict, period_verdict, reason, created_at")
      .eq("research_run_id", run.id)
      .order("created_at", { ascending: false }),
    supabase.from("research_sources").select("url, title, source_ein, entity_validation_status").eq("research_run_id", run.id),
  ]);

  // Most recent verdict per claim -- history is kept, the current judgement shown.
  const verdictByClaim = new Map<string, { verdict: string; period_verdict: string | null; reason: string | null }>();
  for (const v of verifications ?? []) {
    if (!verdictByClaim.has(v.claim_id as string)) {
      verdictByClaim.set(v.claim_id as string, {
        verdict: v.verdict as string,
        period_verdict: (v.period_verdict as string | null) ?? null,
        reason: (v.reason as string | null) ?? null,
      });
    }
  }

  const sourcesByClaim = new Map<string, IntelligenceClaim["sources"]>();
  for (const l of links ?? []) {
    const src = (Array.isArray(l.research_sources) ? l.research_sources[0] : l.research_sources) as
      | { url: string; title: string | null }
      | undefined;
    const list = sourcesByClaim.get(l.claim_id as string) ?? [];
    list.push({ url: src?.url ?? "", title: src?.title ?? null, citedText: (l.cited_text as string | null) ?? null });
    sourcesByClaim.set(l.claim_id as string, list);
  }

  // A key answered more than one way is a conflict a person must settle --
  // two different figures for total assets is not something to average.
  const countByKey = new Map<string, number>();
  for (const c of claims ?? []) countByKey.set(c.claim_key as string, (countByKey.get(c.claim_key as string) ?? 0) + 1);
  const CONFLICTABLE = new Set(["identity.legal_name", "identity.ein", "identity.location", "funding.total_assets", "funding.total_revenue", "funding.total_expenses"]);

  const shaped: IntelligenceClaim[] = (claims ?? []).map((c) => {
    const verdict = verdictByClaim.get(c.id as string);
    let reviewState: IntelligenceReviewState;
    if (c.evidence_missing) reviewState = "evidence_not_captured";
    else if (verdict?.verdict === "supported") reviewState = "verified";
    else if (verdict?.verdict === "partially_supported") reviewState = "partial";
    else if (verdict?.verdict === "unsupported" || verdict?.verdict === "contradicted") reviewState = "conflict";
    else if (c.claim_type === "hypothesis") reviewState = "interpretation";
    else reviewState = "unverified";

    // A conflicting key overrides an otherwise clean verdict: the claim may
    // be perfectly supported and still disagree with its sibling.
    if (reviewState === "verified" && CONFLICTABLE.has(c.claim_key as string) && (countByKey.get(c.claim_key as string) ?? 0) > 1) {
      reviewState = "conflict";
    }

    return {
      id: c.id as string,
      claimKey: c.claim_key as string,
      claim: c.claim as string,
      confidence: c.confidence as ResearchConfidence,
      confidenceReason: (c.confidence_reason as string | null) ?? null,
      // "not_time_bound" and "unstated" are internal vocabulary -- a person
      // should see a year, or a plain statement that none was given.
      reportingPeriod:
        c.reporting_period === "not_time_bound"
          ? null
          : c.reporting_period === "unstated"
            ? "no year stated"
            : ((c.reporting_period as string | null) ?? null),
      periodUnverified: verdict?.period_verdict === "unverified",
      reviewState,
      reviewReason: verdict?.reason ?? (c.confidence_reason as string | null) ?? null,
      sources: sourcesByClaim.get(c.id as string) ?? [],
    };
  });

  // Derived from the claims actually present rather than read from the run's
  // stored array. The stored value is null for every run that predates it,
  // which made the banner announce "every category was found" while the
  // coverage chips beside it showed two categories at zero. A view that
  // contradicts itself is worse than one that is merely out of date.
  const sections: IntelligenceSection[] = RESEARCH_INFORMATION_SECTIONS.map((s) => {
    const claims = shaped.filter((c) => (s.keys as readonly string[]).includes(c.claimKey) && c.reviewState !== "evidence_not_captured");
    return { section: s.section, label: s.label, claims, missing: claims.length === 0 };
  });
  const missingSections = sections.filter((s) => s.missing).map((s) => s.section);

  // Distinct entities this run encountered -- the disambiguation choices.
  const byEin = new Map<string, ProspectIntelligence["candidates"][number]>();
  for (const s of sources ?? []) {
    const ein = s.source_ein as string | null;
    if (!ein) continue;
    const title = (s.title as string | null) ?? "";
    const usable = title.includes(" ") ? title : "";
    const existing = byEin.get(ein);
    if (!existing) {
      byEin.set(ein, { ein, label: usable || (s.url as string), sourceCount: 1, status: s.entity_validation_status as ResearchEntityValidationStatus | null });
    } else {
      existing.sourceCount++;
      if (!existing.label.includes(" ") && usable) existing.label = usable;
    }
  }

  return {
    runId: run.id as string,
    version: run.version as number,
    depth: (run.depth as string | null) ?? null,
    completedAt: (run.completed_at as string | null) ?? null,
    state: (run.completion_state as string | null) ?? null,
    verificationState: (run.verification_state as string | null) ?? null,
    identityConfirmed: !!run.dossier_confirmed,
    confirmedEin: (run.confirmed_ein as string | null) ?? null,
    resolutionMethod: (run.entity_resolution_method as string | null) ?? null,
    candidates: Array.from(byEin.values()).sort((a, b) => b.sourceCount - a.sourceCount),
    sections,
    missingSections,
    retrieval: {
      searches: (run.searches_used as number | null) ?? null,
      fetches: (run.fetch_attempts as number | null) ?? null,
      fetchFailures: (run.fetch_failures as number | null) ?? null,
      missingSourceClasses: ((run.missing_source_classes as string[] | null) ?? []),
    },
  };
}
