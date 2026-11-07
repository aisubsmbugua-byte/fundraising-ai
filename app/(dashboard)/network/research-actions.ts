"use server";

// What does the public web say about this person? (STATE item 112, slice B of
// item 107; ruling 0044 clauses 3, 4, 5, 9 and 10, and clause 2's gate.)
//
// The general invariant: the platform researches a recorded person only after a
// human has CONFIRMED who they are; it refuses, in code and before any run is born
// or any model is called, anyone who is not confirmed, is marked do-not-research, or
// has already been researched (unless a human asks for it again); what it stores is
// a finding of a closed list of kinds whose url, title and passage are the captured
// ones; and only a human can strike (or restore) a finding.
//
// What is in this file, and who may call it:
//   * researchPerson -- the platform researches; metered as a ledger run (operation
//     network_research) BORN BEFORE the model is called. Called from a human's
//     click: the single-person card right after a human clicks "Confirm this
//     person", the "Research your network" button, and "Research this person" /
//     "Research again". NEVER from a page load, an effect, the batch confirm or an
//     import (scripts/test-network-research.ts scans for it).
//   * loadResearchQueue / loadPersonFindings -- READS only: who is waiting to be
//     researched, and one person's findings. They research nobody and spend nothing.
//   * strikeFinding / unstrikeFinding -- HUMAN decisions, recorded with who and when
//     (the verified session user, never a value from the request). The only thing
//     that can be done to a finding after it is stored.
//
// These actions are NOT reachable from the assistant or the external agent: both
// have closed, exactly-asserted tool registries that name no network action, and
// scripts/test-assistant.ts and scripts/test-agent.ts scan for any reference to this
// file (ruling 0039: a gate belongs to a human).
//
// Nothing in this file contacts a recorded person, or sends, drafts or advances
// anything; and nothing reads these findings into a path, a strategy, a draft or any
// funder-facing text (ruling 0044 clause 5). Every action RETURNS its failure rather
// than throwing it (Next redacts a thrown message in a production build).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { beginRun, finalizeRun, newUsage } from "@/lib/ai-runs";
import { findPersonFindings } from "@/lib/ai/person-research";
import { isUuid, type IdentityFacts } from "@/lib/network-identity";
import {
  RESEARCH_CLICK_CAP,
  buildReviewFinding,
  findingKey,
  refusalForResearch,
  researchAgeText,
  researchOutcomeMessage,
  type ResearchAnchor,
  type ResearchRefusalCode,
  type ReviewFinding,
  type StoredFinding,
} from "@/lib/network-research";
import { findingsTableReadable, loadFindingsFor, loadResearchOverview, loadResearchedAt } from "@/lib/network-research-store";
import type { SupabaseClient } from "@supabase/supabase-js";

const NOT_SET_UP =
  "Research is not available yet: the database has not had migration 0085 applied, so findings could not be saved. Nothing was researched and no AI run was spent.";
const UNREADABLE = "Could not read your network just now, so nothing was researched and no AI run was spent.";

type Subject = {
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
};

const SUBJECT_COLUMNS = "id, person_name, affiliation, title, city, state, do_not_research, identity_status, identity_decided_at, identity_candidate_id";

const factsOf = (p: Subject): IdentityFacts => ({
  person_name: p.person_name,
  affiliation: p.affiliation,
  title: p.title,
  city: p.city,
  state: p.state,
});

async function readSubject(supabase: SupabaseClient, id: string): Promise<{ ok: true; person: Subject } | { ok: false; error: string }> {
  const { data, error } = await supabase.from("network_connections").select(SUBJECT_COLUMNS).eq("id", id).maybeSingle();
  if (error) return { ok: false, error: UNREADABLE };
  if (!data) return { ok: false, error: "That person could not be found." };
  return { ok: true, person: data as Subject };
}

// The match a human confirmed for this person: the identity anchor of the research.
async function readAnchor(supabase: SupabaseClient, person: Subject): Promise<ResearchAnchor | null> {
  if (person.identity_status !== "confirmed" || !person.identity_candidate_id) return null;
  const { data, error } = await supabase
    .from("network_identity_candidates")
    .select("label, headline, location_text, source_url, source_title, network_connection_id")
    .eq("id", person.identity_candidate_id)
    .maybeSingle();
  if (error || !data) return null;
  const c = data as { label: string; headline: string | null; location_text: string | null; source_url: string; source_title: string | null; network_connection_id: string };
  // The confirmed candidate must be THIS person's own.
  if (c.network_connection_id !== person.id) return null;
  return { label: c.label, headline: c.headline, location_text: c.location_text, source_url: c.source_url, source_title: c.source_title };
}

