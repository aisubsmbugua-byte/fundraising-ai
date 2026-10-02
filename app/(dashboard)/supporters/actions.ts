"use server";

// The Supporters page's write path (STATE item 80, ruling 0034). A supporter
// is manually added or CSV-imported (item 81, ruling 0034 clause 4); a gift
// is logged into the append-only gift-history table ONLY (migration 0078
// grants insert+select, no update, no delete -- there is nothing to revise, a
// correction is a new row); an interaction is logged the same way the
// prospect-side one is, into the supporter's own table.
//
// Every action returns its failure rather than throwing it, matching
// app/(dashboard)/network/actions.ts's convention -- Next redacts a thrown
// message in a production build, so a returned { error } is the only way the
// caller actually sees what went wrong. logSupporterInteraction and
// importSupportersCsv are the exceptions: the former mirrors logInteraction's
// (app/(dashboard)/revisit/actions.ts) signature and throw-on-error behavior
// exactly so the two are interchangeable as components/LogInteractionForm.tsx's
// onLog prop; the latter mirrors importCandidatesCsv's
// (app/(dashboard)/discovery/actions.ts) throw-then-redirect behavior exactly,
// per ruling 0034 clause 4 and STATE item 81.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import type { InteractionKind } from "@/lib/interactions";
import { SOURCE_TYPES, PLEDGE_FREQUENCIES, parseSupporterCsvRow, parseGiftCsvRow, type GiftCsvErrorReason } from "@/lib/supporters";
import { parseCsv } from "@/lib/candidates";

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

// CSV bulk import -- STATE item 81, ruling 0034 clause 4: "the existing
// candidate CSV import (importCandidatesCsv) is the pattern to mirror
// exactly." Mirrored field-for-field in structure against
// app/(dashboard)/discovery/actions.ts's importCandidatesCsv: same parseCsv
// (lib/candidates.ts), same per-row skip-and-count handling, same
// throw-then-redirect flow (not the catch-and-return shape the rest of this
// file uses), same skipped-vs-imported-vs-duplicate counting reported
// separately in the redirect's query string. The per-row validate/dedupe
// rule itself lives in lib/supporters.ts's parseSupporterCsvRow (pure, so
// item 81's required tests can exercise it with no database) -- see that
// function's own comment for the exact field contract and the documented
// invalid-value and duplicate-matching choices.
export async function importSupportersCsv(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) throw new Error("Choose a CSV file to upload");

  const text = await file.text();
  const rows = parseCsv(text);

  // Every existing supporter's name and email, read once -- the same
  // re-upload-safety importCandidatesCsv added for candidates (see its
  // comment at the matching spot): a file re-uploaded after a correction, or
  // listing the same person twice, must not double the list.
  const { data: knownSupporters } = await supabase.from("supporters").select("name, email");
  const known: { name: string; email: string | null }[] = [...(knownSupporters ?? [])];

  const toInsert: Record<string, unknown>[] = [];
  let errorCount = 0;
  let duplicateCount = 0;

  for (const row of rows) {
    // Checked against rows already in the batch as well as rows already in
    // the database, same reasoning as importCandidatesCsv's known-list: a
    // file listing the same supporter twice is the ordinary case, and a
    // batch insert cannot catch that on its own.
    const outcome = parseSupporterCsvRow(row, known);
    if (outcome.kind === "error") {
      errorCount++;
      continue;
    }
    if (outcome.kind === "duplicate") {
      duplicateCount++;
      continue;
    }
    known.push({ name: outcome.supporter.name, email: outcome.supporter.email });
    toInsert.push({ ...outcome.supporter, created_by: user.id });
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("supporters").insert(toInsert);
    if (error) throw new Error(error.message);
  }

  revalidatePath("/supporters");
  // Duplicates reported separately from errors, never blended into one
  // number -- a skipped duplicate is the import working, a row that could
  // not be read or validated is the import failing (ruling 0021's
  // discipline; same comment importCandidatesCsv makes at this exact spot).
  redirect(`/supporters/import?imported=${toInsert.length}&errors=${errorCount}&duplicates=${duplicateCount}`);
}

