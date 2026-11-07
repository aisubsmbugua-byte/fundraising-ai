"use client";

// The single review screen (STATE item 109, ruling 0044 clause 2): it opens
// straight to the work. A compact status line replaces the old "where everyone
// stands" step; people whose page text contained their name, their employer or
// title, and their place are listed with the match that would be used, and ONE
// button, "Confirm your network (N)", confirms them. People without a strong
// match stay below for an individual choice. A preselected match is a default
// highlight only: nobody is confirmed until a human clicks that button (or the
// confirm button on a person's own card), and the server re-derives the
// preselection from stored data before it confirms anything.

import { useState, useTransition } from "react";
import Link from "next/link";
import { confirmPreselectedIdentities } from "../identity-actions";
import LookupRunner from "./lookup-runner";
import ResearchRunner from "../research/research-runner";
import { Evidence, PersonCard, RecordedFacts, SourceLink } from "./person-card";
import { LOOK_REFUSAL_LABEL, type IdentityState, type LookRefusalCode } from "@/lib/network-identity";
import { statusLineParts, strongMatchPairs, type ReviewPerson, type StateCounts } from "@/lib/network-identity-flow";
import { spacing, colors, buttonPrimary, buttonSecondary, sectionStyle, cardStyle, chipStyle } from "@/lib/ui";

export type { ReviewCandidate, ReviewPerson, StateCounts } from "@/lib/network-identity-flow";

const TONE: Record<IdentityState, "teal" | "amber" | "red" | "neutral"> = {
  not_looked_at: "neutral",
  no_candidates_found: "neutral",
  candidates: "amber",
  confirmed: "teal",
  none_of_these: "neutral",
  do_not_research: "red",
};

// Why some people cannot be looked up at all matters to the person deciding what
// to fix: a name on its own is the one the owner can do something about.
const WORTH_SAYING: LookRefusalCode[] = ["too_few_facts", "no_name"];

function StrongRow({
  p,
  included,
  choosing,
  onInclude,
  onChoose,
  disabled,
}: {
  p: ReviewPerson;
  included: boolean;
  choosing: boolean;
  onInclude: (v: boolean) => void;
  onChoose: (v: boolean) => void;
  disabled: boolean;
}) {
  const c = p.candidates.find((x) => x.id === p.preselectedId);
  if (!c) return null;
  if (choosing) {
    return (
      <div style={{ display: "grid", gap: spacing.xs }}>
        <PersonCard p={p} />
        <div>
          <button type="button" style={buttonSecondary} disabled={disabled} onClick={() => onChoose(false)}>
            Back to the suggested match
          </button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ ...cardStyle, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2, opacity: included ? 1 : 0.7 }} id={`person-${p.id}`}>
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: spacing.sm, alignItems: "flex-start", minWidth: 0 }}>
          <input
            type="checkbox"
            checked={included}
            onChange={(e) => onInclude(e.target.checked)}
            aria-label={`Include ${p.name} when I confirm my network`}
            style={{ marginTop: 4, cursor: "pointer", flexShrink: 0 }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
              <RecordedFacts p={p} />
            </div>
          </div>
        </div>
        <button type="button" style={{ ...buttonSecondary, fontSize: 13, padding: "6px 10px" }} disabled={disabled} onClick={() => onChoose(true)}>
          Choose a different match
        </button>
      </div>
      <div style={{ fontSize: 13, paddingLeft: 26 }}>
        <span style={{ color: colors.textMuted }}>will be confirmed as: </span>
        <strong>{c.label}</strong>
        {c.headline ? ` — ${c.headline}` : ""}
        {c.locationText ? ` — ${c.locationText}` : ""}
      </div>
      <div style={{ paddingLeft: 26 }}>
        <SourceLink c={c} />
        <Evidence items={c.evidence} line={c.evidenceLine} />
        {(!c.labelSupported || c.headlineSupported === false) && (
          <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 12, color: colors.warning }}>
            Some of the words shown here were not found word for word in the captured text. Check the source before you confirm.
          </p>
        )}
      </div>
    </div>
  );
}

