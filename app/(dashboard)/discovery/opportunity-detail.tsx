"use client";

import { useEffect, useState, useTransition } from "react";
import { Globe, MapPin, Coins, Building2, Database, Bookmark, RotateCcw, X, CircleCheck } from "lucide-react";
import { acceptCandidate, dismissCandidate, saveCandidateForLater, restoreCandidateToPending } from "./actions";
import { runResearch } from "../prospects/[id]/research-actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import FitScoreCircle from "@/components/FitScoreCircle";
import InitialsAvatar from "@/components/InitialsAvatar";
import { channelLabel } from "@/lib/prospects";
import { spacing, colors, radiusSm, chipStyle, sectionStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";
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
  const [pendingResearchRun, setPendingResearchRun] = useState<{ runId: string; prospectId: string } | null>(null);
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
  // settle even though it's never awaited (same fix as StrategyPanel).
  useEffect(() => {
    if (pendingResearchRun) {
      runResearch(pendingResearchRun.runId, pendingResearchRun.prospectId, "dossier");
    }
  }, [pendingResearchRun]);

  const disabled = status !== "idle";
  const confidenceTone =
    candidate.fitPercentage == null ? null : candidate.fitPercentage >= 0.7 ? "teal" : candidate.fitPercentage >= 0.4 ? "amber" : "red";
  const confidenceLabel =
    candidate.fitPercentage == null ? null : candidate.fitPercentage >= 0.7 ? "High confidence" : candidate.fitPercentage >= 0.4 ? "Medium confidence" : "Low confidence";
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md }}>
        <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
          <InitialsAvatar name={candidate.name} size={48} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 19, overflowWrap: "break-word" }}>{candidate.name}</h2>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2, display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
              {candidate.website && (
                <a href={candidate.website} target="_blank" rel="noreferrer" style={{ color: colors.textMuted, display: "flex", alignItems: "center", gap: 4 }}>
                  <Globe size={13} /> {candidate.website.replace(/^https?:\/\//, "")}
                </a>
              )}
              {candidate.location && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <MapPin size={13} /> {candidate.location}
                </span>
              )}
            </div>
          </div>
        </div>
        {candidate.fitPercentage != null && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <FitScoreCircle percentage={candidate.fitPercentage} size={56} />
            {confidenceTone && confidenceLabel && (
              <span style={{ ...chipStyle(confidenceTone), whiteSpace: "nowrap" }}>{confidenceLabel}</span>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: spacing.md,
          marginTop: spacing.md,
        }}
      >
        <Stat icon={Building2} label="Channel" value={channelLabel(candidate.channel)} />
        <Stat icon={Coins} label="Typical grant" value={candidate.typical_grant_size ?? "—"} />
        <Stat icon={Building2} label="Funder type" value={candidate.funder_type ?? "—"} />
        <Stat icon={Database} label="Source" value={candidate.source ?? "unknown"} />
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
          ✓ Researching {candidate.name} — the findings will be ready for your review shortly.
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
              style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 8 }}
            >
              <Bookmark size={15} /> {status === "saving" ? "Saving…" : "Save for later"}
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
              style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 8 }}
            >
              <RotateCcw size={15} /> {status === "restoring" ? "Restoring…" : "Move back to review"}
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
              style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 8 }}
            >
              <X size={15} /> {status === "dismissing" ? "Dismissing…" : "Dismiss"}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirmOpen(true)}
            style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 8 }}
          >
            <CircleCheck size={15} /> Accept &amp; start research
          </button>
        </div>
      )}
      <p style={{ fontSize: 12, color: colors.textFaint, marginTop: spacing.sm }}>
        Adds to Discovery; nothing is sent automatically.
      </p>

      <ConfirmDialog
        open={confirmOpen}
        title="Accept candidate"
        message={`Accept "${candidate.name}" into the pipeline as a new prospect at the Discovery stage? Research starts straight away; you review what it finds, then generate a strategy from it.`}
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
            setPendingResearchRun(result);
            setStatus("justAccepted");
            onStatusChange(candidate.id, "accepted");
          });
        }}
      />
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: spacing.sm }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          borderRadius: radiusSm,
          background: colors.surfaceSubtle,
          color: colors.navy500,
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        <Icon size={13} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: colors.textMuted }}>{label}</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{value}</div>
      </div>
    </div>
  );
}
