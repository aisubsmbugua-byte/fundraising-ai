"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  confirmIdentity,
  confirmPreselectedIdentities,
  findIdentityCandidates,
  findIdentityCandidatesForUnidentified,
  markNoneOfThese,
  setDoNotResearch,
} from "../identity-actions";
import { type EvidenceItem, type IdentityState } from "@/lib/network-identity";
import { spacing, colors, buttonPrimary, buttonSecondary, sectionStyle, cardStyle, chipStyle } from "@/lib/ui";

export type ReviewCandidate = {
  id: string;
  label: string;
  headline: string | null;
  locationText: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  evidence: EvidenceItem[];
  evidenceLine: string;
  // Whether the captured text supports the words the AI wrote (null = nothing to test).
  labelSupported: boolean;
  headlineSupported: boolean | null;
  // True when the stored comparison was out of date (the person was edited after
  // the look) and was worked out again from the stored page text.
  recomputed: boolean;
};

export type ReviewPerson = {
  id: string;
  name: string;
  affiliation: string | null;
  title: string | null;
  city: string | null;
  state: string | null;
  preselectedId: string | null;
  candidates: ReviewCandidate[];
};

export type StateCounts = Record<IdentityState, number>;

const MARK_COLOR = { found: colors.success, not_found: colors.warning, not_recorded: colors.textFaint } as const;

function Evidence({ items, line }: { items: EvidenceItem[]; line: string }) {
  return (
    <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 12.5, lineHeight: 1.6 }} aria-label={line}>
      {items.map((e, i) => (
        <span key={e.key} style={{ whiteSpace: "nowrap" }}>
          {i > 0 && <span style={{ color: colors.textFaint }}> · </span>}
          <span style={{ color: colors.textMuted }}>{e.label} </span>
          <span style={{ color: MARK_COLOR[e.value], fontWeight: 600 }}>{e.mark} </span>
          <span style={{ color: MARK_COLOR[e.value] }}>{e.text}</span>
        </span>
      ))}
    </p>
  );
}

function RecordedFacts({ p }: { p: ReviewPerson }) {
  const where = [p.city, p.state].filter(Boolean).join(", ");
  return (
    <div style={{ fontSize: 13, color: colors.textMuted }}>
      {[p.affiliation, p.title, where].filter(Boolean).join(" · ") || "(no employer, title or place recorded)"}
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
      <div style={{ fontSize: 12.5, marginTop: 2, wordBreak: "break-word" }}>
        <span style={{ color: colors.textMuted }}>Found on: </span>
        <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: colors.text }}>
          {c.sourceTitle || c.sourceUrl}
        </a>
      </div>
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

function PersonCard({ p }: { p: ReviewPerson }) {
  const [choice, setChoice] = useState<string>(p.preselectedId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    if (!choice) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = choice === NONE ? await markNoneOfThese(p.id) : await confirmIdentity(p.id, choice);
      if ("error" in result) setError(result.error);
    });
  };

  return (
    <div style={cardStyle} id={`person-${p.id}`}>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
      <RecordedFacts p={p} />
      <fieldset style={{ border: "none", padding: 0, margin: `${spacing.md}px 0 0`, display: "grid", gap: spacing.sm }}>
        <legend style={{ fontSize: 12.5, color: colors.textMuted, padding: 0, marginBottom: spacing.xs }}>Which of these is {p.name}?</legend>
        {p.candidates.map((c) => (
          <label
            key={c.id}
            style={{
              display: "flex",
              gap: spacing.sm,
              alignItems: "flex-start",
              padding: spacing.sm,
              border: `1px solid ${choice === c.id ? colors.primary : colors.border}`,
              borderRadius: 6,
              cursor: "pointer",
              boxSizing: "border-box",
            }}
          >
            <input type="radio" name={`choice-${p.id}`} value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} style={{ marginTop: 3 }} />
            <CandidateBody c={c} suggested={p.preselectedId === c.id} />
          </label>
        ))}
        <label
          style={{
            display: "flex",
            gap: spacing.sm,
            alignItems: "center",
            padding: spacing.sm,
            border: `1px solid ${choice === NONE ? colors.primary : colors.border}`,
            borderRadius: 6,
            cursor: "pointer",
            boxSizing: "border-box",
          }}
        >
          <input type="radio" name={`choice-${p.id}`} value={NONE} checked={choice === NONE} onChange={() => setChoice(NONE)} />
          <span style={{ fontSize: 14 }}>None of these</span>
          <span style={{ fontSize: 12.5, color: colors.textMuted }}>— recorded, and this person is not looked up again unless you reset them</span>
        </label>
      </fieldset>
      <p style={{ margin: `${spacing.sm}px 0 0`, fontSize: 12, color: colors.textMuted }}>
        &ldquo;Not found in source&rdquo; means the text that was captured from the page did not contain it. The captured text is often only a short snippet, so
        that is not proof the page disagrees; open the source to be sure.
      </p>
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{error}</p>}
      {notice && <p style={{ fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{notice}</p>}
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md, flexWrap: "wrap" }}>
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
      </div>
    </div>
  );
}

