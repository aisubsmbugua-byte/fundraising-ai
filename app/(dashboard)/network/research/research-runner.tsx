"use client";

// "Research your network (N)" for confirmed people (STATE item 112, ruling 0044
// clauses 3, 5 and 9).
//
// One button. Its click is the consent: the statement beside it says how many
// confirmed people are waiting, that each one costs one AI run (heavier than a match
// look, because it reads more), that this click spends, and how many it researches
// (the next 50 at most). The click then researches people from HERE, the browser,
// one at a time, by calling the single-person action in sequence -- so each call is
// one request, one person and one ledger run, refused on the server for anyone who is
// not confirmed, is marked do not research, or was already researched -- with visible
// progress and a Stop button. It reuses the identity look's loop unchanged
// (lib/network-identity-flow.ts runLookupLoop): the same cap, the same Stop, the same
// stop after repeated problems.
//
// Nothing here starts on load, after a batch confirmation or after an import: the
// only call to the loop is the click handler. (The one effect below only STOPS the
// loop when the page is left.) It never confirms or changes anyone's identity.

import { useEffect, useRef, useState } from "react";
import { loadResearchQueue, researchPerson } from "../research-actions";
import { buildLookupQueue, lookupLoopAddsUp, runLookupLoop } from "@/lib/network-identity-flow";
import { RESEARCH_SHARED_STATEMENT, researchButtonLabel, researchCostStatement, researchProgressText, researchSummary, toLoopResult } from "@/lib/network-research";
import { spacing, colors, buttonPrimary, buttonSecondary, sectionStyle } from "@/lib/ui";

export type ResearchRunnerPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; position: number; total: number; stopping: boolean }
  | { kind: "finished"; message: string }
  | { kind: "error"; message: string };

const fullWidth = { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.sm } as const;

// The look of the thing, with no behaviour of its own (so it can be rendered for
// every phase with fixture data).
export function ResearchRunnerView({
  phase,
  waiting,
  onStart,
  onStop,
}: {
  phase: ResearchRunnerPhase;
  // Confirmed people waiting to be researched; null when not known yet.
  waiting: number | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const busy = phase.kind === "starting" || phase.kind === "running";
  // With nobody waiting there is nothing to click; a finished click still says what happened.
  if (waiting === 0 && phase.kind === "idle") return null;
  const statement = waiting === null ? "Each person researched costs one AI run, heavier than a match look because it reads more. One click researches at most 50 people." : researchCostStatement(waiting);
  const label = waiting === null ? "Research your network" : researchButtonLabel(waiting);

  return (
    <div style={fullWidth}>
      <div style={{ display: "flex", gap: spacing.md, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" style={buttonPrimary} disabled={busy} onClick={onStart}>
          {phase.kind === "starting" ? "Checking who is waiting…" : phase.kind === "running" ? researchProgressText(phase.position, phase.total) : label}
        </button>
        {phase.kind === "running" && (
          <button type="button" style={buttonSecondary} disabled={phase.stopping} onClick={onStop}>
            {phase.stopping ? "Stopping after this person…" : "Stop"}
          </button>
        )}
        {!busy && <span style={{ fontSize: 12.5, color: colors.textMuted, maxWidth: 560 }}>{statement}</span>}
      </div>
      {phase.kind === "running" && (
        <>
          <progress value={phase.position - 1} max={phase.total} style={{ width: "100%", boxSizing: "border-box" }} aria-label={researchProgressText(phase.position, phase.total)} />
          <p style={{ margin: 0, fontSize: 12.5, color: colors.textMuted }}>
            Each person is one AI run. You can stop at any time, or leave this page: people already researched stay done and the rest wait for your next click. Nobody&apos;s identity
            is changed by this.
          </p>
        </>
      )}
      {!busy && <p style={{ margin: 0, fontSize: 12, color: colors.textMuted }}>{RESEARCH_SHARED_STATEMENT}</p>}
      {phase.kind === "finished" && <p style={{ margin: 0, fontSize: 13 }}>{phase.message}</p>}
      {phase.kind === "error" && <p style={{ margin: 0, fontSize: 13, color: colors.danger }}>{phase.message}</p>}
    </div>
  );
}

export default function ResearchRunner({ waiting, boxed = true }: { waiting: number | null; boxed?: boolean }) {
  const [phase, setPhase] = useState<ResearchRunnerPhase>({ kind: "idle" });
  const stopRef = useRef(false);
  const doneRef = useRef<Set<string>>(new Set());

  // Leaving the page stops the loop at the next person. This effect starts nothing.
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    []
  );

  // The ONLY place the loop is started: the click on the button.
  const start = async () => {
    stopRef.current = false;
    setPhase({ kind: "starting" });
    const fetched = await loadResearchQueue();
    if ("error" in fetched) {
      setPhase({ kind: "error", message: fetched.error });
      return;
    }
    // Anyone already researched in this visit is skipped; the cap is applied here as
    // well as on the server's list.
    const plan = buildLookupQueue(fetched.ids, { done: doneRef.current });
    if (plan.queue.length === 0) {
      setPhase({ kind: "finished", message: "Nobody is waiting to be researched." });
      return;
    }
    setPhase({ kind: "running", position: 1, total: plan.queue.length, stopping: false });
    const outcome = await runLookupLoop({
      queue: plan.queue,
      look: async (personId) => toLoopResult(await researchPerson(personId)),
      shouldStop: () => stopRef.current,
      onProgress: (p) => setPhase({ kind: "running", position: p.position, total: p.total, stopping: stopRef.current }),
    });
    for (const id of outcome.doneIds) doneRef.current.add(id);
    const addsUp = lookupLoopAddsUp(outcome, plan.queue.length);
    setPhase({
      kind: "finished",
      message: addsUp ? researchSummary(outcome, plan.queue.length, fetched.eligible) : "The counts did not add up, so the result is not shown. Check the Network page.",
    });
  };

  // With nobody waiting and nothing to report there is no box at all.
  if (waiting === 0 && phase.kind === "idle") return null;

  const view = (
    <ResearchRunnerView
      phase={phase}
      waiting={waiting}
      onStart={start}
      onStop={() => {
        stopRef.current = true;
        setPhase((p) => (p.kind === "running" ? { ...p, stopping: true } : p));
      }}
    />
  );
  return boxed ? <section style={sectionStyle}>{view}</section> : view;
}
