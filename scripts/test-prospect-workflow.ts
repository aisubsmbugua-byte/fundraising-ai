// The state machine that decides what a prospect page says and offers.
//
// Pure logic, no DB and no API key, same as test-entity-validation.ts. It is
// worth testing precisely because the rules are ordering rules: every bug
// this can have is a precedence bug, where two conditions are true at once
// and the wrong one wins. Those are invisible in review and obvious here.
//
// Usage: npx tsx scripts/test-prospect-workflow.ts

import { deriveProspectWorkflow, type WorkflowInput } from "../lib/prospect-workflow";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}\n      got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}

const done = {
  status: "ready",
  verificationState: "complete",
  completionState: "ready_for_review",
  dossierConfirmed: true,
};
function w(over: Partial<WorkflowInput> = {}): WorkflowInput {
  return { research: done, strategy: null, approvedClaimCount: 0, ...over };
}

console.log("--- the straight path ---");
check("no research yet", deriveProspectWorkflow(w({ research: null })).state, "not_started");
check("no research offers to run it", deriveProspectWorkflow(w({ research: null })).action, "run_research");
check(
  "a run in flight",
  deriveProspectWorkflow(w({ research: { ...done, status: "researching" } })).state,
  "researching"
);
check(
  "extraction counts as in flight",
  deriveProspectWorkflow(w({ research: { ...done, status: "extracting" } })).busy,
  true
);
check(
  "verification in flight",
  deriveProspectWorkflow(w({ research: { ...done, verificationState: "in_progress" } })).state,
  "verifying"
);
check("research done, nothing approved yet", deriveProspectWorkflow(w()).state, "intelligence_review");
check("...and the ask is to review", deriveProspectWorkflow(w()).action, "review_intelligence");
check(
  "once claims are approved the ask changes to generating",
  deriveProspectWorkflow(w({ approvedClaimCount: 6 })).action,
  "generate_strategy"
);
check(
  "strategy building",
  deriveProspectWorkflow(w({ approvedClaimCount: 6, strategy: { status: "analyzing", approved: false } })).state,
  "strategy_running"
);
check(
  "strategy waiting on a person",
  deriveProspectWorkflow(w({ approvedClaimCount: 6, strategy: { status: "ready_for_review", approved: false } })).state,
  "strategy_review"
);
check(
  "strategy approved",
  deriveProspectWorkflow(w({ approvedClaimCount: 6, strategy: { status: "ready_for_review", approved: true } })).state,
  "strategy_approved"
);

console.log("\n--- the stops ---");
// Identity outranks everything downstream: claims about an organization we
// could not identify are not worth reviewing, so the page must not ask for a
// review it should not act on.
check(
  "unconfirmed identity blocks review even with a complete run",
  deriveProspectWorkflow(w({ research: { ...done, dossierConfirmed: false } })).state,
  "identity_needed"
);
check(
  "an explicitly blocked run does too",
  deriveProspectWorkflow(w({ research: { ...done, completionState: "blocked" } })).state,
  "identity_needed"
);
check(
  "identity is asked for, not review",
  deriveProspectWorkflow(w({ research: { ...done, dossierConfirmed: false }, approvedClaimCount: 9 })).action,
  "confirm_identity"
);
check(
  "a failed run offers a re-run, not a review",
  deriveProspectWorkflow(w({ research: { ...done, status: "error" } })).action,
  "run_research"
);
check(
  "failed verification keeps the research and asks for review",
  deriveProspectWorkflow(w({ research: { ...done, verificationState: "failed" } })).state,
  "verification_failed"
);

console.log("\n--- precedence ---");
// The case that made ordering matter: re-running research on a prospect that
// already has an approved strategy. What is happening now is the research.
check(
  "live research outranks an approved strategy",
  deriveProspectWorkflow({
    research: { ...done, status: "researching" },
    strategy: { status: "ready_for_review", approved: true },
    approvedClaimCount: 9,
  }).state,
  "researching"
);
check(
  "a failed re-run does not claim the old strategy is the current state",
  deriveProspectWorkflow({
    research: { ...done, status: "error" },
    strategy: { status: "ready_for_review", approved: true },
    approvedClaimCount: 9,
  }).state,
  "research_failed"
);
// A strategy predating the research (the legacy case) must not make the page
// claim intelligence was approved when none was.
check(
  "a legacy approved strategy with no approvals still reports approved",
  deriveProspectWorkflow(w({ approvedClaimCount: 0, strategy: { status: "ready_for_review", approved: true } })).state,
  "strategy_approved"
);

console.log("\n--- every state is reachable and speaks plainly ---");
// A state with no label, or one naming an internal value, is a leak of the
// kind already fixed twice in this codebase.
const samples: WorkflowInput[] = [
  w({ research: null }),
  w({ research: { ...done, status: "researching" } }),
  w({ research: { ...done, status: "error" } }),
  w({ research: { ...done, dossierConfirmed: false } }),
  w({ research: { ...done, verificationState: "in_progress" } }),
  w({ research: { ...done, verificationState: "failed" } }),
  w(),
  w({ approvedClaimCount: 6, strategy: { status: "analyzing", approved: false } }),
  w({ approvedClaimCount: 6, strategy: { status: "ready_for_review", approved: false } }),
  w({ approvedClaimCount: 6, strategy: { status: "ready_for_review", approved: true } }),
];
const seen = new Set(samples.map((s) => deriveProspectWorkflow(s).state));
check("all ten states are produced by some input", seen.size, 10);
check(
  "no label or hint is empty",
  samples.every((s) => {
    const r = deriveProspectWorkflow(s);
    return r.label.length > 0 && r.hint.length > 0;
  }),
  true
);
check(
  "no label leaks an internal token",
  samples.every((s) => !/_|ready_for_review|dossier/.test(deriveProspectWorkflow(s).label)),
  true
);
check(
  "anything busy asks the user to wait, and nothing else does",
  samples.every((s) => {
    const r = deriveProspectWorkflow(s);
    return r.busy === (r.action === "wait");
  }),
  true
);

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
