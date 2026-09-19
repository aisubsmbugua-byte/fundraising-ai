"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { parseRevisitChoice, type RevisitChoice } from "@/lib/prospect-outcomes";

// Ruling 0019's write path. Two actions, deliberately separate.
//
// Recording a decline and deciding whether to return are two different human
// decisions, so they are two different clicks. Folding them into one form would
// put a revisit control in front of somebody who has only been asked "did they
// say no?" -- and whatever that control defaulted to would then be recorded as
// a decision on every decline. The ruling exists to stop exactly that.
//
// Neither action touches `prospects`. Hard rule 2 is unchanged: an outcome does
// not move a prospect through a stage, and every stage transition stays a
// separate, confirmed human action through the existing gate.
//
// Both return their failure rather than throwing it -- Next redacts a thrown
// message in a production build, so a throw here would show the user
// "An error occurred in the Server Components render" and nothing else. See
// docs/decisions/0001-multi-tenancy.md.

export type ActionResult = { error: string } | { success: true };

export async function recordProspectDecline(
  prospectId: string,
  reason: string,
  occurredOn: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const trimmedReason = reason.trim();
    if (!trimmedReason) return { error: "Say why they declined — that is the whole point of keeping the record." };

    // No disposition is written here, by construction. A prospect that has just
    // declined has no disposition row, and deriveCurrentDisposition reports
    // `undecided` for that. There is no value to get wrong because there is no
    // value.
    const { error } = await supabase.from("prospect_outcomes").insert({
      prospect_id: prospectId,
      outcome: "declined",
      reason: trimmedReason,
      occurred_on: occurredOn || new Date().toISOString().slice(0, 10),
      recorded_by: user.id,
    });
    if (error) return { error: error.message };

    revalidateOutcomeSurfaces(prospectId);
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not record that outcome." };
  }
}

// Sets, changes or reverses the revisit disposition. Every call appends a row;
// nothing is edited and nothing is removed, so a `never` and the reversal that
// undid it are both still readable afterwards.
//
// rawChoice is typed `unknown` on purpose. It arrives from a form, and the
// parse is what decides whether it means anything -- an absent, blank or
// non-string value becomes `undecided`, never `never`.
export async function setRevisitDisposition(
  prospectId: string,
  outcomeId: string,
  rawChoice: unknown,
  rawRevisitOn: unknown,
  reason: string,
): Promise<ActionResult> {
  const parsed = parseRevisitChoice(rawChoice, rawRevisitOn);
  if (!parsed.ok) return { error: parsed.error };
  return writeRevisitDisposition(prospectId, outcomeId, parsed.value, reason);
}

// Takes a RevisitChoice, which only parseRevisitChoice can produce. A caller
// cannot reach this with a hand-written { disposition: "never" } -- the type is
// branded with a symbol no other module can name, so tsc rejects it.
async function writeRevisitDisposition(
  prospectId: string,
  outcomeId: string,
  choice: RevisitChoice,
  reason: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const trimmedReason = reason.trim();
    if (choice.disposition === "never" && !trimmedReason) {
      // Ruling 0019: `never` carries its own reason. A permanent close with no
      // stated cause is the thing the ruling calls an invisible loss.
      return { error: "Closing a funder permanently needs a reason." };
    }

    const { error } = await supabase.from("prospect_outcome_dispositions").insert({
      prospect_outcome_id: outcomeId,
      disposition: choice.disposition,
      revisit_on: choice.disposition === "revisit_on" ? choice.revisitOn : null,
      reason: trimmedReason || null,
      decided_by: user.id,
    });
    if (error) return { error: error.message };

    revalidateOutcomeSurfaces(prospectId);
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save that decision." };
  }
}

function revalidateOutcomeSurfaces(prospectId: string) {
  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/revisit");
  revalidatePath("/pipeline");
  revalidatePath("/dashboard");
}
