"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { deleteOrganization } from "./actions";
import { spacing, colors, radiusSm, fieldStyle, labelStyle, buttonSecondary, buttonDanger } from "@/lib/ui";

const CONFIRM_WORD = "DELETE";

// Type-to-confirm instead of a plain confirm() dialog -- this
// permanently removes an organization and its members' accounts, so a
// single accidental click shouldn't be enough (same reasoning as
// GitHub's "type the repo name" pattern). Same backdrop-click-to-close
// popover shell already used elsewhere in the app (e.g.
// NextActionPopover), not a new pattern.
export default function DeleteOrgButton({ organizationId, name }: { organizationId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setConfirmText("");
    setError(null);
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        title="Delete organization"
        onClick={() => setOpen(true)}
        style={{ ...buttonSecondary, padding: "6px 8px", color: colors.red600 }}
      >
        <Trash2 size={14} />
      </button>

      {open && (
        <>
          <div role="presentation" onClick={close} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              width: 280,
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: radiusSm,
              padding: spacing.md,
              boxShadow: "0 10px 40px rgba(0,0,0,0.15)",
              zIndex: 61,
            }}
          >
            <p style={{ fontSize: 13, margin: 0 }}>
              Delete <strong>{name}</strong>? This can&apos;t be undone, and only works if the organization has no
              data in it yet.
            </p>
            <label style={{ ...labelStyle, display: "block", marginTop: spacing.sm }}>
              Type {CONFIRM_WORD} to confirm
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoFocus
                style={fieldStyle}
              />
            </label>
            <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
              <button
                type="button"
                disabled={isPending || confirmText !== CONFIRM_WORD}
                onClick={() =>
                  startTransition(async () => {
                    const result = await deleteOrganization(organizationId);
                    if ("error" in result) setError(result.error);
                    else close();
                  })
                }
                style={{ ...buttonDanger, opacity: confirmText !== CONFIRM_WORD ? 0.5 : 1 }}
              >
                {isPending ? "Deleting…" : "Delete"}
              </button>
              <button type="button" onClick={close} style={buttonSecondary}>
                Cancel
              </button>
            </div>
            {error && <p style={{ color: colors.red600, fontSize: 12, marginTop: spacing.sm }}>{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