// Gift-history CSV bulk import -- STATE item 82, ruling 0034 clauses 2 and
// 4. HARD BOUNDARY (stated in the item, restated here): this importer
// creates NO supporters, ever. Every row must match an existing supporter
// already in the organization, or the row is an error, counted and
// reported -- never a silent skip and never a new supporter. Structurally
// mirrors importSupportersCsv immediately above: requireUser (not a raw
// supabase.auth.getUser() call -- that was importSupportersCsv's own
// pre-existing pattern, not repeated here since requireUser is this file's
// documented ordinary bar, see lib/auth.ts), load the organization's current
// supporters once, parse every row against that fixed list with parseCsv
// (lib/candidates.ts, the same utility importSupportersCsv already uses),
// run each row through parseGiftCsvRow (lib/supporters.ts -- pure, no
// database, see its own comment for the exact matching/validation rules),
// and report imported/error counts separately, with every error reason kept
// distinguishable rather than blended into one bucket (ruling 0021).
//
// Insert choice: a SINGLE BATCH INSERT of every "insert" outcome, not one
// logSupporterGift() call per row. Reason: logSupporterGift's own body is
// just one insert call plus the amount/giftDate truthy checks that
// parseGiftCsvRow already performs more precisely (numeric > 0, real
// calendar date) before a row ever reaches this point -- calling it per row
// would re-validate nothing useful while paying N round trips instead of
// one, and importSupportersCsv (immediately above) already established the
// batch-insert-after-full-validation pattern for this exact file. The
// inserted shape is identical to logSupporterGift's: supporter_id, amount,
// gift_date, note, recorded_by -- same four data fields plus recorded_by:
// user.id, and created_at is left to the column default both ways (neither
// logSupporterGift nor this path sets it explicitly), so a batch-imported
// gift is indistinguishable in shape from a manually logged one.
export async function importSupporterGiftsCsv(formData: FormData) {
  const user = await requireUser();
  const supabase = createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) throw new Error("Choose a CSV file to upload");

  const text = await file.text();
  const rows = parseCsv(text);

  // Every existing supporter's id/name/email, read once -- parseGiftCsvRow
  // matches each row against this SAME fixed list for the whole run; a gift
  // CSV never grows the supporter list, so unlike importSupportersCsv there
  // is no "known" list to append to as rows are processed.
  const { data: existingSupporters } = await supabase.from("supporters").select("id, name, email");
  const known: { id: string; name: string; email: string | null }[] = [...(existingSupporters ?? [])];

  const toInsert: { supporter_id: string; amount: number; gift_date: string; note: string | null; recorded_by: string }[] = [];
  const errorsByReason: Record<GiftCsvErrorReason, number> = {
    "no match": 0,
    "ambiguous match": 0,
    "invalid amount": 0,
    "invalid date": 0,
  };

  for (const row of rows) {
    const outcome = parseGiftCsvRow(row, known);
    if (outcome.kind === "error") {
      errorsByReason[outcome.reason]++;
      continue;
    }
    toInsert.push({
      supporter_id: outcome.supporterId,
      amount: outcome.amount,
      gift_date: outcome.giftDate,
      note: outcome.note,
      recorded_by: user.id,
    });
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("supporter_gifts").insert(toInsert);
    if (error) throw new Error(error.message);
  }

  revalidatePath("/supporters");
  revalidatePath("/revisit");
  const errorCount = Object.values(errorsByReason).reduce((a, b) => a + b, 0);
  // Every reason kept distinguishable in the query string too, not blended
  // into the single errors count -- ruling 0021's discipline, same as item
  // 81's duplicates-vs-errors split above, carried one level further here
  // since this importer has four distinct error reasons instead of one.
  redirect(
    `/supporters/import-gifts?imported=${toInsert.length}&errors=${errorCount}` +
      `&noMatch=${errorsByReason["no match"]}` +
      `&ambiguous=${errorsByReason["ambiguous match"]}` +
      `&invalidAmount=${errorsByReason["invalid amount"]}` +
      `&invalidDate=${errorsByReason["invalid date"]}`,
  );
}
