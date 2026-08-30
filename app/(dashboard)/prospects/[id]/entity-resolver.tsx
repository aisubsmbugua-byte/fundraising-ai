"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmProspectEin } from "../actions";
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
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Per-candidate, not one shared flag: a single `pending` put all fifteen
  // rows into the same state at once, so the click gave no indication which
  // organization it had applied to.
  const [savingEin, setSavingEin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
            Saved to this prospect. The research below was gathered before this was settled, so it may still describe
            a different organization — run research again and it will resolve to this EIN directly.
          </p>
        </div>
      )}

      {blocked && !savedEin && candidates.length > 1 && (
        <>
          <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.sm, marginBottom: spacing.xs }}>
            Research found {candidates.length} organizations matching this name. Which one is this prospect?
          </p>
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
                          await confirmProspectEin(prospectId, c.ein);
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
                    {saving ? "Saving…" : "This one"}
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
        <span style={{ ...chipStyle("teal"), display: "inline-block", marginTop: spacing.xs }}>confirmed entity</span>
      )}

      {error && <div style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{error}</div>}
    </div>
  );
}
