// One assistant turn, end to end (STATE item 87, ruling 0037; ledger ruling
// 0026). The route handler authenticates and calls this; everything with an
// ordering guarantee lives here so it can be tested against fakes.
//
// The order is fixed, and every refusal comes BEFORE the first birth:
//
//   1. the user's organization is resolved through the session client
//   2. is the assistant enabled for it?                  else refuse (403)
//   3. is the provider configured?                       else refuse (503)
//   4. is the message valid?                             else refuse (400)
//   5. thread found or created                           (missing table: 503)
//   6. the user's message row is written
//   7. the assistant's message row is BORN `running`, naming provider and
//      model -- before any model call (ruling 0037 clause 4)
//   8. the run is born in the ledger (beginRun)          failure: no model call
//   9. the loop runs (the only model calls)
//  10. the run is finalized once, then the message is finalized once
//
// Nothing here throws to the caller: every failure is a returned status and
// body. Nothing here imports executors.ts -- a turn can read and propose, and
// that is all.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beginRun, finalizeRun, newUsage } from "@/lib/ai-runs";
import { readProviderConfig, PROVIDER_ID, isAssistantEnabledForOrg, type Env } from "./config";
import { resolveAssistantAccess, isMissingRelation, SETUP_PENDING_MESSAGE } from "./access";
import { callProvider, type FetchLike } from "./provider";
import { runAssistantLoop, type HistoryMessage, type Limits, type ProviderCaller, type LoopOutput, HISTORY_MESSAGE_CAP } from "./loop";
import { buildSystemPrompt } from "./prompt";
import type { Card, ProposalView, ToolContext } from "./types";
import { isUuid } from "./validate";

export const MAX_USER_MESSAGE_CHARS = 2000;
export const TITLE_CHARS = 60;

export type TurnInput = {
  supabase: SupabaseClient;
  userId: string;
  threadId?: unknown;
  message: unknown;
};

export type TurnDeps = {
  env?: Env;
  now?: () => Date;
  fetchImpl?: FetchLike;
  // Test seams: replace the provider call / the loop's clock and limits.
  call?: ProviderCaller;
  clock?: () => number;
  limits?: Partial<Limits>;
};

export type TurnResponse = { status: number; body: Record<string, unknown> };

function refusal(status: number, code: string, error: string, extra: Record<string, unknown> = {}): TurnResponse {
  return { status, body: { ok: false, error, code, ...extra } };
}

