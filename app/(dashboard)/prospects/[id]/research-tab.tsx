import type { StrategyRun } from "@/lib/strategy";
import type { ProspectIntelligence, IntelligenceReviewState } from "@/lib/prospect-intelligence";
import { spacing, colors, sectionStyle, chipStyle } from "@/lib/ui";
import EntityResolver from "./entity-resolver";
import VerifyRetry from "./verify-retry";
import { ApproveVerified, ClaimDecision } from "./claim-decision";

// How each review state reads to a person, and what they should do about it.
// The wording matters more than the colour: "partial" on its own tells a
// fundraiser nothing, whereas naming what is unproven tells them whether the
// number can go in an ask.
const REVIEW_STATE: Record<IntelligenceReviewState, { label: string; tone: "teal" | "amber" | "red" | "neutral"; hint: string }> = {
  verified: { label: "Verified", tone: "teal", hint: "The cited evidence states this." },
  partial: { label: "Partly supported", tone: "amber", hint: "The evidence backs part of this — the wording reaches further than the source does." },
  interpretation: { label: "Interpretation", tone: "amber", hint: "Reasoned from the evidence rather than stated by it." },
  unverified: { label: "Not yet checked", tone: "neutral", hint: "Research found this, but it has not been checked against its evidence." },
  // "Evidence not captured" rather than "no evidence": the fact may well be
  // true, this run simply did not capture support for it.
  evidence_not_captured: { label: "Evidence not captured", tone: "red", hint: "Found during research, but this run captured nothing citable for it. Treat as a lead, not a fact." },
  conflict: { label: "Conflict", tone: "red", hint: "Sources disagree, or the evidence does not support this. Needs a person to settle it." },
};

