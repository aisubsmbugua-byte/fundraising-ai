"use client";

import { useState } from "react";
import { fieldStyle, colors } from "@/lib/ui";

// Same Enter-to-add list UX as ListInput, but a controlled component
// (value/onChange) for use outside a <form>/FormData context -- e.g.
// panels that call server actions directly with a built object
// rather than submitting form fields.
export default function ControlledListInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function commit() {
    const trimmed = input.trim();
    if (trimmed) {
      onChange([...value, trimmed]);
    }
    setInput("");
  }

  return (
    <div>
      {value.length > 0 && (
        <ol style={{ margin: "0 0 8px 0", paddingLeft: 20, display: "grid", gap: 4 }}>
          {value.map((item, i) => (
            <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 14 }}>
              <span style={{ flex: 1 }}>{item}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                aria-label={`Remove item ${i + 1}`}
                style={{ border: "none", background: "none", cursor: "pointer", color: colors.textMuted }}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            commit();
          }
        }}
        onBlur={commit}
        placeholder={placeholder ?? "Type an item, press Enter to add"}
        style={{ ...fieldStyle, marginTop: 0 }}
      />
    </div>
  );
}