export default function IdentityWorkspace({
  counts,
  totalRecorded,
  eligible,
  researchWaiting,
  skipped,
  strong,
  strongTotal,
  others,
  paging,
}: {
  counts: StateCounts;
  totalRecorded: number;
  eligible: number;
  // Confirmed people waiting to be researched (null when research is not available yet).
  // Shown as its own button below; confirming a list never starts it.
  researchWaiting?: number | null;
  skipped: { code: string; label: string; count: number }[];
  // People with exactly one strong match: shown with the match that would be used.
  strong: ReviewPerson[];
  // How many strong matches there are in all (the screen lists a limited number at a time).
  strongTotal: number;
  // People with candidates but no strong match: one page of them, for a choice.
  others: ReviewPerson[];
  paging: { page: number; totalPages: number; first: number; last: number; total: number };
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [choosing, setChoosing] = useState<Set<string>>(new Set());
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const flip = (set: Set<string>, setter: (s: Set<string>) => void, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    setter(next);
  };

  // Who "Confirm your network" would confirm right now: every strong match the
  // person has not unticked or opened for a different choice.
  const pairs = strongMatchPairs(strong, new Set([...excluded, ...choosing]));

  // A human click, and nothing else, posts the pairs.
  const confirmNetwork = () => {
    setBatchResult(null);
    setBatchError(null);
    startTransition(async () => {
      const result = await confirmPreselectedIdentities(pairs);
      if ("error" in result) setBatchError(result.error);
      else setBatchResult(result.message);
    });
  };

  const worthSaying = skipped.filter((s) => (WORTH_SAYING as string[]).includes(s.code));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.xl, marginTop: spacing.lg }}>
      <section style={sectionStyle} aria-label="Status">
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 13, color: colors.textMuted }}>{totalRecorded} recorded:</span>
          {statusLineParts(counts).map((part) => (
            <span key={part.key} style={chipStyle(TONE[part.key])}>
              {part.text}
            </span>
          ))}
        </div>
        {/* Always mounted, so a finished click can say what happened even when it was the last person: with nobody waiting it shows nothing. */}
        <LookupRunner eligible={eligible} label="Look up more people" primary={false} whenNoneWaiting="nothing" />
        {worthSaying.length > 0 && (
          <p style={{ margin: 0, fontSize: 12.5, color: colors.textMuted }}>
            Cannot be looked up yet: {worthSaying.map((s) => `${s.count} ${LOOK_REFUSAL_LABEL[s.code as LookRefusalCode] ?? s.label}`).join("; ")}.
          </p>
        )}
      </section>

      {typeof researchWaiting === "number" && (
        // After people are confirmed (here, or one at a time) this is the one button
        // that researches them. It is never started by a confirmation: the click is
        // the consent, and the cost is stated beside it.
        <ResearchRunner waiting={researchWaiting} />
      )}

      {strong.length > 0 && (
        <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.md }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.md, flexWrap: "wrap" }}>
            <div>
              <h2 style={{ fontSize: 17, margin: 0 }}>Strong matches ({strongTotal > strong.length ? `${strong.length} of ${strongTotal}` : strong.length})</h2>
              <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13, color: colors.textMuted, maxWidth: 640 }}>
                For {strong.length === 1 ? "this person" : "these people"}, exactly one candidate&apos;s page text contained their name, their employer or title, and their city or
                state. That is only a suggestion: nobody is confirmed until you click the button. Untick anyone you want to check first, or choose a different match.
                {strongTotal > strong.length ? ` This screen shows the first ${strong.length}; the rest appear once these are confirmed.` : ""}
              </p>
            </div>
            <button type="button" style={buttonPrimary} disabled={isPending || pairs.length === 0} onClick={confirmNetwork}>
              {isPending ? "Confirming…" : `Confirm your network (${pairs.length})`}
            </button>
          </div>
          {batchResult && <p style={{ margin: 0, fontSize: 13 }}>{batchResult}</p>}
          {batchError && <p style={{ margin: 0, fontSize: 13, color: colors.danger }}>{batchError}</p>}
          {strong.map((p) => (
            <StrongRow
              key={p.id}
              p={p}
              included={!excluded.has(p.id) && !choosing.has(p.id)}
              choosing={choosing.has(p.id)}
              onInclude={(v) => flip(excluded, setExcluded, p.id, !v)}
              onChoose={(v) => flip(choosing, setChoosing, p.id, v)}
              disabled={isPending}
            />
          ))}
        </section>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.md }}>
        <h2 style={{ fontSize: 17, margin: 0 }}>{strong.length > 0 ? `Needs your choice (${paging.total})` : `Matches to review (${paging.total})`}</h2>
        {others.length === 0 ? (
          <div style={sectionStyle}>
            <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
              {paging.total === 0
                ? strong.length > 0
                  ? "Everyone else with matches is in the strong matches above."
                  : eligible > 0
                    ? "Nobody has matches waiting yet. Use the button above to look people up."
                    : "Nobody has matches waiting."
                : "No one on this page."}
            </p>
          </div>
        ) : (
          others.map((p) => <PersonCard key={p.id} p={p} />)
        )}
        {paging.totalPages > 1 && (
          <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, fontSize: 13 }} aria-label="Pages">
            {paging.page > 1 ? (
              <Link href={paging.page - 1 > 1 ? `/network/identity?page=${paging.page - 1}` : "/network/identity"} style={{ ...buttonSecondary, textDecoration: "none" }}>
                Previous
              </Link>
            ) : (
              <span />
            )}
            <span style={{ color: colors.textMuted }}>
              {paging.first}–{paging.last} of {paging.total} · page {paging.page} of {paging.totalPages}
            </span>
            {paging.page < paging.totalPages ? (
              <Link href={`/network/identity?page=${paging.page + 1}`} style={{ ...buttonSecondary, textDecoration: "none" }}>
                Next
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>
    </div>
  );
}
