import type { SupabaseClient } from "@supabase/supabase-js";
import {
  APPROVED_FOR_DOWNSTREAM,
  assessEntityLifecycle,
  buildEntityCandidates,
  contactEmailDomain,
  deriveEntityNameToken,
  presentableCandidates,
  hasStatedPeriod,
  isFinancialClaimKey,
  strategyFieldPolicy,
  RESEARCH_INFORMATION_SECTIONS,
  type EntityCandidate,
  type EntityLifecycleSignal,
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

// What will actually happen to this claim, as distinct from how trustworthy
// it is. These are different questions and the UI was answering only the
// first: it labelled a flagged claim "needs a decision", implying work was
// required for it to be handled safely, when the gate already excludes it by
// default. Ignoring it IS the safe outcome. Saying so turns a 42-item
// obligation into a much shorter list of genuine choices.
export const STRATEGY_USE_STATES = [
  "in_strategy",
  "advisory_context",
  "approved_not_used",
  "excluded_by_you",
  "ready_to_approve",
  "held_back",
  "not_verified",
  "not_used_field",
] as const;
export type StrategyUse = (typeof STRATEGY_USE_STATES)[number];

// Mirrors loadApprovedIntelligence's admission rules exactly. It reads the
// VERDICT rather than the review state on purpose: review state applies a
// conflict override that the gate does not, and a display that quietly
// diverged from the gate would be the same class of lie this whole change
// is removing. Where they disagree, the UI now shows both.
export function deriveStrategyUse(input: {
  claimKey: string;
  decision: string | null;
  supported: boolean;
  // Whether verification reached this claim at all. Never checked and
  // checked-then-flagged both end up unused, but they are not the same
  // situation and a reviewer can only act usefully on the second.
  hasVerdict: boolean;
  contradicted: boolean;
  evidenceMissing: boolean;
  withheldReason: string | null;
}): StrategyUse {
  const { claimKey, decision, supported, hasVerdict, contradicted, evidenceMissing, withheldReason } = input;
  const policy = strategyFieldPolicy(claimKey);

  if (policy === "unused") return "not_used_field";
  // Widened deliberately: this reads decision strings straight out of the
  // database, which is a text column, so a value the TS union does not know
  // about must fall through to "not approved" rather than fail to compile.
  if (decision && !(APPROVED_FOR_DOWNSTREAM as ReadonlySet<string>).has(decision)) return "excluded_by_you";
  if (decision) return withheldReason ? "approved_not_used" : "in_strategy";

  // An advisory field needs no decision to be used, so it must not be listed
  // as though one were outstanding -- that mislabelling is what made the
  // queue look four times its real size. It is still excluded when the
  // evidence contradicts it or there is no evidence at all.
  if (policy === "advisory") {
    if (contradicted || evidenceMissing) return "held_back";
    return supported ? "ready_to_approve" : "advisory_context";
  }

  if (supported) return "ready_to_approve";
  return hasVerdict ? "held_back" : "not_verified";
}

// Why an approved claim still will not reach Strategy. One definition,
// consumed by both the gate that enforces it and the UI that reports it --
// the previous arrangement had the rule in the gate only, so a reviewer
// could approve a claim and never learn it went nowhere.
export function withheldFromStrategyReason(claimKey: string, reportingPeriod: string | null): string | null {
  if (isFinancialClaimKey(claimKey) && !hasStatedPeriod(reportingPeriod)) {
    return "no reporting period — an undated financial figure cannot be compared or used to size an ask";
  }
  return null;
}

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
  decision: { decision: string; note: string | null } | null;
  // What happens to it, and -- when the answer is "nothing" -- why.
  strategyUse: StrategyUse;
  withheldReason: string | null;
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
  // At most three, each carrying enough to be recognised. Empty when the
  // run could not describe any well enough to offer -- which is a real
  // answer, not a gap to paper over.
  candidates: EntityCandidate[];
  // Everything seen, for the superadmin audit view only.
  allCandidates: EntityCandidate[];
  sections: IntelligenceSection[];
  missingSections: string[];
  // Signals that this organization may not be a going concern. Reported, not
  // concluded -- see assessEntityLifecycle.
  lifecycle: { newestYear: number | null; signals: EntityLifecycleSignal[] };
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
    supabase.from("research_sources").select("id, url, title, source_ein, entity_validation_status").eq("research_run_id", run.id),
  ]);

  // Evidence text per source, so a candidate can be described by what was
  // actually captured about it rather than by its URL.
  const { data: evidenceRows } = await supabase
    .from("research_evidence")
    .select("source_id, exact_text")
    .eq("research_run_id", run.id);
  const textsBySource = new Map<string, string[]>();
  for (const e of evidenceRows ?? []) {
    const id = e.source_id as string;
    textsBySource.set(id, [...(textsBySource.get(id) ?? []), e.exact_text as string]);
  }

  // The prospect's own name and location: one is what the candidates are
  // being matched against, the other is a reason a row might be the right
  // one. Neither is derivable from the run.
  const { data: prospectRow } = await supabase
    .from("prospects")
    .select("name, location, website, contact_email")
    .eq("id", prospectId)
    .maybeSingle();

  const { data: approvals } = await supabase
    .from("research_claim_approvals")
    .select("claim_id, decision, note, created_at")
    .eq("research_run_id", run.id)
    .order("created_at", { ascending: false });
  const decisionByClaim = new Map<string, { decision: string; note: string | null }>();
  for (const a of approvals ?? []) {
    if (!decisionByClaim.has(a.claim_id as string)) decisionByClaim.set(a.claim_id as string, { decision: a.decision as string, note: (a.note as string | null) ?? null });
  }

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

    const decision = decisionByClaim.get(c.id as string) ?? null;
    const withheldReason = withheldFromStrategyReason(c.claim_key as string, (c.reporting_period as string | null) ?? null);

    return {
      id: c.id as string,
      claimKey: c.claim_key as string,
      claim: c.claim as string,
      confidence: c.confidence as ResearchConfidence,
      confidenceReason: (c.confidence_reason as string | null) ?? null,
      strategyUse: deriveStrategyUse({
        claimKey: c.claim_key as string,
        decision: decision?.decision ?? null,
        supported: verdict?.verdict === "supported",
        hasVerdict: !!verdict,
        contradicted: verdict?.verdict === "unsupported" || verdict?.verdict === "contradicted",
        evidenceMissing: !!c.evidence_missing,
        withheldReason,
      }),
      withheldReason,
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
      decision,
      sources: sourcesByClaim.get(c.id as string) ?? [],
    };
  });

  // Derived from the claims actually present rather than read from the run's
  // stored array. The stored value is null for every run that predates it,
  // which made the banner announce "every category was found" while the
  // coverage chips beside it showed two categories at zero. A view that
  // contradicts itself is worse than one that is merely out of date.
  // Two separate questions, previously answered with one filter: what to
  // SHOW, and what counts as COVERED. Uncited claims were dropped from the
  // sections entirely so that a section holding only uncited findings would
  // still read "not found" -- correct for coverage, and a silent
  // disappearance for the reviewer, who could not see a claim that bulk
  // approval would nonetheless sweep into Strategy.
  //
  // Now everything is shown, and coverage is computed from the evidenced
  // subset only.
  const sections: IntelligenceSection[] = RESEARCH_INFORMATION_SECTIONS.map((s) => {
    const claims = shaped.filter((c) => (s.keys as readonly string[]).includes(c.claimKey));
    const evidenced = claims.filter((c) => c.reviewState !== "evidence_not_captured");
    return { section: s.section, label: s.label, claims, missing: evidenced.length === 0 };
  });

  // Claims whose key belongs to no section at all -- identity.website,
  // total_revenue, total_expenses, multiyear_grant_stats and anything added
  // to the claim vocabulary without being added to a section. They were
  // invisible: extracted, verifiable, approvable, and never rendered. A
  // catch-all is what stops the display silently falling behind the
  // vocabulary again.
  const sectioned = new Set(RESEARCH_INFORMATION_SECTIONS.flatMap((s) => s.keys as readonly string[]));
  const unsectioned = shaped.filter((c) => !sectioned.has(c.claimKey));
  if (unsectioned.length > 0) {
    sections.push({ section: "other", label: "Other findings", claims: unsectioned, missing: false });
  }
  const missingSections = sections.filter((s) => s.missing).map((s) => s.section);

  // Every entity the run touched, described well enough to be recognised.
  const allCandidates = buildEntityCandidates({
    sources: (sources ?? []).map((s) => ({
      url: s.url as string,
      title: (s.title as string | null) ?? null,
      sourceEin: (s.source_ein as string | null) ?? null,
      status: (s.entity_validation_status as string | null) ?? null,
      texts: textsBySource.get(s.id as string) ?? [],
    })),
    nameToken: deriveEntityNameToken((prospectRow?.name as string | null) ?? ""),
    prospectLocation: (prospectRow?.location as string | null) ?? null,
    // Same inference the research run uses, so the UI and the resolver agree
    // on what this prospect's domain is.
    prospectWebsite:
      (prospectRow?.website as string | null) ??
      (contactEmailDomain(prospectRow?.contact_email as string | null)
        ? `https://${contactEmailDomain(prospectRow?.contact_email as string | null)}`
        : null),
  });

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
    // Only what a person could actually choose between. The rest stays in
    // allCandidates for the audit view -- completeness belongs there, not in
    // front of someone trying to identify a funder.
    candidates: presentableCandidates(allCandidates),
    allCandidates,
    sections,
    missingSections,
    // Computed from the raw rows rather than the shaped claims: reporting
    // periods are rewritten for display ("unstated" becomes "no year
    // stated"), and a year cannot be read back out of prose.
    lifecycle: assessEntityLifecycle({
      claims: (claims ?? []).map((c) => ({
        claim: c.claim as string,
        reporting_period: (c.reporting_period as string | null) ?? null,
      })),
      currentYear: new Date().getFullYear(),
    }),
    retrieval: {
      searches: (run.searches_used as number | null) ?? null,
      fetches: (run.fetch_attempts as number | null) ?? null,
      fetchFailures: (run.fetch_failures as number | null) ?? null,
      missingSourceClasses: ((run.missing_source_classes as string[] | null) ?? []),
    },
  };
}

