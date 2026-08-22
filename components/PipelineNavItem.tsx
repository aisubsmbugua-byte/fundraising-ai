"use client";

import { useState } from "react";
import Link from "next/link";
import { radiusSm } from "@/lib/ui";

type StageCount = { value: string; label: string; count: number };

// "Pipeline" itself is the disclosure trigger (clicking the word
// opens the stage list) -- "All Stages" is the first entry inside
// the revealed list, since the word no longer navigates directly.
// The list is a flyout to the right of the sidebar, not an inline
// expansion within the same narrow column -- same backdrop-click-to-
// close pattern as AutoSearchForm/DocumentsModal elsewhere in the app.
export default function PipelineNavItem({ stageCounts }: { stageCounts: StageCount[] }) {
  const [open, setOpen] = useState(false);

  return (
    <li style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          background: open ? "rgba(255,255,255,0.06)" : "none",
          border: "none",
          color: "#cbd5e1",
          cursor: "pointer",
          padding: "7px 10px",
          borderRadius: radiusSm,
          font: "inherit",
          fontSize: 14,
          textAlign: "left",
        }}
      >
        Pipeline
        <span style={{ color: "#94a3b8", fontSize: 11 }}>{open ? "◂" : "▸"}</span>
      </button>
      {open && (
        <>
          <div
            role="presentation"
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
          />
          <ul
            className="pipeline-flyout"
            style={{
              position: "absolute",
              left: "calc(100% + 8px)",
              top: 0,
              listStyle: "none",
              padding: 8,
              margin: 0,
              display: "grid",
              gap: 2,
              width: 180,
              background: "#0b1f3a",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: radiusSm,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              zIndex: 61,
            }}
          >
            <li>
              <Link
                href="/pipeline"
                prefetch={false}
                onClick={() => setOpen(false)}
                style={{ display: "block", color: "#e2e8f0", textDecoration: "none", fontSize: 13, padding: "6px 8px", borderRadius: radiusSm }}
              >
                All Stages
              </Link>
            </li>
            {stageCounts.map((s) => (
              <li key={s.value}>
                <Link
                  href={`/pipeline?stage=${s.value}`}
                  prefetch={false}
                  onClick={() => setOpen(false)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    color: "#94a3b8",
                    textDecoration: "none",
                    fontSize: 13,
                    padding: "6px 8px",
                    borderRadius: radiusSm,
                  }}
                >
                  {s.label}
                  <span>{s.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </li>
  );
}
