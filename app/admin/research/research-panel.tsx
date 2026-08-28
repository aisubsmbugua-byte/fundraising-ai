"use client";

import { useState, useTransition } from "react";
import { triggerResearch } from "./actions";
import { fieldStyle, labelStyle, buttonPrimary, spacing, colors } from "@/lib/ui";

type ProspectOption = { id: string; name: string; organization: string | null; stage?: string | null };

type DepthChoice = "auto" | "screen" | "dossier";

export default function ResearchPanel({
  prospects,
  mostRecentRunByProspect,
}: {
  prospects: ProspectOption[];
  mostRecentRunByProspect: Record<string, string>;
}) {
  const [prospectId, setProspectId] = useState(prospects[0]?.id ?? "");
  const [depth, setDepth] = useState<DepthChoice>("auto");
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
        <div style={{ width: 190, flexShrink: 0 }}>
          <label style={labelStyle}>Depth</label>
          <select style={fieldStyle} value={depth} onChange={(e) => setDepth(e.target.value as DepthChoice)}>
            <option value="auto">Auto (by pipeline stage)</option>
            <option value="screen">Screen — search only</option>
            <option value="dossier">Dossier — read pages</option>
          </select>
        </div>
        <button
          style={{ ...buttonPrimary, opacity: isPending || !prospectId ? 0.6 : 1, flexShrink: 0 }}
          disabled={isPending || !prospectId}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await triggerResearch(prospectId, previousRunId, depth === "auto" ? undefined : depth);
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
