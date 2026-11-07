"use client";

// What was found about one confirmed person (STATE item 112, ruling 0044 clauses
// 3 to 5). Every finding is shown with the page it came from (opens in a new tab),
// the wording the page actually gave, and the label "Not yet reviewed by a person";
// a human can strike any of them. Findings the captured text did not support are
// kept apart, collapsed, and never presented as findings; struck ones are kept apart
// too, with a way back. The age of what is held is always shown.
//
// This file only SHOWS and reports clicks: it has no effect, no timer and no call
// to the server of its own. The clicks it reports are made by the caller's handlers.

import { groupFindings, FINDING_KIND_LABEL, NOT_REVIEWED_LABEL, RESEARCH_COST_NOTE, RESEARCH_SHARED_STATEMENT, type ReviewFinding } from "@/lib/network-research";
import type { PersonResearch, ResearchPhase } from "./use-person-research";
import { spacing, colors, buttonSecondary, chipStyle } from "@/lib/ui";

const grid = { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.sm } as const;
const smallButton = { ...buttonSecondary, fontSize: 13, padding: "6px 10px" } as const;

function FindingItem({ f, busy, onStrike, onRestore }: { f: ReviewFinding; busy: boolean; onStrike: (id: string) => void; onRestore: (id: string) => void }) {
  const struck = f.status === "struck";
  return (
    <li style={{ listStyle: "none", border: `1px solid ${colors.border}`, borderRadius: 6, padding: spacing.sm, boxSizing: "border-box", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2 }}>
      <div style={{ fontWeight: 600, fontSize: 14, textDecoration: struck ? "line-through" : "none", color: struck ? colors.textMuted : colors.text, overflowWrap: "anywhere" }}>
        {f.statement || "(no wording)"}
      </div>
      <div style={{ fontSize: 12.5, wordBreak: "break-word" }}>
        <span style={{ color: colors.textMuted }}>Found on: </span>
        <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: colors.text }}>
          {f.sourceTitle || f.sourceUrl}
        </a>
      </div>
      {f.wording && (
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 12.5, color: colors.textMuted, borderLeft: `3px solid ${colors.border}`, paddingLeft: spacing.sm, overflowWrap: "anywhere" }}>
          <span style={{ color: colors.textFaint }}>The page&apos;s own words: </span>&ldquo;{f.wording}&rdquo;
        </p>
      )}
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap", marginTop: spacing.xs }}>
        {struck ? <span style={chipStyle("neutral")}>Struck by a person</span> : <span style={chipStyle("amber")}>{NOT_REVIEWED_LABEL}</span>}
        {struck ? (
          <button type="button" style={smallButton} disabled={busy} onClick={() => onRestore(f.id)}>
            {busy ? "Restoring…" : "Restore"}
          </button>
        ) : (
          <button type="button" style={smallButton} disabled={busy} onClick={() => onStrike(f.id)}>
            {busy ? "Striking…" : "Strike"}
          </button>
        )}
      </div>
    </li>
  );
}

function FindingList({ list, busyId, onStrike, onRestore }: { list: ReviewFinding[]; busyId: string | null; onStrike: (id: string) => void; onRestore: (id: string) => void }) {
  return (
    <ul style={{ margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.sm }}>
      {list.map((f) => (
        <FindingItem key={f.id} f={f} busy={busyId === f.id} onStrike={onStrike} onRestore={onRestore} />
      ))}
    </ul>
  );
}

