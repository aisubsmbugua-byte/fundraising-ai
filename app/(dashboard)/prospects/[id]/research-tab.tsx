import type { StrategyRun } from "@/lib/strategy";
import type { ProspectIntelligence, IntelligenceReviewState, StrategyUse } from "@/lib/prospect-intelligence";
import { spacing, colors, sectionStyle, chipStyle } from "@/lib/ui";
import type { ProspectWorkflow } from "@/lib/prospect-workflow";
import EntityResolver from "./entity-resolver";
import VerifyRetry from "./verify-retry";
import ResearchPanel from "./research-panel";
import ApproveAndGenerate from "./approve-and-generate";
import { ClaimDecision } from "./claim-decision";

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

// What will happen to the claim, which is not the same question as how well
// evidenced it is. The tab used to answer only the second and then describe
// everything unresolved as "needing a decision" -- which read as an
// obligation, when in fact the gate already excludes these and doing nothing
// is the safe outcome. Naming the default is what shortens the queue.
const STRATEGY_USE: Record<StrategyUse, { label: string; tone: "teal" | "amber" | "red" | "neutral" }> = {
  in_strategy: { label: "In Strategy", tone: "teal" },
  ready_to_approve: { label: "Ready to approve", tone: "teal" },
  // Enters as background, labelled unconfirmed. No decision is outstanding,
  // so it must not be listed as though one were.
  advisory_context: { label: "Context only", tone: "neutral" },
  approved_not_used: { label: "Approved · not used", tone: "amber" },
  held_back: { label: "Not used unless you resolve it", tone: "neutral" },
  not_verified: { label: "Not used — never checked", tone: "neutral" },
  not_used_field: { label: "Not used for strategy", tone: "neutral" },
  excluded_by_you: { label: "Excluded by you", tone: "neutral" },
};

