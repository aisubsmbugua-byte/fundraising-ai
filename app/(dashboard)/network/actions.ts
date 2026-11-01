"use server";

// The Network page's write path (STATE item 76, ruling 0033 clauses 1-2).
//
// A connection is the recorder's own note about a person: hand-entered, minimal
// (name, affiliation, how known, strength, notes) and editable and deletable by
// the organization, one at a time or in bulk (ruling 0040 clause 2). There is
// NO contact-detail field -- the system never contacts these people. (A file
// import lives in import-actions.ts.) Deleting a connection deletes every
// path suggestion derived from it (foreign key cascade, migration 0077).
//
// Every action returns its failure rather than throwing it (Next redacts a
// thrown message in a production build).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { isConnectionStrength } from "@/lib/network";
import { NETWORK_DELETE_MAX_IDS, normalizeSearch, parseDeleteIds } from "@/lib/network-list";
import { deleteConnectionsInChunks, loadMatchingConnectionIds } from "@/lib/network-store";

export type ConnectionInput = {
  person_name: string;
  affiliation: string;
  how_known: string;
  strength: string;
  notes: string;
};

type Result = { error: string } | { success: true };

const blankToNull = (v: string) => (v.trim() ? v.trim() : null);

function validate(input: ConnectionInput): { error: string } | null {
  if (!input.person_name.trim()) return { error: "Enter the person's name." };
  // No default: an omitted or unknown strength is refused, never guessed.
  if (!isConnectionStrength(input.strength)) return { error: "Choose how close you are: close, warm or acquaintance." };
  return null;
}

export async function addConnection(input: ConnectionInput): Promise<Result> {
  try {
    const user = await requireUser();
    const invalid = validate(input);
    if (invalid) return invalid;
    const supabase = createClient();
    const { error } = await supabase.from("network_connections").insert({
      // recorded_by comes from the verified session, never from the request.
      recorded_by: user.id,
      person_name: input.person_name.trim(),
      affiliation: blankToNull(input.affiliation),
      how_known: blankToNull(input.how_known),
      strength: input.strength,
      notes: blankToNull(input.notes),
    });
    if (error) return { error: error.message };
    revalidatePath("/network");
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save that person." };
  }
}

export async function updateConnection(id: string, input: ConnectionInput): Promise<Result> {
  try {
    await requireUser();
    const invalid = validate(input);
    if (invalid) return invalid;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("network_connections")
      .update({
        person_name: input.person_name.trim(),
        affiliation: blankToNull(input.affiliation),
        how_known: blankToNull(input.how_known),
        strength: input.strength,
        notes: blankToNull(input.notes),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "That person could not be found." };
    revalidatePath("/network");
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save that change." };
  }
}

export async function deleteConnection(id: string): Promise<Result> {
  try {
    await requireUser();
    const supabase = createClient();
    const { error } = await supabase.from("network_connections").delete().eq("id", id);
    if (error) return { error: error.message };
    revalidatePath("/network");
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not delete that person." };
  }
}

export type BulkDeleteResult = { error: string; deleted?: number; notAttempted?: number } | { success: true; deleted: number };

// Removes the people the caller selected -- by id, never by a filter -- in
// chunks through the session client, and returns how many were actually
// removed. Row-level security scopes the delete to the organization, so an id
// from another organization removes nothing. Path suggestions derived from a
// removed person go with them through the database's foreign key.
export async function deleteConnections(ids: unknown): Promise<BulkDeleteResult> {
  try {
    await requireUser();
    const parsed = parseDeleteIds(ids);
    if ("error" in parsed) return { error: parsed.error };
    const supabase = createClient();
    const result = await deleteConnectionsInChunks(supabase, parsed.ids);
    revalidatePath("/network");
    revalidatePath("/prospects");
    if (result.failure !== null) {
      return {
        error: `${result.deleted} of ${parsed.ids.length} people were removed before an error stopped the removal (${result.failure}). The rest were not removed and nothing after the failed step was attempted.`,
        deleted: result.deleted,
        notAttempted: result.notAttempted,
      };
    }
    return { success: true, deleted: result.deleted };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not remove those people." };
  }
}

// "Select all N matching": the ids of everyone matching the search, read in
// full (past the 1000-row response limit) so the person can confirm exactly
// that many before anything is removed.
export async function getMatchingConnectionIds(search: unknown): Promise<{ error: string } | { ids: string[]; total: number }> {
  try {
    await requireUser();
    const q = normalizeSearch(typeof search === "string" ? search : "");
    const supabase = createClient();
    const found = await loadMatchingConnectionIds(supabase, q);
    if (!found.ok) return { error: "Could not read your network just now." };
    if (found.total > NETWORK_DELETE_MAX_IDS) {
      return { error: `${found.total} people match, and one removal takes at most ${NETWORK_DELETE_MAX_IDS}. Narrow the search, then select again.` };
    }
    return { ids: found.ids, total: found.total };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not read your network just now." };
  }
}
