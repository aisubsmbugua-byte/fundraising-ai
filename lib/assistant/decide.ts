// The decision logic for an assistant proposal (STATE item 87, ruling 0037
// clause 2) -- approve and dismiss -- separated from the server-action file so
// it can be exercised offline against a fake client.
//
// This module does NOT import executors.ts. The one function that performs a
// write is INJECTED by the approve action (app/(dashboard)/assistant/
// actions.ts), which is the only file that imports executors.ts. So the
// guarantee "a proposal can be executed only by the approve action" is a fact
// about imports, scanned in scripts/test-assistant.ts, not about this file's
// good behaviour.
//
// The approve sequence, each step in code:
//
//   1. the proposal is visible through the session client and is the
//      caller's own (created_by);
//   2. the assistant is still enabled for their organization;
//   3. it is pending, unclaimed and unexpired;
//   4. the approval is CLAIMED -- one atomic update that sets claimed_at where
//      the row is still pending, unclaimed and unexpired. Only the request
//      that wins the claim goes on to execute, so a double click or a second
//      tab cannot log the same thing twice;
//   5. the subject is re-read through the session client (still there, still
//      visible); for a next-action change, the current value must equal the
//      `previous` value stored in the payload, else the proposal is stale;
//   6. the injected executor is called with exactly the stored payload;
//   7. executed or failed is written once, guarded by `status = 'pending'`
//      here and by a database trigger underneath.
//
// A proposal whose approval was claimed and never recorded (the server died
// between 4 and 7) stays claimed-and-pending: an honest attempted-and-
// unconfirmed state. Nothing re-runs it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelation, SETUP_PENDING_MESSAGE } from "./access";
import { PROPOSAL_COLUMNS, previousForCompare, rowToView, type ProposalRow } from "./proposals";
import type { ExecutionResult, ProposalView } from "./types";

// A failed execution returns the stored proposal too, so the screen can show
// the failed state and its reason instead of leaving the buttons live.
export type DecideResult = { error: string; proposal?: ProposalView } | { success: true; proposal: ProposalView };

export type ExecuteFn = (actionKey: string, storedPayload: unknown, now: Date) => Promise<ExecutionResult>;

const NOT_FOUND = "That proposal could not be found.";

async function loadOwnProposal(supabase: SupabaseClient, proposalId: string, userId: string) {
  const { data, error } = await supabase.from("assistant_proposals").select(PROPOSAL_COLUMNS).eq("id", proposalId).maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return { row: null, error: SETUP_PENDING_MESSAGE };
    return { row: null, error: "The proposal could not be read just now." };
  }
  const row = (data ?? null) as unknown as ProposalRow | null;
  // RLS already limits this to the user's own; the explicit check keeps the
  // rule in the code path, not only in the policy.
  if (!row || row.created_by !== userId) return { row: null, error: NOT_FOUND };
  return { row, error: null };
}

