"use client";

import { useEffect, useState } from "react";
import { colors } from "@/lib/ui";

// Cycles through a sequence of plausible status messages while
// `active` is true, so a long-running AI call has something more
// informative than a static "Loading..." button. Not literally
// synced to real server-side progress -- that needs a persisted run
// row + polling (see the Deep Dive panel, which does this properly
// since that flow is long/complex enough to be worth it). This is
// the lighter-weight version for actions that don't have that
// infrastructure: still reassuring, much cheaper to add everywhere.
export default function LoadingStatus({
  active,
  messages,
  intervalMs = 2500,
}: {
  active: boolean;
  messages: string[];
  intervalMs?: number;
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setIndex((i) => Math.min(i + 1, messages.length - 1));
    }, intervalMs);
    return () => clearInterval(interval);
  }, [active, messages.length, intervalMs]);

  if (!active) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: colors.warning,
          animation: "pulse 1.5s ease-in-out infinite",
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 13, color: colors.textMuted }}>{messages[index]}</span>
    </div>
  );
}
