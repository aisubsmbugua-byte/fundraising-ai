"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveIntelligenceAndGenerateStrategy } from "./strategy-actions";
import { buttonPrimary, colors, spacing } from "@/lib/ui";

// The handoff, as one control.
//
// Approving intelligence and generating a strategy are separate writes but a
// single decision -- "these are the facts, write from them" -- so they are a
// single button. Splitting them put a human stop in the middle of what looked
// like one automatic flow, which reads as the system having stalled.
//
// The button names both halves for the same reason: someone who clicks
// "Approve" and then watches a strategy appear has been surprised by their
// own action.
export default function ApproveAndGenerate({
  researchRunId,
  prospectId,
  verifiedCount,
  exceptionCount,
  alreadyApprovedCount,
}: {
  researchRunId: string;
  prospectId: string;
  verifiedCount: number;
  exceptionCount: number;
  // Claims already decided on in an earlier sitting -- without this, a
  // reviewer who approved everything individually would see a button
  // offering to approve zero claims.
  alreadyApprovedCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  // Only navigates -- it does NOT start the run. StrategyPanel is the stable
  // destination component for a strategy run and already triggers any run it
  // finds unstarted; kicking it off here too would mean two owners racing for
  // the same claim-lock to no benefit.
  useEffect(() => {
    if (!startedRunId) return;
    router.push(`/prospects/${prospectId}?tab=strategy`);
  }, [startedRunId, prospectId, router]);

  const total = verifiedCount + alreadyApprovedCount;
  if (total === 0) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
      <button
        type="button"
        disabled={pending || startedRunId !== null}
        style={{ ...buttonPrimary, opacity: pending || startedRunId ? 0.6 : 1 }}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await approveIntelligenceAndGenerateStrategy(researchRunId, prospectId);
            if ("error" in result) {
              setError(result.error);
              return;
            }
            setStartedRunId(result.runId);
          })
        }
      >
        {pending || startedRunId ? "Starting…" : "Approve intelligence and generate Strategy"}
      </button>

      <span style={{ fontSize: 12.5, color: colors.textMuted }}>
        {verifiedCount > 0
          ? `Approves ${verifiedCount} verified claim${verifiedCount === 1 ? "" : "s"}`
          : `Uses the ${alreadyApprovedCount} claim${alreadyApprovedCount === 1 ? "" : "s"} you already approved`}
        {/* Stated as a consequence, not a task. These are already excluded;
            the reviewer is being told what will happen, not given a queue. */}
        {exceptionCount > 0 &&
          `. ${exceptionCount} claim${exceptionCount === 1 ? "" : "s"} below ${
            exceptionCount === 1 ? "is" : "are"
          } left out — open ${exceptionCount === 1 ? "it" : "them"} only if you want to change that.`}
      </span>

      {error && <span style={{ fontSize: 12.5, color: colors.danger }}>{error}</span>}
    </div>
  );
}
