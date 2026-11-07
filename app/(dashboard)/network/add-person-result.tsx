"use client";

// What appears under the form after ONE person is added by hand (STATE item 109,
// ruling 0044 clause 2): the look for their matches runs by itself once they are
// saved -- an automatic LOOK is allowed -- and the matches are shown here, in
// place, with the evidence and two buttons, "Confirm this person" and "None of
// these". Nothing here confirms anyone: the only confirm is a human click inside
// PersonCard. The person is saved whatever happens here; a look that cannot run
// or fails never undoes or blocks the save.

import { PersonCard } from "./identity/person-card";
import type { ReviewPerson } from "@/lib/network-identity-flow";
import { spacing, colors, buttonSecondary, cardStyle } from "@/lib/ui";

export type AddPhase =
  | { kind: "idle" }
  // Saved, and not looked at: do not research, or only a name. `canAddDetails`
  // is true when adding an employer, title or city would let the look run.
  | { kind: "not_looked"; name: string; message: string; canAddDetails: boolean }
  | { kind: "looking"; name: string }
  // The look (step "look") or reading its matches back (step "read") failed.
  // Only a failed look is run again by "Try again"; a failed read is read again.
  | { kind: "failed"; name: string; message: string; step: "look" | "read" }
  | { kind: "no_matches"; name: string; message: string }
  | { kind: "matches"; name: string; person: ReviewPerson };

export function AddPersonResultView({
  phase,
  onTryAgain,
  onAddDetails,
}: {
  phase: AddPhase;
  onTryAgain: () => void;
  onAddDetails: () => void;
}) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "looking") {
    return (
      <div style={cardStyle} role="status" aria-live="polite">
        <div style={{ fontWeight: 600, fontSize: 15 }}>{phase.name}</div>
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13 }}>Saved. Looking for matches…</p>
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 12.5, color: colors.textMuted }}>
          This is one AI run. It can take up to a minute. You can keep using the page.
        </p>
      </div>
    );
  }

  if (phase.kind === "matches") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.sm }}>
        <p style={{ margin: 0, fontSize: 13 }}>
          Saved. Found {phase.person.candidates.length} possible {phase.person.candidates.length === 1 ? "match" : "matches"}. Nothing is confirmed until you say so.
        </p>
        <PersonCard key={phase.person.id} p={phase.person} mode="single" />
      </div>
    );
  }

  return (
    <div style={cardStyle} role="status" aria-live="polite">
      <div style={{ fontWeight: 600, fontSize: 15 }}>{phase.name}</div>
      {phase.kind === "failed" ? (
        <>
          <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13 }}>
            Saved. {phase.step === "look" ? "The look for matches did not complete." : "The matches were found but could not be shown."}
          </p>
          <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13, color: colors.danger }}>{phase.message}</p>
        </>
      ) : (
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13 }}>{phase.message}</p>
      )}
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" }}>
        {phase.kind === "failed" && (
          <button type="button" style={buttonSecondary} onClick={onTryAgain}>
            Try again
          </button>
        )}
        {phase.kind === "not_looked" && phase.canAddDetails && (
          <button type="button" style={buttonSecondary} onClick={onAddDetails}>
            Add details
          </button>
        )}
      </div>
    </div>
  );
}
