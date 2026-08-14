"use client";

import { useState, useTransition } from "react";
import { STAGES, stageLabel } from "@/lib/prospects";
import { moveProspectStage } from "./actions";

export default function MoveStageControl({
  prospectId,
  prospectName,
  currentStage,
}: {
  prospectId: string;
  prospectName: string;
  currentStage: string;
}) {
  const [target, setTarget] = useState(currentStage);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 4 }}>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{ fontSize: 12, padding: 4, flex: 1 }}
        >
          {STAGES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={isPending || target === currentStage}
          onClick={() => {
            setError(null);
            const ok = confirm(
              `Advance ${prospectName} from ${stageLabel(currentStage)} → ${stageLabel(target)}?`
            );
            if (!ok) return;
            startTransition(async () => {
              try {
                await moveProspectStage(prospectId, currentStage, target);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Failed to move");
              }
            });
          }}
          style={{ fontSize: 12, padding: "4px 8px" }}
        >
          {isPending ? "Moving…" : "Move"}
        </button>
      </div>
      {error && <p style={{ color: "crimson", fontSize: 11, marginTop: 4 }}>{error}</p>}
    </div>
  );
}