export function FindingsView({
  name,
  phase,
  findings,
  ageText,
  message,
  error,
  busyId,
  showStart,
  onResearch,
  onResearchAgain,
  onStrike,
  onRestore,
}: {
  name: string;
  phase: ResearchPhase;
  findings: ReviewFinding[];
  ageText: string | null;
  message: string | null;
  error: string | null;
  busyId: string | null;
  // In the people list, a confirmed person who has not been researched offers a
  // "Research this person" click. Right after a confirmation the research has
  // already started, so there is nothing to offer.
  showStart: boolean;
  onResearch: () => void;
  onResearchAgain: () => void;
  onStrike: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  if (phase.kind === "none") {
    if (!showStart) return null;
    return (
      <div style={grid}>
        <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>Not researched yet. {RESEARCH_COST_NOTE} Researching spends only when you click.</p>
        <div>
          <button type="button" style={smallButton} onClick={onResearch}>
            Research this person
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: colors.textMuted }}>{RESEARCH_SHARED_STATEMENT}</p>
      </div>
    );
  }

  if (phase.kind === "running") {
    return (
      <div style={grid} role="status" aria-live="polite">
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Researching…</p>
        <p style={{ margin: 0, fontSize: 12.5, color: colors.textMuted }}>
          Looking for what the public web says about {name}. This is one AI run, heavier than a match look, and can take a few minutes. Your confirmation stands whatever happens.
        </p>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div style={grid}>
        <p style={{ margin: 0, fontSize: 13 }}>The research did not complete. {name} is still confirmed; nothing about that was undone.</p>
        <p style={{ margin: 0, fontSize: 13, color: colors.danger }}>{phase.message}</p>
        <div>
          <button type="button" style={smallButton} onClick={onResearch}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const { usable, unsupported, struck } = groupFindings(findings);
  return (
    <div style={grid}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: spacing.sm, flexWrap: "wrap", alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>What we found</h3>
        {ageText && <span style={{ fontSize: 12.5, color: colors.textMuted }}>{ageText}</span>}
      </div>
      {message && <p style={{ margin: 0, fontSize: 13 }}>{message}</p>}
      {error && <p style={{ margin: 0, fontSize: 13, color: colors.danger }}>{error}</p>}
      {usable.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
          Nothing usable was found about {name}. That is not unusual for someone with little public footprint.
        </p>
      ) : (
        usable.map((g) => (
          <section key={g.kind} style={grid} aria-label={FINDING_KIND_LABEL[g.kind]}>
            <h4 style={{ margin: 0, fontSize: 13, color: colors.textMuted, fontWeight: 600 }}>{g.label}</h4>
            <FindingList list={g.findings} busyId={busyId} onStrike={onStrike} onRestore={onRestore} />
          </section>
        ))
      )}
      {unsupported.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Could not be checked against the source ({unsupported.length})</summary>
          <div style={{ ...grid, marginTop: spacing.sm }}>
            <p style={{ margin: 0, fontSize: 12.5, color: colors.warning }}>
              The words below were not all found in the text captured from the page, so they are not treated as findings and nothing uses them. They are kept so you can see what was set aside.
            </p>
            <FindingList list={unsupported} busyId={busyId} onStrike={onStrike} onRestore={onRestore} />
          </div>
        </details>
      )}
      {struck.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Struck ({struck.length})</summary>
          <div style={{ ...grid, marginTop: spacing.sm }}>
            <p style={{ margin: 0, fontSize: 12.5, color: colors.textMuted }}>A struck finding stays recorded and is never used. Restore it if the strike was a mistake.</p>
            <FindingList list={struck} busyId={busyId} onStrike={onStrike} onRestore={onRestore} />
          </div>
        </details>
      )}
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" style={smallButton} onClick={onResearchAgain}>
          Research again
        </button>
        <span style={{ fontSize: 12.5, color: colors.textMuted }}>Costs one AI run. Nothing found here is sent to anyone or used in a draft.</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: colors.textMuted }}>{RESEARCH_SHARED_STATEMENT}</p>
    </div>
  );
}

// The same view, driven by the hook. `showStart` is true in the people list.
export function FindingsSection({ name, research, showStart }: { name: string; research: PersonResearch; showStart: boolean }) {
  return (
    <FindingsView
      name={name}
      phase={research.phase}
      findings={research.findings}
      ageText={research.ageText}
      message={research.message}
      error={research.error}
      busyId={research.busyId}
      showStart={showStart}
      onResearch={() => void research.run(false)}
      onResearchAgain={() => void research.run(true)}
      onStrike={(id) => void research.strike(id)}
      onRestore={(id) => void research.restore(id)}
    />
  );
}
