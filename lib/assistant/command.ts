// THE choke point (STATE item 92, ruling 0038 clauses 2, 3 and 5).
//
// runCommand is the only function that executes a command or a gate. Every
// command and gate registry entry's handler does exactly one thing -- call
// this -- and a source scan in scripts/test-assistant.ts fails the suite if a
// handler reaches an entry point, an executor or the audit table any other
// way, or if the quote check is not the first thing this function does.
//
// The order is fixed, and a refusal at any step stops there:
//
//   a. QUOTE.   The call must carry a quotation of the user's latest message
//               of THIS turn: a normalised substring check against the
//               message the turn handler holds (ToolContext.userMessage) --
//               never against anything the model supplies. Text that reached
//               the model through a tool result, or an earlier message, is
//               not the user's command and cannot satisfy it.
//   b. CAP.     At most MAX_COMMANDS_PER_TURN commands execute in one turn.
//   c. DISPLAY. A gate is decided only on a version the user was shown in an
//               EARLIER turn: a card of the right kind, for that exact
//               subject, carrying the same fingerprint, persisted on an
//               earlier completed assistant message of this thread.
//   d. ARGS.    Every argument is validated again, here (uuid, enum, length,
//               date); ids are resolved through the session client, and an id
//               the session cannot see is "not found".
//   e. TIME.    A long ability is refused BEFORE it starts if the turn's
//               remaining time is less than its stated maximum plus a margin.
//   f. GUARDS.  The ability's own guards re-read the live row; for a gate the
//               fingerprint is RECOMPUTED from it and must equal the one the
//               displayed card carried, or nothing runs.
//   g. RECORD.  The `started` audit row is written BEFORE the effect. If it
//               cannot be written -- or the table is absent -- nothing runs.
//   h. EFFECT.  The existing entry point is called as the signed-in user;
//               throws, {error} returns and NEXT_REDIRECT are all handled.
//   i. OUTCOME. The terminal row (executed | failed) is written once.
//
// Refusals return a structured result to the model AND a card to the user
// saying plainly what was not done and why. Nothing here trusts the model's
// say-so about what it was told to do: that is the whole of ruling 0038.

import { randomUUID } from "node:crypto";
import { COMMAND_DEF_BY_NAME, type CommandDef } from "./command-defs";
import { COMMAND_EXECUTORS, type Field, type Prepared } from "./command-exec";
import { insertCommandEvent, type CommandEventInsert, COMMAND_SETUP_PENDING_MESSAGE } from "./audit";
import { FINGERPRINT_RE } from "./fingerprint";
import { isRedirectError } from "./redirect";
import { isUuid } from "./validate";
import type { AbilityOutcome, Card, CommandEntryPoints, ToolContext } from "./types";

// --- Named bounds (asserted by scripts/test-assistant.ts) --------------------

// A turn may execute only a small, fixed number of commands (ruling 0038
// clause 2). A command names one subject and one action; there is no "all".
export const MAX_COMMANDS_PER_TURN = 3;
// The quotation must be a real excerpt, not a stray character.
export const MIN_QUOTE_CHARS = 4;
// Headroom over a long ability's own stated maximum.
export const TIME_MARGIN_MS = 10_000;
// How many earlier completed assistant messages a gate looks back through.
export const GATE_LOOKBACK_MESSAGES = 30;

// --- (a) the quotation ----------------------------------------------------------

// Whitespace collapsed, case folded. Deliberately nothing more: no stemming,
// no fuzzy match -- a threshold loose enough to forgive paraphrase also
// accepts an invented sentence that shares a word.
export function normalizeQuoteText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export type QuoteVerdict = { ok: true; wordsAsTyped: string } | { ok: false; code: "quote_missing" | "quote_too_short" | "quote_not_found"; reason: string };

