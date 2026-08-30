import type { SupabaseClient } from "@supabase/supabase-js";
import { APPROVED_FOR_DOWNSTREAM } from "@/lib/research";
import type { StrategyRun } from "@/lib/strategy";

// Where a prospect stands on the road from "accepted" to "strategy a person
// approved", as one value.
//
// This exists because the flow it describes contains a deliberate human stop
// -- intelligence has to be reviewed before a strategy is generated from it
// -- and an unexplained pause in the middle of what looks like one automatic
// action reads as a bug. Naming every state, including the waiting ones, is
// what makes the stop legible instead of mysterious.
//
// Derived, never stored, for the same reason computeHealthStatus is: a
// status column would go stale the moment a run finished, and there would
// then be two answers to the same question.
export const PROSPECT_WORKFLOW_STATES = [
  "not_started",
  "researching",
  "research_failed",
  "identity_needed",
  "verifying",
  "verification_failed",
  "intelligence_review",
  "strategy_running",
  "strategy_review",
  "strategy_approved",
] as const;
export type ProspectWorkflowState = (typeof PROSPECT_WORKFLOW_STATES)[number];

// The single thing a person can do next. The UI renders one control from
// this rather than deciding for itself which buttons apply, so the button on
// screen and the state chip beside it can never disagree.
export type ProspectWorkflowAction =
  | "run_research"
  | "confirm_identity"
  | "review_intelligence"
  | "generate_strategy"
  | "review_strategy"
  | "wait"
  | "none";

export type ProspectWorkflow = {
  state: ProspectWorkflowState;
  label: string;
  hint: string;
  action: ProspectWorkflowAction;
  // True while something is running server-side, so the caller knows to poll.
  busy: boolean;
};

export type WorkflowInput = {
  research: {
    status: string;
    // research_runs.verification_state
    verificationState: string | null;
    // research_runs.completion_state -- "blocked" means identity unresolved
    completionState: string | null;
    dossierConfirmed: boolean;
  } | null;
  strategy: {
    status: string;
    approved: boolean;
  } | null;
  // How many claims a person has approved on the latest research run. Zero
  // with research complete means the review has not been done yet.
  approvedClaimCount: number;
};

// Order is the whole design here. Research in flight outranks any strategy
// state: if someone re-runs research on a prospect that already has an
// approved strategy, what is happening NOW is the research, and saying
// "strategy approved" would be answering a question nobody asked.
export function deriveProspectWorkflow(input: WorkflowInput): ProspectWorkflow {
  const { research, strategy, approvedClaimCount } = input;

  if (!research) {
    return {
      state: "not_started",
      label: "No research yet",
      hint: "Research this funder to build the intelligence a strategy is written from.",
      action: "run_research",
      busy: false,
    };
  }

  if (research.status === "researching" || research.status === "extracting") {
    return {
      state: "researching",
      label: "Research in progress",
      hint: "Reading filings and public sources. This normally takes several minutes.",
      action: "wait",
      busy: true,
    };
  }

  if (research.status === "error") {
    return {
      state: "research_failed",
      label: "Research failed",
      hint: "Nothing was saved from this attempt. Running it again is safe.",
      action: "run_research",
      busy: false,
    };
  }

  // Identity before everything else that follows it: research about an
  // organization we could not identify has nothing to contribute, however
  // well-evidenced its individual claims are.
  if (!research.dossierConfirmed || research.completionState === "blocked") {
    return {
      state: "identity_needed",
      label: "Identity confirmation needed",
      hint: "Research could not settle which organization this is. Confirm it and the next run will be about the right one.",
      action: "confirm_identity",
      busy: false,
    };
  }

  if (research.verificationState === "pending" || research.verificationState === "in_progress") {
    return {
      state: "verifying",
      label: "Verification in progress",
      hint: "Each claim is being checked against the evidence it cites.",
      action: "wait",
      busy: true,
    };
  }

  if (research.verificationState === "failed") {
    return {
      state: "verification_failed",
      label: "Verification did not finish",
      hint: "The research itself is intact -- only the check against sources failed. Retrying re-reads stored evidence and does not research again.",
      action: "review_intelligence",
      busy: false,
    };
  }

  if (strategy?.approved) {
    return {
      state: "strategy_approved",
      label: "Strategy approved",
      hint: "Outreach can be drafted from it.",
      action: "none",
      busy: false,
    };
  }

  if (strategy && (strategy.status === "researching" || strategy.status === "analyzing")) {
    return {
      state: "strategy_running",
      label: "Building strategy",
      hint: "Writing an approach from the intelligence you approved.",
      action: "wait",
      busy: true,
    };
  }

  if (strategy?.status === "ready_for_review") {
    return {
      state: "strategy_review",
      label: "Strategy ready for review",
      hint: "Read it, edit anything that is off, then approve.",
      action: "review_strategy",
      busy: false,
    };
  }

  // Research is done and checked. Whether the next step is reviewing or
  // generating depends on whether anything has actually been approved --
  // a strategy cannot be built from an empty payload.
  return approvedClaimCount > 0
    ? {
        state: "intelligence_review",
        label: "Intelligence approved",
        hint: "Generate the strategy from the claims you approved.",
        action: "generate_strategy",
        busy: false,
      }
    : {
        state: "intelligence_review",
        label: "Intelligence ready for review",
        hint: "Approve the claims you want the strategy written from. Anything you exclude will not be used.",
        action: "review_intelligence",
        busy: false,
      };
}