function revalidateResearch() {
  revalidatePath("/network");
  revalidatePath("/network/identity");
}

// ---------------------------------------------------------------------------
// Researching one person
// ---------------------------------------------------------------------------

export type ResearchPersonResult =
  | { error: string; code?: ResearchRefusalCode; researchedAt?: string; ageText?: string }
  | {
      success: true;
      // Rows written by this run, and how many of them the captured text supports
      // (usable) and how many it does not (unsupported: stored, hidden, not used).
      stored: number;
      usable: number;
      unsupported: number;
      // Found again but already held, so not written twice (a struck finding stays struck).
      alreadyHeld: number;
      discarded: number;
      sourcesOffered: number;
      refusedSources: number;
      message: string;
      researchedAt: string;
    };

// One research run for one person: refuse in code, birth the run, search and
// select, write the findings, finalize. The ONLY place a research run is born.
async function researchOne(supabase: SupabaseClient, person: Subject, anchor: ResearchAnchor): Promise<ResearchPersonResult> {
  const usage = newUsage();
  let aiRunId: string;
  try {
    aiRunId = await beginRun(supabase, { operation: "network_research", sourceTable: "network_connections", sourceId: person.id });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not record the run, so nothing was researched." };
  }

  try {
    const result = await findPersonFindings(factsOf(person), anchor, usage);

    // The model call takes a minute or more. Read the person again before writing
    // anything: if they were reset, confirmed as someone else, or marked off limits
    // meanwhile, what was found rests on an identity that no longer stands.
    const fresh = await readSubject(supabase, person.id);
    if (!fresh.ok) throw new Error(fresh.error);
    if (fresh.person.do_not_research || fresh.person.identity_status !== "confirmed" || fresh.person.identity_candidate_id !== person.identity_candidate_id) {
      throw new Error("This person was changed while the research ran (reset, confirmed again or marked do not research), so nothing was saved.");
    }

    // A finding already held is not written twice, and a struck one stays struck:
    // the database's unique index would refuse a duplicate, so it is not offered one.
    const held = await supabase.from("network_person_findings").select("kind, organization_named, role_text, source_url").eq("network_connection_id", person.id);
    if (held.error) throw new Error(held.error.message);
    const have = new Set(((held.data ?? []) as { kind: string; organization_named: string | null; role_text: string | null; source_url: string }[]).map(findingKey));
    const toWrite = result.findings.filter((f) => !have.has(findingKey(f)));
    const alreadyHeld = result.findings.length - toWrite.length;

    if (toWrite.length > 0) {
      const { error: insertError } = await supabase.from("network_person_findings").insert(
        toWrite.map((f) => ({
          network_connection_id: person.id,
          ai_run_id: aiRunId,
          kind: f.kind,
          organization_named: f.organization_named,
          role_text: f.role_text,
          source_url: f.source_url,
          source_title: f.source_title,
          source_passage: f.source_passage,
          supported: f.supported,
          support_detail: f.support_detail,
        }))
      );
      if (insertError) throw new Error(insertError.message);
    }

    const usable = toWrite.filter((f) => f.supported).length;
    const unsupported = toWrite.length - usable;
    await finalizeRun(supabase, aiRunId, {
      outcome: result.findings.length > 0 ? "completed" : "empty",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return {
      success: true,
      stored: toWrite.length,
      usable,
      unsupported,
      alreadyHeld,
      discarded: result.discarded.length,
      sourcesOffered: result.sourcesOffered,
      refusedSources: result.refusedSources.length,
      researchedAt: new Date().toISOString(),
      message: researchOutcomeMessage({
        stored: toWrite.length,
        usable,
        unsupported,
        alreadyHeld,
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
      errorNote: err instanceof Error ? err.message : "Something went wrong researching this person",
    });
    return { error: err instanceof Error ? err.message : "Something went wrong researching this person." };
  }
}

// A human's click researches one person. `again` is true only for a human's explicit
// "Research again"; anything else (including a missing value) is false. The loop
// that runs a whole list passes the id alone, so it can never research anyone twice.
export async function researchPerson(personId: unknown, again?: unknown): Promise<ResearchPersonResult> {
  try {
    await requireUser();
    if (!isUuid(personId)) return { error: "That person was not understood." };
    const supabase = createClient();

    // Every refusal below happens BEFORE beginRun and BEFORE any model call: a
    // refused request is not an AI operation and is not metered. Each is decided
    // from the rows as the database holds them now -- never from what a page showed.
    if (!(await findingsTableReadable(supabase))) return { error: NOT_SET_UP };
    const read = await readSubject(supabase, personId);
    if (!read.ok) return { error: read.error };
    const person = read.person;
    const anchor = await readAnchor(supabase, person);
    const researchedAt = await loadResearchedAt(supabase, person.id, person.identity_decided_at);
    if (researchedAt === undefined) return { error: UNREADABLE };

    const refusal = refusalForResearch(person, { anchorFound: anchor !== null, researchedAt }, again === true, new Date());
    if (refusal) {
      return { error: refusal.message, code: refusal.code, ...(refusal.researchedAt ? { researchedAt: refusal.researchedAt, ageText: refusal.ageText } : {}) };
    }
    if (!anchor) return { error: UNREADABLE };

    const outcome = await researchOne(supabase, person, anchor);
    if ("success" in outcome) revalidateResearch();
    return outcome;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not research this person." };
  }
}

// ---------------------------------------------------------------------------
// Reads: who is waiting, and one person's findings. They research nobody, write
// nothing and spend nothing.
// ---------------------------------------------------------------------------

export type ResearchQueueResult =
  | { error: string }
  | { success: true; ids: string[]; eligible: number; researched: number; confirmed: number };

// "Research your network" fetches who is waiting at the moment of the click, so
// the list it works through is current, not the page's. Returns the first
// RESEARCH_CLICK_CAP ids (a convenience: the client applies the cap itself and the
// server does not rely on it -- every research is still one person, one run, refused
// in code for anyone who may not be researched) and the counts.
export async function loadResearchQueue(): Promise<ResearchQueueResult> {
  try {
    await requireUser();
    const supabase = createClient();
    const overview = await loadResearchOverview(supabase);
    if (!overview.ok) return { error: overview.reason === "not_set_up" ? NOT_SET_UP : UNREADABLE };
    const { plan } = overview;
    return {
      success: true,
      ids: plan.eligible.slice(0, RESEARCH_CLICK_CAP).map((p) => p.id),
      eligible: plan.eligible.length,
      researched: plan.researched,
      confirmed: plan.eligible.length + plan.researched,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not read who is waiting." };
  }
}

export type PersonFindingsResult =
  | { error: string }
  | { success: true; findings: ReviewFinding[]; researchedAt: string | null; ageText: string | null };

// One person's findings, for the card that shows them. The findings of a person
// who is not confirmed do not exist (the database deletes them), so none are returned.
export async function loadPersonFindings(personId: unknown): Promise<PersonFindingsResult> {
  try {
    await requireUser();
    if (!isUuid(personId)) return { error: "That person was not understood." };
    const supabase = createClient();
    const read = await readSubject(supabase, personId);
    if (!read.ok) return { error: read.error };
    const held = await loadFindingsFor(supabase, [personId]);
    if (!held) return { error: NOT_SET_UP };
    const researchedAt = await loadResearchedAt(supabase, personId, read.person.identity_decided_at);
    if (researchedAt === undefined) return { error: UNREADABLE };
    const stored: StoredFinding[] = held.get(personId) ?? [];
    return { success: true, findings: stored.map(buildReviewFinding), researchedAt, ageText: researchAgeText(researchedAt, new Date()) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not read what was found." };
  }
}

// ---------------------------------------------------------------------------
// Human decisions: strike, and restore
// ---------------------------------------------------------------------------

type Result = { error: string } | { success: true };

// "This is wrong." A human strikes a finding. It stays recorded, with who struck it
// and when, and is never used again unless a human restores it. The strike is
// recorded as the verified session user. Nothing else about a finding can change.
export async function strikeFinding(findingId: unknown): Promise<Result> {
  try {
    const user = await requireUser();
    if (!isUuid(findingId)) return { error: "That finding was not understood." };
    const supabase = createClient();
    const { data, error } = await supabase
      .from("network_person_findings")
      .update({ status: "struck", struck_by: user.id, struck_at: new Date().toISOString(), restored_by: null, restored_at: null })
      .eq("id", findingId)
      .eq("status", "included")
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "That finding could not be struck: it was not found, or it is already struck." };
    revalidateResearch();
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not strike that." };
  }
}

// A human takes a strike back. Recorded with who and when (the strike itself is
// then cleared, as the database's decision check requires).
export async function unstrikeFinding(findingId: unknown): Promise<Result> {
  try {
    const user = await requireUser();
    if (!isUuid(findingId)) return { error: "That finding was not understood." };
    const supabase = createClient();
    const { data, error } = await supabase
      .from("network_person_findings")
      .update({ status: "included", struck_by: null, struck_at: null, restored_by: user.id, restored_at: new Date().toISOString() })
      .eq("id", findingId)
      .eq("status", "struck")
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "That finding could not be restored: it was not found, or it is not struck." };
    revalidateResearch();
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not restore that." };
  }
}
