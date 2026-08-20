"use client";

import { useState, useTransition } from "react";
import { generateDraft, updateDraft, approveDraft, deleteDraft } from "./draft-actions";
import CollapsibleField from "@/components/CollapsibleField";
import ConfirmDialog from "@/components/ConfirmDialog";
import LoadingStatus from "@/components/LoadingStatus";
import { DRAFT_KINDS, draftKindLabel, type Draft, type DraftKind } from "@/lib/drafts";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, buttonDanger, cardStyle } from "@/lib/ui";

const DRAFT_MESSAGES = [
  "Reading the approved strategy...",
  "Drafting content grounded in the talking points...",
  "Refining tone and structure...",
  "Almost done...",
];

export default function DraftPanel({
  prospectId,
  deepDiveRunId,
  drafts,
}: {
  prospectId: string;
  deepDiveRunId: string;
  drafts: Draft[];
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
        await generateDraft(prospectId, deepDiveRunId, kind);
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
        Draft outreach content based on the approved strategy. Each draft needs explicit approval —
        nothing gets sent automatically, and sending itself isn&apos;t wired up yet.
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
          <DraftCard key={d.id} draft={d} prospectId={prospectId} />
        ))}
        {drafts.length === 0 && <p style={{ color: colors.textFaint, fontSize: 13 }}>No drafts yet.</p>}
      </div>
    </div>
  );
}

function DraftCard({ draft, prospectId }: { draft: Draft; prospectId: string }) {
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [content, setContent] = useState(draft.content);
  const [isPending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isApproved = draft.status === "approved";
  const kindLabel = draftKindLabel(draft.kind);
  const isEmail = draft.kind === "intro_email";

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>{kindLabel}</strong>
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
        <p style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.sm }}>
          ✓ Approved {draft.approved_at ? new Date(draft.approved_at).toLocaleString() : ""} — ready to send
          once sending is set up.
        </p>
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