// The reads deriveProspectWorkflow needs. Kept apart from it so the rules
// above stay a pure function that can be tested without a database.
//
// Deliberately fetches the latest research run at ANY status -- unlike
// loadProspectIntelligence, which only sees finished ones. A run still in
// flight is precisely what this is for.
export async function loadProspectWorkflow(
  supabase: SupabaseClient,
  prospectId: string
): Promise<ProspectWorkflow & { researchRunId: string | null; approvedClaimCount: number; lastCompletedAt: string | null }> {
  const { data: research } = await supabase
    .from("research_runs")
    .select("id, status, verification_state, completion_state, dossier_confirmed, completed_at")
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: strategy } = await supabase
    .from("strategy_runs")
    .select("status, approved_strategy")
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Pick<StrategyRun, "status" | "approved_strategy">>();

  // Distinct CLAIMS, not approval rows. Approvals are append-only and the
  // latest one wins, so a reviewer who changes their mind about a claim
  // leaves two rows behind; counting rows told the user "uses the 13 claims
  // you already approved" when only 12 claims were approved.
  let approvedClaimCount = 0;
  if (research?.id) {
    const { data: rows } = await supabase
      .from("research_claim_approvals")
      .select("claim_id, decision, created_at")
      .eq("research_run_id", research.id)
      .order("created_at", { ascending: false });
    const latest = new Map<string, string>();
    for (const r of rows ?? []) if (!latest.has(r.claim_id as string)) latest.set(r.claim_id as string, r.decision as string);
    approvedClaimCount = [...latest.values()].filter((d) => APPROVED_FOR_DOWNSTREAM.has(d as never)).length;
  }

  const workflow = deriveProspectWorkflow({
    research: research
      ? {
          status: research.status as string,
          verificationState: (research.verification_state as string | null) ?? null,
          completionState: (research.completion_state as string | null) ?? null,
          dossierConfirmed: !!research.dossier_confirmed,
        }
      : null,
    strategy: strategy ? { status: strategy.status, approved: !!strategy.approved_strategy } : null,
    approvedClaimCount,
  });

  return {
    ...workflow,
    researchRunId: (research?.id as string | null) ?? null,
    approvedClaimCount,
    lastCompletedAt: (research?.completed_at as string | null) ?? null,
  };
}
