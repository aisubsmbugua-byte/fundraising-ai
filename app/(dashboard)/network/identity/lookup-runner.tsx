"use client";

// "Confirm your network" for a list or an import (STATE item 109, ruling 0044).
//
// One button. Its click is the consent: the statement beside it says how many
// people are waiting, that each one costs one AI run, and how many this click
// looks at (the next 50 at most). The click then looks people up from HERE, the
// browser, one at a time, by calling the existing single-person action in
// sequence -- so each call is one request, one person and one ledger run,
// refused on the server for anyone who may not be looked at -- with visible
// progress and a Stop button. It never confirms anyone: a look only proposes
// candidates, and the screen it ends on is where a human confirms.
//
// Nothing here starts on load: the only call to the loop is the click handler.
// (The one effect below only STOPS the loop when the page is left.)

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { findIdentityCandidates, loadLookupQueue } from "../identity-actions";
import {
  IDENTITY_CLICK_CAP,
  buildLookupQueue,
  lookupCostStatement,
  lookupLoopAddsUp,
  lookupSummary,
  progressText,
  runLookupLoop,
} from "@/lib/network-identity-flow";
import { spacing, colors, buttonPrimary, buttonSecondary, sectionStyle } from "@/lib/ui";

export type LookupPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; position: number; total: number; stopping: boolean }
  | { kind: "finished"; message: string; clean: boolean }
  | { kind: "error"; message: string };

export const REVIEW_HREF = "/network/identity";

const fullWidth = { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.sm } as const;

// The look of the thing, with no behaviour of its own (so it can be rendered
// for every phase with fixture data).
export function LookupRunnerView({
  phase,
  eligible,
  label,
  primary,
  reviewHref,
  whenNoneWaiting,
  onStart,
  onStop,
}: {
  phase: LookupPhase;
  // People waiting to be looked up; null when not known yet.
  eligible: number | null;
  label: string;
  primary: boolean;
  // Where the matches are reviewed. When nobody is waiting, the button just goes there.
  reviewHref: string;
  // With nobody waiting, the button is a link into the review screen ("link"),
  // or nothing at all when this IS the review screen ("nothing").
  whenNoneWaiting: "link" | "nothing";
  onStart: () => void;
  onStop: () => void;
}) {
  const buttonStyle = primary ? buttonPrimary : buttonSecondary;
  const busy = phase.kind === "starting" || phase.kind === "running";
  const statement =
    eligible === null
      ? `Each person looked up costs one AI run. One click looks up at most ${IDENTITY_CLICK_CAP} people.`
      : lookupCostStatement(eligible);

  if (eligible === 0 && phase.kind === "idle") {
    if (whenNoneWaiting === "nothing") return null;
    return (
      <div style={fullWidth}>
        <div style={{ display: "flex", gap: spacing.md, alignItems: "center", flexWrap: "wrap" }}>
          <Link href={reviewHref} style={{ ...buttonStyle, textDecoration: "none", display: "inline-block" }}>
            {label}
          </Link>
          <span style={{ fontSize: 12.5, color: colors.textMuted }}>{statement}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={fullWidth}>
      <div style={{ display: "flex", gap: spacing.md, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" style={buttonStyle} disabled={busy} onClick={onStart}>
          {phase.kind === "starting" ? "Checking who is waiting…" : phase.kind === "running" ? progressText(phase.position, phase.total) : label}
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
          <progress value={phase.position - 1} max={phase.total} style={{ width: "100%", boxSizing: "border-box" }} aria-label={progressText(phase.position, phase.total)} />
          <p style={{ margin: 0, fontSize: 12.5, color: colors.textMuted }}>
            Each person is one AI run. You can stop at any time, or leave this page: people already looked at stay done and the rest wait for your next click.
            Nobody is confirmed by this; you choose on the next screen.
          </p>
        </>
      )}
      {phase.kind === "finished" && (
        <p style={{ margin: 0, fontSize: 13 }}>
          {phase.message}{" "}
          {!phase.clean && (
            <Link href={reviewHref} style={{ color: colors.text }}>
              Review what was found
            </Link>
          )}
        </p>
      )}
      {phase.kind === "error" && <p style={{ margin: 0, fontSize: 13, color: colors.danger }}>{phase.message}</p>}
    </div>
  );
}

export default function LookupRunner({
  eligible,
  label = "Confirm your network",
  primary = true,
  reviewHref = REVIEW_HREF,
  navigateWhenDone = false,
  whenNoneWaiting = "link",
  boxed = false,
}: {
  eligible: number | null;
  label?: string;
  primary?: boolean;
  reviewHref?: string;
  // On the Network page and after an import, a finished run goes straight to the
  // review screen (unless something went wrong, which is shown first).
  navigateWhenDone?: boolean;
  whenNoneWaiting?: "link" | "nothing";
  boxed?: boolean;
}) {
  const [phase, setPhase] = useState<LookupPhase>({ kind: "idle" });
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
    const fetched = await loadLookupQueue();
    if ("error" in fetched) {
      setPhase({ kind: "error", message: fetched.error });
      return;
    }
    // Anyone already looked at in this visit is skipped; the cap is applied here
    // as well as on the server's list.
    const plan = buildLookupQueue(fetched.ids, { done: doneRef.current });
    if (plan.queue.length === 0) {
      setPhase({ kind: "finished", message: "Nobody is waiting to be looked up.", clean: false });
      return;
    }
    setPhase({ kind: "running", position: 1, total: plan.queue.length, stopping: false });
    const outcome = await runLookupLoop({
      queue: plan.queue,
      look: (personId) => findIdentityCandidates(personId),
      shouldStop: () => stopRef.current,
      onProgress: (p) => setPhase({ kind: "running", position: p.position, total: p.total, stopping: stopRef.current }),
    });
    for (const id of outcome.doneIds) doneRef.current.add(id);
    const addsUp = lookupLoopAddsUp(outcome, plan.queue.length);
    const clean = outcome.stoppedBy === "done" && outcome.failed === 0 && addsUp;
    setPhase({
      kind: "finished",
      message: addsUp ? lookupSummary(outcome, plan.queue.length, fetched.eligible) : "The counts did not add up, so the result is not shown. Check the Network page.",
      clean,
    });
    if (navigateWhenDone && clean) window.location.assign(reviewHref);
  };

  const view = (
    <LookupRunnerView
      phase={phase}
      eligible={eligible}
      label={label}
      primary={primary}
      reviewHref={reviewHref}
      whenNoneWaiting={whenNoneWaiting}
      onStart={start}
      onStop={() => {
        stopRef.current = true;
        setPhase((p) => (p.kind === "running" ? { ...p, stopping: true } : p));
      }}
    />
  );
  return boxed ? <section style={sectionStyle}>{view}</section> : view;
}
