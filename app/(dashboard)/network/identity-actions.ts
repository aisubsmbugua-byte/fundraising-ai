"use server";

// Who is this person? (STATE item 107 slice A, ruling 0044 clauses 2, 9 and 10.)
//
// The general invariant: the platform may PROPOSE candidate matches for a
// recorded person from the public web; ONLY a human click turns a proposal into
// an identity (or into "none of these"); a person marked do-not-research is
// refused in code before any run is born; and nothing is researched about a
// person beyond finding those candidates.
//
// What is in this file, and who may call it:
//   * findIdentityCandidates / findIdentityCandidatesForUnidentified  -- a human
//     clicks "Find matches"; the platform proposes. Each look is a metered
//     ledger run (operation network_identity) BORN BEFORE the model is called.
//   * confirmIdentity / confirmPreselectedIdentities / markNoneOfThese /
//     resetIdentity / setDoNotResearch -- HUMAN decisions. Each records the
//     verified session user (never a value from the request) as the decider.
//     Nothing here decides anything on its own: preselection is a default
//     highlight, and the batch action confirms only the pairs the human saw and
//     clicked, re-checked against the current data.
//
// These actions are NOT reachable from the assistant or the external agent: both
// have closed, exactly-asserted tool registries that name no network action, and
// scripts/test-network-identity.ts scans lib/assistant, lib/agent and app/api for
// any reference to this file (ruling 0039: an identity decision is a gate).
//
// Nothing in this file contacts a recorded person or sends, drafts or advances
// anything. Every action RETURNS its failure rather than throwing it (Next
// redacts a thrown message in a production build).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { beginRun, finalizeRun, newUsage } from "@/lib/ai-runs";
import { findPersonCandidates } from "@/lib/ai/person-search";
import {
  IDENTITY_BULK_CAP,
  IDENTITY_BULK_TIME_BUDGET_MS,
  IDENTITY_RESET_COLUMNS,
  bulkReportAddsUp,
  bulkReportMessage,
  isUuid,
  lookOutcomeMessage,
  parseIdList,
  planBulkLook,
  preselectedCandidate,
  refusalForLook,
  type BulkLookReport,
  type IdentityFacts,
  type LookRefusal,
  type LookSubject,
  type NetworkIdentityCandidate,
} from "@/lib/network-identity";
import { loadIdentityOverview } from "@/lib/network-identity-store";
import { chunk } from "@/lib/network-list";
import type { SupabaseClient } from "@supabase/supabase-js";

const NOT_SET_UP = "Could not read the identity details just now, so nothing was looked up. If this is a new install, migration 0083 may not be applied yet.";

type Subject = LookSubject & { id: string };

const SUBJECT_COLUMNS = "id, person_name, affiliation, title, city, state, do_not_research, identity_status";

const factsOf = (p: Subject): IdentityFacts => ({
  person_name: p.person_name,
  affiliation: p.affiliation,
  title: p.title,
  city: p.city,
  state: p.state,
});

async function readSubject(supabase: SupabaseClient, id: string): Promise<{ ok: true; person: Subject } | { ok: false; error: string }> {
  const { data, error } = await supabase.from("network_connections").select(SUBJECT_COLUMNS).eq("id", id).maybeSingle();
  if (error) return { ok: false, error: NOT_SET_UP };
  if (!data) return { ok: false, error: "That person could not be found." };
  return { ok: true, person: data as Subject };
}

function revalidateIdentity() {
  revalidatePath("/network");
  revalidatePath("/network/identity");
}

// ---------------------------------------------------------------------------
// Finding candidates
// ---------------------------------------------------------------------------

type LookOutcome =
  | { kind: "refused"; refusal: LookRefusal }
  | { kind: "error"; message: string }
  | { kind: "done"; stored: number; discarded: number; sourcesOffered: number; refusedSources: number; message: string };