export default function IdentityWorkspace({
  counts,
  totalRecorded,
  eligible,
  skipped,
  cap,
  stateLabels,
  preselected,
  people,
  paging,
}: {
  counts: StateCounts;
  totalRecorded: number;
  eligible: number;
  skipped: { code: string; label: string; count: number }[];
  cap: number;
  stateLabels: Record<IdentityState, string>;
  preselected: ReviewPerson[];
  people: ReviewPerson[];
  paging: { page: number; totalPages: number; first: number; last: number; total: number };
}) {
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const runBulk = () => {
    setBulkResult(null);
    setBulkError(null);
    startTransition(async () => {
      const result = await findIdentityCandidatesForUnidentified();
      if ("error" in result) setBulkError(result.error);
      else setBulkResult(result.message);
    });
  };

  const runBatch = () => {
    setBatchResult(null);
    setBatchError(null);
    const pairs = preselected.map((p) => ({ personId: p.id, candidateId: p.preselectedId as string }));
    startTransition(async () => {
      const result = await confirmPreselectedIdentities(pairs);
      if ("error" in result) setBatchError(result.error);
      else {
        setBatchResult(result.message);
        setBatchOpen(false);
      }
    });
  };

  const order: IdentityState[] = ["not_looked_at", "no_candidates_found", "candidates", "confirmed", "none_of_these", "do_not_research"];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.xl, marginTop: spacing.lg }}>
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 17, margin: 0 }}>Where everyone stands ({totalRecorded} recorded)</h2>
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
          {order.map((st) => (
            <span key={st} style={chipStyle(st === "candidates" ? "amber" : st === "confirmed" ? "teal" : st === "do_not_research" ? "red" : "neutral")}>
              {stateLabels[st]}: {counts[st]}
            </span>
          ))}
        </div>

        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.md, display: "grid", gap: spacing.sm }}>
          <div style={{ display: "flex", gap: spacing.md, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" style={buttonPrimary} disabled={isPending || eligible === 0} onClick={runBulk}>
              {isPending ? "Looking…" : `Find matches for everyone not yet identified (${eligible})`}
            </button>
            <span style={{ fontSize: 12.5, color: colors.textMuted, maxWidth: 560 }}>
              Looks at up to {cap} people per click, one at a time, each as its own AI run, and tells you how many it looked at of how many were eligible. Click
              again to continue.
            </span>
          </div>
          {skipped.length > 0 && (
            <p style={{ margin: 0, fontSize: 12.5, color: colors.textMuted }}>
              Not eligible, and why: {skipped.map((s) => `${s.count} ${s.label}`).join("; ")}.
            </p>
          )}
          {bulkResult && <p style={{ margin: 0, fontSize: 13 }}>{bulkResult}</p>}
          {bulkError && <p style={{ margin: 0, fontSize: 13, color: colors.danger }}>{bulkError}</p>}
        </div>
      </section>

      {preselected.length > 0 && (
        <section style={sectionStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.md, flexWrap: "wrap" }}>
            <div>
              <h2 style={{ fontSize: 17, margin: 0 }}>Confirm all preselected ({preselected.length})</h2>
              <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13, color: colors.textMuted, maxWidth: 640 }}>
                For {preselected.length === 1 ? "this person" : "these people"} exactly one candidate&apos;s page text contained their name, their employer or title, and their city or
                state. That is only a suggestion. Open the list, check each one, then confirm.
              </p>
            </div>
            <button type="button" style={buttonSecondary} onClick={() => setBatchOpen((v) => !v)} disabled={isPending}>
              {batchOpen ? "Hide the list" : `Show the ${preselected.length} to check`}
            </button>
          </div>
          {batchOpen && (
            <div style={{ display: "grid", gap: spacing.sm }}>
              <p style={{ margin: 0, fontSize: 13 }}>
                Every person below will be confirmed as the candidate shown. Nobody is confirmed until you click the button at the bottom of this list.
              </p>
              {preselected.map((p) => {
                const c = p.candidates.find((x) => x.id === p.preselectedId);
                if (!c) return null;
                return (
                  <div key={p.id} style={{ ...cardStyle, display: "grid", gap: 2 }}>
                    <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "baseline" }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                      <RecordedFacts p={p} />
                    </div>
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: colors.textMuted }}>will be confirmed as: </span>
                      <strong>{c.label}</strong>
                      {c.headline ? ` — ${c.headline}` : ""}
                      {c.locationText ? ` — ${c.locationText}` : ""}
                    </div>
                    <div style={{ fontSize: 12.5, wordBreak: "break-word" }}>
                      <span style={{ color: colors.textMuted }}>Found on: </span>
                      <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: colors.text }}>
                        {c.sourceTitle || c.sourceUrl}
                      </a>
                    </div>
                    <Evidence items={c.evidence} line={c.evidenceLine} />
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: spacing.sm }}>
                <button type="button" style={buttonPrimary} disabled={isPending} onClick={runBatch}>
                  {isPending ? "Confirming…" : `Confirm these ${preselected.length} ${preselected.length === 1 ? "person" : "people"}`}
                </button>
                <button type="button" style={buttonSecondary} disabled={isPending} onClick={() => setBatchOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {batchResult && <p style={{ margin: 0, fontSize: 13 }}>{batchResult}</p>}
          {batchError && <p style={{ margin: 0, fontSize: 13, color: colors.danger }}>{batchError}</p>}
        </section>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.md }}>
        <h2 style={{ fontSize: 17, margin: 0 }}>Candidates to review ({paging.total})</h2>
        {people.length === 0 ? (
          <div style={sectionStyle}>
            <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
              {paging.total === 0
                ? "Nobody has candidates waiting. Find matches above, or on a person on the Network page."
                : "No one on this page."}
            </p>
          </div>
        ) : (
          people.map((p) => <PersonCard key={p.id} p={p} />)
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
