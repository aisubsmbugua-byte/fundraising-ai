"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearProspectEin, confirmProspectEin, saveIdentityClue } from "../actions";
import { buttonPrimary, buttonSecondary, chipStyle, colors, fieldStyle, labelStyle, sectionStyle, spacing } from "@/lib/ui";
import type { EntityCandidate } from "@/lib/research";

const METHOD_LABEL: Record<string, string> = {
  stored_ein: "confirmed on this prospect",
  authoritative_filing: "from an IRS filing",
  official_domain: "from the funder's own domain",
  ambiguous_filings: "several organizations share this name",
  unresolved: "could not be established",
};

// Identity, and the choice a person makes when research could not settle it.
//
// The previous version listed every EIN the run touched -- twenty rows on a
// generic name, most labelled with a bare aggregator URL, each claiming one
// source. That asks someone to identify an organization by EIN, which is the
// knowledge they came here lacking. It is the system that holds EINs; what a
// fundraiser holds is a website, a city, a denomination, or where they came
// across the funder.
//
// So the list is now a last resort rather than the default: at most three
// candidates, each carrying enough to be recognised, and only when the run
// could describe them that well. Otherwise the question changes to one the
// user can actually answer.
export default function EntityResolver({
  prospectId,
  confirmedEin,
  resolutionMethod,
  candidates,
  blocked,
  savedEin,
  predecessorEins,
}: {
  prospectId: string;
  confirmedEin: string | null;
  resolutionMethod: string | null;
  // Already filtered to what can be recognised -- see presentableCandidates.
  candidates: EntityCandidate[];
  blocked: boolean;
  // The EIN stored on the PROSPECT, which is what confirming writes. Everything
  // else here comes from the completed run, and a run is immutable -- so
  // without this the choice saved correctly and the screen did not change by
  // so much as a word, which is indistinguishable from a broken button.
  savedEin: string | null;
  // What it used to be, after a merger or rename the user recorded.
  predecessorEins: string[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Per-candidate, not one shared flag: a single `pending` put every row into
  // the same state at once, so the click gave no indication which
  // organization it had applied to.
  const [savingEin, setSavingEin] = useState<string | null>(null);
  const [merged, setMerged] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clue, setClue] = useState("");
  const [savingClue, setSavingClue] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared by both entry points -- while a run is blocked, and after a stored
  // EIN has resolved one. Same operation either way.
  function clearSavedEin() {
    setError(null);
    setClearing(true);
    startTransition(async () => {
      try {
        await clearProspectEin(prospectId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not clear the saved EIN.");
        setClearing(false);
      }
    });
  }

  return (
    <div style={sectionStyle}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Identity</h3>
      <div style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
        {/* Scoped to the run when a person has since decided otherwise.
            "Not established" and "Identity confirmed" one line apart are only
            contradictory if you cannot tell which is talking about the run
            and which about the prospect. */}
        {confirmedEin ? (
          <>
            EIN <strong style={{ color: colors.text }}>{confirmedEin}</strong>
            <span> — {METHOD_LABEL[resolutionMethod ?? ""] ?? resolutionMethod}</span>
          </>
        ) : savedEin ? (
          <>This run could not establish the organization{resolutionMethod ? ` — ${METHOD_LABEL[resolutionMethod] ?? resolutionMethod}` : ""}.</>
        ) : (
          <>Not established{resolutionMethod ? ` — ${METHOD_LABEL[resolutionMethod] ?? resolutionMethod}` : ""}.</>
        )}
      </div>

      {/* Settled since this run finished. The run itself cannot be updated --
          its findings were gathered before anyone knew which organization
          this was -- so the honest next step is a re-run, not a quiet
          unblocking of research that may describe someone else. */}
      {blocked && savedEin && (
        <div style={{ marginTop: spacing.sm }}>
          <span style={chipStyle("teal")}>Identity confirmed · {savedEin}</span>
          {predecessorEins.length > 0 && (
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.xs }}>
              Previously {predecessorEins.join(", ")}.
            </div>
          )}
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.xs }}>
            Saved to this prospect. The research below was gathered before this was settled, so it may still describe
            a different organization — run research again and it will resolve to this EIN directly.
          </p>
          {/* A confirmation a person cannot revise is a trap. This prospect
              was pinned to a pre-merger entity by one click, with the picker
              hidden from then on because something was saved. */}
          <button type="button" disabled={clearing} style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }} onClick={clearSavedEin}>
            {clearing ? "Clearing…" : "Choose a different organization"}
          </button>
        </div>
      )}

      {blocked && !savedEin && candidates.length > 0 && (
        <>
          <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.sm, marginBottom: spacing.xs }}>
            {candidates.length === 1 ? "One organization" : `${candidates.length} organizations`} could be this
            prospect. {merged ? "Which exists today?" : "Which is it?"}
          </p>

          {/* A merged predecessor and an unrelated namesake look identical in
              search results, so "these are one organization at different
              times" is knowledge a person has and the system does not. */}
          <label style={{ display: "flex", alignItems: "flex-start", gap: spacing.xs, fontSize: 12.5, color: colors.textMuted, marginBottom: spacing.sm, cursor: "pointer" }}>
            <input type="checkbox" checked={merged} onChange={(e) => setMerged(e.target.checked)} style={{ marginTop: 2 }} />
            <span>These are the same organization at different times — it merged or changed its name.</span>
          </label>

          <div style={{ display: "grid", gap: spacing.sm }}>
            {candidates.map((c) => {
              const saving = savingEin === c.ein;
              const otherSaving = savingEin !== null && !saving;
              return (
                <div
                  key={c.ein}
                  style={{
                    border: `1px solid ${colors.border}`,
                    borderRadius: 6,
                    padding: spacing.sm,
                    opacity: otherSaving ? 0.45 : 1,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: spacing.sm,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 200, flex: 1 }}>
                    <div style={{ fontSize: 13.5, color: colors.text }}>{c.name ?? c.ein}</div>
                    <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                      {[c.location, c.orgType, c.website].filter(Boolean).join(" · ")}
                    </div>
                    <div style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 2, fontFamily: "monospace" }}>EIN {c.ein}</div>
                    {c.whyMatch.length > 0 && (
                      <div style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 2 }}>{c.whyMatch.join(" · ")}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={savingEin !== null}
                    style={{ ...buttonSecondary, padding: "4px 10px", fontSize: 12, alignSelf: "center", minWidth: 84 }}
                    onClick={() => {
                      setError(null);
                      setSavingEin(c.ein);
                      startTransition(async () => {
                        try {
                          await confirmProspectEin(
                            prospectId,
                            c.ein,
                            merged ? candidates.filter((o) => o.ein !== c.ein).map((o) => o.ein) : []
                          );
                          // revalidatePath marks the cache stale but does not
                          // re-render a client component's server-supplied
                          // props, so without this the picker stays put.
                          router.refresh();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Could not save that choice.");
                          setSavingEin(null);
                        }
                      });
                    }}
                  >
                    {saving ? "Saving…" : merged ? "Current one" : "This one"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Nothing recognisable to offer. Asking for a detail the user has beats
          listing twenty EINs they cannot tell apart -- and beats a bare "we
          could not identify it", which hands the problem back with no route
          through. */}
      {blocked && !savedEin && candidates.length === 0 && (
        <div style={{ marginTop: spacing.sm }}>
          <p style={{ fontSize: 13, color: colors.text, marginBottom: spacing.xs }}>
            Several organizations share this name and we could not tell them apart. Add one detail to help us identify
            the right one.
          </p>
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 0, marginBottom: spacing.xs }}>
            Their website is best. A city or state, denomination or parent body, a grant program name, or where you
            came across them all help too.
          </p>
          <div style={{ display: "flex", gap: spacing.xs, flexWrap: "wrap", alignItems: "flex-start" }}>
            <input
              value={clue}
              onChange={(e) => setClue(e.target.value)}
              placeholder="e.g. maclellan.net, or Chattanooga TN, or PCUSA"
              style={{ ...fieldStyle, flex: 1, minWidth: 220, maxWidth: 420 }}
            />
            <button
              type="button"
              disabled={savingClue || clue.trim().length === 0}
              style={{ ...buttonPrimary, opacity: savingClue || !clue.trim() ? 0.6 : 1 }}
              onClick={() => {
                setError(null);
                setSavingClue(true);
                startTransition(async () => {
                  const result = await saveIdentityClue(prospectId, clue.trim());
                  if ("error" in result) {
                    setError(result.error);
                    setSavingClue(false);
                    return;
                  }
                  setClue("");
                  setSavingClue(false);
                  router.refresh();
                });
              }}
            >
              {savingClue ? "Saving…" : "Save detail"}
            </button>
          </div>
          <p style={{ ...labelStyle, marginTop: spacing.xs, marginBottom: 0, fontSize: 11.5, color: colors.textFaint }}>
            Saved to the prospect, then used the next time research runs. If you don&apos;t know any of these, leave it —
            the research stays marked unresolved rather than guessing.
          </p>
        </div>
      )}

      {/* Requires an actual EIN, not merely the absence of a block. Without
          that second condition this rendered "confirmed entity" underneath
          "could not be established". */}
      {!blocked && confirmedEin && (
        <div style={{ marginTop: spacing.xs }}>
          <span style={{ ...chipStyle("teal"), display: "inline-block" }}>confirmed entity</span>
          {predecessorEins.length > 0 && (
            <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: spacing.xs }}>
              previously {predecessorEins.join(", ")}
            </span>
          )}
          {/* Reachable once a stored EIN has resolved the run, not only while
              a run is blocked. A confirmed identity is exactly when a mistake
              becomes invisible: research resolves cleanly, the dossier looks
              authoritative, and every fragment about the RIGHT organization
              is discarded as an entity mismatch. */}
          {savedEin && (
            <div style={{ marginTop: spacing.xs }}>
              <button type="button" disabled={clearing} style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }} onClick={clearSavedEin}>
                {clearing ? "Clearing…" : "This is the wrong organization"}
              </button>
              <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: spacing.xs }}>
                Clears {savedEin} so you can choose again.
              </span>
            </div>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{error}</div>}
    </div>
  );
}
