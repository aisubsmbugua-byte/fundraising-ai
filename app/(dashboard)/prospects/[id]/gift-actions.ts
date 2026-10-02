"use server";

// A prospect's giving-history write path -- STATE item 83, ruling 0035. The
// institutional-funder half of the gift ledger ruling 0034 already settled
// for supporters (logSupporterGift, app/(dashboard)/supporters/actions.ts):
// append-only, inserts into prospect_gifts ONLY. There is no
// updateProspectGift / deleteProspectGift -- migration 0079 grants the table
// insert and select, nothing else, so a mistaken gift is fixed with a
// correction row, never a silent edit (ruling 0035 clause 1).
//
// Lives alongside this prospect's other single-entry, id-scoped actions
// (outcome-actions.ts, network-actions.ts) rather than in the top-level
// app/(dashboard)/prospects/actions.ts, matching that file's own convention:
// a capability that always acts on one already-open prospect gets its own
// file here; a capability that spans many prospects at once (the bulk CSV
// importer, STATE item 83's other half) stays in the top-level file, where
// createProspect/updateProspect/deleteProspect already live.
//
// Returns its failure rather than throwing it, matching outcome-actions.ts's
// own convention immediately above it in this directory -- Next redacts a
// thrown message in a production build, so a returned { error } is the only
// way the caller actually sees what went wrong.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";

type Result = { error: string } | { success: true; id: string };

export async function logProspectGift(
  prospectId: string,
  amount: number,
  giftDate: string,
  note: string | null,
): Promise<Result> {
  try {
    const user = await requireUser();
    if (!(amount > 0)) return { error: "Enter a gift amount greater than zero." };
    if (!giftDate) return { error: "Enter the date of the gift." };

    const supabase = createClient();
    const { data, error } = await supabase
      .from("prospect_gifts")
      .insert({
        prospect_id: prospectId,
        amount,
        gift_date: giftDate,
        note: note?.trim() || null,
        recorded_by: user.id,
      })
      .select("id")
      .single();
    if (error || !data) return { error: error?.message ?? "Could not log that gift." };

    revalidatePath(`/prospects/${prospectId}`);
    revalidatePath("/pipeline");
    return { success: true, id: data.id as string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not log that gift." };
  }
}