export default function ResearchTab({
  prospectId,
  intelligence,
  strategyRun,
  workflow,
  lastCompletedAt,
  approvedClaimCount,
  prospectEin,
  prospectPredecessorEins,
}: {
  prospectId: string;
  intelligence: ProspectIntelligence | null;
  strategyRun: StrategyRun | null;
  workflow: ProspectWorkflow;
  lastCompletedAt: string | null;
  approvedClaimCount: number;
  // Stored on the prospect by a human confirming identity. Distinct from
  // intelligence.confirmedEin, which is what a given RUN resolved to.
  prospectEin: string | null;
  prospectPredecessorEins: string[];
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

  // No finished run to show. This covers three different situations -- never
  // researched, researching right now, and a run that failed -- and the
  // workflow state is what tells them apart. ResearchPanel renders the right
  // control for each, so this block never has to guess.
  if (!intelligence) {
    return (
      <div>
        <div style={sectionStyle}>
          <h3 style={{ fontSize: 14, margin: 0 }}>{workflow.label}</h3>
          <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.sm }}>
            {strategyRun?.findings && workflow.state === "not_started"
              ? "This prospect has legacy findings only, from before research became its own step. Running research produces evidence-backed claims you can review and approve."
              : workflow.hint}
          </p>
          <ResearchPanel prospectId={prospectId} workflow={workflow} lastCompletedAt={lastCompletedAt} />
        </div>
        {legacy}
      </div>
    );
  }

  // Read from the entity vocabulary, not from completion_state. The latter
  // is only written for dossier runs, so a screening run whose entity was
  // never established slipped through as "not blocked" and rendered
  // "could not be established" directly above a green "confirmed entity"
  // chip. Whether we know who this organization is does not depend on how
  // deeply we searched.
  const identityUnresolved =
    intelligence.resolutionMethod === "unresolved" || intelligence.resolutionMethod === "ambiguous_filings";
  const blocked = intelligence.state === "blocked" || identityUnresolved;
  // A person has since said who this is, but the run predates that. Not the
  // same as "we don't know", and telling someone their confirmation never
  // happened is how a working button reads as broken.
  const identitySettledSince = blocked && !!prospectEin;
  const verifying = intelligence.verificationState === "pending" || intelligence.verificationState === "in_progress";
  const verifyFailed = intelligence.verificationState === "failed";
  const gaps = intelligence.sections.filter((s) => s.missing);
  const allClaims = intelligence.sections.flatMap((s) => s.claims);
  const claimsWithSections = intelligence.sections.filter((s) => s.claims.length > 0);
  // Only verified claims can be approved in bulk. Everything else is an
  // exception a person decides on individually -- sweeping those along is
  // precisely how unchecked facts reach an ask.
  const verifiedCount = allClaims.filter((c) => c.strategyUse === "ready_to_approve").length;
  const exceptionCount = allClaims.filter((c) => c.strategyUse === "held_back" || c.strategyUse === "not_verified").length;
  // Screening is a cheaper pass that is never verified -- see the depth
  // tiering. Saying so is the difference between "we found little" and "we
  // did not look hard, and did not check what we found".
  const preliminary = intelligence.depth !== null && intelligence.depth !== "dossier";

  return (
    <div style={{ display: "grid", gap: spacing.md }}>
      {/* Identity comes first when it is unsettled. Everything below it may
          describe a different organization, so the choice that resolves that
          has to precede the material it governs -- not sit under it. */}
      {blocked && (
        <EntityResolver
          prospectId={prospectId}
          confirmedEin={intelligence.confirmedEin}
          resolutionMethod={intelligence.resolutionMethod}
          candidates={intelligence.candidates}
          operatingIdentity={intelligence.operatingIdentity}
          blocked={blocked}
          savedEin={prospectEin}
          predecessorEins={prospectPredecessorEins}
        />
      )}

      {/* Signals, not a verdict. Each has an innocent reading -- a funder can
          go quiet, change fiscal year, or be described loosely by a source --
          so this asks a question rather than answering one. Deciding needs
          context we do not have and a person does. */}
      {intelligence.lifecycle.signals.length > 0 && (
        <div style={{ ...sectionStyle, borderLeft: `3px solid ${colors.danger}` }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Is this organization still operating?</h3>
          <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.xs }}>
            The research below may describe an organization that has since merged, been renamed, or wound up. Worth
            checking before you spend time on it:
          </p>
          <ul style={{ fontSize: 12.5, color: colors.text, margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
            {intelligence.lifecycle.signals.map((s) => (
              <li key={s.kind}>{s.detail}</li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, marginBottom: 0 }}>
            If it merged into another organization, confirm the surviving one under Identity — research will then be
            about the entity that still exists.
          </p>
        </div>
      )}

      {preliminary && (
        <div style={{ ...sectionStyle, borderLeft: `3px solid #b8860b` }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Preliminary — screening only</h3>
          <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
            This was a screening pass, not a full dossier: fewer sources were searched and none of the claims were
            checked against their evidence. Use it to judge whether this funder is worth pursuing, not to write an
            ask. Running research again produces a full, verified dossier.
          </p>
        </div>
      )}

      {/* The one thing to read first. A blocked dossier says so plainly
          rather than presenting facts that may describe another organization. */}
      <div style={{ ...sectionStyle, borderLeft: `3px solid ${blocked ? (identitySettledSince ? "#b8860b" : colors.danger) : verifying || verifyFailed ? "#b8860b" : gaps.length ? "#b8860b" : colors.text}` }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>
          {blocked
            ? identitySettledSince
              ? "Research is out of date"
              : "Identity not confirmed"
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
            ? identitySettledSince
              ? "You confirmed this organization after the research below was gathered, so it may still describe a different one. Run research again and it will resolve to the saved EIN directly."
              : "Several organizations share this name and research could not tell which is meant. Everything below may describe a different organization — confirm the entity before relying on any of it."
            : verifying
              ? "Research is complete and shown below. Each claim is being checked against the evidence it cites; review states will appear shortly."
              : verifyFailed
                ? "The research below is intact, but the check against sources did not finish, so claims are unreviewed. Retrying is safe — it re-reads the stored evidence and does not re-run research."
                : gaps.length
                  ? `Research is usable, but nothing was found for: ${gaps.map((g) => g.label.toLowerCase()).join(", ")}.`
                  : "Every information category was found. Individual claims still carry their own review state below."}
        </p>
        {verifyFailed && <div style={{ marginTop: spacing.xs }}><VerifyRetry runId={intelligence.runId} /></div>}
        <div style={{ marginTop: spacing.sm }}>
          <ResearchPanel prospectId={prospectId} workflow={workflow} lastCompletedAt={lastCompletedAt} />
        </div>
      </div>

      {!blocked && !verifying && (verifiedCount > 0 || approvedClaimCount > 0) && (
        <div style={sectionStyle}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Approve intelligence</h3>
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.sm }}>
            Only approved intelligence reaches Strategy and outreach. Verified claims are approved together.
            Anything the evidence does not fully support is <strong>already left out</strong> — you only need to
            look at those if you want to correct one, accept it on your own knowledge, or send it back for more
            research.
          </p>
          <ApproveAndGenerate
            researchRunId={intelligence.runId}
            prospectId={prospectId}
            verifiedCount={verifiedCount}
            exceptionCount={exceptionCount}
            alreadyApprovedCount={approvedClaimCount}
          />
        </div>
      )}

      {!blocked && (
        <EntityResolver
          prospectId={prospectId}
          confirmedEin={intelligence.confirmedEin}
          resolutionMethod={intelligence.resolutionMethod}
          candidates={intelligence.candidates}
          operatingIdentity={intelligence.operatingIdentity}
          blocked={blocked}
          savedEin={prospectEin}
          predecessorEins={prospectPredecessorEins}
        />
      )}

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

      {/* Collapsed while identity is unresolved. These claims are not a
          review queue yet -- they may describe a different organization, so
          presenting them as findings to work through invites exactly the
          wrong action. Kept reachable, not kept prominent. */}
      {blocked && claimsWithSections.length > 0 && (
        <details style={sectionStyle}>
          <summary style={{ fontSize: 13.5, color: colors.text, cursor: "pointer" }}>
            Unconfirmed candidate research ({allClaims.length} claims)
          </summary>
          <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
            Gathered before the organization was identified. None of it can be approved or used until you confirm
            which organization this is, above.
          </p>
        </details>
      )}

      {!blocked &&
        claimsWithSections.map((s) => (
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
                      {/* Two different questions, answered separately: how far
                          the evidence goes, and what will actually happen to
                          the claim. Collapsing them is what made a safe
                          default read as an outstanding obligation. */}
                      <span style={chipStyle(STRATEGY_USE[c.strategyUse].tone)}>{STRATEGY_USE[c.strategyUse].label}</span>
                      <span style={{ fontSize: 12, color: colors.textMuted }}>{c.reviewReason || state.hint}</span>
                    </div>
                    {c.withheldReason && (
                      <div style={{ fontSize: 12, color: "#b8860b", marginTop: 3 }}>
                        Approved for the record, but not sent to Strategy — {c.withheldReason}.
                      </div>
                    )}
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