export function verifyQuote(quote: unknown, userMessage: unknown): QuoteVerdict {
  if (typeof quote !== "string" || quote.trim() === "") {
    return { ok: false, code: "quote_missing", reason: "No quotation of the user's words was given, so nothing was done." };
  }
  if (typeof userMessage !== "string" || userMessage.trim() === "") {
    return { ok: false, code: "quote_not_found", reason: "There is no message from the user in this turn to authorize that, so nothing was done." };
  }
  const q = normalizeQuoteText(quote);
  if (q.length < MIN_QUOTE_CHARS) {
    return { ok: false, code: "quote_too_short", reason: `The quotation was too short to show what the user asked for (at least ${MIN_QUOTE_CHARS} characters), so nothing was done.` };
  }
  if (!normalizeQuoteText(userMessage).includes(q)) {
    return {
      ok: false,
      code: "quote_not_found",
      reason: "The words given as the user's instruction do not appear in the user's latest message, so nothing was done. Only the user's own words in this message can authorize an action.",
    };
  }
  // For the record: the words as the user TYPED them -- their casing and
  // spacing -- found by matching the quotation's own words, in order,
  // separated by any whitespace, case-insensitively. (The check above
  // guarantees a match exists; the fallback is only for exotic case folding.)
  const tokens = quote.trim().split(/\s+/).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const found = new RegExp(tokens.join("\\s+"), "i").exec(userMessage);
  const asTyped = found ? found[0] : quote.trim();
  return { ok: true, wordsAsTyped: asTyped };
}

// --- (c) "shown in an earlier turn" ------------------------------------------------

// Pure, so the matching rule is pinned offline: a card of the right kind, for
// exactly this subject, carrying exactly this fingerprint.
export function findDisplayedGateCard(
  cards: unknown,
  subject: "strategy_run" | "draft",
  subjectId: string,
  fingerprint: string
): boolean {
  if (!Array.isArray(cards)) return false;
  for (const c of cards) {
    if (c === null || typeof c !== "object") continue;
    const card = c as Record<string, unknown>;
    if (subject === "strategy_run") {
      if (card.kind === "strategy_review" && card.runId === subjectId && card.fingerprint === fingerprint && card.approved === false) return true;
    } else if (card.kind === "draft_review" && Array.isArray(card.drafts)) {
      for (const d of card.drafts) {
        if (d !== null && typeof d === "object") {
          const item = d as Record<string, unknown>;
          if (item.draftId === subjectId && item.fingerprint === fingerprint) return true;
        }
      }
    }
  }
  return false;
}

// --- outcome builders ----------------------------------------------------------------

type Def = CommandDef;

function refusalOutcome(def: Def, code: string, reason: string, opts: { quote?: string; href?: string; extra?: Record<string, unknown> } = {}): AbilityOutcome {
  const card: Card = { kind: "refusal", ability: def.name, title: `${def.label} — not done`, reason, quote: opts.quote, href: opts.href };
  return {
    ok: true,
    modelResult: {
      status: "refused",
      nothingWasDone: true,
      code,
      reason,
      ability: def.name,
      guidance: "Tell the user plainly that this was not done and why. Do not say or imply that it happened.",
      ...(opts.extra ?? {}),
    },
    card,
  };
}

function failedOutcome(def: Def, reason: string, quote: string, href?: string): AbilityOutcome {
  const card: Card = { kind: "refusal", ability: def.name, title: `${def.label} — not completed`, reason, quote, href };
  return {
    ok: true,
    modelResult: {
      status: "failed",
      code: "entry_point_failed",
      reason,
      ability: def.name,
      guidance: "Tell the user plainly that this could not be completed and why. Do not say or imply that it happened.",
    },
    card,
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v ?? null };
}

// --- the choke point -------------------------------------------------------------------

