"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { getLatestDeepDiveRun, approveStrategy, retryDeepDive, runDeepDive } from "./deep-dive-actions";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, cardStyle } from "@/lib/ui";
import type { DeepDiveRun, Strategy, OrganizationIntel } from "@/lib/deep-dive";

const RUNNING_STATUSES = new Set(["researching", "analyzing"]);

const emptyIntel: OrganizationIntel = {
  location: "",
  funder_type: "",
  geographic_focus: "",
  typical_grant_size: "",
  focus_areas: [],
};

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
  const [intel, setIntel] = useState<OrganizationIntel>(run?.organization_intel ?? emptyIntel);
  const [focusAreasText, setFocusAreasText] = useState((run?.organization_intel?.focus_areas ?? []).join(", "));
  const triggeredRef = useRef<string | null>(null);

  // This panel is the stable "destination" component for a run, so
  // it's responsible for actually kicking off the work -- not
  // whatever page navigated here (see runDeepDive's comment for why).
  // triggeredRef guards against firing twice for the same run within
  // this component instance (e.g. React re-render); started_at on the
  // server guards against firing twice across page loads/refreshes.
  useEffect(() => {
    if (run && run.status === "researching" && !run.started_at && triggeredRef.current !== run.id) {
      triggeredRef.current = run.id;
      runDeepDive(run.id, prospectId);
    }
  }, [run, prospectId]);

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
        if (latest.status === "ready_for_review" && latest.organization_intel) {
          setIntel(latest.organization_intel);
          setFocusAreasText(latest.organization_intel.focus_areas.join(", "));
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
        <div style={{ ...cardStyle, marginTop: spacing.md }}>
          <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm }}>
            Our AI is doing a deep dive on this prospect to formulate an outreach and ask strategy.
            This typically takes a minute or two — this will update automatically as soon as it&apos;s
            ready for your review.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
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
                  <div style={labelStyle}>Funder intelligence</div>
                  <p style={{ color: colors.textMuted }}>
                    {[
                      run.organization_intel?.funder_type,
                      run.organization_intel?.location,
                      run.organization_intel?.geographic_focus,
                      run.organization_intel?.typical_grant_size,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                  {run.organization_intel?.focus_areas && run.organization_intel.focus_areas.length > 0 && (
                    <p style={{ color: colors.textMuted, fontSize: 13 }}>
                      Focus areas: {run.organization_intel.focus_areas.join(", ")}
                    </p>
                  )}
                </div>
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
                AI-proposed — review and edit before approving. Approving applies the funder intelligence
                below to this prospect's record and unlocks outreach drafting. Nothing happens until then.
              </p>

              <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginTop: spacing.md }}>
                Funder intelligence
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.sm, marginTop: spacing.xs }}>
                <label style={labelStyle}>
                  Location
                  <input
                    value={intel.location}
                    onChange={(e) => setIntel({ ...intel, location: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Funder type
                  <input
                    value={intel.funder_type}
                    onChange={(e) => setIntel({ ...intel, funder_type: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Geographic focus
                  <input
                    value={intel.geographic_focus}
                    onChange={(e) => setIntel({ ...intel, geographic_focus: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Typical grant size
                  <input
                    value={intel.typical_grant_size}
                    onChange={(e) => setIntel({ ...intel, typical_grant_size: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
              </div>
              <label style={{ ...labelStyle, display: "block", marginTop: spacing.sm }}>
                Focus areas (comma-separated)
                <input
                  value={focusAreasText}
                  onChange={(e) => setFocusAreasText(e.target.value)}
                  style={fieldStyle}
                />
              </label>

              <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginTop: spacing.lg }}>
                Strategy
              </div>
              <div style={{ display: "grid", gap: spacing.md, marginTop: spacing.xs }}>
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
                    const approvedStrategy: Strategy = {
                      outreach_approach: outreach,
                      ask_positioning: positioning,
                      rationale,
                    };
                    const approvedIntel: OrganizationIntel = {
                      ...intel,
                      focus_areas: focusAreasText
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    };
                    await approveStrategy(run.id, prospectId, approvedStrategy, approvedIntel);
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
