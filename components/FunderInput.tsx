"use client";

import { useState, useRef } from "react";
import { fieldStyle, colors, buttonSecondary } from "@/lib/ui";

export type Funder = { name: string; location: string };

export default function FunderInput({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue: Funder[];
}) {
  const [funders, setFunders] = useState<Funder[]>(defaultValue ?? []);
  const [funderName, setFunderName] = useState("");
  const [location, setLocation] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const trimmedName = funderName.trim();
    if (!trimmedName) return;
    setFunders([...funders, { name: trimmedName, location: location.trim() }]);
    setFunderName("");
    setLocation("");
    nameInputRef.current?.focus();
  }

  return (
    <div>
      {funders.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px 0", display: "grid", gap: 4 }}>
          {funders.map((f, i) => (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              <span style={{ flex: 1 }}>
                {f.name}
                {f.location && <span style={{ color: colors.textMuted }}> — {f.location}</span>}
              </span>
              <button
                type="button"
                onClick={() => setFunders(funders.filter((_, idx) => idx !== i))}
                aria-label={`Remove ${f.name}`}
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
          ref={nameInputRef}
          value={funderName}
          onChange={(e) => setFunderName(e.target.value)}
          placeholder="Funder name"
          style={{ ...fieldStyle, marginTop: 0, flex: 2 }}
        />
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              commit();
            }
          }}
          placeholder="Location (city, state)"
          style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
        />
        <button type="button" onClick={commit} style={{ ...buttonSecondary, padding: "8px 12px" }}>
          + Add
        </button>
      </div>
      <input type="hidden" name={name} value={JSON.stringify(funders)} />
    </div>
  );
}
