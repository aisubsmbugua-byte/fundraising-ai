"use client";

import { useState, useTransition } from "react";
import { submitClaimReview, setClaimVerificationStatus } from "./actions";
import { fieldStyle, buttonSecondary, spacing, colors } from "@/lib/ui";
import type { ResearchEvalVerdict } from "@/lib/research";

const VERDICTS: ResearchEvalVerdict[] = [
  "match",
  "partial",
  "miss",
  "contradicted",
  "plausible",
  "hallucinated",
  "unclear",
  "outdated",
];

// One reviewer control per claim -- the claim and its supporting evidence
// (rendered by the caller, page.tsx) sit directly above this in the DOM,
// so a reviewer sees both together while deciding.
export default function ClaimReview({
  claimId,
  researchRunId,
  currentVerificationStatus,
}: {
  claimId: string;
  researchRunId: string;
  currentVerificationStatus: string;
}) {
  const [verdict, setVerdict] = useState<ResearchEvalVerdict>("match");
  const [notes, setNotes] = useState("");
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", gap: spacing.xs, alignItems: "center", marginTop: spacing.xs, flexWrap: "wrap" }}>
      <select
        style={{ ...fieldStyle, width: "auto", marginTop: 0, fontSize: 12.5, padding: "4px 6px" }}
        value={verdict}
        onChange={(e) => setVerdict(e.target.value as ResearchEvalVerdict)}
      >
        {VERDICTS.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      <input
        style={{ ...fieldStyle, width: 160, marginTop: 0, fontSize: 12.5, padding: "4px 6px" }}
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button
        style={{ ...buttonSecondary, padding: "4px 10px", fontSize: 12.5 }}
        disabled={isPending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const result = await submitClaimReview(claimId, researchRunId, verdict, notes);
            setMessage("error" in result ? result.error : "Saved");
            if (!("error" in result)) setNotes("");
          });
        }}
      >
        Save review
      </button>
      <span style={{ fontSize: 12, color: colors.textFaint }}>
        verification: <strong>{currentVerificationStatus}</strong>
      </span>
      <button
        style={{ ...buttonSecondary, padding: "4px 10px", fontSize: 12.5 }}
        disabled={isPending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const result = await setClaimVerificationStatus(claimId, "human_confirmed");
            setMessage("error" in result ? result.error : "Confirmed");
          });
        }}
      >
        Confirm
      </button>
      <button
        style={{ ...buttonSecondary, padding: "4px 10px", fontSize: 12.5, color: colors.danger, borderColor: colors.danger }}
        disabled={isPending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const result = await setClaimVerificationStatus(claimId, "human_disputed");
            setMessage("error" in result ? result.error : "Disputed");
          });
        }}
      >
        Dispute
      </button>
      {message && <span style={{ fontSize: 12, color: colors.textMuted }}>{message}</span>}
    </div>
  );
}