// ---------------------------------------------------------------------------
// The approved intelligence payload.
//
// This is the ONLY thing an automated consumer may read. Strategy must never
// query research_claims and decide for itself what is safe: the policy for
// what counts as usable lives here, in one place, and is therefore testable
// and changeable in one place. A downstream agent applying its own judgement
// would mean the rule "unsupported claims must not be used" exists in as many
// versions as there are consumers.
//
// A claim qualifies when it was verified against its evidence, OR when a
// person explicitly approved it despite that. Nothing else passes: not
// unchecked claims, not partly supported ones a reviewer never saw, and never
// anything from a run whose identity was unresolved.

export type ApprovedClaim = {
  claimKey: string;
  claim: string;
  reportingPeriod: string | null;
  // Advisory claims enter without individual approval, so they must never be
  // readable as confirmed fact. The limitation travels WITH the claim rather
  // than sitting in a heading above a list, because a model reading a block
  // of bullets does not reliably carry a caveat from a header down to the
  // twentieth line under it.
  advisory: boolean;
  limitation: string | null;
  // True when a person accepted this over the evidence -- their note travels
  // with it so a downstream reader knows it rests on human knowledge.
  humanOverride: boolean;
  overrideNote: string | null;
  sources: { url: string; title: string | null }[];
};

