// Publishing one tier of a qualification run.
//
// The existing agentic run writes nothing a consumer can see until the very
// end: the flip to `ready` is the last write, so a partial run is never
// readable. That is a correctness property and progressive presentation looks
// like it breaks it.
//
// It does not, because a tier's output is COMPLETE AT ITS OWN TIER rather than
// a partial version of the final answer. "This is the right legal entity and it
// paid grants in its most recent filing" is a finished fact about a smaller
// question, and publishing it publishes nothing provisional. The property is
// preserved by making each tier's write atomic instead of by deferring every
// write to the end.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { LegitimacyOutcome } from "./legitimacy";

export const QUALIFICATION_TIERS = ["tier1_registry", "tier2_official", "fit", "recommendation"] as const;
export type QualificationTier = (typeof QUALIFICATION_TIERS)[number];

// Mirrors the four-valued predicate, plus the one state that is about the
// retrieval rather than the answer. retrieval_failed is deliberately NOT
// folded into insufficient_evidence: "we could not reach the source" and "the
// source does not say" send a user to different next actions, and collapsing
// them is what invites a rerun that can never succeed.
export const QUALIFICATION_STAGE_STATES = [
  "established",
  "conflicting",
  "insufficient_evidence",
  "not_applicable",
  "retrieval_failed",
] as const;
export type QualificationStageState = (typeof QUALIFICATION_STAGE_STATES)[number];

export type PublishResult =
  | { published: true; id: string }
  | { published: false; reason: "already_published" };

// Insert one tier's result.
//
// A second write for the same (run, tier) violates a unique index and is
// reported, never silently applied. Re-publishing a tier would mean a consumer
// that already read it now disagrees with one that reads it later, which is
// exactly the class of thing the atomic-write property exists to prevent --
// so the caller has to decide what a duplicate means rather than having a
// decision made for it.
export async function publishQualificationStage(
  supabase: SupabaseClient,
  input: {
    researchRunId: string;
    // Required explicitly: a service-role caller has no authenticated user, so
    // the column default my_organization_id() resolves to null and the
    // cross-tenant trigger would reject the row.
    organizationId: string;
    tier: QualificationTier;
    state: QualificationStageState;
    result: unknown;
    durationMs?: number | null;
  }
): Promise<PublishResult> {
  const { data, error } = await supabase
    .from("qualification_stages")
    .insert({
      research_run_id: input.researchRunId,
      organization_id: input.organizationId,
      tier: input.tier,
      state: input.state,
      result: input.result,
      duration_ms: input.durationMs ?? null,
    })
    .select("id")
    .single();

  // 23505 = unique_violation on (research_run_id, tier).
  if (error?.code === "23505") return { published: false, reason: "already_published" };
  if (error) throw new Error(`publishing ${input.tier}: ${error.message}`);
  return { published: true, id: data!.id as string };
}

// The tier-1 payload: everything a first-rung view needs, and nothing that
// belongs to a later tier.
//
// Both halves of the predicate keep their own status alongside the combined
// verdict. An identity that is established while grantmaking is not_applicable
// is a genuinely different situation from one where nothing resolved, and the
// combined state alone cannot say which happened.
export function tier1Payload(input: {
  legitimacy: LegitimacyOutcome;
  organization: {
    ein: string;
    name: string;
    city: string | null;
    state: string | null;
    foundationCode: number | null;
    pfFilingRequirementCode: number | null;
    assetAmount: number | null;
    incomeAmount: number | null;
    filingYears: number[];
  } | null;
  searchedFor: string | null;
}) {
  const { legitimacy } = input;
  return {
    legitimacy: { state: legitimacy.state, reason: legitimacy.reason },
    identity: {
      state: legitimacy.identity.state,
      ein: legitimacy.identity.ein,
      matchedName: legitimacy.identity.matched?.name ?? null,
      reason: legitimacy.identity.reason,
      // A conflicting verdict is only useful if it can say what it is
      // conflicting between.
      alternatives: legitimacy.identity.alternatives.map((a) => ({
        ein: a.ein, name: a.name, city: a.city, state: a.state,
      })),
    },
    grantmaking: legitimacy.grantmaking
      ? {
          state: legitimacy.grantmaking.state,
          mostRecentFilingYear: legitimacy.grantmaking.mostRecentFilingYear,
          mostRecentGrantsPaid: legitimacy.grantmaking.mostRecentGrantsPaid,
          yearsSinceFiling: legitimacy.grantmaking.yearsSinceFiling,
          stale: legitimacy.grantmaking.stale,
          reason: legitimacy.grantmaking.reason,
        }
      : null,
    organization: input.organization,
    searchedFor: input.searchedFor,
  };
}
