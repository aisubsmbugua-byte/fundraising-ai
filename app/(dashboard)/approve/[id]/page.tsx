import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/assistant/validate";
import { draftKindLabel } from "@/lib/drafts";
import { APPROVAL_MESSAGES, evaluateApproval, loadApprovalRow, loadLiveSubject, loadTokenRevoked, type LiveSubject } from "@/lib/agent/approvals";
import { AGENT_SETUP_PENDING_MESSAGE } from "@/lib/agent/setup";
import { spacing, colors, sectionStyle, cardStyle, buttonSecondary, labelStyle, type as typeScale } from "@/lib/ui";
import ApproveButton from "./approve-button";

export const dynamic = "force-dynamic";

// The page an approval link opens (STATE item 98, ruling 0039 clause 3). A
// signed-in session is required (the dashboard layout redirects otherwise, and
// middleware gates /approve). The request is read through the signed-in user's
// own client, so only the user it was made for can see it. The FULL content is
// rendered from the live row; Approve is offered only when the live content is
// still the content the link was made for.

function Refusal({ message, href }: { message: string; href?: string }) {
  return (
    <div style={{ ...sectionStyle, marginTop: spacing.xl }}>
      <p style={{ margin: 0, fontSize: typeScale.body }}>{message}</p>
      <div>
        <Link href={href ?? "/dashboard"} style={buttonSecondary}>
          {href ? "Open the prospect" : "Back to the dashboard"}
        </Link>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <div style={{ whiteSpace: "pre-wrap", fontSize: typeScale.body, marginTop: spacing.xs }}>{value.trim() === "" ? "(empty)" : value}</div>
    </div>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      {items.length === 0 ? (
        <div style={{ fontSize: typeScale.body, marginTop: spacing.xs }}>(none)</div>
      ) : (
        <ul style={{ margin: `${spacing.xs}px 0 0`, paddingLeft: 20, fontSize: typeScale.body }}>
          {items.map((x, i) => (
            <li key={i} style={{ whiteSpace: "pre-wrap" }}>
              {x}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Content({ live }: { live: LiveSubject }) {
  if (live.kind === "strategy") {
    const s = live.strategy;
    const i = live.intel;
    return (
      <div style={{ ...cardStyle, display: "grid", gap: spacing.md }}>
        <h2 style={{ margin: 0, fontSize: typeScale.cardTitle }}>Proposed strategy for {live.prospectName}</h2>
        {s && (
          <>
            <Field label="Outreach approach" value={s.outreach_approach} />
            <Field label="Ask positioning" value={s.ask_positioning} />
            <Field label="Rationale" value={s.rationale} />
            <List label="Key talking points" items={s.key_talking_points} />
            <List label="Evidence to highlight" items={s.evidence_to_highlight} />
          </>
        )}
        {i && (
          <>
            <h3 style={{ margin: 0, fontSize: typeScale.body }}>What the strategy assumes about the funder</h3>
            <Field label="Location" value={i.location} />
            <Field label="Funder type" value={i.funder_type} />
            <Field label="Geographic focus" value={i.geographic_focus} />
            <Field label="Typical grant size" value={i.typical_grant_size} />
            <List label="Focus areas" items={i.focus_areas} />
          </>
        )}
      </div>
    );
  }
  return (
    <div style={{ ...cardStyle, display: "grid", gap: spacing.md }}>
      <h2 style={{ margin: 0, fontSize: typeScale.cardTitle }}>
        {draftKindLabel(live.draftKind)} for {live.prospectName}
      </h2>
      {live.subject !== null && <Field label="Subject" value={live.subject} />}
      <Field label="Text" value={live.content} />
    </div>
  );
}

export default async function ApprovePage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const title = (
    <>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Approve</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
        Your agent asked for your decision on this. Nothing has been approved: you decide, here, after reading it.
      </p>
    </>
  );

  if (!isUuid(params.id)) {
    return (
      <div style={{ maxWidth: 720 }}>
        {title}
        <Refusal message={APPROVAL_MESSAGES.not_found} />
      </div>
    );
  }

  const loaded = await loadApprovalRow(supabase, params.id);
  if (loaded.setupPending) {
    return (
      <div style={{ maxWidth: 720 }}>
        {title}
        <Refusal message={AGENT_SETUP_PENDING_MESSAGE} />
      </div>
    );
  }
  if (loaded.failed) {
    return (
      <div style={{ maxWidth: 720 }}>
        {title}
        <Refusal message="That approval link could not be read just now. Try again in a moment." />
      </div>
    );
  }
  const row = loaded.row;
  const [revoked, subject] = row ? await Promise.all([loadTokenRevoked(supabase, row.token_id), loadLiveSubject(supabase, row)]) : [false, { live: null, failed: false }];
  const now = new Date();
  const verdict = evaluateApproval({ row, userId: user.id, now, live: subject.live, tokenRevoked: revoked });
  const prospectHref = row ? `/prospects/${row.prospect_id}` : undefined;

  if (verdict.state !== "ready" || !row || !subject.live) {
    return (
      <div style={{ maxWidth: 720 }}>
        {title}
        <Refusal message={verdict.state === "ready" ? APPROVAL_MESSAGES.subject_gone : verdict.message} href={verdict.state === "not_found" ? undefined : prospectHref} />
      </div>
    );
  }

  const live = subject.live;
  const sendNote =
    live.kind === "draft"
      ? "Approving a draft marks it approved. It is not sending: nothing goes to anyone. Delivering it is a separate step, on the prospect's page, with its own confirmation."
      : "Approving a strategy records your decision. Nothing is sent to anyone; drafting outreach from it is a separate step.";

  return (
    <div style={{ maxWidth: 720 }}>
      {title}
      <div style={{ display: "grid", gap: spacing.lg, marginTop: spacing.xl }}>
        <p style={{ margin: 0, fontSize: typeScale.body }}>{row.summary}</p>
        <Content live={live} />
        <div style={{ ...sectionStyle }}>
          <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>{sendNote}</p>
          <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
            This link works once and expires at <span suppressHydrationWarning>{new Date(row.expires_at).toLocaleString()}</span>. If the content changes before you decide, it will not approve the new version.
          </p>
          <ApproveButton requestId={row.id} cancelHref={`/prospects/${row.prospect_id}`} />
        </div>
      </div>
    </div>
  );
}
