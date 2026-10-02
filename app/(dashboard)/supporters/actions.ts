"use server";

// The Supporters page's write path (STATE item 80, ruling 0034). A supporter
// is manually added (no import here -- that's item 81, separate); a gift is
// logged into the append-only gift-history table ONLY (migration 0078 grants
// insert+select, no update, no delete -- there is nothing to revise, a
// correction is a new row); an interaction is logged the same way the
// prospect-side one is, into the supporter's own table.
//
// Every action returns its failure rather than throwing it, matching
// app/(dashboard)/network/actions.ts's convention -- Next redacts a thrown
// message in a production build, so a returned { error } is the only way the
// caller actually sees what went wrong. logSupporterInteraction is the one
// exception: it mirrors logInteraction's (app/(dashboard)/revisit/actions.ts)
// signature and throw-on-error behavior exactly, so the two are
// interchangeable as components/LogInteractionForm.tsx's onLog prop.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import type { InteractionKind } from "@/lib/interactions";
import { SOURCE_TYPES, PLEDGE_FREQUENCIES } from "@/lib/supporters";

type Result = { error: string } | { success: true; id: string };

function blankToNull(raw: FormDataEntryValue | null): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v ? v : null;
}

function numberOrNull(raw: FormDataEntryValue | null): number | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const SOURCE_TYPE_VALUES = SOURCE_TYPES.map((s) => s.value) as readonly string[];
const PLEDGE_FREQUENCY_VALUES = PLEDGE_FREQUENCIES.map((f) => f.value) as readonly string[];

// Manual add. Only name is required; every other field -- contact, how they
// arrived, what they pledged, notes -- is optional, matching ruling 0034's
// minimal shape (no channel, no stage, no EIN, no typical_grant_size).
export async function createSupporter(formData: FormData): Promise<Result> {
  try {
    const user = await requireUser();

    const name = (formData.get("name") as string | null)?.trim();
    if (!name) return { error: "Enter the supporter's name." };

    const sourceType = ((formData.get("source_type") as string | null) || "other").trim();
    if (!SOURCE_TYPE_VALUES.includes(sourceType)) return { error: "Choose how this supporter arrived (event, website, or other)." };

    const pledgedFrequency = blankToNull(formData.get("pledged_frequency"));
    if (pledgedFrequency && !PLEDGE_FREQUENCY_VALUES.includes(pledgedFrequency)) {
      return { error: "Choose a valid pledge frequency (one-time, monthly, or annual)." };
    }

    const pledgedAmount = numberOrNull(formData.get("pledged_amount"));
    if (pledgedAmount != null && pledgedAmount < 0) return { error: "A pledge amount can't be negative." };

    const supabase = createClient();
    const { data, error } = await supabase
      .from("supporters")
      .insert({
        name,
        email: blankToNull(formData.get("email")),
        phone: blankToNull(formData.get("phone")),
        source_type: sourceType,
        source_detail: blankToNull(formData.get("source_detail")),
        pledged_amount: pledgedAmount,
        pledged_frequency: pledgedFrequency,
        notes: blankToNull(formData.get("notes")),
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error || !data) return { error: error?.message ?? "Could not add that supporter." };

    revalidatePath("/supporters");
    revalidatePath("/revisit");
    return { success: true, id: data.id as string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add that supporter." };
  }
}

// Append-only: inserts into supporter_gifts ONLY. There is no
// updateSupporterGift / deleteSupporterGift -- migration 0078 grants the
// table insert and select, nothing else, so a mistaken gift is fixed with a
// correction row, never a silent edit (ruling 0034 clause 2).
export async function logSupporterGift(supporterId: string, amount: number, giftDate: string, note: string | null): Promise<Result> {
  try {
    const user = await requireUser();
    if (!(amount > 0)) return { error: "Enter a gift amount greater than zero." };
    if (!giftDate) return { error: "Enter the date of the gift." };

    const supabase = createClient();
    const { data, error } = await supabase
      .from("supporter_gifts")
      .insert({
        supporter_id: supporterId,
        amount,
        gift_date: giftDate,
        note: note?.trim() || null,
        recorded_by: user.id,
      })
      .select("id")
      .single();
    if (error || !data) return { error: error?.message ?? "Could not log that gift." };

    revalidatePath("/supporters");
    revalidatePath("/revisit");
    return { success: true, id: data.id as string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not log that gift." };
  }
}

// Mirrors logInteraction's signature and throw-on-error behavior exactly
// (app/(dashboard)/revisit/actions.ts) -- same shape, a different table --
// so components/LogInteractionForm.tsx's onLog prop accepts either
// interchangeably, bound to a supporter instead of a prospect.
export async function logSupporterInteraction(supporterId: string, kind: InteractionKind, summary: string, occurredAt: string) {
  const user = await requireUser();
  const supabase = createClient();

  const { error } = await supabase.from("supporter_interactions").insert({
    supporter_id: supporterId,
    kind,
    summary,
    occurred_at: occurredAt,
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/supporters");
  revalidatePath("/revisit");
}