export async function approveProposalCore(input: {
  supabase: SupabaseClient;
  userId: string;
  proposalId: string;
  enabled: boolean;
  now: Date;
  execute: ExecuteFn;
}): Promise<DecideResult> {
  const { supabase, userId, enabled, execute } = input;
  const { row, error } = await loadOwnProposal(supabase, input.proposalId, userId);
  if (!row) return { error: error ?? NOT_FOUND };

  if (!enabled) return { error: "The assistant is not switched on for your organization." };

  if (row.status !== "pending") return { error: `This proposal was already ${row.status}.` };
  if (row.claimed_at) {
    return {
      error: "An approval of this proposal was already started. Check the record itself to see whether it was made; it will not be run a second time.",
    };
  }
  const nowIso = input.now.toISOString();
  if (row.expires_at <= nowIso) {
    // Best effort: the database accepts `expired` only after expiry.
    await supabase
      .from("assistant_proposals")
      .update({ status: "expired", decided_at: nowIso })
      .eq("id", row.id)
      .eq("status", "pending")
      .is("claimed_at", null);
    return { error: "This proposal has expired. Ask the assistant again if you still want it." };
  }

  // 4. Claim. Atomic: the conditions are in the WHERE, so exactly one
  // concurrent request can win.
  const { data: claimed, error: claimError } = await supabase
    .from("assistant_proposals")
    .update({ claimed_at: nowIso })
    .eq("id", row.id)
    .eq("status", "pending")
    .is("claimed_at", null)
    .gt("expires_at", nowIso)
    .select("id");
  if (claimError) return { error: "The approval could not be started just now. Nothing was changed." };
  if (!claimed || claimed.length === 0) {
    return { error: "This proposal was already decided, or its approval was already started. Nothing was changed." };
  }

  async function finish(status: "executed" | "failed", result: unknown, note: string | null): Promise<DecideResult> {
    const { data: done, error: finishError } = await supabase
      .from("assistant_proposals")
      .update({ status, decided_at: new Date().toISOString(), result: result ?? null, error_note: note })
      .eq("id", row!.id)
      .eq("status", "pending")
      .select(PROPOSAL_COLUMNS);
    if (finishError || !done || done.length === 0) {
      return {
        error: "The change may have been made, but its result could not be recorded. Check the record itself; it will not be run a second time.",
      };
    }
    const view = rowToView(done[0] as unknown as ProposalRow);
    if (status === "failed") return { error: note ?? "The change could not be made.", proposal: view };
    return { success: true, proposal: view };
  }

  // 5. The subject, re-read through the session client.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (row.subject_table === "prospects") {
    const { data: subject, error: subjectError } = await supabase
      .from("prospects")
      .select("id, next_action, next_action_due")
      .eq("id", row.subject_id)
      .maybeSingle();
    if (subjectError) return finish("failed", null, "The prospect could not be read, so nothing was changed.");
    if (!subject) return finish("failed", null, "That prospect no longer exists or is no longer visible to you, so nothing was changed.");
    if (row.action_key === "set_prospect_next_action") {
      const prev = (payload.previous ?? {}) as { next_action?: string | null; next_action_due?: string | null };
      const current = subject as { next_action: string | null; next_action_due: string | null };
      const same =
        (previousForCompare(current.next_action) ?? null) === (prev.next_action ?? null) &&
        (current.next_action_due ?? null) === (prev.next_action_due ?? null);
      if (!same) {
        return finish("failed", null, "The prospect's next action has changed since this was proposed, so nothing was changed. Ask again if you still want it.");
      }
    }
  } else if (row.subject_table === "supporters") {
    const { data: subject, error: subjectError } = await supabase.from("supporters").select("id").eq("id", row.subject_id).maybeSingle();
    if (subjectError) return finish("failed", null, "The supporter could not be read, so nothing was changed.");
    if (!subject) return finish("failed", null, "That supporter no longer exists or is no longer visible to you, so nothing was changed.");
  } else {
    return finish("failed", null, "Unknown subject. Nothing was changed.");
  }

  // 6. Execute, with exactly the stored payload (re-validated by the executor).
  const execution = await execute(row.action_key, row.payload, input.now);
  if (!execution.ok) return finish("failed", null, execution.error);
  return finish("executed", execution.result, null);
}

export async function dismissProposalCore(input: { supabase: SupabaseClient; userId: string; proposalId: string; now: Date }): Promise<DecideResult> {
  const { supabase, userId } = input;
  const { row, error } = await loadOwnProposal(supabase, input.proposalId, userId);
  if (!row) return { error: error ?? NOT_FOUND };
  if (row.status !== "pending") return { error: `This proposal was already ${row.status}.` };
  if (row.claimed_at) return { error: "An approval of this proposal was already started, so it cannot be dismissed." };

  const { data, error: updateError } = await supabase
    .from("assistant_proposals")
    .update({ status: "dismissed", decided_at: input.now.toISOString() })
    .eq("id", row.id)
    .eq("status", "pending")
    .is("claimed_at", null)
    .select(PROPOSAL_COLUMNS);
  if (updateError) return { error: "The proposal could not be dismissed just now." };
  if (!data || data.length === 0) return { error: "This proposal was already decided." };
  return { success: true, proposal: rowToView(data[0] as unknown as ProposalRow) };
}
