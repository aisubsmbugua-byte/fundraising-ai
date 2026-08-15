"use client";

import { useState } from "react";

export default function TagInput({
  name,
  defaultValue,
  suggestions,
  placeholder,
}: {
  name: string;
  defaultValue: string[];
  suggestions?: string[];
  placeholder?: string;
}) {
  const [tags, setTags] = useState<string[]>(defaultValue ?? []);
  const [input, setInput] = useState("");
  const datalistId = `${name}-suggestions`;

  function commit() {
    const value = input.trim();
    if (value && !tags.includes(value)) {
      setTags([...tags, value]);
    }
    setInput("");
  }

  return (
    <div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {tags.map((tag) => (
            <span
              key={tag}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "#f1f5f9",
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 13,
              }}
            >
              {tag}
              <button
                type="button"
                onClick={() => setTags(tags.filter((t) => t !== tag))}
                aria-label={`Remove ${tag}`}
                style={{ border: "none", background: "none", cursor: "pointer", color: "#64748b", padding: 0 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        list={suggestions ? datalistId : undefined}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder={placeholder ?? "Type a value, press Enter to add"}
        style={{ width: "100%", padding: 8 }}
      />
      {suggestions && (
        <datalist id={datalistId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {tags.map((tag) => (
        <input key={tag} type="hidden" name={name} value={tag} />
      ))}
    </div>
  );
}
