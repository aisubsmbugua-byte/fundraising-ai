"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { approveStrategy, retryStrategy, runStrategy } from "./strategy-actions";
import CollapsibleField from "@/components/CollapsibleField";
import ControlledListInput from "@/components/ControlledListInput";
import LoadingStatus from "@/components/LoadingStatus";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, cardStyle } from "@/lib/ui";
import type { StrategyRun, Strategy, OrganizationIntel } from "@/lib/strategy";

const RUNNING_STATUSES = new Set(["researching", "analyzing"]);

const emptyIntel: OrganizationIntel = {
  location: "",
  funder_type: "",
  geographic_focus: "",
  typical_grant_size: "",
  focus_areas: [],
};

export default function StrategyPanel({
  prospectId,
  initialRun,
  onApproved,
}: {
  prospectId: string;
  initialRun: StrategyRun | null;
  // Optional -- lets a caller like Strategy Review's split-pane
  // workspace know a strategy was just approved (so it can drop the
  // item out of its "waiting on review" list) without this panel
  // needing to know anything about where it's embedded.
  onApproved?: () => void;
}) {
  const [run, setRun] = useState<StrategyRun | null>(initialRun);
  const [isPending, startTransition] = useTransition();
  const [outreach, setOutreach] = useState(run?.strategy?.outreach_approach ?? "");
  const [positioning, setPositioning] = useState(run?.strategy?.ask_positioning ?? "");
  const [rationale, setRationale] = useState(run?.strategy?.rationale ?? "");
  const [talkingPoints, setTalkingPoints] = useState<string[]>(run?.strategy?.key_talking_points ?? []);
  const [evidenceToHighlight, setEvidenceToHighlight] = useState<string[]>(
    run?.strategy?.evidence_to_highlight ?? []
  );
  const [intel, setIntel] = useState<OrganizationIntel>(run?.organization_intel ?? emptyIntel);
  const [focusAreasText, setFocusAreasText] = useState((run?.organization_intel?.focus_areas ?? []).join(", "));
  const triggeredRef = useRef<string | null>(null);
  // A refusal from the strategy guard is information, not a crash.
  const [retryError, setRetryError] = useState<string | null>(null);

  // Fetches run status via a plain REST route, not a Server Action --
  // see app/api/strategy-runs/[prospectId]/route.ts for why.
  async function fetchRun() {
    const res = await fetch(`/api/strategy-runs/${prospectId}`);
    if (!res.ok) return null;
    const { run: latest } = await res.json();
    return latest as StrategyRun | null;
  }

  // This panel is the stable "destination" component for a run, so
  // it's responsible for actually kicking off the work -- not
  // whatever page navigated here (see runStrategy's comment for why).
  // triggeredRef guards against firing twice for the same run within
  // this component instance (e.g. React re-render); started_at on the
  // server guards against firing twice across page loads/refreshes.
  useEffect(() => {
    if (run && run.status === "researching" && !run.started_at && triggeredRef.current !== run.id) {
      triggeredRef.current = run.id;
      runStrategy(run.id, prospectId);
    }
  }, [run, prospectId]);

  // Poll while a run is actively researching/analyzing. Stops itself
  // once the run reaches a terminal state.
  useEffect(() => {
    if (!run || !RUNNING_STATUSES.has(run.status)) return;

    const interval = setInterval(async () => {
      const latest = await fetchRun();
      if (latest) {
        setRun(latest);
        if (latest.status === "ready_for_review" && latest.strategy) {
          setOutreach(latest.strategy.outreach_approach);
          setPositioning(latest.strategy.ask_positioning);
          setRationale(latest.strategy.rationale);
          setTalkingPoints(latest.strategy.key_talking_points ?? []);
          setEvidenceToHighlight(latest.strategy.evidence_to_highlight ?? []);
        }
        if (latest.status === "ready_for_review" && latest.organization_intel) {
          setIntel(latest.organization_intel);
          setFocusAreasText((latest.organization_intel.focus_areas ?? []).join(", "));
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
            Our AI is preparing an outreach and ask strategy for this prospect.
            This typically takes a minute or two — this will update automatically as soon as it&apos;s
            ready for your review.
          </p>
          <LoadingStatus active messages={[run.status_message ?? "Working…"]} />
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
                setRetryError(null);
                const result = await retryStrategy(prospectId);
                if ("error" in result) {
                  setRetryError(result.error);
                  return;
                }
                const latest = await fetchRun();
                setRun(latest);
                runStrategy(result.runId, prospectId);
              })
            }
            style={{ ...buttonSecondary, marginTop: spacing.sm }}
          >
            {isPending ? "Retrying…" : "Retry strategy"}
          </button>
          {retryError && (
            <div style={{ fontSize: 12.5, color: colors.danger, marginTop: spacing.xs }}>{retryError}</div>
          )}
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
                  <CollapsibleField label="Outreach approach" value={run.approved_strategy?.outreach_approach ?? ""} />
                </div>
                <div>
                  <div style={labelStyle}>Ask positioning</div>
                  <CollapsibleField label="Ask positioning" value={run.approved_strategy?.ask_positioning ?? ""} />
                </div>
                <div>
                  <div style={labelStyle}>Rationale</div>
                  <CollapsibleField label="Rationale" value={run.approved_strategy?.rationale ?? ""} />
                </div>
                <div>
                  <div style={labelStyle}>Key talking points</div>
                  {run.approved_strategy?.key_talking_points && run.approved_strategy.key_talking_points.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      {run.approved_strategy.key_talking_points.map((point, i) => (
                        <li key={i}>{point}</li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ color: colors.textFaint }}>—</p>
                  )}
                </div>
                <div>
                  <div style={labelStyle}>Evidence to highlight</div>
                  {run.approved_strategy?.evidence_to_highlight && run.approved_strategy.evidence_to_highlight.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      {run.approved_strategy.evidence_to_highlight.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ color: colors.textFaint }}>—</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => {
                    setRetryError(null);
                    const result = await retryStrategy(prospectId);
                    if ("error" in result) {
                      setRetryError(result.error);
                      return;
                    }
                    const newRunId = result.runId;
                    const latest = await fetchRun();
                    setRun(latest);
                    runStrategy(newRunId, prospectId);
                  })
                }
                style={{ ...buttonSecondary, marginTop: spacing.md }}
              >
                {isPending ? "Regenerating…" : "Regenerate strategy"}
              </button>
              {retryError && (
                <div style={{ fontSize: 12.5, color: colors.danger, marginTop: spacing.xs }}>{retryError}</div>
              )}
              <p style={{ fontSize: 11, color: colors.textFaint, marginTop: spacing.xs }}>
                Useful if your Organization Profile has changed since this was approved, or to pick up
                new fields added since. This creates a fresh strategy to review and approve — it doesn&apos;t
                touch the one above unless you approve the new one too.
              </p>
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
              <div className="responsive-grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.sm, marginTop: spacing.xs }}>
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
                <div>
                  <div style={labelStyle}>Outreach approach</div>
                  <CollapsibleField label="Outreach approach" value={outreach} onChange={setOutreach} />
                </div>
                <div>
                  <div style={labelStyle}>Ask positioning</div>
                  <CollapsibleField label="Ask positioning" value={positioning} onChange={setPositioning} />
                </div>
                <div>
                  <div style={labelStyle}>Rationale</div>
                  <CollapsibleField label="Rationale" value={rationale} onChange={setRationale} />
                </div>
                <div>
                  <div style={labelStyle}>Key talking points</div>
                  <ControlledListInput
                    value={talkingPoints}
                    onChange={setTalkingPoints}
                    placeholder="Type a talking point, press Enter to add"
                  />
                </div>
                <div>
                  <div style={labelStyle}>Evidence to highlight</div>
                  <ControlledListInput
                    value={evidenceToHighlight}
                    onChange={setEvidenceToHighlight}
                    placeholder="Type what kind of evidence would resonate, press Enter to add"
                  />
                </div>
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
                      key_talking_points: talkingPoints,
                      evidence_to_highlight: evidenceToHighlight,
                    };
                    const approvedIntel: OrganizationIntel = {
                      ...intel,
                      focus_areas: focusAreasText
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    };
                    await approveStrategy(run.id, prospectId, approvedStrategy, approvedIntel);
                    const latest = await fetchRun();
                    setRun(latest);
                    onApproved?.();
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