export default function ResearchTab({
  prospectId,
  intelligence,
  strategyRun,
}: {
  prospectId: string;
  intelligence: ProspectIntelligence | null;
  strategyRun: StrategyRun | null;
}) {
  // Kept, but collapsed and labelled: it predates entity checking and
  // verification, so presenting it beside verified intelligence without that
  // caveat would imply a standard it was never held to.
  const legacy = strategyRun?.findings ? (
    <details style={{ marginTop: spacing.md }}>
      <summary style={{ fontSize: 13, color: colors.textMuted, cursor: "pointer" }}>
        Legacy research (from the earlier deep-dive)
      </summary>
      <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs }}>
        Unstructured findings from the original deep-dive, kept for prospects researched before structured
        intelligence existed. It has not been entity-checked or verified against its sources.
      </p>
      <p style={{ fontSize: 13, color: colors.text, whiteSpace: "pre-wrap", marginTop: spacing.sm }}>{strategyRun.findings}</p>
    </details>
  ) : null;

  if (!intelligence) {
    return (
      <div>
        <div style={sectionStyle}>
          <h3 style={{ fontSize: 14, margin: 0 }}>No structured research yet</h3>
          <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
            {strategyRun?.findings
              ? "This prospect has legacy deep-dive findings only. Structured intelligence appears once research has been run for it."
              : "Structured intelligence appears once research has been run for this prospect."}
          </p>
        </div>
        {legacy}
      </div>
    );
  }

  const blocked = intelligence.state === "blocked";
  const verifying = intelligence.verificationState === "pending" || intelligence.verificationState === "in_progress";
  const verifyFailed = intelligence.verificationState === "failed";
  const gaps = intelligence.sections.filter((s) => s.missing);
  const allClaims = intelligence.sections.flatMap((s) => s.claims);
  // Only verified claims can be approved in bulk. Everything else is an
  // exception a person decides on individually -- sweeping those along is
  // precisely how unchecked facts reach an ask.
  const verifiedCount = allClaims.filter((c) => c.reviewState === "verified" && !c.decision).length;
  const exceptionCount = allClaims.filter((c) => c.reviewState !== "verified" && !c.decision).length;

  return (
    <div style={{ display: "grid", gap: spacing.md }}>
      {/* The one thing to read first. A blocked dossier says so plainly
          rather than presenting facts that may describe another organization. */}
      <div style={{ ...sectionStyle, borderLeft: `3px solid ${blocked ? colors.danger : verifying || verifyFailed ? "#b8860b" : gaps.length ? "#b8860b" : colors.text}` }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>
          {blocked
            ? "Identity not confirmed"
            : verifying
              ? "Checking claims against their sources"
              : verifyFailed
                ? "Verification incomplete"
                : gaps.length
                  ? "Research available, with gaps"
                  : "Ready for review"}
        </h3>
        <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
          {blocked
            ? "Several organizations share this name and research could not tell which is meant. Everything below may describe a different organization — confirm the entity before relying on any of it."
            : verifying
              ? "Research is complete and shown below. Each claim is being checked against the evidence it cites; review states will appear shortly."
              : verifyFailed
                ? "The research below is intact, but the check against sources did not finish, so claims are unreviewed. Retrying is safe — it re-reads the stored evidence and does not re-run research."
                : gaps.length
                  ? `Research is usable, but nothing was found for: ${gaps.map((g) => g.label.toLowerCase()).join(", ")}.`
                  : "Every information category was found. Individual claims still carry their own review state below."}
        </p>
        {verifyFailed && <div style={{ marginTop: spacing.xs }}><VerifyRetry runId={intelligence.runId} /></div>}
      </div>

      {!blocked && !verifying && (verifiedCount > 0 || exceptionCount > 0) && (
        <div style={sectionStyle}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Approve intelligence</h3>
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.sm }}>
            Only approved intelligence reaches Strategy and outreach. Verified claims can be approved together;
            anything the evidence does not fully support needs a decision of its own.
          </p>
          <ApproveVerified runId={intelligence.runId} verifiedCount={verifiedCount} exceptionCount={exceptionCount} />
        </div>
      )}

      <EntityResolver
        prospectId={prospectId}
        confirmedEin={intelligence.confirmedEin}
        resolutionMethod={intelligence.resolutionMethod}
        candidates={intelligence.candidates}
        blocked={blocked}
      />

      {/* Coverage before detail, so an absence is as visible as a finding. */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Coverage</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: spacing.sm }}>
          {intelligence.sections.map((s) => (
            <span key={s.section} style={chipStyle(s.missing ? "red" : "teal")}>
              {s.label}
              {s.missing ? " — not found" : ` · ${s.claims.length}`}
            </span>
          ))}
        </div>
        {intelligence.retrieval.missingSourceClasses.length > 0 && (
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.sm, marginBottom: 0 }}>
            A grant schedule appeared in the search results but was never read, which may explain a missing category.
          </p>
        )}
        {(intelligence.retrieval.fetchFailures ?? 0) > 0 && (
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4, marginBottom: 0 }}>
            {intelligence.retrieval.fetchFailures} of {intelligence.retrieval.fetches} pages could not be read on this run.
          </p>
        )}
      </div>

      {intelligence.sections
        .filter((s) => s.claims.length > 0)
        .map((s) => (
          <div key={s.section} style={sectionStyle}>
            <h3 style={{ fontSize: 14, margin: 0 }}>{s.label}</h3>
            <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
              {s.claims.map((c) => {
                const state = REVIEW_STATE[c.reviewState];
                return (
                  <div key={c.id} style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.sm }}>
                    <div style={{ fontSize: 13.5, color: colors.text }}>
                      {c.claim}
                      {c.reportingPeriod && (
                        <span style={{ color: colors.textFaint, fontSize: 12 }}>
                          {" "}
                          ({c.reportingPeriod}
                          {c.periodUnverified ? ", year not confirmed" : ""})
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 3, display: "flex", alignItems: "baseline", gap: spacing.xs, flexWrap: "wrap" }}>
                      <span style={chipStyle(state.tone)}>{state.label}</span>
                      <span style={{ fontSize: 12, color: colors.textMuted }}>{c.reviewReason || state.hint}</span>
                    </div>
                    {!blocked && !verifying && (
                      <ClaimDecision runId={intelligence.runId} claimId={c.id} decided={c.decision} />
                    )}
                    {c.sources.length > 0 && (
                      <details style={{ marginTop: 3 }}>
                        <summary style={{ fontSize: 12, color: colors.textFaint, cursor: "pointer" }}>
                          {c.sources.length} source{c.sources.length === 1 ? "" : "s"}
                        </summary>
                        <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
                          {c.sources.map((src, i) => (
                            <div key={i} style={{ fontSize: 12, color: colors.textMuted }}>
                              <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ color: colors.textMuted }}>
                                {src.title || src.url}
                              </a>
                              {src.citedText && <div style={{ color: colors.textFaint, marginTop: 2 }}>&ldquo;{src.citedText}&rdquo;</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

      {legacy}
    </div>
  );
}
