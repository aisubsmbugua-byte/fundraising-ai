"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import { runResearch, startProspectResearch, verifyRunClaims } from "./research-actions";
import { buttonPrimary, buttonSecondary, colors, spacing } from "@/lib/ui";
import type { ProspectWorkflow } from "@/lib/prospect-workflow";

type RunSnapshot = {
  id: string;
  status: string;
  status_message: string | null;
  started_at: string | null;
  verification_state: string | null;
  completed_at: string | null;
};

const RUNNING = new Set(["researching", "extracting"]);

// Starts research and reports on it. The panel owns the whole run: it kicks
// off the work, polls it, and chains verification when extraction lands.
//
// Verification is a separate call on purpose, not part of runResearch. A
// research run can use most of the route's 450s budget by itself (150s
// search + 280s extraction), so a verification call inside the same
// invocation risks killing a finished dossier in order to check it.
export default function ResearchPanel({
  prospectId,
  workflow,
  lastCompletedAt,
}: {
  prospectId: string;
  workflow: ProspectWorkflow;
  // ISO date of the last finished run, for the repeat-run wording.
  lastCompletedAt: string | null;
}) {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const triggeredRef = useRef<string | null>(null);
  const verifiedRef = useRef<string | null>(null);

  async function fetchRun() {
    const res = await fetch(`/api/research-runs/${prospectId}`);
    if (!res.ok) return null;
    const { run: latest } = await res.json();
    return latest as RunSnapshot | null;
  }

  // Same division of responsibility as StrategyPanel: this component is the
  // stable destination for a run, so it does the triggering. triggeredRef
  // guards a double-fire within one mount; started_at guards it across page
  // loads, server-side.
  useEffect(() => {
    if (run && run.status === "researching" && !run.started_at && triggeredRef.current !== run.id) {
      triggeredRef.current = run.id;
      runResearch(run.id, prospectId, "dossier");
    }
  }, [run, prospectId]);

  // Verification chains off a finished run rather than off the click, so it
  // still happens if the user navigates away mid-run and comes back.
  useEffect(() => {
    if (run && run.status === "ready" && run.verification_state === "pending" && verifiedRef.current !== run.id) {
      verifiedRef.current = run.id;
      verifyRunClaims(run.id);
    }
  }, [run]);

  useEffect(() => {
    if (!workflow.busy && !run) return;
    if (run && !RUNNING.has(run.status) && run.verification_state !== "pending" && run.verification_state !== "in_progress") {
      return;
    }

    const interval = setInterval(async () => {
      const latest = await fetchRun();
      if (!latest) return;
      setRun(latest);
      // A run that has finished AND been checked is the end of this panel's
      // job -- the page reload below is what swaps in the reviewable claims.
      if (!RUNNING.has(latest.status) && latest.verification_state !== "pending" && latest.verification_state !== "in_progress") {
        window.location.reload();
      }
    }, 1500);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, workflow.busy, prospectId]);

  function begin() {
    setConfirming(false);
    setError(null);
    startTransition(async () => {
      const result = await startProspectResearch(prospectId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setRun({
        id: result.runId,
        status: "researching",
        status_message: "Starting research...",
        started_at: null,
        verification_state: null,
        completed_at: null,
      });
    });
  }

  const busy = workflow.busy || isPending || (run !== null && RUNNING.has(run.status));

  if (busy) {
    const message =
      run?.verification_state === "in_progress"
        ? "Checking each claim against the evidence it cites…"
        : run?.status_message ?? workflow.hint;
    return (
      <div>
        <LoadingStatus active messages={[message]} />
      </div>
    );
  }

  const repeat = lastCompletedAt !== null;
  const lastDate = lastCompletedAt
    ? new Date(lastCompletedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : null;

  return (
    <div>
      <button
        type="button"
        disabled={isPending}
        style={repeat ? buttonSecondary : buttonPrimary}
        onClick={() => setConfirming(true)}
      >
        {repeat ? "Run research again" : "Run research"}
      </button>

      {error && <div style={{ fontSize: 12.5, color: colors.danger, marginTop: spacing.xs }}>{error}</div>}

      <ConfirmDialog
        open={confirming}
        title="Run dossier research?"
        message={
          repeat
            ? `Research was last completed on ${lastDate}. Running it again reviews current filings, funding information, eligibility and available grant history. It normally takes several minutes.`
            : "This will review current filings, funding information, eligibility and available grant history. It normally takes several minutes."
        }
        confirmLabel="Run research"
        cancelLabel="Cancel"
        onConfirm={begin}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
