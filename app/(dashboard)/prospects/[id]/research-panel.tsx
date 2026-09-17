"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import { runResearch, startProspectResearch, verifyRunClaims } from "./research-actions";
import { buttonPrimary, buttonSecondary, colors, spacing } from "@/lib/ui";
import type { OutstandingIntelligence } from "@/lib/research";
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
  gaps = [],
  coverage = null,
}: {
  prospectId: string;
  workflow: ProspectWorkflow;
  // ISO date of the last finished run, for the repeat-run wording.
  lastCompletedAt: string | null;
  // What another search could still add, and what it would be worth. Every
  // entry here traces to obtainableGaps over the screening ledger (ruling
  // 0009): a fact that was looked for and is not published never reaches this
  // list, in any wording. Never a fixed list, because what a funder publishes
  // genuinely differs.
  gaps?: OutstandingIntelligence[];
  // The ledger behind that list, so the empty case can say WHICH empty it is.
  // Null means no ledger was derived -- there is no finished run to derive one
  // from -- and in that case this panel says nothing about coverage at all
  // rather than defaulting to the flattering reading. That default is how
  // "everything looked for was found" used to appear over a run that had
  // looked for nothing.
  coverage?: { found: number; settled: number; open: number; total: number } | null;
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
      {/* "Run research again" was the wrong name in the wrong place. It sat
          as a peer of "Check claims against their sources" -- which reads
          evidence already stored -- while doing something entirely different:
          a fresh web search, paid, several minutes. Two actions that differ in
          cost by an order of magnitude must not read as variations of one
          another, and "again" implies the last attempt failed when usually
          nothing is wrong at all.
          
          So it is named for what it does, and sized for how often it is the
          right answer: rarely. */}
      <button
        type="button"
        disabled={isPending}
        style={repeat ? { ...buttonSecondary, padding: "4px 10px", fontSize: 12.5 } : buttonPrimary}
        onClick={() => setConfirming(true)}
      >
        {repeat ? "Gather more intelligence" : "Run research"}
      </button>
      {repeat && (
        <div style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 4, maxWidth: 560 }}>
          {gaps.length > 0 ? (
            <>
              What another search could still find:
              <ul style={{ margin: "3px 0 0", paddingLeft: 16 }}>
                {gaps.map((g, i) => (
                  <li key={i}>
                    <span style={{ color: colors.textMuted }}>{g.label}</span> — {g.worth}
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 3 }}>
                {/* Ruling 0013/STATE check (6): the old wording said this
                    "spends credits". There is no credits concept anywhere in
                    the 65 migrations -- the app was telling a nonprofit they
                    were drawing down a balance that does not exist. What is
                    true, and stays true whatever the pricing model becomes, is
                    that the run costs real money and takes several minutes. */}
                A fresh search of the live web{lastDate ? `, last done ${lastDate}` : ""} — it costs real money and
                takes several minutes.
              </div>
            </>
          ) : coverage ? (
            // Nothing left that more work could change. Ruling 0009: this used
            // to be one sentence -- "everything looked for was found" -- and it
            // had to cover two different situations. They are stated separately
            // now, because "we found it" and "we looked everywhere it could be
            // and they do not state it" are different facts about the funder.
            <>
              Nothing further to look for{lastDate ? ` as of ${lastDate}` : ""}: of the {coverage.total} facts screening
              needs, {coverage.found} {coverage.found === 1 ? "was" : "were"} found and {coverage.settled}{" "}
              {coverage.settled === 1 ? "was" : "were"} looked for in every source that could carry {coverage.settled === 1 ? "it" : "them"} and not
              stated. A funder can still publish something new — worth a search only if you believe something has
              changed since.
            </>
          ) : null}
        </div>
      )}

      {error && <div style={{ fontSize: 12.5, color: colors.danger, marginTop: spacing.xs }}>{error}</div>}

      <ConfirmDialog
        open={confirming}
        title={repeat ? "Gather more intelligence?" : "Run dossier research?"}
        message={
          repeat
            ? // Names the target when there is one, and the likely outcome when
              // there is not. A dialog that only describes the upside invites
              // paying for it repeatedly. Ruling 0009 governs the first branch:
              // the list it names is obtainableGaps' output and nothing else,
              // so a fact this funder was already found not to state can never
              // be named here as a reason to spend.
              (gaps.length > 0
                ? `This searches the live web for what another search could still find: ${gaps.map((g) => g.label).join(", ")}. Whether a funder publishes any of it varies — some do not. `
                : coverage
                  ? `Every fact screening needs has either been found or been looked for in every source that could carry it, so this is likely to return what the last search did. `
                  : `There is no coverage record for this funder, so there is nothing specific to aim this at. `) +
              `Last searched ${lastDate}. It costs real money and takes several minutes. It does not re-read evidence already stored.`
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
