"use client";

import { useState } from "react";
import Link from "next/link";

type StageCount = { value: string; label: string; count: number };

// The chevron toggles the stage sublist open/closed; the "Pipeline"
// label itself is a separate link to the unfiltered board, so
// clicking it doesn't fight with expanding the list.
export default function PipelineNavItem({ stageCounts }: { stageCounts: StageCount[] }) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/pipeline" prefetch={false} style={{ color: "#cbd5e1", textDecoration: "none" }}>
          Pipeline
        </Link>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Collapse pipeline stages" : "Expand pipeline stages"}
          style={{
            background: "none",
            border: "none",
            color: "#94a3b8",
            cursor: "pointer",
            padding: 4,
            fontSize: 11,
          }}
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open && (
        <ul style={{ listStyle: "none", padding: 0, marginTop: 4, marginLeft: 12, display: "grid", gap: 4 }}>
          {stageCounts.map((s) => (
            <li key={s.value}>
              <Link
                href={`/pipeline?stage=${s.value}`}
                prefetch={false}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  color: "#94a3b8",
                  textDecoration: "none",
                  fontSize: 13,
                }}
              >
                {s.label}
                <span>{s.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
