"use client";

import { useState, useRef } from "react";
import { fieldStyle, colors, buttonSecondary } from "@/lib/ui";

export type PersonEntry = { name: string; role: string; phone: string };

// Three-field repeater for Key People specifically (name/role/phone)
// -- diverged from the generic PairRepeater once phone was needed,
// since none of PairRepeater's other uses (funders, social links)
// need a third field.
export default function PersonInput({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue: PersonEntry[];
}) {
  const [people, setPeople] = useState<PersonEntry[]>(defaultValue ?? []);
  const [personName, setPersonName] = useState("");
  const [role, setRole] = useState("");
  const [phone, setPhone] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const trimmedName = personName.trim();
    if (!trimmedName) return;
    setPeople([...people, { name: trimmedName, role: role.trim(), phone: phone.trim() }]);
    setPersonName("");
    setRole("");
    setPhone("");
    nameInputRef.current?.focus();
  }

  return (
    <div>
      {people.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px 0", display: "grid", gap: 4 }}>
          {people.map((p, i) => (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              <span style={{ flex: 1 }}>
                {p.name}
                {p.role && <span style={{ color: colors.textMuted }}> — {p.role}</span>}
                {p.phone && <span style={{ color: colors.textMuted }}> · {p.phone}</span>}
              </span>
              <button
                type="button"
                onClick={() => setPeople(people.filter((_, idx) => idx !== i))}
                aria-label={`Remove ${p.name}`}
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
          value={personName}
          onChange={(e) => setPersonName(e.target.value)}
          placeholder="Full name"
          style={{ ...fieldStyle, marginTop: 0, flex: 2 }}
        />
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Title / role"
          style={{ ...fieldStyle, marginTop: 0, flex: 2 }}
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              commit();
            }
          }}
          placeholder="Phone (optional)"
          style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
        />
        <button type="button" onClick={commit} style={{ ...buttonSecondary, padding: "8px 12px" }}>
          + Add
        </button>
      </div>
      <input type="hidden" name={name} value={JSON.stringify(people)} />
    </div>
  );
}
