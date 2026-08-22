"use client";

import { useState, useTransition } from "react";
import { updateContact } from "@/app/(dashboard)/prospects/actions";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

export default function ContactPopover({
  prospectId,
  currentName,
  currentEmail,
}: {
  prospectId: string;
  currentName: string | null;
  currentEmail: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName ?? "");
  const [email, setEmail] = useState(currentEmail ?? "");
  const [isPending, startTransition] = useTransition();

  function openPopover() {
    setName(currentName ?? "");
    setEmail(currentEmail ?? "");
    setOpen(true);
  }

  function save() {
    startTransition(async () => {
      await updateContact(prospectId, name, email);
      setOpen(false);
    });
  }

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={openPopover} style={buttonSecondary}>
        {currentName || currentEmail ? "Edit contact" : "Add a contact"}
      </button>

      {open && (
        <>
          <div
            role="presentation"
            onClick={() => setOpen(false)}
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
              Contact name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={fieldStyle} autoFocus />
            </label>
            <label style={{ ...labelStyle, display: "block", marginTop: spacing.sm }}>
              Contact email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={fieldStyle} />
            </label>
            <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
              <button type="button" disabled={isPending} onClick={save} style={buttonPrimary}>
                {isPending ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setOpen(false)} style={buttonSecondary}>
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
