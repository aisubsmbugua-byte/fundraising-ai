"use server";

// Importing people from a file (STATE item 103, ruling 0040 clauses 1-3).
//
// The page parses the file in the browser and sends only the MAPPED rows
// (name, affiliation, how known, notes) plus one strength for the whole batch.
// This file treats that request as hostile: it re-validates the strength, the
// shape of every row, the field lengths and the row count itself, and it
// de-duplicates on the server against everyone already recorded (read in full,
// past the 1000-row response limit) as well as within the batch.
//
// Boundaries, stated because they are the point:
//   * the SESSION client only -- never a service-role client -- so row-level
//     security (migration 0077) bounds every read and write;
//   * organization_id is never passed: the column default fills it;
//   * recorded_by is the verified session user, never a value from the request;
//   * no contact-detail field exists to write -- the request shape has exactly
//     four text fields plus the batch strength, and anything else is refused;
//   * the import creates connections and nothing else: it contacts no one.
//
// Counts are returned BY REASON and add up to the rows received; a failure
// part-way says exactly how many went in. Failures are RETURNED, not thrown
// (Next redacts a thrown message in a production build).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { isConnectionStrength } from "@/lib/network";
import { classifyImportRows, countsAddUp, parseImportRequest, type ImportCounts } from "@/lib/network-import";
import { insertConnectionsInChunks, loadConnectionKeys } from "@/lib/network-store";

export type ImportPreviewResult = { error: string } | { success: true; counts: ImportCounts };

export type ImportResult =
  | { error: string; partial?: { imported: number; notAttempted: number; counts: ImportCounts } }
  | { success: true; imported: number; counts: ImportCounts };

// Read-only. Classifies exactly as the real import will -- the same function --
// against everyone already recorded, and writes nothing. Lets the page show,
// before the import runs, how many rows are duplicates of people already here.
export async function previewConnectionImport(rows: unknown, options: unknown): Promise<ImportPreviewResult> {
  try {
    await requireUser();
    const parsed = parseImportRequest(rows, options, false);
    if ("error" in parsed) return { error: parsed.error };
    const supabase = createClient();
    const existing = await loadConnectionKeys(supabase);
    if (!existing.ok) return { error: "Could not read your network just now, so the duplicates could not be checked." };
    const { counts } = classifyImportRows(parsed.rows, existing.keys);
    if (!countsAddUp(counts)) return { error: "The counts did not add up, so nothing is shown." };
    return { success: true, counts };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not check that file." };
  }
}

export async function importConnections(rows: unknown, options: unknown): Promise<ImportResult> {
  try {
    const user = await requireUser();
    // Everything is validated BEFORE any read or write -- the strength first.
    const parsed = parseImportRequest(rows, options, true);
    if ("error" in parsed) return { error: parsed.error };
    const strength = parsed.strength;
    if (!isConnectionStrength(strength)) return { error: "Choose how close you are: close, warm or acquaintance. Nothing was imported." };

    const supabase = createClient();
    const existing = await loadConnectionKeys(supabase);
    if (!existing.ok) return { error: "Could not read your network just now, so nothing was imported." };

    const { toInsert, counts } = classifyImportRows(parsed.rows, existing.keys);
    if (!countsAddUp(counts)) return { error: "The counts did not add up, so nothing was imported." };
    if (toInsert.length === 0) return { success: true, imported: 0, counts };

    const result = await insertConnectionsInChunks(supabase, user.id, toInsert, strength);
    revalidatePath("/network");
    revalidatePath("/prospects");
    if (result.failure !== null) {
      return {
        error: `${result.imported} of ${toInsert.length} people were imported before an error stopped the import (${result.failure}). The rest, ${toInsert.length - result.imported}, were not imported and nothing after the failed step was attempted. Nothing already imported was undone; you can remove those people from the Network page.`,
        partial: { imported: result.imported, notAttempted: result.notAttempted, counts },
      };
    }
    return { success: true, imported: result.imported, counts };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not import that file." };
  }
}
