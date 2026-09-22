"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { generateDraft, generateProposalDraft, generateDeckOutline, composeDraft, updateDraft, approveDraft, deleteDraft, unapproveDraft } from "./draft-actions";
import { sendApprovedDraft } from "./send-actions";
import CollapsibleField from "@/components/CollapsibleField";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import { DRAFT_KINDS, draftKindLabel, type Draft, type DraftKind, type OutreachDraftKind } from "@/lib/drafts";
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
  // Null when no approved strategy exists (STATE item 60). AI drafting
  // stays gated on it exactly as before -- the buttons don't render and
  // generateDraft is never called without one -- but the panel itself now
  // renders regardless, because composing an email by hand needs no
  // strategy. The drafts list and the approve/send flow are identical in
  // both modes.
  strategyRunId: string | null;
  drafts: Draft[];
  sendAttempts: DraftSendAttempt[];
  contactEmail: string | null;
  sender: SenderIdentity;
}) {
  // Tracked per-kind (not a single shared isPending) so clicking one
  // button doesn't show "Drafting..." on both -- each kind runs and
  // reports its own state independently.
  const [pendingKinds, setPendingKinds] = useState<Set<DraftKind>>(new Set());
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleDraft(kind: OutreachDraftKind) {
    if (!strategyRunId) return; // AI drafting requires an approved strategy; the buttons don't render without one.
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

  // The proposal (STATE item 63): same approved-strategy gate as the
  // outreach buttons, its own action (a distinct ai_runs operation), and
  // its refusals come back as data -- shown, not swallowed.
  function handleProposal() {
    if (!strategyRunId) return;
    setProposalError(null);
    setPendingKinds((prev) => new Set(prev).add("proposal"));
    startTransition(async () => {
      try {
        const result = await generateProposalDraft(prospectId, strategyRunId);
        if ("error" in result) setProposalError(result.error);
      } finally {
        setPendingKinds((prev) => {
          const next = new Set(prev);
          next.delete("proposal");
          return next;
        });
      }
    });
  }

  // The deck outline (STATE item 66): same shape as handleProposal --
  // same approved-strategy gate, its own action (a distinct ai_runs
  // operation), refusals shown as data. The approved outline gets its
  // deck view via the link on the draft's card below.
  function handleDeck() {
    if (!strategyRunId) return;
    setDeckError(null);
    setPendingKinds((prev) => new Set(prev).add("deck"));
    startTransition(async () => {
      try {
        const result = await generateDeckOutline(prospectId, strategyRunId);
        if ("error" in result) setDeckError(result.error);
      } finally {
        setPendingKinds((prev) => {
          const next = new Set(prev);
          next.delete("deck");
          return next;
        });
      }
    });
  }

  return (
    <div style={{ marginTop: spacing.xxl }}>
      <h2 style={{ fontSize: 16 }}>Outreach</h2>
      {strategyRunId ? (
        <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
          Draft outreach content based on the approved strategy, or compose an email yourself. Each draft
          needs explicit approval, and nothing gets sent automatically — an approved email goes out only
          when you confirm the exact message on a final review, one click, one message.
        </p>
      ) : (
        <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
          AI drafting unlocks once a strategy is approved, but you can compose an email yourself at any
          time. Each draft needs explicit approval, and nothing gets sent automatically — an approved
          email goes out only when you confirm the exact message on a final review, one click, one
          message.
        </p>
      )}
      {strategyRunId && (
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
          <button
            type="button"
            disabled={pendingKinds.has("proposal")}
            onClick={handleProposal}
            style={buttonSecondary}
          >
            {pendingKinds.has("proposal") ? "Drafting…" : "Draft Grant Proposal"}
          </button>
          <button
            type="button"
            disabled={pendingKinds.has("deck")}
            onClick={handleDeck}
            style={buttonSecondary}
          >
            {pendingKinds.has("deck") ? "Drafting…" : "Draft Deck Outline"}
          </button>
        </div>
      )}
      {proposalError && (
        <p style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{proposalError}</p>
      )}
      {deckError && (
        <p style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{deckError}</p>
      )}
      <LoadingStatus active={pendingKinds.size > 0} messages={DRAFT_MESSAGES} />
      <ComposeSection prospectId={prospectId} />

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

// Human-composed email (STATE item 60): a plain form that saves a draft
// via composeDraft -- no AI call anywhere on this path. The saved draft
// lands in the same list below with the same edit/approve/send flow; this
// section never touches approval or sending.
function ComposeSection({ prospectId }: { prospectId: string }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) {
    return (
      <div style={{ marginTop: spacing.md }}>
        <button type="button" onClick={() => setOpen(true)} style={buttonSecondary}>
          Compose email
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, marginTop: spacing.md }}>
      <strong style={{ fontSize: 14 }}>Compose email</strong>
      <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs }}>
        You are writing this email yourself — no AI involved. Like every draft, it still needs explicit
        approval, and nothing gets sent until you confirm the exact message.
      </p>
      <label style={{ ...labelStyle, display: "block", marginTop: spacing.sm }}>
        Subject
        <input value={subject} onChange={(e) => setSubject(e.target.value)} style={fieldStyle} />
      </label>
      <label style={{ ...labelStyle, display: "block", marginTop: spacing.sm }}>
        Body
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} style={fieldStyle} />
      </label>
      {composeError && (
        <p style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{composeError}</p>
      )}
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await composeDraft(prospectId, subject, content);
              if ("error" in result) {
                setComposeError(result.error);
              } else {
                setComposeError(null);
                setSubject("");
                setContent("");
                setOpen(false);
              }
            })
          }
          style={buttonPrimary}
        >
          {isPending ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setComposeError(null);
          }}
          style={buttonSecondary}
        >
          Cancel
        </button>
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
  // STATE item 68: the un-approve confirm step. Nothing happens on the
  // first click (the ProspectOutcomePanel retraction's expand-then-confirm
  // shape); the consequences are named before the confirming click.
  const [unapproveOpen, setUnapproveOpen] = useState(false);
  // STATE item 67: updateDraft and deleteDraft return their refusals
  // (an approved draft is locked server-side); shown here, not swallowed.
  // The buttons already hide once the card knows the draft is approved,
  // so this only ever shows on a stale card -- but the guard is the
  // server's, and its answer deserves display.
  const [actionError, setActionError] = useState<string | null>(null);
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
        <div style={labelStyle}>
          {isEmail ? "Body" : draft.kind === "proposal" ? "Proposal" : draft.kind === "deck" ? "Outline" : "Notes"}
        </div>
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
                // If the save is refused (already approved server-side),
                // stop: re-approving without the edit would silently
                // re-stamp the approval instead.
                const saved = await updateDraft(draft.id, prospectId, isEmail ? subject : null, content);
                if ("error" in saved) {
                  setActionError(saved.error);
                  return;
                }
                setActionError(null);
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
            onClick={() =>
              startTransition(async () => {
                const saved = await updateDraft(draft.id, prospectId, isEmail ? subject : null, content);
                setActionError("error" in saved ? saved.error : null);
              })
            }
            style={buttonSecondary}
          >
            Save Edits
          </button>
          <button type="button" disabled={isPending} onClick={() => setConfirmDelete(true)} style={buttonDanger}>
            Delete
          </button>
        </div>
      )}
      {actionError && (
        <p style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{actionError}</p>
      )}
      {isApproved && (
        <>
          <p style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.sm }}>
            ✓ Approved {draft.approved_at ? new Date(draft.approved_at).toLocaleString() : ""}
          </p>
          {isEmail && (
            <SendSection draft={draft} prospectId={prospectId} attempts={attempts} contactEmail={contactEmail} sender={sender} />
          )}
          {draft.kind === "deck" && (
            // The deck view renders THIS approved outline deterministically
            // (STATE item 66) -- the link exists only once the outline is
            // approved, and the view itself refuses an unapproved draft too.
            <div style={{ marginTop: spacing.sm }}>
              <Link href={`/prospects/${prospectId}/deck/${draft.id}`} style={buttonSecondary}>
                View deck (print to PDF to export)
              </Link>
            </div>
          )}
          {/* STATE item 68: the way back, for approved UNSENT drafts only.
              A sent or attempted draft never offers it -- the server
              refuses those anyway; this is the honest surface of the same
              rule. Expand-then-confirm: the first click only opens the
              step, and the confirming click names its consequences. */}
          {!isSent && !hasUnconfirmed && (
            <div style={{ marginTop: spacing.sm }}>
              {!unapproveOpen ? (
                <button type="button" disabled={isPending} onClick={() => setUnapproveOpen(true)} style={buttonSecondary}>
                  Un-approve…
                </button>
              ) : (
                <div style={{ ...cardStyle, background: colors.bgSubtle }}>
                  <p style={{ fontSize: 12.5, color: colors.text, margin: 0 }}>
                    Un-approving returns this {kindLabel.toLowerCase()} to a draft: editing and deleting
                    reopen, and the approval record is cleared
                    {draft.kind === "deck"
                      ? " — its deck page stops rendering until it is approved again"
                      : isEmail
                        ? " — it cannot be sent until it is approved again"
                        : ""}
                    . The content itself is not changed or lost.
                  </p>
                  <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.sm }}>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await unapproveDraft(draft.id, prospectId);
                          setActionError("error" in result ? result.error : null);
                          if (!("error" in result)) setUnapproveOpen(false);
                        })
                      }
                      style={buttonDanger}
                    >
                      {isPending ? "Un-approving…" : "Un-approve this draft"}
                    </button>
                    <button type="button" disabled={isPending} onClick={() => setUnapproveOpen(false)} style={buttonSecondary}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
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
          startTransition(async () => {
            const removed = await deleteDraft(draft.id, prospectId);
            setActionError("error" in removed ? removed.error : null);
          });
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
