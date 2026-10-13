import type { SupabaseClient } from "@supabase/supabase-js";

export const STRATEGY_RUN_STATUSES = ["researching", "analyzing", "ready_for_review", "error"] as const;
export type StrategyRunStatus = (typeof STRATEGY_RUN_STATUSES)[number];

export type Strategy = {
  outreach_approach: string;
  ask_positioning: string;
  rationale: string;
  // Reusable across every downstream artifact -- outreach email, call
  // prep, and eventually proposals/decks -- so there's one consistent
  // narrative instead of each draft reinventing it.
  key_talking_points: string[];
  // What kind of outcomes/proof points would resonate with this
  // specific funder -- the AI's freeform wish-list, kept even now that
  // the Evidence Library (Slice 6) exists as a fallback for when no
  // real evidence_items match. Prefer evidence_item_ids on the run
  // itself when it's non-empty -- that's real, citable evidence, not
  // just a description of what to go find.
  evidence_to_highlight: string[];
};

export type OrganizationIntel = {
  location: string;
  funder_type: string;
  geographic_focus: string;
  typical_grant_size: string;
  focus_areas: string[];
};

export type StrategyRun = {
  id: string;
  prospect_id: string;
  status: StrategyRunStatus;
  status_message: string | null;
  started_at: string | null;
  findings: string | null;
  strategy: Strategy | null;
  organization_intel: OrganizationIntel | null;
  model: string | null;
  error_message: string | null;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  approved_strategy: Strategy | null;
  // Null means the strategy predates approved intelligence: built from
  // unstructured legacy research, never checked against reviewed claims.
  approved_intelligence_run_id: string | null;
  // Verified + approved evidence_items the AI actually cited when
  // proposing this strategy. Null on runs from before the Evidence
  // Library existed.
  evidence_item_ids: string[] | null;
};

// Shared by the sidebar "Strategies to Review" badge, the
// /prospects/review queue, and the overnight auto-search queue-depth
// check -- one prospect can have multiple strategy_runs (e.g. via
// "Regenerate strategy"), and only the latest one per prospect counts.
// No "latest per prospect" query built into strategy_runs, so
// dedupe newest-first in JS; cheap at this app's scale. organizationId
// is only needed when called with the admin client (the overnight
// cron route, which has no auth.uid() for RLS to filter by) -- the
// normal session-client callers leave it unset and rely on RLS.
export async function countStrategiesReadyForReview(supabase: SupabaseClient, organizationId?: string): Promise<number> {
  let query = supabase
    .from("strategy_runs")
    .select("prospect_id, status, approved_strategy, created_at")
    .order("created_at", { ascending: false });
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data: runs } = await query;

  const seenProspects = new Set<string>();
  let count = 0;
  for (const run of runs ?? []) {
    if (seenProspects.has(run.prospect_id)) continue;
    seenProspects.add(run.prospect_id);
    if (run.status === "ready_for_review" && !run.approved_strategy) count++;
  }
  return count;
}

// STATE item 93 (ruling 0038): feedback on a proposed strategy is bounded.
// Lives here, not in strategy-actions.ts, because a "use server" file can
// export only async functions -- and the assistant's argument validator
// needs the same number the action enforces.
export const MAX_STRATEGY_FEEDBACK_CHARS = 1500;

// The shape guard for a strategy revision's model output (STATE item 93).
//
// This MIRRORS the inline guards in runStrategy (strategy-actions.ts) --
// the model's tool schema is a hint, not a contract -- as a pure function so
// it can be tested offline. runStrategy itself is untouched (item 93 does
// not authorize changing it), so the two copies can drift; the test in
// scripts/test-assistant.ts pins this one's behaviour, and the report for
// item 93 names the duplication.
//
// One deliberate difference from the inline version: list items must be
// strings (a non-string item is dropped), because the output is hashed into
// a fingerprint and rendered in full on a card.
export type ShapedStrategyResult = {
  strategy: Strategy;
  intel: OrganizationIntel;
  // Validated against the pool the model was handed; null when the model
  // returned no usable list (the caller then keeps the run's existing ids).
  evidenceItemIds: string[] | null;
  // False when every prose field is blank: a failure to surface, not a
  // strategy a person is expected to approve.
  hasSubstance: boolean;
};

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function shapeStrategyResult(
  raw: unknown,
  prospect: {
    location?: string | null;
    funder_type?: string | null;
    geographic_focus?: string | null;
    typical_grant_size?: string | null;
    focus_areas?: string[] | null;
  },
  evidencePoolIds: ReadonlySet<string>
): ShapedStrategyResult {
  const result = (raw !== null && typeof raw === "object" ? raw : {}) as {
    organization_intel?: Partial<OrganizationIntel> | null;
    strategy?: Partial<Strategy> | null;
    evidence_used?: unknown;
  };
  const aiIntel = result.organization_intel ?? {};
  const aiStrategy = result.strategy ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  // AI fills gaps, never overwrites data a person already entered.
  const intel: OrganizationIntel = {
    location: prospect.location || str(aiIntel.location),
    funder_type: prospect.funder_type || str(aiIntel.funder_type),
    geographic_focus: prospect.geographic_focus || str(aiIntel.geographic_focus),
    typical_grant_size: prospect.typical_grant_size || str(aiIntel.typical_grant_size),
    focus_areas: prospect.focus_areas && prospect.focus_areas.length > 0 ? prospect.focus_areas : asStringList(aiIntel.focus_areas),
  };
  const strategy: Strategy = {
    outreach_approach: str(aiStrategy.outreach_approach),
    ask_positioning: str(aiStrategy.ask_positioning),
    rationale: str(aiStrategy.rationale),
    key_talking_points: asStringList(aiStrategy.key_talking_points),
    evidence_to_highlight: asStringList(aiStrategy.evidence_to_highlight),
  };
  const evidenceItemIds = Array.isArray(result.evidence_used)
    ? result.evidence_used.filter((id): id is string => typeof id === "string" && evidencePoolIds.has(id))
    : null;
  const hasSubstance = Boolean(strategy.outreach_approach.trim() || strategy.ask_positioning.trim() || strategy.rationale.trim());
  return { strategy, intel, evidenceItemIds, hasSubstance };
}
