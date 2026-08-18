"use client";

import { useState } from "react";
import { fieldStyle, colors } from "@/lib/ui";

const linkButtonStyle: React.CSSProperties = {
  fontSize: 12,
  background: "none",
  border: "none",
  color: colors.text,
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline",
};

// Shows a ~3-line clamped preview with a "view more" toggle instead
// of a fixed-height textarea that internally scrolls and hides most
// of the content. Pass onChange to make it editable when expanded;
// omit it for a read-only expandable paragraph.
export default function CollapsibleField({
  value,
  onChange,
  previewLines = 3,
}: {
  value: string;
  onChange?: (value: string) => void;
  previewLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const editable = !!onChange;

  if (expanded) {
    return (
      <div>
        {editable ? (
          <textarea value={value} onChange={(e) => onChange!(e.target.value)} rows={10} style={fieldStyle} autoFocus />
        ) : (
          <p style={{ margin: "4px 0", fontSize: 14, whiteSpace: "pre-wrap" }}>{value}</p>
        )}
        <button type="button" onClick={() => setExpanded(false)} style={linkButtonStyle}>
          Show less
        </button>
      </div>
    );
  }

  return (
    <div>
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
      <button type="button" onClick={() => setExpanded(true)} style={linkButtonStyle}>
        {editable ? "View & edit full text" : "View more"}
      </button>
    </div>
  );
}
