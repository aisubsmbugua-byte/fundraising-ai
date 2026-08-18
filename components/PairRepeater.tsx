"use client";

import { useState, useRef } from "react";
import { fieldStyle, colors, buttonSecondary } from "@/lib/ui";

// Generic two-field repeater: type into field A (+ optionally field
// B), press Enter in field B (or click Add) to commit the pair as a
// removable list entry. Submits as a single hidden input holding a
// JSON array of {[keyA]: string, [keyB]: string} objects. Used for
// any "list of small structured records" field -- key people
// (name/role), social links (platform/url), etc.
export default function PairRepeater({
  name,
  defaultValue,
  keyA,
  keyB,
  placeholderA,
  placeholderB,
  widthA = 2,
  widthB = 1,
}: {
  name: string;
  defaultValue: Record<string, string>[];
  keyA: string;
  keyB: string;
  placeholderA: string;
  placeholderB: string;
  widthA?: number;
  widthB?: number;
}) {
  const [items, setItems] = useState<Record<string, string>[]>(defaultValue ?? []);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const aRef = useRef<HTMLInputElement>(null);

  function commit() {
    const trimmedA = a.trim();
    if (!trimmedA) return;
    setItems([...items, { [keyA]: trimmedA, [keyB]: b.trim() }]);
    setA("");
    setB("");
    aRef.current?.focus();
  }

  return (
    <div>
      {items.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px 0", display: "grid", gap: 4 }}>
          {items.map((item, i) => (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              <span style={{ flex: 1 }}>
                {item[keyA]}
                {item[keyB] && <span style={{ color: colors.textMuted }}> — {item[keyB]}</span>}
              </span>
              <button
                type="button"
                onClick={() => setItems(items.filter((_, idx) => idx !== i))}
                aria-label={`Remove ${item[keyA]}`}
                style={{ border: "none", background: "none", cursor: "pointer", color: colors.textMuted }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={aRef}
          value={a}
          onChange={(e) => setA(e.target.value)}
          placeholder={placeholderA}
          style={{ ...fieldStyle, marginTop: 0, flex: widthA }}
        />
        <input
          value={b}
          onChange={(e) => setB(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              commit();
            }
          }}
          placeholder={placeholderB}
          style={{ ...fieldStyle, marginTop: 0, flex: widthB }}
        />
        <button type="button" onClick={commit} style={{ ...buttonSecondary, padding: "8px 12px" }}>
          + Add
        </button>
      </div>
      <input type="hidden" name={name} value={JSON.stringify(items)} />
    </div>
  );
}
