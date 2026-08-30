"use client";

import { useState, useTransition } from "react";
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
}: {
  prospectId: string;
  confirmedEin: string | null;
  resolutionMethod: string | null;
  candidates: { ein: string; label: string; sourceCount: number; status: string | null }[];
  blocked: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={sectionStyle}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Identity</h3>
      <div style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
        {confirmedEin ? (
          <>
            EIN <strong style={{ color: colors.text }}>{confirmedEin}</strong>
            <span> — {METHOD_LABEL[resolutionMethod ?? ""] ?? resolutionMethod}</span>
          </>
        ) : (
          <>Not established{resolutionMethod ? ` — ${METHOD_LABEL[resolutionMethod] ?? resolutionMethod}` : ""}.</>
        )}
      </div>

      {blocked && candidates.length > 1 && (
        <>
          <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.sm, marginBottom: spacing.xs }}>
            Research found {candidates.length} organizations matching this name. Which one is this prospect?
          </p>
          <div style={{ display: "grid", gap: spacing.xs }}>
            {candidates.map((c) => (
              <div key={c.ein} style={{ display: "flex", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "monospace", fontSize: 12, minWidth: 92 }}>{c.ein}</span>
                <span style={{ fontSize: 13, flex: 1, minWidth: 170 }}>{c.label}</span>
                <span style={{ fontSize: 11, color: colors.textFaint }}>
                  {c.sourceCount} source{c.sourceCount === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12, opacity: pending ? 0.5 : 1 }}
                  onClick={() =>
                    startTransition(async () => {
                      setError(null);
                      try {
                        await confirmProspectEin(prospectId, c.ein);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Could not save that choice.");
                      }
                    })
                  }
                >
                  This one
                </button>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
            Choosing stores the EIN on this prospect. Research will then resolve to it directly, and the next run
            will be about the right organization.
          </p>
        </>
      )}

      {blocked && candidates.length <= 1 && (
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
