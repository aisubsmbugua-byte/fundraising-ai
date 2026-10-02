"use client";

import { useTransition } from "react";
import { INTERACTION_KINDS, type InteractionKind } from "@/lib/interactions";
import { spacing, fieldStyle, cardStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

// Shared by the Follow-up page's split view (app/(dashboard)/revisit/
// followup-workspace.tsx), the prospect page's Activity tab
// (app/(dashboard)/prospects/[id]/activity-tab.tsx), and the Supporters page
// (app/(dashboard)/supporters/) -- one form, parameterized by which action it
// logs through, so none of those surfaces can drift apart. STATE item 79
// built this against prospects only; STATE item 80 (ruling 0034) generalized
// it: the form no longer knows what kind of record it's logging against --
// it takes an `onLog` callback and calls that, so a caller supplies
// `logInteraction` bound to a prospect or `logSupporterInteraction` bound to
// a supporter, interchangeably.
export default function LogInteractionForm({
  onLog,
  onDone,
}: {
  onLog: (kind: InteractionKind, summary: string, occurredAt: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          await onLog(
            formData.get("kind") as InteractionKind,
            formData.get("summary") as string,
            (formData.get("occurred_at") as string) || new Date().toISOString().slice(0, 10)
          );
          onDone();
        });
      }}
      style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm, ...cardStyle }}
    >
      <div style={{ display: "flex", gap: spacing.sm }}>
        <select name="kind" defaultValue="email" style={{ ...fieldStyle, marginTop: 0 }}>
          {INTERACTION_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <input type="date" name="occurred_at" defaultValue={new Date().toISOString().slice(0, 10)} style={{ ...fieldStyle, marginTop: 0 }} />
      </div>
      <textarea name="summary" placeholder="What happened?" required rows={2} style={fieldStyle} />
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onDone} style={buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}
