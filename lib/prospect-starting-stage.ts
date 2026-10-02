// STATE item 79: a human adding an existing relationship should not have it
// start as a cold lead. This is deliberately a separate module from
// fieldsFromForm (app/(dashboard)/prospects/actions.ts) rather than a field
// added to it -- fieldsFromForm is shared with updateProspect, whose edit
// form carries no stage input at all, so folding stage-reading logic in
// there would make every ordinary edit either silently reset a prospect's
// stage to Discovery or null it out. Keeping this pure and separate also
// makes it testable without a database (scripts/test-prospect-starting-stage.ts).

import { STAGES, type Stage } from "@/lib/prospects";

// What the New Prospect form submitted, resolved to a real stage. Anything
// that isn't one of the six values the pipeline board already uses --
// missing, empty, or garbled -- falls back to 'discovery', so a submission
// that never saw this field (there is none today, but any future caller
// that omits it) reproduces today's behavior exactly.
export function resolveStartingStage(
  submittedStage: string | null | undefined,
  submittedReason: string | null | undefined
): { stage: Stage; reason: string | null } {
  const stage = STAGES.some((s) => s.value === submittedStage) ? (submittedStage as Stage) : "discovery";
  const reason = submittedReason?.trim() || null;
  return { stage, reason };
}

export type StartingStageChangeInsert = {
  prospect_id: string;
  from_stage: Stage;
  to_stage: Stage;
  changed_by: string;
  changed_by_email: string | undefined;
  note: string;
};

// The one backfill row a non-Discovery creation writes, in the exact column
// shape moveProspectStage (app/(dashboard)/pipeline/actions.ts) writes to
// stage_changes -- from_stage = to_stage because this is not a move, it is
// making a starting point visible in the audit trail rather than
// indistinguishable from a prospect nobody has ever looked at. Returns null
// for Discovery: that path must leave stage_changes untouched, byte-identical
// to createProspect's behavior before this item.
export function buildStartingStageChange(
  prospectId: string,
  stage: Stage,
  reason: string | null,
  userId: string,
  userEmail: string | undefined
): StartingStageChangeInsert | null {
  if (stage === "discovery") return null;
  return {
    prospect_id: prospectId,
    from_stage: stage,
    to_stage: stage,
    changed_by: userId,
    changed_by_email: userEmail,
    note: reason || "Added directly at this stage",
  };
}
