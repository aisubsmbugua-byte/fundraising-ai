"use client";

import { useState } from "react";
import { fieldStyle, colors } from "@/lib/ui";

// Same Enter-to-add mechanic as TagInput, but rendered as a vertical
// numbered list instead of inline chips -- better suited for longer,
// sentence-length items (e.g. "over 300 worship leaders discipled")
// than short keyword tags.
export default function ListInput({
  name,
  defaultValue,
  placeholder,
}: {
  name: string;
  defaultValue: string[];
  placeholder?: string;
}) {
  const [items, setItems] = useState<string[]>(defaultValue ?? []);
  const [input, setInput] = useState("");

  function commit() {
    const value = input.trim();
    if (value) {
      setItems([...items, value]);
    }
    setInput("");
  }

  return (
    <div>
      {items.length > 0 && (
        <ol style={{ margin: "0 0 8px 0", paddingLeft: 20, display: "grid", gap: 4 }}>
          {items.map((item, i) => (
            <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 14 }}>
              <span style={{ flex: 1 }}>{item}</span>
              <button
                type="button"
                onClick={() => setItems(items.filter((_, idx) => idx !== i))}
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
      {items.map((item, i) => (
        <input key={i} type="hidden" name={name} value={item} />
      ))}
    </div>
  );
}
