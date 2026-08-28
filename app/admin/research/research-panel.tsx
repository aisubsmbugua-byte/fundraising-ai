"use client";

import { useState, useTransition } from "react";
import { triggerResearch } from "./actions";
import { fieldStyle, labelStyle, buttonPrimary, spacing, colors } from "@/lib/ui";

type ProspectOption = { id: string; name: string; organization: string | null };

export default function ResearchPanel({
  prospects,
  mostRecentRunByProspect,
}: {
  prospects: ProspectOption[];
  mostRecentRunByProspect: Record<string, string>;
}) {
  const [prospectId, setProspectId] = useState(prospects[0]?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const previousRunId = mostRecentRunByProspect[prospectId] ?? null;

  return (
    <div style={{ marginTop: spacing.lg }}>
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "flex-end" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>Prospect</label>
          <select style={fieldStyle} value={prospectId} onChange={(e) => setProspectId(e.target.value)}>
            {prospects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.organization ? ` (${p.organization})` : ""}
              </option>
            ))}
          </select>
        </div>
        <button
          style={{ ...buttonPrimary, opacity: isPending || !prospectId ? 0.6 : 1, flexShrink: 0 }}
          disabled={isPending || !prospectId}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await triggerResearch(prospectId, previousRunId);
              if ("error" in result) setError(result.error);
            });
          }}
        >
          {isPending ? "Researching..." : previousRunId ? "Retry research" : "Run research"}
        </button>
      </div>
      {isPending && (
        <p style={{ color: colors.textMuted, fontSize: 13, marginTop: spacing.xs }}>
          Web search then extraction -- can take up to ~2 minutes.
        </p>
      )}
      {error && <p style={{ color: colors.danger, fontSize: 13, marginTop: spacing.xs }}>{error}</p>}
    </div>
  );
}
