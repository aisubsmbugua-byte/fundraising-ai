"use server";

// Network paths (STATE items 76 and 103, rulings 0033 and 0040): "Who can open
// this door".
//
// The general invariant: a path is a proposal grounded in two captured facts --
// a connection a human recorded and a funder-side claim a human approved --
// referenced by id, and only a human moves it out of `suggested`.
//
// Nothing in this file sends, drafts or advances anything. There is no import
// of the send path, the drafting actions or any stage code, and
// decideNetworkPath writes exactly status, decided_by and decided_at
// (ruling 0033 clause 5; hard rules 1-3). The system never contacts a network
// person: no contact detail is stored to contact them with.
//
// Both actions RETURN their failure rather than throw it -- Next redacts a
// thrown message in a production build (see outcome-actions.ts).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { loadApprovedIntelligence } from "@/lib/prospect-intelligence";
import { beginRun, finalizeRun, newUsage, addResponseUsage } from "@/lib/ai-runs";
import {
  NETWORK_PATHS_TOOL,
  buildNetworkPathPrompt,
  selectAnchorClaims,
  validateNetworkPaths,
} from "@/lib/network";
import { emptyShortlistMessage, pathsOutcomeMessage, shortlistConnections } from "@/lib/network-shortlist";
import { loadAllConnections } from "@/lib/network-store";

// Every success states how many people were considered of how many are
// recorded and by what rule (ruling 0040 clause 7). `examined` is false only
// when narrowing left nobody, in which case the model was not asked.
export type FindPathsResult =
  | { error: string }
  | {
      success: true;
      stored: number;
      alreadyKnown: number;
      discarded: number;
      considered: number;
      totalRecorded: number;
      narrowed: boolean;
      matched: number | null;
      rule: string;
      examined: boolean;
      message: string;
    };

