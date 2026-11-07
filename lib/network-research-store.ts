// The database side of researching a confirmed person (STATE item 112, ruling
// 0044). Every function takes the caller's SESSION client -- never a service-role
// client -- so each read is bounded by the row-level-security policies of
// migrations 0083 and 0085 (hard rule 6). Nothing here names organization_id.
// Importing nothing from Next, the whole file runs offline against a fake client.
//
// Reads that must be COMPLETE page past the database's 1000-row response limit
// with fetchAllRows against an exact count first, so a short read is an error, not
// a smaller network (lib/fetch-all-rows.ts).
//
// Every read here is TOLERANT of a database that has not had migration 0085
// applied: the answer is { ok: false } and the caller says so in plain words.
// Nothing is guessed from a failed read. READ-ONLY: nothing here writes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { chunk } from "@/lib/network-list";
import { planResearchQueue, researchedAtFrom, type ResearchPlan, type StoredFinding } from "@/lib/network-research";

export type ResearchPerson = {
  id: string;
  person_name: string;
  affiliation: string | null;
  title: string | null;
  city: string | null;
  state: string | null;
  do_not_research: boolean;
  identity_status: string;
  identity_decided_at: string | null;
  identity_candidate_id: string | null;
  created_at: string;
};

export const RESEARCH_PERSON_COLUMNS =
  "id, person_name, affiliation, title, city, state, do_not_research, identity_status, identity_decided_at, identity_candidate_id, created_at";

const FINISHED = ["completed", "empty"];

// An exact row count (a head request), optionally narrowed by `apply`, or null
// when it could not be read.
async function headCount(supabase: SupabaseClient, table: string, apply: (q: any) => any = (q) => q): Promise<number | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { count, error } = await apply(supabase.from(table).select("id", { count: "exact", head: true }));
  if (error || typeof count !== "number") return null;
  return count;
}

// Is the findings table there (migration 0085 applied) and readable? Asked BEFORE
// a ledger run is born, so no AI run is spent for findings that could not be saved.
export async function findingsTableReadable(supabase: SupabaseClient): Promise<boolean> {
  try {
    return (await headCount(supabase, "network_person_findings")) !== null;
  } catch {
    return false;
  }
}

// When one person's CURRENT identity was last researched (see researchedAtFrom), or
// null when never; undefined when the ledger could not be read.
export async function loadResearchedAt(supabase: SupabaseClient, personId: string, decidedAt: string | null): Promise<string | null | undefined> {
  try {
    const { data, error } = await supabase
      .from("ai_runs")
      .select("outcome, ended_at")
      .eq("operation", "network_research")
      .eq("source_id", personId)
      .in("outcome", FINISHED);
    if (error) return undefined;
    return researchedAtFrom((data ?? []) as { outcome: string | null; ended_at: string | null }[], decidedAt);
  } catch {
    return undefined;
  }
}

// Everyone whose identity is CONFIRMED (the plan then sets aside anyone marked do
// not research), and when each was last researched. Used for the count on "Research your network" and for the queue a
// click works through.
export async function loadResearchOverview(
  supabase: SupabaseClient
): Promise<
  | { ok: true; people: ResearchPerson[]; researchedAt: Map<string, string>; plan: ResearchPlan<ResearchPerson> }
  | { ok: false; reason: "not_set_up" | "unreadable" }
> {
  try {
    if (!(await findingsTableReadable(supabase))) return { ok: false, reason: "not_set_up" };
    // Only people whose identity a human has confirmed can be researched, so only
    // they are read (an exact count first, so a short read is an error).
    const total = await headCount(supabase, "network_connections", (q) => q.eq("identity_status", "confirmed"));
    if (total === null) return { ok: false, reason: "unreadable" };
    const peopleProbe = await supabase.from("network_connections").select(RESEARCH_PERSON_COLUMNS).limit(1);
    if (peopleProbe.error) return { ok: false, reason: "not_set_up" };
    const people = await fetchAllRows<ResearchPerson>(
      () =>
        supabase
          .from("network_connections")
          .select(RESEARCH_PERSON_COLUMNS)
          .eq("identity_status", "confirmed")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }) as never,
      total,
      "confirmed people"
    );
    const runTotal = await headCount(supabase, "ai_runs", (q) => q.eq("operation", "network_research").in("outcome", FINISHED));
    if (runTotal === null) return { ok: false, reason: "unreadable" };
    const runs = await fetchAllRows<{ source_id: string | null; outcome: string | null; ended_at: string | null }>(
      () =>
        supabase
          .from("ai_runs")
          .select("source_id, outcome, ended_at")
          .eq("operation", "network_research")
          .in("outcome", FINISHED)
          .order("started_at", { ascending: true })
          .order("id", { ascending: true }) as never,
      runTotal,
      "research runs"
    );
    const bySource = new Map<string, { outcome: string | null; ended_at: string | null }[]>();
    for (const r of runs) {
      if (!r.source_id) continue;
      const list = bySource.get(r.source_id) ?? [];
      list.push(r);
      bySource.set(r.source_id, list);
    }
    const researchedAt = new Map<string, string>();
    for (const p of people) {
      if (p.identity_status !== "confirmed") continue;
      const at = researchedAtFrom(bySource.get(p.id) ?? [], p.identity_decided_at);
      if (at) researchedAt.set(p.id, at);
    }
    return { ok: true, people, researchedAt, plan: planResearchQueue(people, new Set(researchedAt.keys())) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

// The findings held for these people (one page of the Network list, or one
// person), grouped by person; null when they could not be read.
export async function loadFindingsFor(supabase: SupabaseClient, ids: readonly string[]): Promise<Map<string, StoredFinding[]> | null> {
  const out = new Map<string, StoredFinding[]>();
  if (ids.length === 0) return out;
  try {
    for (const part of chunk([...ids], 100)) {
      const { data, error } = await supabase.from("network_person_findings").select("*").in("network_connection_id", part).order("created_at", { ascending: true });
      if (error) return null;
      for (const f of (data ?? []) as StoredFinding[]) {
        const list = out.get(f.network_connection_id) ?? [];
        list.push(f);
        out.set(f.network_connection_id, list);
      }
    }
    return out;
  } catch {
    return null;
  }
}