export async function runCommand(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<AbilityOutcome> {
  // (a) THE QUOTE CHECK IS THE FIRST THING THAT HAPPENS. (The lookup below is
  // a table read of static data, not an action; it cannot refuse and has no
  // effect. A source scan pins that nothing else precedes verifyQuote.)
  const verdict = verifyQuote(rawArgs?.authorizing_quote, ctx.userMessage);

  const found = COMMAND_DEF_BY_NAME.get(name);
  const exec = found ? COMMAND_EXECUTORS[name] : undefined;
  if (!found || !exec) return { ok: false, error: `There is no command named "${String(name).slice(0, 60)}".` };
  const def: Def = found;

  const commandId = randomUUID();
  const suppliedQuote = typeof rawArgs?.authorizing_quote === "string" ? rawArgs.authorizing_quote.trim().slice(0, 500) : "";
  // What the record keeps as the quoted words: the user's own words as typed
  // once the quotation is verified; until then, what the model supplied.
  let recordedQuote = suppliedQuote === "" ? "(none)" : suppliedQuote;

  const base = (): Omit<CommandEventInsert, "event" | "payload" | "quote" | "previous" | "result" | "error_note" | "subject_table" | "subject_id"> => ({
    command_id: commandId,
    origin: "command",
    thread_id: ctx.threadId,
    user_message_id: ctx.userMessageId,
    assistant_message_id: ctx.messageId,
    ability: def.name,
    restores_command_id: null,
  });

  // A refusal before the effect is ONE terminal row: there is no effect for a
  // started row to precede. Best effort -- an absent table or a failed write
  // never turns a refusal into anything else, and never blocks it.
  async function refused(
    code: string,
    reason: string,
    opts: { quote?: string; href?: string; extra?: Record<string, unknown>; subject?: { table: string; id: string } | null } = {}
  ): Promise<AbilityOutcome> {
    await insertCommandEvent(ctx.supabase, {
      ...base(),
      event: "refused",
      payload: asRecord(rawArgs),
      quote: recordedQuote,
      previous: null,
      result: { code },
      error_note: reason.slice(0, 1000),
      subject_table: opts.subject?.table ?? null,
      subject_id: opts.subject?.id ?? null,
    });
    return refusalOutcome(def, code, reason, opts);
  }

  if (!verdict.ok) return refused(verdict.code, verdict.reason);
  const userWords = verdict.wordsAsTyped.slice(0, 500);
  recordedQuote = userWords;

  // (b) the per-turn cap.
  if (ctx.commandsRun >= MAX_COMMANDS_PER_TURN) {
    return refused(
      "turn_cap",
      `At most ${MAX_COMMANDS_PER_TURN} actions can be taken in one message, and that many were already taken, so this one was not done. Ask for it in a new message.`,
      { quote: userWords }
    );
  }

  // (c) a gate is decided only on what the user was shown, earlier.
  let displayedFingerprint: string | null = null;
  if (def.gate) {
    const subjectId = def.gate.subject === "strategy_run" ? rawArgs.run_id : rawArgs.draft_id;
    const fp = typeof rawArgs.fingerprint === "string" ? rawArgs.fingerprint.trim().toLowerCase() : "";
    if (!isUuid(subjectId) || !FINGERPRINT_RE.test(fp)) {
      return refused("invalid_arguments", "That needs the id and fingerprint from the lookup that showed it, so nothing was done.", { quote: userWords });
    }
    const subjectKey = subjectId.toLowerCase();
    const { data, error } = await ctx.supabase
      .from("assistant_messages")
      .select("id, cards, finalized_at")
      .eq("thread_id", ctx.threadId)
      .eq("role", "assistant")
      .eq("status", "completed")
      .lt("finalized_at", ctx.userMessageAt)
      .neq("id", ctx.messageId)
      .order("finalized_at", { ascending: false })
      .limit(GATE_LOOKBACK_MESSAGES);
    if (error) {
      return refused("read_failed", "The earlier messages could not be read to confirm what you were shown, so nothing was done.", { quote: userWords });
    }
    const shown = ((data ?? []) as { id: string; cards: unknown }[]).some((m) => findDisplayedGateCard(m.cards, def.gate!.subject, subjectKey, fp));
    if (!shown) {
      return refused(
        "not_shown_earlier",
        "That was not shown to you, in exactly this form, in an earlier message of this conversation, so it was not approved. A decision is made only on what has been seen: it is shown now, and approving it takes your next message.",
        { quote: userWords }
      );
    }
    displayedFingerprint = fp;
  }

  // (d) every argument, validated again here.
  const valid = def.validate(rawArgs, ctx.now);
  if (!valid.ok) return refused("invalid_arguments", `${valid.error} Nothing was done.`, { quote: userWords });
  const args = valid.value;

  // (e) a long ability is refused before it starts if the turn cannot finish it.
  if (def.maxDurationMs !== null) {
    const left = ctx.remainingMs();
    if (!(left >= def.maxDurationMs + TIME_MARGIN_MS)) {
      return refused(
        "not_enough_time",
        "There is not enough time left in this message to do that safely, so it was not started. Ask for it on its own, in a new message.",
        { quote: userWords }
      );
    }
  }

  // (f) the ability's guards, against the live rows.
  let prepared: Prepared;
  try {
    const res = await exec(args, { supabase: ctx.supabase, userId: ctx.userId, now: ctx.now });
    if ("refused" in res) {
      return refused(res.refused.code, res.refused.reason, { quote: userWords, href: res.refused.href, extra: res.refused.extra });
    }
    prepared = res.prepared;
  } catch (err) {
    console.error(`[assistant] ${def.name} guard step threw:`, err instanceof Error ? err.message : err);
    return refused("read_failed", "The records needed to check that could not be read just now, so nothing was done.", { quote: userWords });
  }

  if (def.gate) {
    // THE RECOMPUTE. The fingerprint of the live row, computed just now by the
    // same pure function the read used, must equal the displayed one. A gate
    // that did not supply one is refused, never waved through.
    if (typeof prepared.liveFingerprint !== "string" || prepared.liveFingerprint !== displayedFingerprint) {
      return refused(
        "changed_since_shown",
        "What you were shown has changed since, so it was not approved. A decision is made only on what has been seen: look at the current version, then say to approve it.",
        { quote: userWords, subject: prepared.subject }
      );
    }
  }

  // (g) the record, BEFORE the effect.
  // The exact payload, in the tool's own argument names. Validation above
  // refused any key the schema does not name, so this holds nothing else; the
  // quotation has its own column.
  const payload = asRecord({ ...rawArgs });
  delete payload.authorizing_quote;
  const started = await insertCommandEvent(ctx.supabase, {
    ...base(),
    event: "started",
    payload,
    quote: userWords,
    previous: prepared.previous,
    result: null,
    error_note: null,
    subject_table: prepared.subject?.table ?? null,
    subject_id: prepared.subject?.id ?? null,
  });
  if (!started.ok) {
    const reason = started.setupPending
      ? COMMAND_SETUP_PENDING_MESSAGE
      : "That could not be recorded, and an action is never taken unrecorded, so nothing was done.";
    return refusalOutcome(def, started.setupPending ? "setup_pending" : "record_failed", reason, { quote: userWords });
  }
  ctx.commandsRun += 1;

  async function terminal(event: "executed" | "failed", result: Record<string, unknown> | null, note: string | null, subject: { table: string; id: string } | null): Promise<boolean> {
    const res = await insertCommandEvent(ctx.supabase, {
      ...base(),
      event,
      payload,
      quote: userWords,
      previous: null,
      result,
      error_note: note,
      subject_table: subject?.table ?? prepared.subject?.table ?? null,
      subject_id: subject?.id ?? prepared.subject?.id ?? null,
    });
    return res.ok;
  }

  // (h) the effect, through the existing entry point, as the signed-in user.
  let eps: CommandEntryPoints;
  try {
    eps = await ctx.loadEntryPoints();
  } catch (err) {
    const note = err instanceof Error ? err.message : "The action could not be started.";
    console.error(`[assistant] ${def.name}: entry points could not be loaded:`, note);
    await terminal("failed", null, "The action could not be started.", null);
    return failedOutcome(def, "The action could not be started, so nothing was done.", userWords);
  }

  let effect;
  try {
    effect = await prepared.effect(eps);
  } catch (err) {
    // An entry point may throw (a database error) or redirect (signed out).
    const note = isRedirectError(err)
      ? "Your session is no longer signed in, so nothing was done. Sign in and try again."
      : err instanceof Error && err.message
        ? err.message
        : "The action failed.";
    console.error(`[assistant] ${def.name} threw:`, note);
    effect = { ok: false as const, error: note };
  }

  // (i) the outcome, written once.
  if (!effect.ok) {
    const recorded = await terminal("failed", null, effect.error.slice(0, 1000), null);
    const out = failedOutcome(def, `${effect.error}${recorded ? "" : " (This failure could not be recorded.)"}`, userWords, undefined);
    return out;
  }

  const recorded = await terminal("executed", { ...effect.result, commandId }, null, effect.subject ?? null);
  const note = recorded ? effect.note : "The record of this action could not be completed; the action itself was done.";
  const resultCard: Card = {
    kind: "command_result",
    ability: def.name,
    commandId,
    title: def.label,
    summary: effect.summary,
    quote: userWords,
    fields: effect.fields as Field[],
    replaced: effect.replaced,
    restorable: Boolean(effect.restorable) && recorded,
    href: effect.href,
    note: [note, effect.warning].filter(Boolean).join(" ") || undefined,
  };
  return {
    ok: true,
    modelResult: {
      status: "done",
      ability: def.name,
      commandId,
      summary: effect.summary,
      ...effect.modelResult,
      ...(effect.warning ? { warning: effect.warning } : {}),
    },
    card: resultCard,
    cards: effect.cards,
  };
}