// A claim a person approved that still cannot be handed to a model. Returned
// rather than dropped silently: a reviewer who spends a decision on a claim
// is owed the fact that it went no further, and a silent filter is how the
// last one of these went unnoticed for a whole build.
export type WithheldClaim = {
  claimKey: string;
  reason: string;
};

export type ApprovedIntelligence = {
  researchRunId: string;
  version: number;
  confirmedEin: string | null;
  claims: ApprovedClaim[];
  withheld: WithheldClaim[];
};

export type StrategyReadiness = { ready: boolean; reason: string | null };

// Whether a strategy can be generated at all, and if not, why in words a
// person can act on.
//
// One definition, used by the guard that enforces it AND the UI that decides
// whether to offer the button. Keeping them separate is what produced a
// "Retry strategy" control whose only possible outcome was a refusal -- and,
// before that refusal was returned rather than thrown, a 500.
export async function strategyReadiness(supabase: SupabaseClient, prospectId: string): Promise<StrategyReadiness> {
  const approved = await loadApprovedIntelligence(supabase, prospectId);
  if (!approved) {
    return {
      ready: false,
      reason: "There is no confirmed research to build a strategy from. Run research and confirm the organization's identity first.",
    };
  }
  // every() on an empty list is true, which is the wanted answer: a payload
  // of nothing, and a payload of advisory context only, are both too thin to
  // write a strategy from.
  if (approved.claims.every((c) => c.advisory)) {
    return {
      ready: false,
      reason: "No intelligence has been approved yet. Approve the claims the strategy should be written from first.",
    };
  }
  return { ready: true, reason: null };
}

