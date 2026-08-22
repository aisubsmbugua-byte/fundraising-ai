"use client";

import { useState, useTransition } from "react";
import { DollarSign, Check, X } from "lucide-react";
import { updateAskAmount } from "@/app/(dashboard)/prospects/actions";
import { spacing, colors, radiusSm, sectionStyle } from "@/lib/ui";

// The "Potential" summary tile, but click the value to edit it in
// place -- a single number doesn't need a popover or a trip to the
// full edit form.
export default function EditableAskAmount({ prospectId, askAmount }: { prospectId: string; askAmount: number | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(askAmount != null ? String(askAmount) : "");
  const [isPending, startTransition] = useTransition();

  function startEditing() {
    setValue(askAmount != null ? String(askAmount) : "");
    setEditing(true);
  }

  function save() {
    const trimmed = value.trim();
    const parsed = trimmed ? Number(trimmed) : null;
    if (trimmed && (parsed === null || Number.isNaN(parsed))) return;
    startTransition(async () => {
      await updateAskAmount(prospectId, parsed);
      setEditing(false);
    });
  }

  return (
    <div style={sectionStyle}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: radiusSm,
          background: colors.teal100,
          color: colors.teal700,
        }}
      >
        <DollarSign size={14} />
      </span>
      <div style={{ fontSize: 12, color: colors.textMuted }}>Potential</div>
      {editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
          <input
            type="number"
            min={0}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
            autoFocus
            style={{
              width: "100%",
              minWidth: 0,
              fontSize: 16,
              fontWeight: 700,
              padding: "2px 4px",
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 4,
              boxSizing: "border-box",
            }}
          />
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            title="Save"
            style={{ background: "none", border: "none", color: colors.teal700, cursor: "pointer", padding: 2, flexShrink: 0 }}
          >
            <Check size={16} />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            title="Cancel"
            style={{ background: "none", border: "none", color: colors.textFaint, cursor: "pointer", padding: 2, flexShrink: 0 }}
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={startEditing}
          title="Click to edit"
          style={{
            display: "block",
            fontSize: 18,
            fontWeight: 700,
            marginTop: 2,
            background: "none",
            border: "none",
            padding: 0,
            color: colors.text,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {askAmount != null ? `$${askAmount.toLocaleString("en-US")}` : "—"}
        </button>
      )}
    </div>
  );
}
