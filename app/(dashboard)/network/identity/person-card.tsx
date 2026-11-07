"use client";

// The one place a person's candidates are shown with a choice. Used by the
// review screen (/network/identity) and, in "single" mode, in place under the
// form that has just added one person. The confirm and "none of these" buttons
// here are the ONLY client call sites of confirmIdentity and markNoneOfThese:
// each runs from a click on a button, never from an effect or a page load, and
// never on the strength of a preselected match alone.
//
// In "single" mode (the panel under the add form) the SAME click continues into
// the research of the person just confirmed (STATE item 112, ruling 0044): once
// the confirmation has succeeded, in the continuation of that click, the card
// researches the person and shows "Researching…" and then "What we found" in
// place. That is the only automatic research there is. It never happens on load,
// never without a human's confirmation first, never in the review screen's batch
// confirm, and a failed research never undoes the confirmation.

import { useState, useTransition } from "react";
import { confirmIdentity, findIdentityCandidates, markNoneOfThese, setDoNotResearch } from "../identity-actions";
import { FindingsSection } from "../research/findings-view";
import { usePersonResearch } from "../research/use-person-research";
import type { EvidenceItem } from "@/lib/network-identity";
import type { ReviewCandidate, ReviewPerson } from "@/lib/network-identity-flow";
import { spacing, colors, buttonPrimary, buttonSecondary, cardStyle, chipStyle } from "@/lib/ui";

const MARK_COLOR = { found: colors.success, not_found: colors.warning, not_recorded: colors.textFaint } as const;

export function Evidence({ items, line }: { items: EvidenceItem[]; line: string }) {
  return (
    <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 12.5, lineHeight: 1.6 }} aria-label={line}>
      {items.map((e, i) => (
        // A plain space between items gives the line somewhere to wrap on a narrow screen.
        <span key={e.key}>
          {i > 0 && " "}
          <span style={{ whiteSpace: "nowrap" }}>
            {i > 0 && <span style={{ color: colors.textFaint }}>· </span>}
            <span style={{ color: colors.textMuted }}>{e.label} </span>
            <span style={{ color: MARK_COLOR[e.value], fontWeight: 600 }}>{e.mark} </span>
            <span style={{ color: MARK_COLOR[e.value] }}>{e.text}</span>
          </span>
        </span>
      ))}
    </p>
  );
}

export function RecordedFacts({ p }: { p: ReviewPerson }) {
  const where = [p.city, p.state].filter(Boolean).join(", ");
  return (
    <div style={{ fontSize: 13, color: colors.textMuted }}>
      {[p.affiliation, p.title, where].filter(Boolean).join(" · ") || "(no employer, title or place recorded)"}
    </div>
  );
}

export function SourceLink({ c }: { c: ReviewCandidate }) {
  return (
    <div style={{ fontSize: 12.5, marginTop: 2, wordBreak: "break-word" }}>
      <span style={{ color: colors.textMuted }}>Found on: </span>
      <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: colors.text }}>
        {c.sourceTitle || c.sourceUrl}
      </a>
    </div>
  );
}

function CandidateBody({ c, suggested }: { c: ReviewCandidate; suggested: boolean }) {
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{c.label}</span>
        {suggested && <span style={chipStyle("teal")}>Suggested — please check</span>}
      </div>
      {c.headline && <div style={{ fontSize: 13 }}>{c.headline}</div>}
      {c.locationText && <div style={{ fontSize: 13, color: colors.textMuted }}>{c.locationText}</div>}
      <SourceLink c={c} />
      <Evidence items={c.evidence} line={c.evidenceLine} />
      {(!c.labelSupported || c.headlineSupported === false) && (
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 12, color: colors.warning }}>
          {!c.labelSupported ? "The name shown is the AI's reading of the page and was not found word for word in the text that was captured. " : ""}
          {c.headlineSupported === false ? "The description above uses words that were not found in the captured text. " : ""}
          Check the source before choosing.
        </p>
      )}
      {c.recomputed && (
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 12, color: colors.textMuted }}>
          This person&apos;s details were edited after the look, so the comparison above was worked out again from the captured text.
        </p>
      )}
    </div>
  );
}

const NONE = "__none__";

const optionStyle = (selected: boolean) =>
  ({
    display: "flex",
    gap: spacing.sm,
    alignItems: "flex-start",
    padding: spacing.sm,
    border: `1px solid ${selected ? colors.primary : colors.border}`,
    borderRadius: 6,
    cursor: "pointer",
    boxSizing: "border-box",
  }) as const;

