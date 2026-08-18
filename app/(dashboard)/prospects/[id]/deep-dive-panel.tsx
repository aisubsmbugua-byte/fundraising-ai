"use client";

import { useEffect, useState, useTransition } from "react";
import { getLatestDeepDiveRun, approveStrategy, retryDeepDive, runDeepDive } from "./deep-dive-actions";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, cardStyle } from "@/lib/ui";
import type { DeepDiveRun, Strategy } from "@/lib/deep-dive";

const RUNNING_STATUSES = new Set(["researching", "analyzing"]);

export default function DeepDivePanel({
  prospectId,
  initialRun,
}: {
  prospectId: string;
  initialRun: DeepDiveRun | null;
}) {
  const [run, setRun] = useState<DeepDiveRun | null>(initialRun);
  const [isPending, startTransition] = useTransition();
  const [outreach, setOutreach] = useState(run?.strategy?.outreach_approach ?? "");
  const [positioning, setPositioning] = useState(run?.strategy?.ask_positioning ?? "");
  const [rationale, setRationale] = useState(run?.strategy?.rationale ?? "");

  // Poll while a run is actively researching/analyzing. Stops itself
  // once the run reaches a terminal state.
  useEffect(() => {
    if (!run || !RUNNING_STATUSES.has(run.status)) return;

    const interval = setInterval(async () => {
      const latest = await getLatestDeepDiveRun(prospectId);
      if (latest) {
        setRun(latest);
        if (latest.status === "ready_for_review" && latest.strategy) {
          setOutreach(latest.strategy.outreach_approach);
          setPositioning(latest.strategy.ask_positioning);
          setRationale(latest.strategy.rationale);
        }
      }
    }, 1200);

    return () => clearInterval(interval);
  }, [run, prospectId]);

  if (!run) return null;

  const isApproved = !!run.approved_strategy;

  return (
    <div style={{ marginTop: spacing.xxl }}>
      <h2 style={{ fontSize: 16 }}>Strategy</h2>

      {RUNNING_STATUSES.has(run.status) && (
        <div style={{ ...cardStyle, marginTop: spacing.md, display: "flex", alignItems: "center", gap: spacing.sm }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: colors.warning,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
          <span style={{ fontSize: 14, color: colors.text }}>{run.status_message ?? "Working…"}</span>
        </div>
      )}

      {run.status === "error" && (
        <div style={{ ...cardStyle, marginTop: spacing.md }}>
          <p style={{ fontSize: 14, color: "crimson" }}>
            {run.status_message}
            {run.error_message ? `: ${run.error_message}` : ""}
          </p>
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                const newRunId = await retryDeepDive(prospectId);
                const latest = await getLatestDeepDiveRun(prospectId);
                setRun(latest);
                runDeepDive(newRunId, prospectId);
              })
            }
            style={{ ...buttonSecondary, marginTop: spacing.sm }}
          >
            {isPending ? "Retrying…" : "Retry Deep Dive"}
          </button>
        </div>
      )}

      {run.status === "ready_for_review" && (
        <div style={{ ...cardStyle, marginTop: spacing.md }}>
          {isApproved ? (
            <>
              <p style={{ fontSize: 12, color: colors.success, marginBottom: spacing.sm }}>
                ✓ Approved {run.approved_at ? new Date(run.approved_at).toLocaleString() : ""}
              </p>
              <div style={{ display: "grid", gap: spacing.sm, fontSize: 14 }}>
                <div>
                  <div style={labelStyle}>Outreach approach</div>
                  <p>{run.approved_strategy?.outreach_approach}</p>
                </div>
                <div>
                  <div style={labelStyle}>Ask positioning</div>
                  <p>{run.approved_strategy?.ask_positioning}</p>
                </div>
                <div>
                  <div style={labelStyle}>Rationale</div>
                  <p style={{ color: colors.textMuted }}>{run.approved_strategy?.rationale}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: 12, color: colors.textMuted, marginBottom: spacing.sm }}>
                AI-proposed strategy — review and edit before approving. Nothing downstream (drafting
                outreach content) happens until this is approved.
              </p>
              <div style={{ display: "grid", gap: spacing.md }}>
                <label style={labelStyle}>
                  Outreach approach
                  <textarea
                    value={outreach}
                    onChange={(e) => setOutreach(e.target.value)}
                    rows={3}
                    style={fieldStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Ask positioning
                  <textarea
                    value={positioning}
                    onChange={(e) => setPositioning(e.target.value)}
                    rows={3}
                    style={fieldStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Rationale
                  <textarea
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    rows={3}
                    style={fieldStyle}
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => {
                    const approved: Strategy = {
                      outreach_approach: outreach,
                      ask_positioning: positioning,
                      rationale,
                    };
                    await approveStrategy(run.id, prospectId, approved);
                    const latest = await getLatestDeepDiveRun(prospectId);
                    setRun(latest);
                  })
                }
                style={{ ...buttonPrimary, marginTop: spacing.md }}
              >
                {isPending ? "Saving…" : "Approve Strategy"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
