"use client";

import { useState, useTransition } from "react";
import { generateDraft, updateDraft, approveDraft, deleteDraft } from "./draft-actions";
import { sendApprovedDraft } from "./send-actions";
import CollapsibleField from "@/components/CollapsibleField";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import { DRAFT_KINDS, draftKindLabel, type Draft, type DraftKind } from "@/lib/drafts";
import { evaluateSendReadiness, type DraftSendAttempt, type SendPayload, type SenderIdentity } from "@/lib/draft-send";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, buttonDanger, cardStyle, chipStyle, radiusSm, shadow } from "@/lib/ui";

const DRAFT_MESSAGES = [
  "Reading the approved strategy...",
  "Drafting content grounded in the talking points...",
  "Refining tone and structure...",
  "Almost done...",
];

export default function DraftPanel({
  prospectId,
  strategyRunId,
  drafts,
  sendAttempts,
  contactEmail,
  sender,
}: {
  prospectId: string;
  strategyRunId: string;
  drafts: Draft[];
  sendAttempts: DraftSendAttempt[];
  contactEmail: string | null;
  sender: SenderIdentity;
}) {
  // Tracked per-kind (not a single shared isPending) so clicking one
  // button doesn't show "Drafting..." on both -- each kind runs and
  // reports its own state independently.
  const [pendingKinds, setPendingKinds] = useState<Set<DraftKind>>(new Set());
  const [, startTransition] = useTransition();

  function handleDraft(kind: DraftKind) {
    setPendingKinds((prev) => new Set(prev).add(kind));
    startTransition(async () => {
      try {
        await generateDraft(prospectId, strategyRunId, kind);
      } finally {
        setPendingKinds((prev) => {
          const next = new Set(prev);
          next.delete(kind);
          return next;
        });
      }
    });
  }

  return (
    <div style={{ marginTop: spacing.xxl }}>
      <h2 style={{ fontSize: 16 }}>Outreach</h2>
      <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
        Draft outreach content based on the approved strategy. Each draft needs explicit approval, and
        nothing gets sent automatically — an approved email goes out only when you confirm the exact
        message on a final review, one click, one message.
      </p>
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
        {DRAFT_KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            disabled={pendingKinds.has(k.value)}
            onClick={() => handleDraft(k.value)}
            style={buttonSecondary}
          >
            {pendingKinds.has(k.value) ? "Drafting…" : `Draft ${k.label}`}
          </button>
        ))}
      </div>
      <LoadingStatus active={pendingKinds.size > 0} messages={DRAFT_MESSAGES} />

      <div style={{ display: "grid", gap: spacing.md, marginTop: spacing.lg }}>
        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            prospectId={prospectId}
            attempts={sendAttempts.filter((a) => a.draft_id === d.id)}
            contactEmail={contactEmail}
            sender={sender}
          />
        ))}
        {drafts.length === 0 && <p style={{ color: colors.textFaint, fontSize: 13 }}>No drafts yet.</p>}
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  prospectId,
  attempts,
  contactEmail,
  sender,
}: {
  draft: Draft;
  prospectId: string;
  attempts: DraftSendAttempt[];
  contactEmail: string | null;
  sender: SenderIdentity;
}) {
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [content, setContent] = useState(draft.content);
  const [isPending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isApproved = draft.status === "approved";
  const kindLabel = draftKindLabel(draft.kind);
  const isEmail = draft.kind === "intro_email";

  const sentAttempt = attempts.find((a) => a.outcome === "sent") ?? null;
  const isSent = Boolean(draft.sent_at) || sentAttempt !== null;
  const hasUnconfirmed = attempts.some((a) => a.outcome === null);

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>{kindLabel}</strong>
        {isSent ? (
          <span style={chipStyle("teal")}>Sent</span>
        ) : hasUnconfirmed ? (
          <span style={chipStyle("amber")}>Send unconfirmed</span>
        ) : (
          <span
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 4,
              background: isApproved ? "#dcfce7" : "#f1f5f9",
              color: isApproved ? "#166534" : colors.textMuted,
            }}
          >
            {isApproved ? "Approved" : "Draft"}
          </span>
        )}
      </div>

      {isEmail && (
        <label style={{ ...labelStyle, display: "block", marginTop: spacing.sm }}>
          Subject
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={isApproved}
            style={fieldStyle}
          />
        </label>
      )}

      <div style={{ marginTop: spacing.sm }}>
        <div style={labelStyle}>{isEmail ? "Body" : "Notes"}</div>
        <CollapsibleField
          label={kindLabel}
          value={content}
          onChange={isApproved ? undefined : setContent}
          previewLines={4}
        />
      </div>

      {!isApproved && (
        <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                await updateDraft(draft.id, prospectId, isEmail ? subject : null, content);
                await approveDraft(draft.id, prospectId);
              })
            }
            style={buttonPrimary}
          >
            {isPending ? "Saving…" : "Approve"}
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => startTransition(() => updateDraft(draft.id, prospectId, isEmail ? subject : null, content))}
            style={buttonSecondary}
          >
            Save Edits
          </button>
          <button type="button" disabled={isPending} onClick={() => setConfirmDelete(true)} style={buttonDanger}>
            Delete
          </button>
        </div>
      )}
      {isApproved && (
        <>
          <p style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.sm }}>
            ✓ Approved {draft.approved_at ? new Date(draft.approved_at).toLocaleString() : ""}
          </p>
          {isEmail && (
            <SendSection draft={draft} prospectId={prospectId} attempts={attempts} contactEmail={contactEmail} sender={sender} />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete draft"
        message={`Delete this ${kindLabel.toLowerCase()} draft? This can't be undone.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          startTransition(() => deleteDraft(draft.id, prospectId));
        }}
      />
    </div>
  );
}

// The send gate (ruling 0029). What the confirmation displays is the SAME
// payload the handler will send: both come from evaluateSendReadiness on
// the same stored draft + contact email -- there is no second place a
// recipient, subject or body could be assembled. The handler re-runs the
// same evaluation server-side at send time, so this section deciding to
// offer the button never decides anything by itself.
function SendSection({
  draft,
  prospectId,
  attempts,
  contactEmail,
  sender,
}: {
  draft: Draft;
  prospectId: string;
  attempts: DraftSendAttempt[];
  contactEmail: string | null;
  sender: SenderIdentity;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  const [isSending, startSending] = useTransition();

  const sentAttempt = attempts.find((a) => a.outcome === "sent") ?? null;
  const unconfirmedAttempt = attempts.find((a) => a.outcome === null) ?? null;
  const failedAttempts = attempts.filter((a) => a.outcome === "failed");
  const lastFailed =
    failedAttempts.length > 0
      ? [...failedAttempts].sort((a, b) => b.attempted_at.localeCompare(a.attempted_at))[0]
      : null;

  // Already sent: show the captured facts (recipient from the attempt row,
  // never re-derived from the prospect, which may have changed since).
  if (draft.sent_at || sentAttempt) {
    return (
      <p style={{ fontSize: 12, color: colors.success, marginTop: spacing.sm }}>
        Sent{sentAttempt ? ` to ${sentAttempt.recipient_email}` : ""}
        {draft.sent_at ? ` on ${new Date(draft.sent_at).toLocaleString()}` : sentAttempt?.completed_at ? ` on ${new Date(sentAttempt.completed_at).toLocaleString()}` : ""}
        . Logged to the interaction timeline. Sending again requires a new draft.
      </p>
    );
  }

  if (unconfirmedAttempt) {
    return (
      <p style={{ fontSize: 12, color: colors.warning, marginTop: spacing.sm }}>
        A send was attempted on {new Date(unconfirmedAttempt.attempted_at).toLocaleString()} and the provider
        never confirmed the outcome — the email to {unconfirmedAttempt.recipient_email} may or may not have
        been delivered. This draft is locked against re-sending; if the message must go out, create a new
        draft.
      </p>
    );
  }

  const readiness = evaluateSendReadiness(draft, attempts, contactEmail, sender);

  return (
    <div style={{ marginTop: spacing.sm }}>
      {lastFailed && (
        <p style={{ fontSize: 12, color: colors.danger, marginBottom: spacing.xs }}>
          A previous send failed and nothing was delivered
          {lastFailed.error_note ? `: ${lastFailed.error_note}` : "."} You can confirm a new send below.
        </p>
      )}
      {readiness.ok ? (
        <button type="button" disabled={isSending} onClick={() => { setSendError(null); setConfirmOpen(true); }} style={buttonPrimary}>
          {isSending ? "Sending…" : "Send…"}
        </button>
      ) : (
        <p style={{ fontSize: 12, color: colors.textMuted }}>{readiness.reason}</p>
      )}
      {sendError && <p style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{sendError}</p>}
      {sendWarning && <p style={{ fontSize: 12, color: colors.warning, marginTop: spacing.xs }}>{sendWarning}</p>}
      {readiness.ok && (
        <SendConfirmDialog
          open={confirmOpen}
          payload={readiness.payload}
          busy={isSending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            startSending(async () => {
              const result = await sendApprovedDraft(draft.id, prospectId);
              setConfirmOpen(false);
              if ("error" in result) {
                setSendError(result.error);
              } else {
                setSendError(null);
                setSendWarning(result.warning ?? null);
              }
            });
          }}
        />
      )}
    </div>
  );
}

// A final review of the exact message, not a generic "are you sure":
// from identity, reply-to, recipient, subject and body are the payload
// itself (ruling 0029 clause 2 -- the confirmation displays what will be
// sent, extended to the sender identity by STATE item 57). Wider than
// ConfirmDialog because the body must be readable, but the same
// overlay-and-card shape.
function SendConfirmDialog({
  open,
  payload,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  payload: SendPayload;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={busy ? undefined : onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: colors.surface,
          borderRadius: radiusSm,
          padding: spacing.xl,
          maxWidth: 560,
          width: "92%",
          maxHeight: "85vh",
          overflowY: "auto",
          boxShadow: shadow.dialog,
          boxSizing: "border-box",
        }}
      >
        <h3 style={{ marginBottom: spacing.xs, fontSize: 16 }}>Send this email?</h3>
        <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: spacing.md }}>
          This is exactly what will be sent — one message, to one recipient, right now. It cannot be
          unsent, and this draft can never be sent again.
        </p>
        <div style={{ display: "grid", gap: spacing.sm }}>
          <div>
            <div style={labelStyle}>From</div>
            <div style={{ fontSize: 14 }}>{payload.from}</div>
          </div>
          <div>
            <div style={labelStyle}>Replies go to</div>
            <div style={{ fontSize: 14 }}>{payload.replyTo}</div>
          </div>
          <div>
            <div style={labelStyle}>To</div>
            <div style={{ fontSize: 14 }}>{payload.to}</div>
          </div>
          <div>
            <div style={labelStyle}>Subject</div>
            <div style={{ fontSize: 14 }}>{payload.subject}</div>
          </div>
          <div>
            <div style={labelStyle}>Body</div>
            <div
              style={{
                fontSize: 13,
                whiteSpace: "pre-wrap",
                border: `1px solid ${colors.border}`,
                borderRadius: radiusSm,
                padding: spacing.sm,
                background: colors.bgSubtle,
                maxHeight: 280,
                overflowY: "auto",
              }}
            >
              {payload.body}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.lg }}>
          <button type="button" onClick={onCancel} disabled={busy} style={buttonSecondary}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} style={buttonPrimary}>
            {busy ? "Sending…" : `Send to ${payload.to}`}
          </button>
        </div>
      </div>
    </div>
  );
}