export async function findNetworkPaths(prospectId: string): Promise<FindPathsResult> {
  try {
    await requireUser();
    const supabase = createClient();

    const { data: prospect } = await supabase.from("prospects").select("id, name").eq("id", prospectId).maybeSingle();
    if (!prospect) return { error: "Prospect not found." };

    // Every refusal below happens BEFORE beginRun and BEFORE the model is
    // called: a refused request is not an AI operation and is not metered.
    //
    // The ONLY research payload this feature reads is approved intelligence.
    // It returns null until the funder's identity is resolved, so an unresolved
    // prospect can never feed a path.
    const approved = await loadApprovedIntelligence(supabase, prospectId);
    if (!approved) {
      return {
        error:
          "There is no confirmed research about this funder yet, so there is nothing to connect your network to. Run research and confirm the organization's identity first.",
      };
    }
    const anchorClaims = selectAnchorClaims(approved.claims);
    if (anchorClaims.length === 0) {
      return {
        error:
          "Nothing approved about this funder names a person or an organization yet. Approve research that names the funder's people, then look for paths again.",
      };
    }

    // EVERY recorded person, read in pages past the database's 1000-row response
    // limit against the exact total (a short read is an error, not a smaller
    // network). Then the stated narrowing rule (ruling 0040 clause 7): a network
    // no larger than one look can consider is passed through whole and unchanged;
    // a larger one is cut to a shortlist by lib/network-shortlist.ts, and the
    // result says so. There is no refusal and no silent truncation.
    const loaded = await loadAllConnections(supabase);
    if (!loaded.ok) return { error: "Could not read your network just now, so no paths were looked for." };
    if (loaded.total === 0) {
      return { error: "You have not recorded anyone you know yet. Add people on the Network page, then look for paths." };
    }
    const shortlist = shortlistConnections(loaded.connections, anchorClaims);
    const connections = shortlist.considered;
    if (connections.length === 0) {
      // Nobody shares a distinctive word with this funder's approved facts. This
      // is NOT an AI operation: no model call, no ledger birth -- it returns
      // before beginRun, like every other refusal above.
      return {
        success: true,
        stored: 0,
        alreadyKnown: 0,
        discarded: 0,
        considered: 0,
        totalRecorded: shortlist.totalRecorded,
        narrowed: shortlist.narrowed,
        matched: shortlist.matched,
        rule: shortlist.rule,
        examined: false,
        message: emptyShortlistMessage(shortlist),
      };
    }

    // The pools. Both are the exact lists handed to the model -- the CONSIDERED
    // people, not everyone recorded; every id the model returns is validated
    // against them below, so a path citing someone who was not shortlisted is
    // discarded like any other id outside the pool.
    const connectionIds = new Set(connections.map((c) => c.id));
    const claimIds = new Set(anchorClaims.map((c) => c.claimId));

    // Run ledger (ruling 0033 clause 6, ruling 0026): birth BEFORE the model
    // call, as its own operation. beginRun throws when the record cannot be
    // written, and then the model is never called.
    const usage = newUsage();
    let aiRunId: string;
    try {
      aiRunId = await beginRun(supabase, { operation: "network_paths", sourceTable: "prospects", sourceId: prospectId });
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Could not record the run, so nothing was looked for." };
    }

    try {
      const response = await anthropic.messages.create(
        {
          model: DRAFT_MODEL,
          max_tokens: 1500,
          tools: [NETWORK_PATHS_TOOL],
          tool_choice: { type: "tool", name: NETWORK_PATHS_TOOL.name },
          messages: [
            {
              role: "user",
              content: buildNetworkPathPrompt({ prospectName: prospect.name as string, connections, claims: anchorClaims }),
            },
          ],
        },
        { timeout: 60_000 }
      );
      addResponseUsage(usage, response);

      const toolUse = response.content.find((block) => block.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") throw new Error("The AI did not return a structured answer. Try again.");

      // The capture guarantee: a path citing an id outside the pools it was
      // handed is discarded and LOGGED, never stored.
      const rawPaths = (toolUse.input as { paths?: unknown }).paths;
      const { kept, discarded } = validateNetworkPaths(rawPaths, connectionIds, claimIds);
      for (const d of discarded) {
        console.log(`[network_paths] discarded a path (${d.reason}): ${JSON.stringify(d.raw)}`);
      }

      // A pair already stored (including one a human dismissed) is not stored
      // again, so a re-run cannot resurrect a decision.
      const { data: existing } = await supabase
        .from("network_path_suggestions")
        .select("network_connection_id, funder_claim_id")
        .eq("prospect_id", prospectId);
      const known = new Set((existing ?? []).map((e) => `${e.network_connection_id}|${e.funder_claim_id}`));
      const fresh = kept.filter((p) => !known.has(`${p.network_connection_id}|${p.funder_claim_id}`));

      if (fresh.length > 0) {
        // status is left to its column default ('suggested'): the AI-produced
        // state is the review state, and the insert policy admits no other.
        const { error: insertError } = await supabase.from("network_path_suggestions").insert(
          fresh.map((p) => ({
            prospect_id: prospectId,
            network_connection_id: p.network_connection_id,
            funder_claim_id: p.funder_claim_id,
            reasoning: p.reasoning,
            model_confidence: p.confidence,
          }))
        );
        if (insertError) throw new Error(insertError.message);
      }

      await finalizeRun(supabase, aiRunId, {
        outcome: fresh.length > 0 ? "completed" : "empty",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });

      revalidatePath(`/prospects/${prospectId}`);
      const alreadyKnown = kept.length - fresh.length;
      return {
        success: true,
        stored: fresh.length,
        alreadyKnown,
        discarded: discarded.length,
        considered: connections.length,
        totalRecorded: shortlist.totalRecorded,
        narrowed: shortlist.narrowed,
        matched: shortlist.matched,
        rule: shortlist.rule,
        examined: true,
        message: pathsOutcomeMessage({ stored: fresh.length, alreadyKnown, shortlist }),
      };
    } catch (err) {
      await finalizeRun(supabase, aiRunId, {
        outcome: "failed",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        errorNote: err instanceof Error ? err.message : "Something went wrong looking for paths",
      });
      return { error: err instanceof Error ? err.message : "Something went wrong looking for paths." };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not look for paths." };
  }
}

// A human's judgement on a proposed path, and nothing more. Writes status,
// decided_by (from the verified session user) and decided_at -- no message, no
// draft, no stage. Only a path still `suggested` can be decided: a decision is
// a record of a person's judgement and is not silently overwritten.
export async function decideNetworkPath(
  suggestionId: string,
  prospectId: string,
  decision: "accepted" | "dismissed"
): Promise<{ error: string } | { success: true }> {
  try {
    if (decision !== "accepted" && decision !== "dismissed") return { error: "Choose accept or dismiss." };
    const user = await requireUser();
    const supabase = createClient();

    const { data, error } = await supabase
      .from("network_path_suggestions")
      .update({ status: decision, decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("id", suggestionId)
      .eq("status", "suggested")
      .select("id");
    if (error) return { error: error.message };
    if (!data || data.length === 0) return { error: "That path has already been decided, or no longer exists." };

    revalidatePath(`/prospects/${prospectId}`);
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not record that decision." };
  }
}
