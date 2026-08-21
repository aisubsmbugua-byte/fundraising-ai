"use client";

import { useState } from "react";
import Link from "next/link";

type StageCount = { value: string; label: string; count: number };

// "Pipeline" itself is the disclosure trigger (clicking the word
// toggles the stage list) -- "All Stages" is the first entry inside
// the revealed list, since the word no longer navigates directly.
export default function PipelineNavItem({ stageCounts }: { stageCounts: StageCount[] }) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          background: "none",
          border: "none",
          color: "#cbd5e1",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
          textAlign: "left",
        }}
      >
        Pipeline
        <span style={{ color: "#94a3b8", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul style={{ listStyle: "none", padding: 0, marginTop: 4, marginLeft: 12, display: "grid", gap: 4 }}>
          <li>
            <Link
              href="/pipeline"
              prefetch={false}
              style={{ display: "block", color: "#e2e8f0", textDecoration: "none", fontSize: 13 }}
            >
              All Stages
            </Link>
          </li>
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
