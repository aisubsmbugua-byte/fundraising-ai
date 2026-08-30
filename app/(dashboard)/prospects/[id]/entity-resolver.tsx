"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearProspectEin, confirmProspectEin } from "../actions";
import { buttonSecondary, chipStyle, colors, sectionStyle, spacing } from "@/lib/ui";

const METHOD_LABEL: Record<string, string> = {
  stored_ein: "confirmed on this prospect",
  authoritative_filing: "from an IRS filing",
  official_domain: "from the funder's own domain",
  ambiguous_filings: "several organizations share this name",
  unresolved: "could not be established",
};

// Identity, and the choice a person makes when research could not settle it.
//
// The candidates are the organizations this run actually encountered, so the
// question put to the user is concrete -- "which of these four is your
// funder" -- rather than asking them to supply an EIN from memory. Confirming
// one stores it, and every later run resolves to it directly.
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
  candidates: { ein: string; label: string; sourceCount: number; status: string | null }[];
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
  // Per-candidate, not one shared flag: a single `pending` put all fifteen
  // rows into the same state at once, so the click gave no indication which
  // organization it had applied to.
  const [savingEin, setSavingEin] = useState<string | null>(null);
  const [merged, setMerged] = useState(false);
  const [clearing, setClearing] = useState(false);
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
          <button
            type="button"
            disabled={clearing}
            style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }}
            onClick={clearSavedEin}
          >
            {clearing ? "Clearing…" : "Choose a different organization"}
          </button>
        </div>
      )}

      {blocked && !savedEin && candidates.length > 1 && (
        <>
          <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.sm, marginBottom: spacing.xs }}>
            Research found {candidates.length} organizations matching this name.{" "}
            {merged ? "Which one is the organization that exists today?" : "Which one is this prospect?"}
          </p>

          {/* The question the resolver cannot ask. A merged predecessor and an
              unrelated namesake look identical in search results, so "these
              are one organization at different times" is knowledge a person
              has and the system does not. Without this the list forces a
              single choice and the older entity looks like the right answer,
              which is how a defunct EIN gets confirmed. */}
          <label style={{ display: "flex", alignItems: "flex-start", gap: spacing.xs, fontSize: 12.5, color: colors.textMuted, marginBottom: spacing.sm, cursor: "pointer" }}>
            <input type="checkbox" checked={merged} onChange={(e) => setMerged(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              These are the same organization at different times — it merged or changed its name. Choosing will record
              the others as what it used to be, instead of discarding them.
            </span>
          </label>
          <div style={{ display: "grid", gap: spacing.xs }}>
            {candidates.map((c) => {
              const saving = savingEin === c.ein;
              const otherSaving = savingEin !== null && !saving;
              return (
                <div key={c.ein} style={{ display: "flex", alignItems: "center", gap: spacing.xs, flexWrap: "wrap", opacity: otherSaving ? 0.45 : 1 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, minWidth: 92 }}>{c.ein}</span>
                  <span style={{ fontSize: 13, flex: 1, minWidth: 170 }}>{c.label}</span>
                  <span style={{ fontSize: 11, color: colors.textFaint }}>
                    {c.sourceCount} source{c.sourceCount === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    disabled={savingEin !== null}
                    style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12, minWidth: 74 }}
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
                          // Deliberate: revalidatePath marks the cache stale
                          // but this component's own props come from a server
                          // render, so without an explicit refresh the page
                          // keeps showing the picker as though nothing was
                          // saved.
                          router.refresh();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Could not save that choice.");
                          setSavingEin(null);
                        }
                      });
                    }}
                  >
                    {saving ? "Saving…" : merged ? "The current one" : "This one"}
                  </button>
                </div>
              );
            })}
          </div>
          <p style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
            Choosing stores the EIN on this prospect. Research will then resolve to it directly, and the next run
            will be about the right organization.
          </p>
        </>
      )}

      {blocked && !savedEin && candidates.length <= 1 && (
        <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
          Research could not establish which organization this is. Adding the EIN on the prospect record will settle
          it for every future run.
        </p>
      )}

      {/* Requires an actual EIN, not merely the absence of a block. Without
          that second condition this rendered "confirmed entity" underneath
          "could not be established" on any run that never reached the
          blocking check. */}
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
              <button
                type="button"
                disabled={clearing}
                style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }}
                onClick={clearSavedEin}
              >
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
