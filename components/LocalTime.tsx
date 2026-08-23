"use client";

import { useEffect, useState } from "react";

// Same fix as Greeting.tsx, applied to "As of.../Last updated..."
// timestamps: .toLocaleString()/.toLocaleDateString() without an
// explicit timeZone reads the runtime's default zone, which on
// Vercel's serverless functions is UTC, not the visitor's -- so
// formatting server-side showed the wrong time-of-day/date for
// anyone outside UTC. Takes the underlying instant as an ISO string
// (that part was always correct -- Date always stores an absolute
// instant regardless of "timezone") and formats it client-side after
// mount instead, same neutral-fallback-then-hydrate pattern to avoid
// a server/client mismatch.
export default function LocalTime({ iso, mode = "datetime" }: { iso: string; mode?: "datetime" | "date" }) {
  const [formatted, setFormatted] = useState<string | null>(null);

  useEffect(() => {
    const d = new Date(iso);
    setFormatted(mode === "date" ? d.toLocaleDateString() : d.toLocaleString());
  }, [iso, mode]);

  return <>{formatted ?? "…"}</>;
}
