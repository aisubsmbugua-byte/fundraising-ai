// The database side of the Network (STATE item 103). Every function takes the
// caller's SESSION client -- never a service-role client -- so each read and
// write is bounded by the row-level-security policies of migration 0077
// (hard rule 6). No function here names organization_id: the column default
// my_organization_id() fills it on insert, and the policies scope every read
// and delete. Importing nothing from Next, the whole file runs offline against
// a fake client.
//
// Reads that must be COMPLETE (path-finding, de-duplication) page past the
// database's 1000-row response limit with fetchAllRows and take the exact
// count first, so a short read is an error, not a smaller network.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import type { NetworkConnection, ConnectionStrength } from "@/lib/network";
import { connectionKey, NETWORK_IMPORT_CHUNK_SIZE, type MappedRow } from "@/lib/network-import";
import { chunk, NETWORK_DELETE_CHUNK_SIZE, searchOrFilter } from "@/lib/network-list";

async function exactCount(supabase: SupabaseClient, q: string): Promise<number | null> {
  let query = supabase.from("network_connections").select("id", { count: "exact", head: true });
  const or = searchOrFilter(q);
  if (or) query = query.or(or);
  const { count, error } = await query;
  if (error || typeof count !== "number") return null;
  return count;
}

// The exact number of people recorded (optionally those matching a search), or
// null when the table could not be read.
export const countConnections = exactCount;

// EVERY recorded person, newest-updated first (the order the single read used
// before paging, with id as a tiebreaker so pages are stable), and the exact
// total it was checked against.
export async function loadAllConnections(
  supabase: SupabaseClient
): Promise<{ ok: true; connections: NetworkConnection[]; total: number } | { ok: false }> {
  try {
    const total = await exactCount(supabase, "");
    if (total === null) return { ok: false };
    const connections = await fetchAllRows<NetworkConnection>(
      () => supabase.from("network_connections").select("*").order("updated_at", { ascending: false }).order("id", { ascending: true }) as never,
      total,
      "network connections"
    );
    return { ok: true, connections, total };
  } catch {
    return { ok: false };
  }
}

// The de-duplication keys of everyone already recorded.
export async function loadConnectionKeys(supabase: SupabaseClient): Promise<{ ok: true; keys: Set<string>; total: number } | { ok: false }> {
  try {
    const total = await exactCount(supabase, "");
    if (total === null) return { ok: false };
    const rows = await fetchAllRows<{ person_name: string; affiliation: string | null }>(
      () => supabase.from("network_connections").select("person_name, affiliation").order("id", { ascending: true }) as never,
      total,
      "network connection names"
    );
    return { ok: true, keys: new Set(rows.map((r) => connectionKey(r.person_name, r.affiliation))), total };
  } catch {
    return { ok: false };
  }
}

// The ids of everyone matching a search, for "select all N matching".
export async function loadMatchingConnectionIds(supabase: SupabaseClient, q: string): Promise<{ ok: true; ids: string[]; total: number } | { ok: false }> {
  try {
    const total = await exactCount(supabase, q);
    if (total === null) return { ok: false };
    const or = searchOrFilter(q);
    const rows = await fetchAllRows<{ id: string }>(
      () => {
        let query = supabase.from("network_connections").select("id").order("id", { ascending: true });
        if (or) query = query.or(or);
        return query as never;
      },
      total,
      "matching network connections"
    );
    return { ok: true, ids: rows.map((r) => r.id), total };
  } catch {
    return { ok: false };
  }
}

export type ChunkedInsertResult = {
  imported: number;
  // Rows in chunks that were never attempted because an earlier chunk failed.
  notAttempted: number;
  // Set when a chunk failed; that chunk wrote nothing (one insert statement is atomic).
  failure: string | null;
};

// Inserts in chunks. NOT all-or-nothing across chunks, and it does not claim to
// be: when a chunk fails, the chunks before it stay, the failed chunk wrote
// nothing, and nothing after it is attempted -- and the result says exactly so.
// The row carries recorded_by (the verified session user, passed by the caller)
// and the strength the person chose; organization_id is left to the column default.
export async function insertConnectionsInChunks(
  supabase: SupabaseClient,
  recordedBy: string,
  rows: readonly MappedRow[],
  strength: ConnectionStrength
): Promise<ChunkedInsertResult> {
  let imported = 0;
  const chunks = chunk(rows, NETWORK_IMPORT_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    // Ruling 0044: title, city and state are recorded when the file has them. A
    // chunk with none of them leaves those columns out of the write altogether,
    // so an import of the older shape still works against a database that has
    // not yet had migration 0083 applied; a chunk that has any of them needs the
    // migration and says so (the database's own message) if it is missing.
    const withFacts = chunks[i].some((r) => r.title || r.city || r.state);
    const { error } = await supabase.from("network_connections").insert(
      chunks[i].map((r) => ({
        recorded_by: recordedBy,
        person_name: r.person_name,
        affiliation: r.affiliation,
        ...(withFacts ? { title: r.title, city: r.city, state: r.state } : {}),
        how_known: r.how_known,
        strength,
        notes: r.notes,
      }))
    );
    if (error) {
      const notAttempted = chunks.slice(i + 1).reduce((n, c) => n + c.length, 0);
      return { imported, notAttempted, failure: error.message };
    }
    imported += chunks[i].length;
  }
  return { imported, notAttempted: 0, failure: null };
}

export type ChunkedDeleteResult = { deleted: number; notAttempted: number; failure: string | null };

export async function deleteConnectionsInChunks(supabase: SupabaseClient, ids: readonly string[]): Promise<ChunkedDeleteResult> {
  let deleted = 0;
  const chunks = chunk(ids, NETWORK_DELETE_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    // The cascade to path suggestions is the database's job (migration 0077's
    // foreign key); suggestions are not deleted here.
    const { data, error } = await supabase.from("network_connections").delete().in("id", chunks[i]).select("id");
    if (error) {
      const notAttempted = chunks.slice(i + 1).reduce((n, c) => n + c.length, 0);
      return { deleted, notAttempted, failure: error.message };
    }
    deleted += data?.length ?? 0;
  }
  return { deleted, notAttempted: 0, failure: null };
}
