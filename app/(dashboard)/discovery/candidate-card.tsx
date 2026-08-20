"use client";

import { useEffect, useState, useTransition } from "react";
import { acceptCandidate, dismissCandidate } from "./actions";
import { runDeepDive } from "../prospects/[id]/deep-dive-actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import TierBadge from "@/components/TierBadge";
import { channelLabel } from "@/lib/prospects";
import { spacing, colors, buttonPrimary, buttonSecondary, cardStyle } from "@/lib/ui";
import type { Candidate } from "@/lib/candidates";

type CardStatus = "idle" | "accepting" | "justAccepted" | "removed" | "dismissing";

// A brief confirmation flash before the card disappears, long enough
// to register as "yes, that worked" without making the reviewer wait.
const CONFIRMATION_DISPLAY_MS = 1400;

export default function CandidateCard({ candidate }: { candidate: Candidate }) {
  const [status, setStatus] = useState<CardStatus>("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeepDive, setPendingDeepDive] = useState<{ runId: string; prospectId: string } | null>(
    null
  );
  const [, startTransition] = useTransition();

  // Fired from an effect, not inline in the transition below --
  // calling a Server Action directly inside startTransition kept
  // isPending-equivalent state stuck for as long as that call took to
  // settle even though it's never awaited. Decoupling it here mirrors
  // the pattern DeepDivePanel already uses successfully.
  useEffect(() => {
    if (pendingDeepDive) {
      runDeepDive(pendingDeepDive.runId, pendingDeepDive.prospectId);
    }
  }, [pendingDeepDive]);

  if (status === "removed") return null;

  const disabled = status !== "idle";

  return (
    <div
      style={{
        ...cardStyle,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        opacity: status === "dismissing" ? 0.5 : 1,
        transition: "opacity 0.2s ease",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <strong>{candidate.name}</strong>
          {candidate.suggested_tier && <TierBadge tier={candidate.suggested_tier} />}
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted }}>
          {channelLabel(candidate.channel)}
          {candidate.organization ? ` · ${candidate.organization}` : ""} · via {candidate.source ?? "unknown"}
        </div>
        {typeof candidate.raw?.rationale === "string" && candidate.raw.rationale && status === "idle" && (
          <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, maxWidth: 560 }}>
            {candidate.raw.rationale}
          </p>
        )}
        {status === "accepting" && (
          <LoadingStatus
            active
            messages={[`Kicking off AI research on ${candidate.name} to build a pursuit strategy...`]}
          />
        )}
        {status === "justAccepted" && (
          <p style={{ fontSize: 13, color: colors.success, marginTop: spacing.xs }}>
            ✓ AI is now researching {candidate.name} — your strategy will be ready for review shortly.
          </p>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setConfirmOpen(true)}
          style={{ ...buttonPrimary, padding: "6px 12px", fontSize: 13 }}
        >
          Accept
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setStatus("dismissing");
            startTransition(async () => {
              await dismissCandidate(candidate.id);
              setStatus("removed");
            });
          }}
          style={{ ...buttonSecondary, padding: "6px 12px", fontSize: 13 }}
        >
          Dismiss
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Accept candidate"
        message={`Accept "${candidate.name}" into the pipeline as a new prospect at the Discovery stage? This starts an automatic deep-dive to propose a strategy for pursuing them.`}
        confirmLabel="Accept"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          setStatus("accepting");
          startTransition(async () => {
            const result = await acceptCandidate(candidate.id);
            if (!result) {
              setStatus("idle");
              return;
            }
            setPendingDeepDive(result);
            setStatus("justAccepted");
            setTimeout(() => setStatus("removed"), CONFIRMATION_DISPLAY_MS);
          });
        }}
      />
    </div>
  );
}
