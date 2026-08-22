"use client";

import { useState, useTransition } from "react";
import { CalendarClock } from "lucide-react";
import { updateNextAction } from "@/app/(dashboard)/prospects/actions";
import { spacing, colors, radiusSm, fieldStyle, labelStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

// A scoped quick-edit for next_action/next_action_due, reused wherever
// a prospect shows up in the pipeline (right rail, board cards, list
// rows) -- "send this to follow-up" shouldn't require leaving the
// board/list to hit the full edit form. stopPropagation everywhere is
// load-bearing: this gets nested inside dnd-kit draggable cards and
// plain Links, and a trigger click must not start a drag or navigate.
export default function NextActionPopover({
  prospectId,
  currentAction,
  currentDue,
  variant = "button",
}: {
  prospectId: string;
  currentAction: string | null;
  currentDue: string | null;
  variant?: "button" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState(currentAction ?? "");
  const [due, setDue] = useState(currentDue ?? "");
  const [isPending, startTransition] = useTransition();

  function openPopover(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setAction(currentAction ?? "");
    setDue(currentDue ?? "");
    setOpen(true);
  }

  function save(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      await updateNextAction(prospectId, action, due);
      setOpen(false);
    });
  }

  function cancel(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  }

  return (
    <div
      style={{ position: "relative", display: "inline-block" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {variant === "button" ? (
        <button type="button" onClick={openPopover} style={buttonSecondary}>
          {currentAction ? "Update" : "Set next action"}
        </button>
      ) : (
        <button
          type="button"
          onClick={openPopover}
          title={currentAction ? "Update next action" : "Set next action"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: `1px solid ${colors.border}`,
            borderRadius: radiusSm,
            background: colors.surface,
            color: colors.navy500,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <CalendarClock size={12} />
        </button>
      )}

      {open && (
        <>
          <div
            role="presentation"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              left: 0,
              width: 260,
              background: "#fff",
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              padding: spacing.md,
              boxShadow: "0 10px 40px rgba(0,0,0,0.15)",
              zIndex: 61,
            }}
          >
            <label style={labelStyle}>
              Next action
              <input
                type="text"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="e.g. Send follow-up email"
                style={fieldStyle}
                autoFocus
              />
            </label>
            <label style={{ ...labelStyle, display: "block", marginTop: spacing.sm }}>
              Due date
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={fieldStyle} />
            </label>
            <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
              <button type="button" disabled={isPending} onClick={save} style={buttonPrimary}>
                {isPending ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={cancel} style={buttonSecondary}>
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
