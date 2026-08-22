"use client";

import { useTransition } from "react";
import { moveProspectStage } from "@/app/(dashboard)/pipeline/actions";
import { stageLabel } from "@/lib/prospects";
import { buttonPrimary } from "@/lib/ui";

// One-click version of MoveStageControl for the common case (advance
// to the very next stage) -- the full select+Move control is still
// available in Overview for the less common case of jumping stages or
// moving backward.
export default function AdvanceStageButton({
  prospectId,
  currentStage,
  nextStage,
}: {
  prospectId: string;
  currentStage: string;
  nextStage: string;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(() => moveProspectStage(prospectId, currentStage, nextStage))}
      style={buttonPrimary}
    >
      {isPending ? "Moving…" : `Move to ${stageLabel(nextStage)}`}
    </button>
  );
}