export async function loadApprovedIntelligence(
  supabase: SupabaseClient,
  prospectId: string
): Promise<ApprovedIntelligence | null> {
  const { data: run } = await supabase
    .from("research_runs")
    .select("id, version, confirmed_ein, dossier_confirmed")
    .eq("prospect_id", prospectId)
    .eq("status", "ready")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Unresolved identity is disqualifying outright. Research about an
  // organization we could not identify has nothing to contribute to a
  // strategy for this one, however well-supported its individual claims are.
  if (!run || !run.dossier_confirmed) return null;

  const [{ data: claims }, { data: verifications }, { data: approvals }, { data: links }] = await Promise.all([
    supabase.from("research_claims").select("id, claim_key, claim, reporting_period, evidence_missing").eq("research_run_id", run.id),
    supabase.from("research_claim_verifications").select("claim_id, verdict, created_at").eq("research_run_id", run.id).order("created_at", { ascending: false }),
    supabase.from("research_claim_approvals").select("claim_id, decision, note, corrected_claim, created_at").eq("research_run_id", run.id).order("created_at", { ascending: false }),
    supabase.from("research_claim_sources").select("claim_id, research_sources(url, title)").eq("research_run_id", run.id),
  ]);

  const verdictByClaim = new Map<string, string>();
  for (const v of verifications ?? []) if (!verdictByClaim.has(v.claim_id as string)) verdictByClaim.set(v.claim_id as string, v.verdict as string);

  const decisionByClaim = new Map<string, { decision: string; note: string | null; corrected: string | null }>();
  for (const a of approvals ?? []) {
    if (decisionByClaim.has(a.claim_id as string)) continue;
    decisionByClaim.set(a.claim_id as string, {
      decision: a.decision as string,
      note: (a.note as string | null) ?? null,
      corrected: (a.corrected_claim as string | null) ?? null,
    });
  }

  const sourcesByClaim = new Map<string, { url: string; title: string | null }[]>();
  for (const l of links ?? []) {
    const src = (Array.isArray(l.research_sources) ? l.research_sources[0] : l.research_sources) as { url: string; title: string | null } | undefined;
    if (!src) continue;
    const list = sourcesByClaim.get(l.claim_id as string) ?? [];
    if (!list.some((x) => x.url === src.url)) list.push({ url: src.url, title: src.title });
    sourcesByClaim.set(l.claim_id as string, list);
  }

  const approved: ApprovedClaim[] = [];
  const withheld: WithheldClaim[] = [];
  for (const c of claims ?? []) {
    const decision = decisionByClaim.get(c.id as string);
    // An explicit exclusion always wins, even over a clean verdict: a person
    // who has seen a claim and rejected it outranks the check. It wins over
    // the advisory path too -- a reviewer who rejected something must not
    // see it reappear as "context".
    if (decision && !["approved", "approved_with_note", "corrected"].includes(decision.decision)) continue;

    const verified = verdictByClaim.get(c.id as string) === "supported";
    const policy = strategyFieldPolicy(c.claim_key as string);
    if (policy === "unused") continue;

    // Advisory fields enter without individual approval, which is the whole
    // point -- they were never verifiable in the first place, so demanding a
    // decision on them produced a queue nobody could act on. Two limits keep
    // that from becoming a channel for known-wrong content:
    //
    //   nothing the verifier CONTRADICTED gets in, at any label. "Advisory"
    //   means unconfirmed, not disproven.
    //
    //   nothing with evidence_missing gets in. There is no captured source
    //   behind it, so there is nothing for a limitation label to describe.
    if (policy === "advisory" && !verified) {
      const verdict = verdictByClaim.get(c.id as string);
      if (c.evidence_missing) continue;
      if (verdict && verdict !== "partially_supported") continue;

      approved.push({
        claimKey: c.claim_key as string,
        claim: decision?.corrected || (c.claim as string),
        reportingPeriod: (c.reporting_period as string | null) ?? null,
        advisory: true,
        limitation: decision
          ? "accepted by a reviewer, not confirmed against evidence"
          : verdict === "partially_supported"
            ? "the evidence supports only part of this"
            : "not checked against its evidence",
        humanOverride: false,
        overrideNote: decision?.note ?? null,
        sources: sourcesByClaim.get(c.id as string) ?? [],
      });
      continue;
    }

    if (!verified && !decision) continue;

    // An undated financial figure is withheld from strategy even when a
    // person approved it. Extraction already caps these at low confidence,
    // but ApprovedClaim carries no confidence, so downstream that demotion
    // had no effect: a figure marked untrustworthy arrived in the strategy
    // prompt with the same standing as the confirmed EIN.
    //
    // Withheld rather than labelled on purpose. A "do not size an ask off
    // this" tag in the prompt is the same model-obedience dependency the
    // entity and period work removed from this pipeline -- and the harm is
    // specific: a cumulative giving total read as annual overstated one real
    // funder's capacity by roughly 2x.
    //
    // Approving such a claim is still worth doing: it stays visible in
    // Prospect Intelligence, where a person can read it in context. It just
    // does not become an input a model reasons from unpriced.
    const withheldReason = withheldFromStrategyReason(c.claim_key as string, (c.reporting_period as string | null) ?? null);
    if (withheldReason) {
      withheld.push({ claimKey: c.claim_key as string, reason: withheldReason });
      continue;
    }

    approved.push({
      claimKey: c.claim_key as string,
      claim: decision?.corrected || (c.claim as string),
      reportingPeriod: (c.reporting_period as string | null) ?? null,
      advisory: false,
      limitation: null,
      humanOverride: !verified,
      overrideNote: decision?.note ?? null,
      sources: sourcesByClaim.get(c.id as string) ?? [],
    });
  }

  return {
    researchRunId: run.id as string,
    version: run.version as number,
    confirmedEin: (run.confirmed_ein as string | null) ?? null,
    claims: approved,
    withheld,
  };
}
