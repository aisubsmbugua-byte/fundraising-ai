// The run-ledger contract (ruling 0026, table ai_runs in migration 0067).
// Server-only: every caller is a server action holding a Supabase client.
//
// Two facts, written separately, by the two functions here:
//
//   beginRun    -- "a run happened". Inserts the birth row BEFORE any model
//                  call and returns its id. It THROWS on failure, on purpose:
//                  an operation that cannot first write its record does not
//                  run (clause 1). Every live call site already wraps its
//                  work in a try/catch that records the operation's own
//                  failure, so a birth failure surfaces as a failed
//                  operation, never as an unmetered run.
//
//   finalizeRun -- "how the run ended". Writes the terminal facts once:
//                  outcome (completed | failed | empty), ended_at, and the
//                  consumption actually observed. It NEVER throws and never
//                  rejects: a finalization error must not mask the
//                  operation's own result, and the row it failed to finalize
//                  is then correctly a born-unfinalized row -- exactly the
//                  encoding a killed run gets, which is the honest reading
//                  of "we never observed this run end".
//
// There is deliberately no function that writes 'killed'. A killed run is a
// born row whose outcome stays null past its deadline; nobody observes a
// kill, so nobody may record one.
//
// Consumption is CAPTURED, never estimated (clause 3): the accumulator below
// only accepts figures off an API response the operation actually received.
// Until the first response arrives the counts stay null -- "no consumption
// figures" is a fact, not a zero. For an operation that makes several model
// calls (discovery search+extract, research search+extract, strategy
// search+analysis), one user-perceived operation is ONE run: tokens
// aggregate across the calls and `model` records the first call's model;
// the per-call split, where it exists, lives in the operation's own run
// table, joinable via source_table/source_id (clause 5).

import type { SupabaseClient } from "@supabase/supabase-js";

// The vocabulary of the ledger's `operation` column. The column itself is
// unconstrained text (see 0067) -- this union is what stops a typo, at
// compile time, in the only code that writes it.
export const AI_RUN_OPERATIONS = [
  "discovery_search",
  "channel_fit",
  "research",
  "research_verify",
  "strategy",
  "draft",
  // The grant-proposal draft (STATE item 63) is a DISTINCT operation from
  // "draft" (the outreach kinds): decision 0006 prices per operation, and
  // a proposal is not an intro email.
  "proposal_draft",
  // The pitch-deck outline (STATE item 66) is likewise its own operation:
  // decision 0006 prices per operation, and a deck outline is neither an
  // intro email nor a proposal.
  "deck_draft",
  "revisit_suggest",
] as const;
export type AiRunOperation = (typeof AI_RUN_OPERATIONS)[number];

export type AiRunOutcome = "completed" | "failed" | "empty";

// Mutable per-operation accumulator. Null counts mean "no response ever
// arrived"; after the first response they are real captured totals, even if
// a later call in the same operation failed -- partial consumption is still
// consumption that happened.
export type UsageAccumulator = {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export function newUsage(): UsageAccumulator {
  return { model: null, inputTokens: null, outputTokens: null };
}

// For call sites that already hold {model, usage:{inputTokens,outputTokens}}
// (searchFunderWeb, extractResearchClaims, verifyResearchClaims -- all of
// which read these off the SDK response themselves).
export function addUsage(
  acc: UsageAccumulator,
  observed: { model: string; inputTokens: number; outputTokens: number }
): void {
  if (acc.model === null) acc.model = observed.model;
  acc.inputTokens = (acc.inputTokens ?? 0) + observed.inputTokens;
  acc.outputTokens = (acc.outputTokens ?? 0) + observed.outputTokens;
}

// For call sites holding a raw SDK Message.
export function addResponseUsage(
  acc: UsageAccumulator,
  response: { model: string; usage?: { input_tokens?: number; output_tokens?: number } }
): void {
  addUsage(acc, {
    model: response.model,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  });
}

// Inserts the birth row. Call this BEFORE the operation's first model call.
//
// organizationId is only needed on the service-role/admin-client path (the
// overnight discovery cron), where there is no auth.uid() for the column's
// `default my_organization_id()` to resolve from -- same threading the cron
// route already does for every other org-scoped write. Session-client
// callers leave it undefined and the default fills it, same as everywhere
// else in the app.
export async function beginRun(
  supabase: SupabaseClient,
  opts: {
    operation: AiRunOperation;
    organizationId?: string;
    // The operation's own row where one already exists at birth
    // (discovery_search_runs / research_runs / strategy_runs id). Frozen at
    // birth by the ai_runs trigger -- pass it here or not at all.
    sourceTable?: string;
    sourceId?: string;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("ai_runs")
    .insert({
      operation: opts.operation,
      ...(opts.organizationId ? { organization_id: opts.organizationId } : {}),
      source_table: opts.sourceTable ?? null,
      source_id: opts.sourceId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`ai_runs birth insert failed for ${opts.operation}: ${error?.message ?? "no row returned"}`);
  }
  return data.id as string;
}

// Writes the terminal facts, once. Never throws; a failure here is logged
// and the row stays born-unfinalized, which is the correct record of "this
// run's end was never successfully observed". The .is("outcome", null)
// guard makes an accidental double-finalize a quiet zero-row update on
// every client rather than a trigger exception on the admin one.
export async function finalizeRun(
  supabase: SupabaseClient,
  runId: string,
  facts: {
    outcome: AiRunOutcome;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    errorNote?: string | null;
  }
): Promise<void> {
  try {
    const { error } = await supabase
      .from("ai_runs")
      .update({
        outcome: facts.outcome,
        model: facts.model ?? null,
        input_tokens: facts.inputTokens ?? null,
        output_tokens: facts.outputTokens ?? null,
        error_note: facts.errorNote ?? null,
        ended_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .is("outcome", null);
    if (error) {
      console.error(`[ai-runs] finalize failed for run ${runId} (${facts.outcome}):`, error.message);
    }
  } catch (err) {
    console.error(`[ai-runs] finalize failed for run ${runId} (${facts.outcome}):`, err instanceof Error ? err.message : err);
  }
}
