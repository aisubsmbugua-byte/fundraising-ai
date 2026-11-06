// The database side of person identity (STATE item 107 slice A, ruling 0044).
// Every function takes the caller's SESSION client -- never a service-role
// client -- so each read is bounded by the row-level-security policies of
// migrations 0077 and 0083 (hard rule 6). Nothing here names organization_id.
// Importing nothing from Next, the whole file runs offline against a fake client.
//
// Reads that must be COMPLETE page past the database's 1000-row response limit
// with fetchAllRows against an exact count first, so a short read is an error,
// not a smaller network (lib/fetch-all-rows.ts).
//
// Every read here is TOLERANT of a database that has not had migration 0083
// applied: the answer is { ok: false } and the caller says so in plain words.
// Nothing is guessed from a failed read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import type { NetworkIdentityCandidate, LookSubject } from "@/lib/network-identity";
import { chunk } from "@/lib/network-list";

export type IdentityPerson = LookSubject & { id: string; created_at: string };

const PERSON_COLUMNS = "id, person_name, affiliation, title, city, state, do_not_research, identity_status, created_at";

// An exact row count (a head request), optionally narrowed by `apply`, or null
// when it could not be read.
async function headCount(supabase: SupabaseClient, table: string, apply: (q: any) => any = (q) => q): Promise<number | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { count, error } = await apply(supabase.from(table).select("id", { count: "exact", head: true }));
  if (error || typeof count !== "number") return null;
  return count;
}

// A run that finished with nothing to show is a fact ("looked at, no candidates
// found") that must not collapse into "never looked at". It is read from the run
// ledger: the person's most recent FINISHED look (completed or empty) is an
// empty one. A look that later produced candidates, or a reset that cleared
// them, supersedes it by being newer or by the person no longer being
// unconfirmed.
function lookedEmptyFrom(runs: readonly { source_id: string | null; outcome: string | null }[]): Set<string> {
  const latest = new Map<string, string | null>();
  for (const r of runs) if (r.source_id) latest.set(r.source_id, r.outcome);
  const out = new Set<string>();
  for (const [id, outcome] of latest) if (outcome === "empty") out.add(id);
  return out;
}

// EVERYONE recorded, their candidates and which of them were looked at with
// nothing found. Used by the confirmation screen and the "find matches for
// everyone not yet identified" action.
export async function loadIdentityOverview(
  supabase: SupabaseClient
): Promise<
  | { ok: true; people: IdentityPerson[]; candidates: Map<string, NetworkIdentityCandidate[]>; lookedEmpty: Set<string> }
  | { ok: false; reason: "not_set_up" | "unreadable" }
> {
  try {
    const total = await headCount(supabase, "network_connections");
    if (total === null) return { ok: false, reason: "unreadable" };
    // The identity columns are named explicitly: a database without migration
    // 0083 refuses the select, which is how "not set up" is told from "empty".
    const peopleProbe = await supabase.from("network_connections").select(PERSON_COLUMNS).limit(1);
    if (peopleProbe.error) return { ok: false, reason: "not_set_up" };
    const people = await fetchAllRows<IdentityPerson>(
      () => supabase.from("network_connections").select(PERSON_COLUMNS).order("created_at", { ascending: true }).order("id", { ascending: true }) as never,
      total,
      "network people"
    );

    const candidateTotal = await headCount(supabase, "network_identity_candidates");
    if (candidateTotal === null) return { ok: false, reason: "not_set_up" };
    const candidateRows = await fetchAllRows<NetworkIdentityCandidate>(
      () => supabase.from("network_identity_candidates").select("*").order("network_connection_id", { ascending: true }).order("rank", { ascending: true }) as never,
      candidateTotal,
      "identity candidates"
    );
    const candidates = new Map<string, NetworkIdentityCandidate[]>();
    for (const c of candidateRows) {
      const list = candidates.get(c.network_connection_id) ?? [];
      list.push(c);
      candidates.set(c.network_connection_id, list);
    }

    const runTotal = await headCount(supabase, "ai_runs", (q) => q.eq("operation", "network_identity").in("outcome", ["completed", "empty"]));
    if (runTotal === null) return { ok: false, reason: "unreadable" };
    const runs = await fetchAllRows<{ source_id: string | null; outcome: string | null }>(
      () =>
        supabase
          .from("ai_runs")
          .select("source_id, outcome")
          .eq("operation", "network_identity")
          .in("outcome", ["completed", "empty"])
          .order("started_at", { ascending: true })
          .order("id", { ascending: true }) as never,
      runTotal,
      "identity runs"
    );
    return { ok: true, people, candidates, lookedEmpty: lookedEmptyFrom(runs) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

// For one page of the Network list: how many candidates each of these people
// holds and which were looked at with nothing found. { available: false } when
// the identity tables are not there yet.
export async function loadIdentityContext(
  supabase: SupabaseClient,
  ids: readonly string[]
): Promise<{ available: true; candidateCounts: Map<string, number>; lookedEmpty: Set<string> } | { available: false }> {
  if (ids.length === 0) return { available: true, candidateCounts: new Map(), lookedEmpty: new Set() };
  try {
    const candidateCounts = new Map<string, number>();
    const runs: { source_id: string | null; outcome: string | null }[] = [];
    for (const part of chunk(ids, 100)) {
      const c = await supabase.from("network_identity_candidates").select("network_connection_id").in("network_connection_id", part);
      if (c.error) return { available: false };
      for (const row of (c.data ?? []) as { network_connection_id: string }[]) {
        candidateCounts.set(row.network_connection_id, (candidateCounts.get(row.network_connection_id) ?? 0) + 1);
      }
      const r = await supabase
        .from("ai_runs")
        .select("source_id, outcome")
        .eq("operation", "network_identity")
        .in("outcome", ["completed", "empty"])
        .in("source_id", part)
        .order("started_at", { ascending: true });
      if (r.error) return { available: false };
      runs.push(...((r.data ?? []) as { source_id: string | null; outcome: string | null }[]));
    }
    return { available: true, candidateCounts, lookedEmpty: lookedEmptyFrom(runs) };
  } catch {
    return { available: false };
  }
}

export type IdentityCounts = { confirmed: number; noneOfThese: number; doNotResearch: number };

// Exact head counts for the Network page's summary line; null when the identity
// columns are not there yet.
export async function countIdentityStates(supabase: SupabaseClient): Promise<IdentityCounts | null> {
  const eq = (col: string, value: string | boolean) => (q: any) => q.eq(col, value); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [confirmed, noneOfThese, doNotResearch] = await Promise.all([
    headCount(supabase, "network_connections", eq("identity_status", "confirmed")),
    headCount(supabase, "network_connections", eq("identity_status", "none_of_these")),
    headCount(supabase, "network_connections", eq("do_not_research", true)),
  ]);
  if (confirmed === null || noneOfThese === null || doNotResearch === null) return null;
  return { confirmed, noneOfThese, doNotResearch };
}
