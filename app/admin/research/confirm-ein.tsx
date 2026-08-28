"use client";

import { useState, useTransition } from "react";
import { confirmProspectEin } from "@/app/(dashboard)/prospects/actions";
import { colors, spacing, buttonSecondary, chipStyle } from "@/lib/ui";

const METHOD_LABEL: Record<string, string> = {
  stored_ein: "from the prospect's saved EIN",
  authoritative_filing: "from an authoritative filing",
  official_domain: "from the funder's own domain",
  ambiguous_filings: "competing filings -- deliberately not chosen",
  unresolved: "could not be established",
};

// The human review gate for AI-derived identity. runResearch proposes an EIN
// on the run but never writes it to the prospect: that would be AI output
// landing straight in the CRM in a non-review state, which hard rule 3
// forbids. Saving it here is a person's decision, and once saved every later
// run of this prospect resolves deterministically from it.
export default function ConfirmEin({
  prospectId,
  proposedEin,
  method,
  savedEin,
}: {
  prospectId: string;
  proposedEin: string | null;
  method: string | null;
  savedEin: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!method) return null;

  const alreadySaved = savedEin !== null && savedEin === proposedEin;

  return (
    <div style={{ marginTop: spacing.xs, fontSize: 13, color: colors.textMuted, display: "flex", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" }}>
      <span>
        Entity:{" "}
        {proposedEin ? (
          <strong style={{ color: colors.text }}>{proposedEin}</strong>
        ) : (
          <span style={{ color: colors.text }}>not established</span>
        )}{" "}
        <span style={{ color: colors.textMuted }}>({METHOD_LABEL[method] ?? method})</span>
      </span>

      {alreadySaved && <span style={chipStyle("teal")}>saved on prospect</span>}

      {proposedEin && !alreadySaved && (
        <button
          type="button"
          disabled={pending}
          style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              try {
                await confirmProspectEin(prospectId, proposedEin);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not save the EIN.");
              }
            })
          }
        >
          {pending ? "Saving..." : savedEin ? `Replace saved EIN (${savedEin})` : "Save EIN to prospect"}
        </button>
      )}

      {error && <span style={{ color: colors.danger }}>{error}</span>}
    </div>
  );
}
