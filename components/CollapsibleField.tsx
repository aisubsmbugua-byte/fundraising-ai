"use client";

import { useState } from "react";
import { fieldStyle, colors, buttonPrimary, buttonSecondary } from "@/lib/ui";

const linkButtonStyle: React.CSSProperties = {
  fontSize: 12,
  background: "none",
  border: "none",
  color: colors.text,
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline",
};

// Shows a ~3-line clamped preview with a "view more" link that opens
// the full text in a modal -- more comfortable to read/edit than an
// inline expand, especially with several of these stacked together.
// Pass onChange to make it editable; omit it for read-only.
export default function CollapsibleField({
  label,
  value,
  onChange,
  previewLines = 3,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  previewLines?: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const editable = !!onChange;

  return (
    <>
      <p
        style={{
          margin: "4px 0",
          fontSize: 14,
          display: "-webkit-box",
          WebkitLineClamp: previewLines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {value || <span style={{ color: colors.textFaint }}>(empty)</span>}
      </p>
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
        style={linkButtonStyle}
      >
        {editable ? "View & edit full text" : "View more"}
      </button>

      {open && (
        <div
          role="presentation"
          onClick={() => setOpen(false)}
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
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: 24,
              maxWidth: 560,
              width: "90%",
              maxHeight: "80vh",
              overflowY: "auto",
              boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
            }}
          >
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>{label}</h3>
            {editable ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={12}
                style={{ ...fieldStyle, marginTop: 0 }}
                autoFocus
              />
            ) : (
              <p style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{value}</p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setOpen(false)} style={buttonSecondary}>
                {editable ? "Cancel" : "Close"}
              </button>
              {editable && (
                <button
                  type="button"
                  onClick={() => {
                    onChange!(draft);
                    setOpen(false);
                  }}
                  style={buttonPrimary}
                >
                  Save
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
