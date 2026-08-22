"use client";

import { useEffect, useState, useTransition } from "react";
import { acceptCandidate, dismissCandidate, saveCandidateForLater, restoreCandidateToPending } from "./actions";
import { runDeepDive } from "../prospects/[id]/deep-dive-actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import FitScoreCircle from "@/components/FitScoreCircle";
import { channelLabel } from "@/lib/prospects";
import { spacing, colors, sectionStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";
import type { CandidateWithScore } from "./opportunity-workspace";

type PanelStatus = "idle" | "accepting" | "justAccepted" | "dismissing" | "saving" | "restoring";

export default function OpportunityDetail({
  candidate,
  onStatusChange,
}: {
  candidate: CandidateWithScore;
  onStatusChange: (id: string, status: "dismissed" | "saved" | "pending" | "accepted") => void;
}) {
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeepDive, setPendingDeepDive] = useState<{ runId: string; prospectId: string } | null>(null);
  const [, startTransition] = useTransition();

  // Reset local transient state whenever the selected candidate
  // changes, so a leftover "accepting" spinner from the last card
  // doesn't bleed into the next one.
  useEffect(() => {
    setStatus("idle");
  }, [candidate.id]);

  // Fired from an effect, not inline in the transition below --
  // calling a Server Action directly inside startTransition kept
  // isPending-equivalent state stuck for as long as that call took to
  // settle even though it's never awaited (same fix as DeepDivePanel).
  useEffect(() => {
    if (pendingDeepDive) {
      runDeepDive(pendingDeepDive.runId, pendingDeepDive.prospectId);
    }
  }, [pendingDeepDive]);

  const disabled = status !== "idle";
  const rationale = typeof candidate.raw?.rationale === "string" ? candidate.raw.rationale : null;
  // Light re-presentation of the same rationale text as separate
  // points instead of one paragraph -- not new content, just
  // "structured intelligence" per the handoff, without needing a new
  // AI extraction schema to back genuinely separate reasons.
  const rationalePoints = rationale
    ? rationale
        .split(/(?<=[.?!])\s+(?=[A-Z])/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return (
    <div style={sectionStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 19 }}>{candidate.name}</h2>
          <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
            {candidate.website && (
              <a href={candidate.website} target="_blank" rel="noreferrer" style={{ color: colors.textMuted }}>
                {candidate.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            {candidate.location ? (candidate.website ? ` · ${candidate.location}` : candidate.location) : ""}
          </div>
        </div>
        {candidate.fitPercentage != null && <FitScoreCircle percentage={candidate.fitPercentage} size={56} />}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: spacing.md,
          marginTop: spacing.md,
        }}
      >
        <Stat label="Channel" value={channelLabel(candidate.channel)} />
        <Stat label="Typical grant" value={candidate.typical_grant_size ?? "—"} />
        <Stat label="Funder type" value={candidate.funder_type ?? "—"} />
        <Stat label="Source" value={candidate.source ?? "unknown"} />
      </div>

      {rationalePoints.length > 0 && (
        <div style={{ marginTop: spacing.lg }}>
          <h3 style={{ fontSize: 14 }}>Why This Organization</h3>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20, display: "grid", gap: 6 }}>
            {rationalePoints.map((point, i) => (
              <li key={i} style={{ fontSize: 13, color: colors.text }}>
                {point}
              </li>
            ))}
          </ul>
        </div>
      )}

      {status === "accepting" && (
        <LoadingStatus
          active
          messages={[`Kicking off AI research on ${candidate.name} to build a pursuit strategy...`]}
        />
      )}
      {status === "justAccepted" && (
        <p style={{ fontSize: 13, color: colors.success, marginTop: spacing.md }}>
          ✓ AI is now researching {candidate.name} — your strategy will be ready for review shortly.
        </p>
      )}

      {status !== "justAccepted" && (
        <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.lg, flexWrap: "wrap" }}>
          {candidate.status === "pending" && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setStatus("saving");
                startTransition(async () => {
                  await saveCandidateForLater(candidate.id);
                  onStatusChange(candidate.id, "saved");
                });
              }}
              style={buttonSecondary}
            >
              {status === "saving" ? "Saving…" : "Save for later"}
            </button>
          )}
          {candidate.status !== "pending" && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setStatus("restoring");
                startTransition(async () => {
                  await restoreCandidateToPending(candidate.id);
                  onStatusChange(candidate.id, "pending");
                });
              }}
              style={buttonSecondary}
            >
              {status === "restoring" ? "Restoring…" : "Move back to review"}
            </button>
          )}
          {candidate.status !== "dismissed" && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setStatus("dismissing");
                startTransition(async () => {
                  await dismissCandidate(candidate.id);
                  onStatusChange(candidate.id, "dismissed");
                });
              }}
              style={buttonSecondary}
            >
              {status === "dismissing" ? "Dismissing…" : "Dismiss"}
            </button>
          )}
          <button type="button" disabled={disabled} onClick={() => setConfirmOpen(true)} style={buttonPrimary}>
            Accept &amp; start research
          </button>
        </div>
      )}
      <p style={{ fontSize: 12, color: colors.textFaint, marginTop: spacing.sm }}>
        Adds to Discovery; nothing is sent automatically.
      </p>

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
            onStatusChange(candidate.id, "accepted");
          });
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: colors.textMuted }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}
