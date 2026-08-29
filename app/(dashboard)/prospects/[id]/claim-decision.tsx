"use client";

import { useState, useTransition } from "react";
import { approveVerifiedIntelligence, decideClaim } from "./research-actions";
import { buttonPrimary, buttonSecondary, colors, fieldStyle, spacing } from "@/lib/ui";

// Bulk approval, scoped to verified claims only. The count is stated plainly
// so nobody believes this covers the whole dossier.
export function ApproveVerified({ runId, verifiedCount, exceptionCount }: { runId: string; verifiedCount: number; exceptionCount: number }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  if (verifiedCount === 0) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
      <button
        type="button"
        disabled={pending}
        style={{ ...buttonPrimary, opacity: pending ? 0.6 : 1 }}
        onClick={() =>
          startTransition(async () => {
            const result = await approveVerifiedIntelligence(runId);
            setMessage("error" in result ? result.error : `Approved ${result.approved} verified claim${result.approved === 1 ? "" : "s"}.`);
          })
        }
      >
        {pending ? "Approving..." : `Approve ${verifiedCount} verified claim${verifiedCount === 1 ? "" : "s"}`}
      </button>
      {exceptionCount > 0 && (
        <span style={{ fontSize: 12.5, color: colors.textMuted }}>
          {exceptionCount} claim{exceptionCount === 1 ? "" : "s"} need{exceptionCount === 1 ? "s" : ""} a decision below — these are not
          included.
        </span>
      )}
      {message && <span style={{ fontSize: 12.5, color: colors.textMuted }}>{message}</span>}
    </div>
  );
}

// One claim a person is actually looking at. Approving something the evidence
// does not support requires a note, because the override outlives the reviewer.
export function ClaimDecision({ runId, claimId, decided }: { runId: string; claimId: string; decided: { decision: string; note: string | null } | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [corrected, setCorrected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (decided) {
    return (
      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 3 }}>
        {decided.decision.replace(/_/g, " ")}
        {decided.note ? ` — “${decided.note}”` : ""}
      </div>
    );
  }

  const act = (decision: "approved_with_note" | "corrected" | "excluded" | "research_requested") =>
    startTransition(async () => {
      setError(null);
      const result = await decideClaim(runId, claimId, decision, note, corrected);
      if ("error" in result) setError(result.error);
      else setOpen(false);
    });

  if (!open) {
    return (
      <button type="button" style={{ ...buttonSecondary, padding: "1px 7px", fontSize: 11.5, marginTop: 3 }} onClick={() => setOpen(true)}>
        Review
      </button>
    );
  }

  return (
    <div style={{ marginTop: spacing.xs, display: "grid", gap: spacing.xs }}>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Why are you accepting or rejecting this? Required to approve something the evidence doesn't support."
        style={{ ...fieldStyle, fontSize: 12.5 }}
      />
      <input
        value={corrected}
        onChange={(e) => setCorrected(e.target.value)}
        placeholder="Corrected wording (only if correcting)"
        style={{ ...fieldStyle, fontSize: 12.5 }}
      />
      <div style={{ display: "flex", gap: spacing.xs, flexWrap: "wrap" }}>
        <button type="button" disabled={pending} style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }} onClick={() => act("approved_with_note")}>
          Approve with note
        </button>
        <button type="button" disabled={pending} style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }} onClick={() => act("corrected")}>
          Save correction
        </button>
        <button type="button" disabled={pending} style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }} onClick={() => act("excluded")}>
          Exclude
        </button>
        <button type="button" disabled={pending} style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }} onClick={() => act("research_requested")}>
          Research again
        </button>
        <button type="button" style={{ ...buttonSecondary, padding: "2px 8px", fontSize: 12 }} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <div style={{ fontSize: 12, color: colors.danger }}>{error}</div>}
    </div>
  );
}