function title(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1)}…` : t;
}

export async function handleAssistantTurn(input: TurnInput, deps: TurnDeps = {}): Promise<TurnResponse> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const supabase = input.supabase;

  try {
    // 1-2. Who is this, and is the assistant on for them? No ledger row, no
    // message row, nothing is written for a refused request.
    const access = await resolveAssistantAccess(supabase, input.userId, env);
    if (!access.organizationId) return refusal(403, "no_organization", "Your account is not attached to an organization.");
    if (!access.enabled || !isAssistantEnabledForOrg(access.organizationId, env)) {
      return refusal(403, "not_enabled", "The assistant is not switched on for your organization.");
    }

    // 3. Configuration is read BEFORE any birth (the isSendConfigured shape):
    // with no key there will be no request, so nothing enters the ledger.
    const provider = readProviderConfig(env);
    if (!provider.ok) {
      return refusal(
        503,
        "not_configured",
        "The assistant is switched on for your organization, but its model connection is not configured yet. The owner needs to finish setup."
      );
    }
    const config = provider.config;

    // 4. Input validation.
    if (typeof input.message !== "string") return refusal(400, "invalid_message", "Write a message to send.");
    const message = input.message.trim();
    if (message.length === 0) return refusal(400, "invalid_message", "Write a message to send.");
    if (message.length > MAX_USER_MESSAGE_CHARS) {
      return refusal(400, "message_too_long", `That message is too long. Keep it under ${MAX_USER_MESSAGE_CHARS} characters.`);
    }
    if (input.threadId !== undefined && input.threadId !== null && !isUuid(input.threadId)) {
      return refusal(400, "invalid_thread", "That conversation could not be found.");
    }

    // 5. The thread. A missing relation here means migration 0080 is not
    // applied: say so plainly and write nothing.
    let threadId: string;
    if (typeof input.threadId === "string") {
      const { data, error } = await supabase.from("assistant_threads").select("id").eq("id", input.threadId).maybeSingle();
      if (error) {
        if (isMissingRelation(error)) return refusal(503, "setup_pending", SETUP_PENDING_MESSAGE);
        console.error("[assistant] thread lookup failed:", error.message);
        return refusal(500, "thread_error", "The conversation could not be loaded.");
      }
      if (!data) return refusal(404, "thread_not_found", "That conversation could not be found.");
      threadId = data.id as string;
    } else {
      const { data, error } = await supabase.from("assistant_threads").insert({ title: title(message) }).select("id").single();
      if (error || !data) {
        if (isMissingRelation(error)) return refusal(503, "setup_pending", SETUP_PENDING_MESSAGE);
        console.error("[assistant] thread insert failed:", error?.message);
        return refusal(500, "thread_error", "A conversation could not be started.");
      }
      threadId = data.id as string;
    }

    // 6. The user's own message, born terminal.
    const stamp = now().toISOString();
    const { data: userRow, error: userError } = await supabase
      .from("assistant_messages")
      .insert({ thread_id: threadId, role: "user", status: "completed", content: message, finalized_at: stamp })
      .select("id")
      .single();
    if (userError || !userRow) {
      if (isMissingRelation(userError)) return refusal(503, "setup_pending", SETUP_PENDING_MESSAGE);
      console.error("[assistant] user message insert failed:", userError?.message);
      return refusal(500, "message_error", "Your message could not be saved.", { threadId });
    }
    const userMessageId = userRow.id as string;

    // 7. The turn's own record, BORN before the model is called, naming the
    // provider and the model it is addressed to (ruling 0037 clause 4).
    const { data: asstRow, error: asstError } = await supabase
      .from("assistant_messages")
      .insert({ thread_id: threadId, role: "assistant", status: "running", provider: PROVIDER_ID, model: config.model })
      .select("id")
      .single();
    if (asstError || !asstRow) {
      console.error("[assistant] assistant message insert failed:", asstError?.message);
      return refusal(500, "message_error", "The assistant's reply could not be started.", { threadId, userMessageId });
    }
    const assistantMessageId = asstRow.id as string;

    async function finalizeMessage(fields: {
      status: "completed" | "failed";
      content: string;
      cards: Card[];
      stopReason: string;
      inputTokens: number | null;
      outputTokens: number | null;
      responseModel: string | null;
      errorNote: string | null;
    }): Promise<void> {
      const { error } = await supabase
        .from("assistant_messages")
        .update({
          status: fields.status,
          content: fields.content,
          cards: fields.cards,
          stop_reason: fields.stopReason,
          input_tokens: fields.inputTokens,
          output_tokens: fields.outputTokens,
          response_model: fields.responseModel,
          error_note: fields.errorNote,
          finalized_at: now().toISOString(),
        })
        .eq("id", assistantMessageId)
        .eq("status", "running");
      // A failure here leaves the row `running`, which is the honest encoding
      // of "this turn's end was never observed" -- same as a killed run.
      if (error) console.error(`[assistant] could not finalize message ${assistantMessageId}:`, error.message);
    }

    // 8. The ledger row, born before the model call. beginRun throws on
    // failure by design: the turn then does not run (ruling 0026 clause 1).
    const usage = newUsage();
    let aiRunId: string;
    try {
      aiRunId = await beginRun(supabase, {
        operation: "assistant_turn",
        sourceTable: "assistant_messages",
        sourceId: assistantMessageId,
      });
    } catch (err) {
      const note = err instanceof Error ? err.message : "Could not record the run.";
      await finalizeMessage({
        status: "failed",
        content: "",
        cards: [],
        stopReason: "error",
        inputTokens: null,
        outputTokens: null,
        responseModel: null,
        errorNote: note,
      });
      return refusal(500, "ledger_unavailable", "The assistant could not record this request, so nothing was asked. Try again.", {
        threadId,
        userMessageId,
        messageId: assistantMessageId,
      });
    }

    // 9. The loop: the only place a model is called.
    let out: LoopOutput;
    try {
      const { data: historyRows } = await supabase
        .from("assistant_messages")
        .select("role, content")
        .eq("thread_id", threadId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(HISTORY_MESSAGE_CAP);
      const history = ((historyRows ?? []) as { role: string; content: string }[])
        .reverse()
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content }) as HistoryMessage);

      const ctx: ToolContext = {
        supabase,
        userId: input.userId,
        threadId,
        messageId: assistantMessageId,
        now: now(),
        proposalsCreated: 0,
      };
      const call: ProviderCaller =
        deps.call ??
        ((req, timeoutMs) => callProvider(config, { messages: req.messages, tools: req.tools }, { timeoutMs, fetchImpl: deps.fetchImpl }));

      out = await runAssistantLoop({
        aiRunId,
        system: buildSystemPrompt(now()),
        history,
        ctx,
        usage,
        call,
        clock: deps.clock,
        limits: deps.limits,
      });
    } catch (err) {
      const note = err instanceof Error ? err.message : "The assistant hit an unexpected error.";
      console.error("[assistant] loop threw:", note);
      await finalizeRun(supabase, aiRunId, {
        outcome: "failed",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        errorNote: note,
      });
      await finalizeMessage({
        status: "failed",
        content: "",
        cards: [],
        stopReason: "error",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        responseModel: usage.model,
        errorNote: note,
      });
      return refusal(500, "internal", "The assistant hit an unexpected error. Nothing was changed except any proposals already shown.", {
        threadId,
        userMessageId,
        messageId: assistantMessageId,
      });
    }

    // 10. Exactly one run finalization, then exactly one message finalization.
    await finalizeRun(supabase, aiRunId, {
      outcome: out.outcome,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      errorNote: out.errorNote,
    });
    await finalizeMessage({
      status: out.outcome === "failed" ? "failed" : "completed",
      content: out.content,
      cards: out.cards,
      stopReason: out.stopReason,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      responseModel: usage.model,
      errorNote: out.errorNote,
    });

    const messageBody = {
      id: assistantMessageId,
      content: out.content,
      status: out.outcome === "failed" ? "failed" : "completed",
      stopReason: out.stopReason,
    };

    if (out.outcome === "failed") {
      // Plain wording for the client; the provider's own detail stays in the
      // ledger and the server log.
      return {
        status: 502,
        body: {
          ok: false,
          code: "provider_error",
          error: `${out.providerError?.message ?? "The assistant could not answer."} Nothing was changed except any proposals already shown below. Try again.`,
          threadId,
          userMessageId,
          message: messageBody,
          cards: out.cards,
          proposals: out.proposals as ProposalView[],
        },
      };
    }

    return {
      status: 200,
      body: { ok: true, threadId, userMessageId, message: messageBody, cards: out.cards, proposals: out.proposals as ProposalView[] },
    };
  } catch (err) {
    console.error("[assistant] turn failed before the loop:", err instanceof Error ? err.message : err);
    return refusal(500, "internal", "The assistant hit an unexpected error. Nothing was changed.");
  }
}
