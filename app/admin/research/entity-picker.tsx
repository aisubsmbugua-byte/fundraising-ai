"use client";

import { useState, useTransition } from "react";
import { confirmProspectEin } from "@/app/(dashboard)/prospects/actions";
import { buttonSecondary, chipStyle, colors, spacing } from "@/lib/ui";

export type EntityCandidate = {
  ein: string;
  // A representative source title for this EIN -- usually the organization's
  // own name as an aggregator states it, which is what a human needs to tell
  // two similarly-named entities apart.
  label: string;
  sourceCount: number;
  status: string | null;
};

// Presents the competing organizations a run actually saw, so a human can
// settle identity once instead of the system guessing.
//
// The candidates are not stored anywhere new: a run already records
// research_sources.source_ein alongside each source's title and entity
// verdict, so the distinct EINs it encountered ARE the candidate list. That
// is why this needed no schema -- the ambiguity was always in the data, just
// never surfaced.
export default function EntityPicker({
  prospectId,
  candidates,
  savedEin,
}: {
  prospectId: string;
  candidates: EntityCandidate[];
  savedEin: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (candidates.length < 2) return null;

  return (
    <div style={{ marginTop: spacing.xs, padding: spacing.sm, border: `1px solid ${colors.border}`, borderRadius: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
        {candidates.length} organizations matched this name — which one is the prospect?
      </div>
      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
        Confirming one stores it on the prospect, so every later run resolves to it directly instead of re-deriving
        identity.
      </div>
      <div style={{ display: "grid", gap: spacing.xs, marginTop: spacing.sm }}>
        {candidates.map((c) => (
          <div key={c.ein} style={{ display: "flex", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, minWidth: 92 }}>{c.ein}</span>
            <span style={{ fontSize: 13, flex: 1, minWidth: 180 }}>{c.label}</span>
            <span style={{ fontSize: 11, color: colors.textFaint }}>
              {c.sourceCount} source{c.sourceCount === 1 ? "" : "s"}
            </span>
            {c.status && <span style={chipStyle("neutral")}>{c.status.replace(/_/g, " ")}</span>}
            {savedEin === c.ein ? (
              <span style={chipStyle("teal")}>confirmed</span>
            ) : (
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
                      setError(err instanceof Error ? err.message : "Could not save the EIN.");
                    }
                  })
                }
              >
                This one
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <div style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{error}</div>}
    </div>
  );
}