const EVIDENCE_NOTE = (
  <>
    &ldquo;Not found in source&rdquo; means the text that was captured from the page did not contain it. The captured text is often only a short snippet, so
    that is not proof the page disagrees; open the source to be sure.
  </>
);

// mode "review": the radio choice (candidates and "None of these") with one
// confirm button, plus Look again and Do not research -- the review screen.
// mode "single": the person was just added; the candidates are chosen with a
// radio and the two buttons are "Confirm this person" and "None of these".
export function PersonCard({ p, mode = "review" }: { p: ReviewPerson; mode?: "review" | "single" }) {
  const [choice, setChoice] = useState<string>(p.preselectedId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const research = usePersonResearch(p.id);
  const single = mode === "single";

  // A human click on a button: nothing here runs on load or on a timer.
  const confirmChosen = () => {
    if (!choice || choice === NONE) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await confirmIdentity(p.id, choice);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      if (single) {
        setDone(`Confirmed: ${p.candidates.find((c) => c.id === choice)?.label ?? p.name}.`);
        // The confirmation above has succeeded; this click carries on into the
        // research of that person. The server still refuses anyone it must.
        await research.run(false);
      }
    });
  };
  const recordNone = () => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await markNoneOfThese(p.id);
      if ("error" in result) setError(result.error);
      else if (single) setDone("Recorded: none of these. This person will not be looked up again unless you reset them.");
    });
  };
  const submit = () => (choice === NONE ? recordNone() : confirmChosen());

  if (done) {
    return (
      <div style={cardStyle} id={`person-${p.id}`}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13 }}>{done}</p>
        <div style={{ marginTop: spacing.md }}>
          <FindingsSection name={p.name} research={research} showStart={false} />
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle} id={`person-${p.id}`}>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
      <RecordedFacts p={p} />
      <fieldset style={{ border: "none", padding: 0, margin: `${spacing.md}px 0 0`, display: "grid", gap: spacing.sm }}>
        <legend style={{ fontSize: 12.5, color: colors.textMuted, padding: 0, marginBottom: spacing.xs }}>Which of these is {p.name}?</legend>
        {p.candidates.map((c) => (
          <label key={c.id} style={optionStyle(choice === c.id)}>
            <input type="radio" name={`choice-${p.id}`} value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} style={{ marginTop: 3 }} />
            <CandidateBody c={c} suggested={p.preselectedId === c.id} />
          </label>
        ))}
        {!single && (
          <label style={{ ...optionStyle(choice === NONE), alignItems: "center" }}>
            <input type="radio" name={`choice-${p.id}`} value={NONE} checked={choice === NONE} onChange={() => setChoice(NONE)} />
            <span style={{ fontSize: 14 }}>None of these</span>
            <span style={{ fontSize: 12.5, color: colors.textMuted }}>— recorded, and this person is not looked up again unless you reset them</span>
          </label>
        )}
      </fieldset>
      <p style={{ margin: `${spacing.sm}px 0 0`, fontSize: 12, color: colors.textMuted }}>{EVIDENCE_NOTE}</p>
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{error}</p>}
      {notice && <p style={{ fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{notice}</p>}
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md, flexWrap: "wrap" }}>
        {single ? (
          <>
            <button type="button" style={buttonPrimary} disabled={isPending || !choice} onClick={confirmChosen}>
              {isPending ? "Saving…" : "Confirm this person"}
            </button>
            <button type="button" style={buttonSecondary} disabled={isPending} onClick={recordNone}>
              None of these
            </button>
          </>
        ) : (
          <>
            <button type="button" style={buttonPrimary} disabled={isPending || !choice} onClick={submit}>
              {isPending ? "Saving…" : choice === NONE ? "Record: none of these" : "Confirm this is the person"}
            </button>
            <button
              type="button"
              style={buttonSecondary}
              disabled={isPending}
              onClick={() => {
                setError(null);
                setNotice(null);
                startTransition(async () => {
                  const result = await findIdentityCandidates(p.id);
                  if ("error" in result) setError(result.error);
                  else setNotice(result.message);
                });
              }}
            >
              Look again
            </button>
            <button
              type="button"
              style={buttonSecondary}
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await setDoNotResearch([p.id], true);
                  if ("error" in result) setError(result.error);
                });
              }}
            >
              Do not research this person
            </button>
          </>
        )}
      </div>
    </div>
  );
}