// One look at one person: refuse in code, birth the run, search and select,
// replace the person's candidates, finalize. The ONLY place a run is born for a
// person; both public actions below go through it.
async function lookAtPerson(supabase: SupabaseClient, person: Subject): Promise<LookOutcome> {
  // Every refusal happens BEFORE beginRun and BEFORE any model call: a refused
  // request is not an AI operation and is not metered. A person marked do not
  // research, already confirmed, or recorded as none of these is refused here,
  // from the row as the database holds it now -- never from what the page showed.
  const refusal = refusalForLook(person, { candidateCount: 0, lookedAt: false }, "single");
  if (refusal) return { kind: "refused", refusal };

  // Run ledger (ruling 0044 clause 9, ruling 0026): birth BEFORE the model is
  // called, as its own operation. beginRun throws when the record cannot be
  // written, and then the model is never called.
  const usage = newUsage();
  let aiRunId: string;
  try {
    aiRunId = await beginRun(supabase, { operation: "network_identity", sourceTable: "network_connections", sourceId: person.id });
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Could not record the run, so nothing was looked up." };
  }

  try {
    const result = await findPersonCandidates(factsOf(person), usage);

    // A fresh look that found someone REPLACES the person's earlier candidates
    // (still unconfirmed: a confirmed or decided person is refused above). A
    // look that found no one keeps what was there.
    if (result.candidates.length > 0) {
      const cleared = await supabase.from("network_identity_candidates").delete().eq("network_connection_id", person.id);
      if (cleared.error) throw new Error(cleared.error.message);
      const { error: insertError } = await supabase.from("network_identity_candidates").insert(
        result.candidates.map((c) => ({
          network_connection_id: person.id,
          ai_run_id: aiRunId,
          label: c.label,
          headline: c.headline,
          location_text: c.location_text,
          source_url: c.source_url,
          source_title: c.source_title,
          source_passage: c.source_passage,
          agreement: c.agreement,
          rank: c.rank,
        }))
      );
      if (insertError) throw new Error(insertError.message);
    }

    await finalizeRun(supabase, aiRunId, {
      outcome: result.candidates.length > 0 ? "completed" : "empty",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return {
      kind: "done",
      stored: result.candidates.length,
      discarded: result.discarded.length,
      sourcesOffered: result.sourcesOffered,
      refusedSources: result.refusedSources.length,
      message: lookOutcomeMessage({
        stored: result.candidates.length,
        discarded: result.discarded.length,
        sourcesOffered: result.sourcesOffered,
        refusedSources: result.refusedSources.length,
      }),
    };
  } catch (err) {
    await finalizeRun(supabase, aiRunId, {
      outcome: "failed",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      errorNote: err instanceof Error ? err.message : "Something went wrong looking for matches",
    });
    return { kind: "error", message: err instanceof Error ? err.message : "Something went wrong looking for matches." };
  }
}

export type FindIdentityResult =
  | { error: string }
  | { success: true; stored: number; discarded: number; sourcesOffered: number; refusedSources: number; message: string };

// A person's own "Find matches" click.
export async function findIdentityCandidates(personId: unknown): Promise<FindIdentityResult> {
  try {
    await requireUser();
    if (!isUuid(personId)) return { error: "That person was not understood." };
    const supabase = createClient();
    const read = await readSubject(supabase, personId);
    if (!read.ok) return { error: read.error };
    const outcome = await lookAtPerson(supabase, read.person);
    if (outcome.kind === "refused") return { error: outcome.refusal.message };
    if (outcome.kind === "error") return { error: outcome.message };
    revalidateIdentity();
    return { success: true, stored: outcome.stored, discarded: outcome.discarded, sourcesOffered: outcome.sourcesOffered, refusedSources: outcome.refusedSources, message: outcome.message };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not look for matches." };
  }
}

export type BulkFindResult = { error: string } | { success: true; report: BulkLookReport; message: string };

// "Find matches for everyone not yet identified". Looks at the people the plan
// calls eligible, ONE AT A TIME, up to IDENTITY_BULK_CAP per click and within a
// time budget, and reports how many were looked at of how many were eligible and
// why every other person was not -- it never silently skips anyone. Each person
// is re-read just before their look, so someone marked do-not-research or
// decided while the click was running is refused from the current row.
export async function findIdentityCandidatesForUnidentified(): Promise<BulkFindResult> {
  try {
    await requireUser();
    const supabase = createClient();
    const overview = await loadIdentityOverview(supabase);
    if (!overview.ok) return { error: overview.reason === "not_set_up" ? NOT_SET_UP : "Could not read your network just now, so nobody was looked up." };

    const counts = new Map<string, number>();
    for (const [id, list] of overview.candidates) counts.set(id, list.length);
    const plan = planBulkLook(overview.people, counts, overview.lookedEmpty);

    const report: BulkLookReport = {
      cap: IDENTITY_BULK_CAP,
      totalRecorded: plan.totalRecorded,
      eligible: plan.eligible.length,
      looked: 0,
      failed: 0,
      changedSinceListed: 0,
      notReached: 0,
      withCandidates: 0,
      noCandidatesFound: 0,
      stoppedBecause: null,
      skipped: plan.skipped,
    };

    const startedAt = Date.now();
    let attempted = 0;
    for (let i = 0; i < plan.eligible.length; i++) {
      if (attempted >= IDENTITY_BULK_CAP) {
        report.stoppedBecause = "cap";
        report.notReached = plan.eligible.length - i;
        break;
      }
      if (Date.now() - startedAt > IDENTITY_BULK_TIME_BUDGET_MS) {
        report.stoppedBecause = "time";
        report.notReached = plan.eligible.length - i;
        break;
      }
      attempted++;
      const fresh = await readSubject(supabase, plan.eligible[i].id);
      if (!fresh.ok) {
        report.failed++;
        continue;
      }
      // The current row, not the list: refuse again here, before the ledger.
      if (refusalForLook(fresh.person, { candidateCount: 0, lookedAt: false }, "single")) {
        report.changedSinceListed++;
        continue;
      }
      const outcome = await lookAtPerson(supabase, fresh.person);
      if (outcome.kind === "refused") report.changedSinceListed++;
      else if (outcome.kind === "error") report.failed++;
      else {
        report.looked++;
        if (outcome.stored > 0) report.withCandidates++;
        else report.noCandidatesFound++;
      }
    }
    revalidateIdentity();
    if (!bulkReportAddsUp(report)) return { error: "The counts did not add up, so the result is not shown. Check the Network page." };
    return { success: true, report, message: bulkReportMessage(report) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not look for matches." };
  }
}

// ---------------------------------------------------------------------------
// Human decisions
// ---------------------------------------------------------------------------

type Result = { error: string } | { success: true };

async function candidatesOf(supabase: SupabaseClient, personId: string): Promise<NetworkIdentityCandidate[] | null> {
  const { data, error } = await supabase.from("network_identity_candidates").select("*").eq("network_connection_id", personId).order("rank", { ascending: true });
  if (error) return null;
  return (data ?? []) as NetworkIdentityCandidate[];
}

// "This is the person." A human click on one candidate. Only a person still
// unconfirmed and not marked do-not-research can be confirmed, and only to one
// of their OWN candidates; the decider is the verified session user.
export async function confirmIdentity(personId: unknown, candidateId: unknown): Promise<Result> {
  try {
    const user = await requireUser();
    if (!isUuid(personId) || !isUuid(candidateId)) return { error: "That choice was not understood." };
    const supabase = createClient();
    const read = await readSubject(supabase, personId);
    if (!read.ok) return { error: read.error };
    if (read.person.do_not_research) return { error: "This person is marked do not research, so their identity cannot be confirmed." };
    if (read.person.identity_status !== "unconfirmed") return { error: "This person's identity has already been decided. Reset it first to choose again." };
    const cands = await candidatesOf(supabase, personId);
    if (!cands || !cands.some((c) => c.id === candidateId)) return { error: "That candidate is not one of this person's candidates any more. Refresh the page." };

    const { data, error } = await supabase
      .from("network_connections")
      .update({ identity_status: "confirmed", identity_candidate_id: candidateId, identity_decided_by: user.id, identity_decided_at: new Date().toISOString() })
      .eq("id", personId)
      .eq("identity_status", "unconfirmed")
      .eq("do_not_research", false)
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "This person's identity was decided by someone else a moment ago." };
    revalidateIdentity();
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not confirm that." };
  }
}

export type BatchConfirmResult =
  | { error: string }
  | { success: true; confirmed: number; skipped: { personId: string; reason: string }[]; message: string };

// "Confirm all preselected." Takes the (person, candidate) pairs the human saw
// listed on the screen and clicked Confirm on. It confirms a pair ONLY IF that
// candidate is still, right now, the one preselected for that person (computed
// again from the stored captured text and the person's current facts) -- so a
// crafted request cannot confirm anything a person could not have seen
// preselected, and a person whose facts changed since the page loaded is
// skipped and named. A human decision, recorded as the verified session user.
export async function confirmPreselectedIdentities(pairs: unknown): Promise<BatchConfirmResult> {
  try {
    const user = await requireUser();
    if (!Array.isArray(pairs) || pairs.length === 0) return { error: "There is nothing to confirm." };
    if (pairs.length > 500) return { error: "One confirmation covers at most 500 people. Nothing was confirmed." };
    const items: { personId: string; candidateId: string }[] = [];
    for (const p of pairs) {
      const o = (p ?? {}) as Record<string, unknown>;
      if (!isUuid(o.personId) || !isUuid(o.candidateId)) return { error: "The selection was not understood. Nothing was confirmed." };
      items.push({ personId: o.personId, candidateId: o.candidateId });
    }
    const seen = new Set<string>();
    const supabase = createClient();
    let confirmed = 0;
    const skipped: { personId: string; reason: string }[] = [];
    for (const it of items) {
      if (seen.has(it.personId)) {
        skipped.push({ personId: it.personId, reason: "listed twice" });
        continue;
      }
      seen.add(it.personId);
      const read = await readSubject(supabase, it.personId);
      if (!read.ok) {
        skipped.push({ personId: it.personId, reason: read.error });
        continue;
      }
      const p = read.person;
      if (p.do_not_research) {
        skipped.push({ personId: it.personId, reason: "marked do not research" });
        continue;
      }
      if (p.identity_status !== "unconfirmed") {
        skipped.push({ personId: it.personId, reason: "already decided" });
        continue;
      }
      const cands = await candidatesOf(supabase, it.personId);
      const pre = cands ? preselectedCandidate(cands, factsOf(p)) : null;
      if (!pre || pre.id !== it.candidateId) {
        skipped.push({ personId: it.personId, reason: "no longer the preselected match (the person or their candidates changed)" });
        continue;
      }
      const { data, error } = await supabase
        .from("network_connections")
        .update({ identity_status: "confirmed", identity_candidate_id: it.candidateId, identity_decided_by: user.id, identity_decided_at: new Date().toISOString() })
        .eq("id", it.personId)
        .eq("identity_status", "unconfirmed")
        .eq("do_not_research", false)
        .select("id");
      if (error || !data || data.length === 0) {
        skipped.push({ personId: it.personId, reason: error ? error.message : "decided by someone else a moment ago" });
        continue;
      }
      confirmed++;
    }
    revalidateIdentity();
    return {
      success: true,
      confirmed,
      skipped,
      message: `Confirmed ${confirmed} of ${items.length} ${items.length === 1 ? "person" : "people"}.${skipped.length > 0 ? ` ${skipped.length} ${skipped.length === 1 ? "was" : "were"} left unconfirmed (${skipped.map((s) => s.reason).filter((v, i, a) => a.indexOf(v) === i).join("; ")}).` : ""}`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not confirm those." };
  }
}

// "None of these." A human records that no candidate is this person. Recorded
// (ruling 0019: a no is data) and the person is not looked up again until a
// human resets them. Only meaningful, and only allowed, when the person has
// candidates to say no to.
export async function markNoneOfThese(personId: unknown): Promise<Result> {
  try {
    const user = await requireUser();
    if (!isUuid(personId)) return { error: "That person was not understood." };
    const supabase = createClient();
    const read = await readSubject(supabase, personId);
    if (!read.ok) return { error: read.error };
    if (read.person.do_not_research) return { error: "This person is marked do not research." };
    if (read.person.identity_status !== "unconfirmed") return { error: "This person's identity has already been decided. Reset it first to choose again." };
    const cands = await candidatesOf(supabase, personId);
    if (!cands || cands.length === 0) return { error: "There are no candidates to say no to. Find matches first." };

    const { data, error } = await supabase
      .from("network_connections")
      .update({ identity_status: "none_of_these", identity_candidate_id: null, identity_decided_by: user.id, identity_decided_at: new Date().toISOString() })
      .eq("id", personId)
      .eq("identity_status", "unconfirmed")
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "This person's identity was decided by someone else a moment ago." };
    revalidateIdentity();
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not record that." };
  }
}

// A human puts a confirmed or "none of these" person back to unconfirmed, with
// no candidates, so they can be looked at afresh. The only way a decided person
// is ever searched again.
export async function resetIdentity(personId: unknown): Promise<Result> {
  try {
    await requireUser();
    if (!isUuid(personId)) return { error: "That person was not understood." };
    const supabase = createClient();
    const { data, error } = await supabase
      .from("network_connections")
      .update({ ...IDENTITY_RESET_COLUMNS })
      .eq("id", personId)
      .in("identity_status", ["confirmed", "none_of_these"])
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "There is nothing to reset: this person has no decision recorded." };
    // The candidates of the earlier look go too, so the next look starts clean.
    // (The database's trigger does the same.)
    const cleared = await supabase.from("network_identity_candidates").delete().eq("network_connection_id", personId);
    if (cleared.error) return { error: `The decision was reset, but the old candidates could not be cleared: ${cleared.error.message}` };
    revalidateIdentity();
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not reset that." };
  }
}

export type DoNotResearchResult = { error: string; changed?: number } | { success: true; changed: number };

// Marks people do-not-research (or allows research again), one at a time or in
// bulk, by id. Marking a person off limits clears what was found about them: a
// confirmed identity is voided and their candidates are deleted. A recorded "none
// of these" stays recorded. Row-level security scopes it to the organization.
export async function setDoNotResearch(ids: unknown, value: unknown): Promise<DoNotResearchResult> {
  try {
    await requireUser();
    if (typeof value !== "boolean") return { error: "Say whether to mark these people do not research or allow research again." };
    const parsed = parseIdList(ids, value ? "mark do not research" : "allow research for");
    if ("error" in parsed) return { error: parsed.error };
    const supabase = createClient();
    let changed = 0;
    for (const part of chunk(parsed.ids, 100)) {
      if (value) {
        // Void any confirmation first (it rested on candidates that are about to
        // go), then set the flag, then delete what was found.
        const voided = await supabase.from("network_connections").update({ ...IDENTITY_RESET_COLUMNS }).in("id", part).eq("identity_status", "confirmed").select("id");
        if (voided.error) return { error: voided.error.message, changed };
      }
      const { data, error } = await supabase.from("network_connections").update({ do_not_research: value }).in("id", part).select("id");
      if (error) return { error: `${changed} of ${parsed.ids.length} were changed before an error stopped it (${error.message}). The rest were not changed.`, changed };
      changed += data?.length ?? 0;
      if (value) {
        const cleared = await supabase.from("network_identity_candidates").delete().in("network_connection_id", part);
        if (cleared.error) return { error: `The flag was set, but the candidates could not be cleared: ${cleared.error.message}`, changed };
      }
    }
    revalidateIdentity();
    return { success: true, changed };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not change that." };
  }
}
