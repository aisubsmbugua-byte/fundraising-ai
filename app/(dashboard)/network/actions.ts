"use server";

// The Network page's write path (STATE item 76, ruling 0033 clauses 1-2).
//
// A connection is the recorder's own note about a person: hand-entered, minimal
// (name, affiliation, title, city, state, how known, strength, notes) and
// editable and deletable by the organization, one at a time or in bulk (ruling
// 0040 clause 2, ruling 0044 clause 1). There is NO contact-detail field -- the
// system never contacts these people. (A file import lives in import-actions.ts;
// finding and confirming who a person is lives in identity-actions.ts.)
// Deleting a connection deletes every path suggestion and every identity
// candidate derived from it (foreign key cascade, migrations 0077 and 0083).
//
// Editing the facts a confirmation rests on (name, affiliation, title, city,
// state) voids a confirmed identity and clears the person's candidates: the
// confirmation was of the facts as recorded (ruling 0044 clause 2). This file
// does it with the edit; migration 0083's trigger does it for every other path.
//
// Every action returns its failure rather than throwing it (Next redacts a
// thrown message in a production build).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { isConnectionStrength } from "@/lib/network";
import { IDENTITY_RESET_COLUMNS, identityFactsChanged, type IdentityFacts } from "@/lib/network-identity";
import { NETWORK_CITY_MAX, NETWORK_STATE_MAX, NETWORK_TITLE_MAX } from "@/lib/network-import";
import { NETWORK_DELETE_MAX_IDS, normalizeSearch, parseDeleteIds } from "@/lib/network-list";
import { deleteConnectionsInChunks, loadMatchingConnectionIds } from "@/lib/network-store";

export type ConnectionInput = {
  person_name: string;
  affiliation: string;
  // Ruling 0044 clause 1. Optional text; left undefined by a caller that does
  // not carry them, which on an edit means "leave as it is".
  title?: string;
  city?: string;
  state?: string;
  // A person a human has marked off limits for research (clause 10).
  do_not_research?: boolean;
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
  // Over the cap is refused, never shortened.
  if ((input.title ?? "").trim().length > NETWORK_TITLE_MAX) return { error: `The title is longer than ${NETWORK_TITLE_MAX} characters.` };
  if ((input.city ?? "").trim().length > NETWORK_CITY_MAX) return { error: `The city is longer than ${NETWORK_CITY_MAX} characters.` };
  if ((input.state ?? "").trim().length > NETWORK_STATE_MAX) return { error: `The state is longer than ${NETWORK_STATE_MAX} characters.` };
  return null;
}

// The new person's id comes back so the page can look for their matches (item
// 109). Returning it confers nothing: a look is a separate action, refused in
// code for anyone who may not be looked at.
export type AddResult = { error: string } | { success: true; id: string | null };

export async function addConnection(input: ConnectionInput): Promise<AddResult> {
  try {
    const user = await requireUser();
    const invalid = validate(input);
    if (invalid) return invalid;
    const supabase = createClient();
    const title = blankToNull(input.title ?? "");
    const city = blankToNull(input.city ?? "");
    const state = blankToNull(input.state ?? "");
    const markedOff = input.do_not_research === true;
    const { data: created, error } = await supabase.from("network_connections").insert({
      // recorded_by comes from the verified session, never from the request.
      recorded_by: user.id,
      person_name: input.person_name.trim(),
      affiliation: blankToNull(input.affiliation),
      // The identity facts are written only when there is one to write, so a
      // person with none can still be saved before migration 0083 is applied.
      ...(title || city || state ? { title, city, state } : {}),
      ...(markedOff ? { do_not_research: true } : {}),
      how_known: blankToNull(input.how_known),
      strength: input.strength,
      notes: blankToNull(input.notes),
    }).select("id").single();
    if (error) return { error: error.message };
    revalidatePath("/network");
    return { success: true, id: typeof created?.id === "string" ? created.id : null };
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

    // The person as they are now, so a change to the facts a confirmation rests
    // on can be told from an edit that leaves them alone.
    const found = await supabase.from("network_connections").select("*").eq("id", id).maybeSingle();
    if (found.error) return { error: found.error.message };
    const current = found.data as Record<string, unknown> | null;
    if (!current) return { error: "That person could not be found." };
    const hasIdentity = "identity_status" in current;

    const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const before: IdentityFacts = {
      person_name: text(current.person_name) ?? "",
      affiliation: text(current.affiliation),
      title: text(current.title),
      city: text(current.city),
      state: text(current.state),
    };
    const after: IdentityFacts = {
      person_name: input.person_name.trim(),
      affiliation: blankToNull(input.affiliation),
      // undefined = the caller did not carry the field: leave it as it is.
      title: input.title === undefined ? before.title : blankToNull(input.title),
      city: input.city === undefined ? before.city : blankToNull(input.city),
      state: input.state === undefined ? before.state : blankToNull(input.state),
    };
    const wasConfirmed = hasIdentity && current.identity_status === "confirmed";
    const wasMarkedOff = hasIdentity && current.do_not_research === true;
    const nowMarkedOff = input.do_not_research === undefined ? wasMarkedOff : input.do_not_research === true;
    const markingOff = nowMarkedOff && !wasMarkedOff;
    // A confirmation was of the facts as recorded: editing any of them (or
    // marking the person off limits) voids it.
    const voidsConfirmation = wasConfirmed && (identityFactsChanged(before, after) || markingOff);

    const { data, error } = await supabase
      .from("network_connections")
      .update({
        person_name: after.person_name,
        affiliation: after.affiliation,
        // The identity columns are written only where the database has them or
        // there is something to write.
        ...(hasIdentity || after.title || after.city || after.state ? { title: after.title, city: after.city, state: after.state } : {}),
        ...(hasIdentity && input.do_not_research !== undefined ? { do_not_research: nowMarkedOff } : {}),
        ...(voidsConfirmation ? IDENTITY_RESET_COLUMNS : {}),
        how_known: blankToNull(input.how_known),
        strength: input.strength,
        notes: blankToNull(input.notes),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "That person could not be found." };

    // The candidates of a person whose confirmation was voided, or who was just
    // marked off limits, go with it. (The database's trigger does the same;
    // this keeps the application correct on its own.)
    if (hasIdentity && (voidsConfirmation || markingOff)) {
      const cleared = await supabase.from("network_identity_candidates").delete().eq("network_connection_id", id);
      if (cleared.error) return { error: `The change was saved, but the candidates could not be cleared: ${cleared.error.message}` };
    }
    revalidatePath("/network");
    revalidatePath("/network/identity");
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
    revalidatePath("/network/identity");
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
    revalidatePath("/network/identity");
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
