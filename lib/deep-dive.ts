import type { SupabaseClient } from "@supabase/supabase-js";

export const DEEP_DIVE_STATUSES = ["researching", "analyzing", "ready_for_review", "error"] as const;
export type DeepDiveStatus = (typeof DEEP_DIVE_STATUSES)[number];

export type Strategy = {
  outreach_approach: string;
  ask_positioning: string;
  rationale: string;
  // Reusable across every downstream artifact -- outreach email, call
  // prep, and eventually proposals/decks -- so there's one consistent
  // narrative instead of each draft reinventing it.
  key_talking_points: string[];
  // What kind of outcomes/proof points would resonate with this
  // specific funder. The Evidence Library doesn't exist yet (Slice
  // 6), but capturing what to look for now means proposal/deck
  // generation already knows what to go find once it does.
  evidence_to_highlight: string[];
};

export type OrganizationIntel = {
  location: string;
  funder_type: string;
  geographic_focus: string;
  typical_grant_size: string;
  focus_areas: string[];
};

export type DeepDiveRun = {
  id: string;
  prospect_id: string;
  status: DeepDiveStatus;
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
};

// Shared by the sidebar "Strategies to Review" badge, the
// /prospects/review queue, and the overnight auto-search queue-depth
// check -- one prospect can have multiple deep_dive_runs (e.g. via
// "Run New Deep Dive"), and only the latest one per prospect counts.
// No "latest per prospect" query built into deep_dive_runs, so
// dedupe newest-first in JS; cheap at this app's scale.
export async function countStrategiesReadyForReview(supabase: SupabaseClient): Promise<number> {
  const { data: runs } = await supabase
    .from("deep_dive_runs")
    .select("prospect_id, status, approved_strategy, created_at")
    .order("created_at", { ascending: false });

  const seenProspects = new Set<string>();
  let count = 0;
  for (const run of runs ?? []) {
    if (seenProspects.has(run.prospect_id)) continue;
    seenProspects.add(run.prospect_id);
    if (run.status === "ready_for_review" && !run.approved_strategy) count++;
  }
  return count;
}
