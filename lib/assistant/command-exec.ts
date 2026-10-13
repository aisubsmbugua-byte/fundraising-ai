// What each command and gate DOES (STATE item 92, ruling 0038).
//
// Imported by exactly one file: command.ts, the choke point. abilities.ts
// never imports this module, and a registry handler has no way to reach a
// function in it -- a source scan asserts both.
//
// Every executor has two phases, and the order between them is the point:
//
//   prepare   READS through the signed-in user's session client (an id the
//             session cannot see is "not found"), applies every guard the
//             ability promises, and returns either a refusal or a Prepared:
//             the subject, what is about to be replaced, and an `effect`.
//
//   effect    calls the EXISTING entry point -- the function a person using
//             the page would use -- and reports what it did.
//
// command.ts writes the born-before-effect audit row BETWEEN the two, so
// nothing in `effect` can run unrecorded, and a refusal in `prepare` costs
// nothing. Nothing here is imported by, or callable from, a registry handler.
//
// Entry points are NOT imported here. They arrive as a parameter of
// `effect`, handed in by the choke point, so this module holds no server
// action and the guards below are exercisable against fakes that count calls.
//
// The guards that matter most are the gates', because the existing entry
// points they wrap check almost nothing:
//   * approveStrategy only checks that someone is signed in -- it does not
//     look at status, at whether the run belongs to the prospect, at whether
//     it is the latest run, or at whether it is already approved (a second
//     call silently overwrites the approval). approve_strategy checks all
//     four, re-read here, before calling it.
//   * approveDraft only flips a status and has no guard of its own (and is
//     test-pinned, so it is not modified). approve_draft checks the draft is
//     still a draft, belongs to the prospect, is unsent, has text, and still
//     matches what was shown.

import type { SupabaseClient } from "@supabase/supabase-js";
import { channelLabel } from "@/lib/prospects";
import { draftKindLabel } from "@/lib/drafts";
import { interactionKindLabel } from "@/lib/interactions";
import type { OrganizationIntel, Strategy } from "@/lib/strategy";
import type { Card, CommandEntryPoints } from "./types";
import { draftFingerprint, strategyFingerprint } from "./fingerprint";
import { getDrafts, getStrategyForReview, listProspectNames } from "./reads";
import { isRedirectError, prospectIdFromRedirect } from "./redirect";
import type {
  AddProspectArgs,
  ApproveDraftArgs,
  ApproveStrategyArgs,
  CommandArgs,
  EditDraftArgs,
  GenerateDraftArgs,
  LogProspectInteractionArgs,
  LogSupporterInteractionArgs,
  PushBackArgs,
  ReviseDraftArgs,
  SetAskAmountArgs,
  SetNextActionArgs,
  ReopenDraftArgs,
} from "./command-defs";

export type Field = { label: string; value: string };

export type Refusal = { code: string; reason: string; href?: string; extra?: Record<string, unknown> };

export type EffectResult =
  | {
      ok: true;
      summary: string;
      fields: Field[];
      replaced?: Field[];
      // What the model is told, beyond the status the choke point adds. Only
      // keys on the command allowlist survive the dispatcher.
      modelResult: Record<string, unknown>;
      // What is written to the audit record's `result` column.
      result: Record<string, unknown>;
      subject?: { table: string; id: string };
      href?: string;
      cards?: Card[];
      restorable?: boolean;
      warning?: string;
      note?: string;
    }
  | { ok: false; error: string };

export type Prepared = {
  subject: { table: string; id: string } | null;
  // What the write is about to replace, captured BEFORE the effect (it goes in
  // the born-before-effect row, so a crash mid-effect still leaves it).
  previous: Record<string, unknown> | null;
  // Gates only: the fingerprint of the LIVE content, recomputed from the row
  // just read. The choke point compares it to the fingerprint the displayed
  // card carried; a gate that does not supply one is refused.
  liveFingerprint?: string;
  effect: (entryPoints: CommandEntryPoints) => Promise<EffectResult>;
};

export type ExecEnv = { supabase: SupabaseClient; userId: string; now: Date };

export type PrepareResult = { refused: Refusal } | { prepared: Prepared };

export type Executor = (args: CommandArgs, env: ExecEnv) => Promise<PrepareResult>;

// --- helpers -----------------------------------------------------------------

const READ_FAILED = (what: string): PrepareResult => ({
  refused: { code: "read_failed", reason: `${what} could not be read just now, so nothing was done.` },
});
const NOT_FOUND = (what: string): PrepareResult => ({
  refused: { code: "not_found", reason: `${what} could not be found (or you cannot see it), so nothing was done.` },
});

function refuse(code: string, reason: string, href?: string, extra?: Record<string, unknown>): PrepareResult {
  return { refused: { code, reason, href, extra } };
}

function prospectHref(id: string): string {
  return `/prospects/${id}`;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function errorText(err: unknown, fallback: string): string {
  if (isRedirectError(err)) return "Your session is no longer signed in, so nothing was done. Sign in and try again.";
  return err instanceof Error && err.message ? err.message : fallback;
}

type DraftRow = {
  id: string;
  prospect_id: string;
  kind: string;
  status: string;
  subject: string | null;
  content: string | null;
  sent_at: string | null;
};

const DRAFT_COLUMNS = "id, prospect_id, kind, status, subject, content, sent_at";

async function loadDraft(env: ExecEnv, draftId: string): Promise<{ row: DraftRow | null; failed: boolean }> {
  const { data, error } = await env.supabase.from("drafts").select(DRAFT_COLUMNS).eq("id", draftId).maybeSingle();
  if (error) return { row: null, failed: true };
  return { row: (data as DraftRow | null) ?? null, failed: false };
}

async function loadProspectName(env: ExecEnv, prospectId: string): Promise<{ name: string | null; failed: boolean }> {
  const { data, error } = await env.supabase.from("prospects").select("id, name").eq("id", prospectId).maybeSingle();
  if (error) return { name: null, failed: true };
  return { name: data ? String((data as { name: string }).name) : null, failed: false };
}

// --- add_prospect --------------------------------------------------------------

const addProspect: Executor = async (raw, env) => {
  const args = raw as AddProspectArgs;
  // Exact, case-insensitive, whitespace-normalised. Compared in code over a
  // paged read of every prospect -- never by interpolating the model's text
  // into a filter.
  const existing = await listProspectNames(env.supabase);
  if (!existing.ok) return READ_FAILED("The list of existing prospects");
  const wanted = norm(args.name);
  const dup = existing.rows.find((r) => norm(r.name) === wanted);
  if (dup) {
    return refuse("duplicate", `There is already a prospect named "${dup.name}", so a second one was not added.`, prospectHref(dup.id), {
      existingProspectId: dup.id,
      existingProspectName: dup.name,
    });
  }

  return {
    prepared: {
      subject: null,
      previous: null,
      effect: async (ep) => {
        // The ordinary New Prospect form, field for field. NO `stage` is set,
        // so the entry point's own resolveStartingStage lands it in Discovery:
        // starting anywhere else is a stage decision, and is not offered.
        const form = new FormData();
        form.set("name", args.name);
        form.set("channel", args.channel);
        if (args.organization) form.set("organization", args.organization);
        if (args.website) form.set("website", args.website);
        if (args.location) form.set("location", args.location);
        if (args.notes) form.set("notes", args.notes);

        // createProspect ends in redirect(`/prospects/<id>`), which works by
        // throwing: a redirect carrying the new prospect's own path IS its
        // success signal, and the id is read out of it.
        let newId: string | null = null;
        try {
          await ep.createProspect(form);
        } catch (err) {
          if (isRedirectError(err)) {
            newId = prospectIdFromRedirect(err);
            if (newId === null) return { ok: false, error: "Your session is no longer signed in, so nothing was added. Sign in and try again." };
          } else {
            return { ok: false, error: errorText(err, "The prospect could not be added.") };
          }
        }

        // Confirm against the database rather than trusting a string.
        let confirmed: { id: string; name: string; stage: string } | null = null;
        if (newId) {
          const { data } = await env.supabase.from("prospects").select("id, name, stage").eq("id", newId).maybeSingle();
          confirmed = (data as { id: string; name: string; stage: string } | null) ?? null;
        }
        if (!confirmed) {
          // No usable id came back: find it by exact name, once.
          const after = await listProspectNames(env.supabase);
          const hit = after.ok ? after.rows.find((r) => norm(r.name) === wanted) : undefined;
          if (hit) {
            const { data } = await env.supabase.from("prospects").select("id, name, stage").eq("id", hit.id).maybeSingle();
            confirmed = (data as { id: string; name: string; stage: string } | null) ?? null;
          }
        }
        if (!confirmed) return { ok: false, error: "The prospect may have been added, but it could not be confirmed. Check the pipeline before asking again." };

        const fields: Field[] = [
          { label: "Name", value: confirmed.name },
          { label: "Channel", value: channelLabel(args.channel) },
          { label: "Starts at", value: "Discovery" },
        ];
        if (args.organization) fields.push({ label: "Organization", value: args.organization });
        if (args.website) fields.push({ label: "Website", value: args.website });
        if (args.location) fields.push({ label: "Location", value: args.location });
        if (args.notes) fields.push({ label: "Note", value: args.notes });
        return {
          ok: true,
          summary: `Added "${confirmed.name}" as a new prospect, at the start of the pipeline.`,
          fields,
          modelResult: { prospectId: confirmed.id, prospectName: confirmed.name },
          result: { prospectId: confirmed.id, stage: confirmed.stage },
          subject: { table: "prospects", id: confirmed.id },
          href: prospectHref(confirmed.id),
        };
      },
    },
  };
};

// --- edit_draft ----------------------------------------------------------------

const editDraft: Executor = async (raw, env) => {
  const args = raw as EditDraftArgs;
  const { row, failed } = await loadDraft(env, args.draftId);
  if (failed) return READ_FAILED("That draft");
  if (!row) return NOT_FOUND("That draft");
  const href = prospectHref(row.prospect_id);
  if (row.sent_at) return refuse("already_sent", "That draft has already been delivered, so its text is fixed. Further work happens on a new draft.", href);
  if (row.status !== "draft") {
    return refuse("not_a_draft", "That draft is approved, so its text is locked. Reopen it for editing first, then ask again.", href);
  }
  if (row.kind !== "intro_email" && row.kind !== "call_prep") {
    return refuse("wrong_kind", "Only an outreach draft (an introductory note or call-prep notes) is edited this way. A proposal or deck outline is changed with feedback instead.", href);
  }
  if (row.kind === "call_prep" && args.subject !== null) {
    return refuse("no_subject", "Call-prep notes have no subject line, so none was set.", href);
  }
  const newSubject = row.kind === "intro_email" ? (args.subject ?? row.subject ?? "") : null;
  const oldSubject = row.subject ?? null;
  const oldContent = row.content ?? "";
  if ((newSubject ?? null) === oldSubject && args.content.trim() === oldContent.trim()) {
    return refuse("no_change", "That text is the same as what is already there, so nothing was changed.", href);
  }

  return {
    prepared: {
      subject: { table: "drafts", id: row.id },
      previous: { subject: oldSubject, content: oldContent },
      effect: async (ep) => {
        let res: { ok: true } | { error: string };
        try {
          res = await ep.updateDraft(row.id, row.prospect_id, newSubject, args.content);
        } catch (err) {
          return { ok: false, error: errorText(err, "The draft could not be changed.") };
        }
        if ("error" in res) return { ok: false, error: res.error };
        const label = draftKindLabel(row.kind);
        const fields: Field[] = [{ label: "Draft", value: label }];
        if (row.kind === "intro_email") fields.push({ label: "Subject", value: newSubject ?? "" });
        fields.push({ label: "New text", value: args.content });
        const replaced: Field[] = [];
        if (row.kind === "intro_email") replaced.push({ label: "Subject", value: oldSubject ?? "" });
        replaced.push({ label: "Text", value: oldContent });
        return {
          ok: true,
          summary: `Replaced the text of the ${label.toLowerCase()} draft. It is still a draft, waiting for your review.`,
          fields,
          replaced,
          modelResult: { draftId: row.id, kind: row.kind, draftStatus: "draft" },
          result: {
            draftId: row.id,
            afterFingerprint: draftFingerprint({ kind: row.kind, subject: newSubject, content: args.content }),
          },
          subject: { table: "drafts", id: row.id },
          href,
          restorable: true,
        };
      },
    },
  };
};

// --- revise_draft_with_feedback -------------------------------------------------

const reviseDraft: Executor = async (raw, env) => {
  const args = raw as ReviseDraftArgs;
  const { row, failed } = await loadDraft(env, args.draftId);
  if (failed) return READ_FAILED("That draft");
  if (!row) return NOT_FOUND("That draft");
  const href = prospectHref(row.prospect_id);
  if (row.sent_at) return refuse("already_sent", "That draft has already been delivered, so its text is fixed.", href);
  if (row.status !== "draft") {
    return refuse("not_a_draft", "That draft is approved, so its text is locked. Reopen it for editing first, then ask again.", href);
  }
  if (row.kind !== "proposal" && row.kind !== "deck") {
    return refuse("wrong_kind", "Only a grant proposal or a deck outline is revised with feedback. An outreach draft is edited directly.", href);
  }
  const oldContent = row.content ?? "";

  return {
    prepared: {
      subject: { table: "drafts", id: row.id },
      previous: { subject: row.subject ?? null, content: oldContent },
      effect: async (ep) => {
        let res: { ok: true; content: string } | { error: string };
        try {
          res = await ep.reviseDraftWithFeedback(row.id, args.feedback);
        } catch (err) {
          return { ok: false, error: errorText(err, "The draft could not be revised.") };
        }
        if ("error" in res) return { ok: false, error: res.error };
        const label = draftKindLabel(row.kind);
        return {
          ok: true,
          summary: `Revised the ${label.toLowerCase()} to address your feedback. It is still a draft, waiting for your review.`,
          fields: [
            { label: "Draft", value: label },
            { label: "Your feedback", value: args.feedback },
            { label: "Revised text", value: res.content },
          ],
          replaced: [{ label: "Text", value: oldContent }],
          modelResult: { draftId: row.id, kind: row.kind, draftStatus: "draft" },
          result: {
            draftId: row.id,
            afterFingerprint: draftFingerprint({ kind: row.kind, subject: row.subject ?? null, content: res.content }),
          },
          subject: { table: "drafts", id: row.id },
          href,
          restorable: true,
        };
      },
    },
  };
};

// --- push_back_on_strategy --------------------------------------------------------

const pushBack: Executor = async (raw, env) => {
  const args = raw as PushBackArgs;
  const { data, error } = await env.supabase
    .from("strategy_runs")
    .select("id, prospect_id, status, approved_strategy")
    .eq("id", args.runId)
    .maybeSingle();
  if (error) return READ_FAILED("That strategy");
  if (!data) return NOT_FOUND("That strategy");
  const run = data as { id: string; prospect_id: string };
  const href = prospectHref(run.prospect_id);

  return {
    prepared: {
      subject: { table: "strategy_runs", id: run.id },
      previous: null,
      effect: async (ep) => {
        // reviseStrategyWithFeedback re-derives and refuses everything else
        // (not waiting for review, already approved, not the latest, empty
        // feedback, not strategy-ready) BEFORE it writes a row.
        let res: { ok: true; runId: string } | { error: string };
        try {
          res = await ep.reviseStrategyWithFeedback(run.id, args.feedback);
        } catch (err) {
          return { ok: false, error: errorText(err, "The strategy could not be revised.") };
        }
        if ("error" in res) return { ok: false, error: res.error };
        // Show the revision in full, in this turn, so it can be approved in a
        // later one. Best effort: the revision exists either way.
        const cards: Card[] = [];
        const shown = await getStrategyForReview(env.supabase, { prospectId: run.prospect_id });
        if (shown.ok) cards.push(shown.card);
        return {
          ok: true,
          summary: "Revised the strategy to address your feedback. The new version is waiting for your review and is not approved; the earlier one is kept.",
          fields: [{ label: "Your feedback", value: args.feedback }],
          modelResult: { prospectId: run.prospect_id, newRunId: res.runId, approved: false },
          result: { newRunId: res.runId, fromRunId: run.id },
          subject: { table: "strategy_runs", id: res.runId },
          href,
          cards,
        };
      },
    },
  };
};

// --- generate_outreach_draft -------------------------------------------------------

const generateDraft: Executor = async (raw, env) => {
  const args = raw as GenerateDraftArgs;
  const prospect = await loadProspectName(env, args.prospectId);
  if (prospect.failed) return READ_FAILED("That prospect");
  if (prospect.name === null) return NOT_FOUND("That prospect");
  const href = prospectHref(args.prospectId);

  // The prospect's LATEST run -- the one the drafting gate itself reads.
  const { data: runs, error } = await env.supabase
    .from("strategy_runs")
    .select("id, approved_strategy, created_at")
    .eq("prospect_id", args.prospectId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return READ_FAILED("That prospect's strategy");
  const latest = ((runs ?? [])[0] ?? null) as { id: string; approved_strategy: unknown } | null;
  if (!latest || latest.approved_strategy === null || latest.approved_strategy === undefined) {
    return refuse("no_approved_strategy", "There is no approved strategy for this prospect yet, so there is nothing to draft from. Approve the strategy first.", href);
  }
  const runId = latest.id;

  const before = await env.supabase.from("drafts").select("id").eq("prospect_id", args.prospectId).eq("strategy_run_id", runId).eq("kind", args.kind);
  if (before.error) return READ_FAILED("That prospect's drafts");
  const beforeIds = new Set(((before.data ?? []) as { id: string }[]).map((d) => d.id));

  return {
    prepared: {
      subject: { table: "prospects", id: args.prospectId },
      previous: null,
      effect: async (ep) => {
        try {
          // generateDraft inserts the draft and returns nothing; it throws on
          // failure. One model call, no web search.
          await ep.generateDraft(args.prospectId, runId, args.kind);
        } catch (err) {
          return { ok: false, error: errorText(err, "The draft could not be written.") };
        }
        const after = await env.supabase
          .from("drafts")
          .select("id, created_at")
          .eq("prospect_id", args.prospectId)
          .eq("strategy_run_id", runId)
          .eq("kind", args.kind)
          .order("created_at", { ascending: false });
        const created = ((after.data ?? []) as { id: string }[]).find((d) => !beforeIds.has(d.id)) ?? null;
        const label = draftKindLabel(args.kind);
        const cards: Card[] = [];
        if (created) {
          const shown = await getDrafts(env.supabase, { prospectId: args.prospectId, draftId: created.id });
          if (shown.ok) cards.push(shown.card);
        }
        return {
          ok: true,
          summary: `Wrote a new ${label.toLowerCase()} draft for "${prospect.name}" from the approved strategy. It is a draft, waiting for your review.`,
          fields: [
            { label: "Prospect", value: prospect.name ?? "" },
            { label: "Draft", value: label },
          ],
          modelResult: { prospectId: args.prospectId, kind: args.kind, ...(created ? { draftId: created.id } : {}), draftStatus: "draft" },
          result: { draftId: created?.id ?? null, strategyRunId: runId },
          subject: created ? { table: "drafts", id: created.id } : { table: "prospects", id: args.prospectId },
          href,
          cards,
          warning: created ? undefined : "The draft was written but could not be identified; check the prospect's drafts.",
        };
      },
    },
  };
};

// --- unapprove_draft ------------------------------------------------------------------

const unapproveDraft: Executor = async (raw, env) => {
  const args = raw as ReopenDraftArgs;
  const { row, failed } = await loadDraft(env, args.draftId);
  if (failed) return READ_FAILED("That draft");
  if (!row) return NOT_FOUND("That draft");
  const href = prospectHref(row.prospect_id);
  if (row.sent_at) return refuse("already_sent", "That draft has been delivered, so it stays exactly as it was. Further work happens on a new draft.", href);
  if (row.status !== "approved") return refuse("not_approved", "That draft is not approved, so there is nothing to reopen.", href);

  return {
    prepared: {
      subject: { table: "drafts", id: row.id },
      previous: { status: "approved" },
      effect: async (ep) => {
        let res: { ok: true } | { error: string };
        try {
          // The entry point also refuses when a delivery is on record or its
          // outcome is unconfirmed; that refusal comes back as {error}.
          res = await ep.unapproveDraft(row.id, row.prospect_id);
        } catch (err) {
          return { ok: false, error: errorText(err, "The draft could not be reopened.") };
        }
        if ("error" in res) return { ok: false, error: res.error };
        return {
          ok: true,
          summary: `Reopened the ${draftKindLabel(row.kind).toLowerCase()} draft for editing. Its text is unchanged and it is no longer approved.`,
          fields: [{ label: "Draft", value: draftKindLabel(row.kind) }],
          modelResult: { draftId: row.id, draftStatus: "draft" },
          result: { draftId: row.id },
          subject: { table: "drafts", id: row.id },
          href,
        };
      },
    },
  };
};

// --- log_prospect_interaction / log_supporter_interaction -------------------------------

const logProspectInteraction: Executor = async (raw, env) => {
  const args = raw as LogProspectInteractionArgs;
  const prospect = await loadProspectName(env, args.prospectId);
  if (prospect.failed) return READ_FAILED("That prospect");
  if (prospect.name === null) return NOT_FOUND("That prospect");
  const name = prospect.name;
  return {
    prepared: {
      subject: { table: "prospects", id: args.prospectId },
      previous: null,
      effect: async (ep) => {
        try {
          await ep.logInteraction(args.prospectId, args.kind, args.summary, args.occurredAt);
        } catch (err) {
          return { ok: false, error: errorText(err, "The interaction could not be recorded.") };
        }
        return {
          ok: true,
          summary: `Logged a ${interactionKindLabel(args.kind).toLowerCase()} dated ${args.occurredAt} on "${name}".`,
          fields: [
            { label: "Prospect", value: name },
            { label: "Type", value: interactionKindLabel(args.kind) },
            { label: "Date", value: args.occurredAt },
            { label: "What happened", value: args.summary },
          ],
          modelResult: { prospectId: args.prospectId, prospectName: name },
          result: { prospectId: args.prospectId },
          subject: { table: "prospects", id: args.prospectId },
          href: prospectHref(args.prospectId),
        };
      },
    },
  };
};

const logSupporterInteraction: Executor = async (raw, env) => {
  const args = raw as LogSupporterInteractionArgs;
  const { data, error } = await env.supabase.from("supporters").select("id, name").eq("id", args.supporterId).maybeSingle();
  if (error) return READ_FAILED("That supporter");
  if (!data) return NOT_FOUND("That supporter");
  const name = String((data as { name: string }).name);
  return {
    prepared: {
      subject: { table: "supporters", id: args.supporterId },
      previous: null,
      effect: async (ep) => {
        try {
          await ep.logSupporterInteraction(args.supporterId, args.kind, args.summary, args.occurredAt);
        } catch (err) {
          return { ok: false, error: errorText(err, "The interaction could not be recorded.") };
        }
        return {
          ok: true,
          summary: `Logged a ${interactionKindLabel(args.kind).toLowerCase()} dated ${args.occurredAt} on supporter "${name}".`,
          fields: [
            { label: "Supporter", value: name },
            { label: "Type", value: interactionKindLabel(args.kind) },
            { label: "Date", value: args.occurredAt },
            { label: "What happened", value: args.summary },
          ],
          modelResult: { prospectName: name },
          result: { supporterId: args.supporterId },
          subject: { table: "supporters", id: args.supporterId },
          href: "/supporters",
        };
      },
    },
  };
};

// --- set_prospect_next_action -------------------------------------------------------------

const setNextAction: Executor = async (raw, env) => {
  const args = raw as SetNextActionArgs;
  const { data, error } = await env.supabase
    .from("prospects")
    .select("id, name, next_action, next_action_due")
    .eq("id", args.prospectId)
    .maybeSingle();
  if (error) return READ_FAILED("That prospect");
  if (!data) return NOT_FOUND("That prospect");
  const row = data as { name: string; next_action: string | null; next_action_due: string | null };
  const href = prospectHref(args.prospectId);
  if ((row.next_action ?? null) === args.nextAction && (row.next_action_due ?? null) === args.nextActionDue) {
    return refuse("no_change", "That is already the next action and due date, so nothing was changed.", href);
  }
  return {
    prepared: {
      subject: { table: "prospects", id: args.prospectId },
      previous: { next_action: row.next_action ?? null, next_action_due: row.next_action_due ?? null },
      effect: async (ep) => {
        try {
          // The entry point takes the due date as a string, empty for none.
          await ep.updateNextAction(args.prospectId, args.nextAction, args.nextActionDue ?? "");
        } catch (err) {
          return { ok: false, error: errorText(err, "The next action could not be changed.") };
        }
        return {
          ok: true,
          summary: `Set the next action on "${row.name}".`,
          fields: [
            { label: "Prospect", value: row.name },
            { label: "Next action", value: args.nextAction },
            { label: "Due", value: args.nextActionDue ?? "No due date" },
          ],
          replaced: [
            { label: "Next action", value: row.next_action ?? "None" },
            { label: "Due", value: row.next_action_due ?? "No due date" },
          ],
          modelResult: { prospectId: args.prospectId, prospectName: row.name },
          result: { prospectId: args.prospectId },
          subject: { table: "prospects", id: args.prospectId },
          href,
        };
      },
    },
  };
};

// --- set_prospect_ask_amount -----------------------------------------------------------------

const setAskAmount: Executor = async (raw, env) => {
  const args = raw as SetAskAmountArgs;
  const { data, error } = await env.supabase.from("prospects").select("id, name, ask_amount").eq("id", args.prospectId).maybeSingle();
  if (error) return READ_FAILED("That prospect");
  if (!data) return NOT_FOUND("That prospect");
  const row = data as { name: string; ask_amount: number | null };
  const href = prospectHref(args.prospectId);
  const current = row.ask_amount === null || row.ask_amount === undefined ? null : Number(row.ask_amount);
  if (current === args.askAmount) return refuse("no_change", "That is already the ask amount, so nothing was changed.", href);
  const money = (n: number | null) => (n === null ? "Not set" : `$${n.toLocaleString("en-US")}`);
  return {
    prepared: {
      subject: { table: "prospects", id: args.prospectId },
      previous: { ask_amount: current },
      effect: async (ep) => {
        try {
          await ep.updateAskAmount(args.prospectId, args.askAmount);
        } catch (err) {
          return { ok: false, error: errorText(err, "The ask amount could not be changed.") };
        }
        return {
          ok: true,
          summary: args.askAmount === null ? `Cleared the ask amount on "${row.name}".` : `Set the ask amount on "${row.name}" to ${money(args.askAmount)}.`,
          fields: [
            { label: "Prospect", value: row.name },
            { label: "Ask amount", value: money(args.askAmount) },
          ],
          replaced: [{ label: "Ask amount", value: money(current) }],
          modelResult: { prospectId: args.prospectId, prospectName: row.name },
          result: { prospectId: args.prospectId },
          subject: { table: "prospects", id: args.prospectId },
          href,
        };
      },
    },
  };
};

// --- approve_strategy (GATE) ----------------------------------------------------------------------

const approveStrategy: Executor = async (raw, env) => {
  const args = raw as ApproveStrategyArgs;
  const href = prospectHref(args.prospectId);

  // Re-read through the session client, now. Everything below is about the
  // row as it is at this moment, not as it was when the card was drawn.
  const { data, error } = await env.supabase
    .from("strategy_runs")
    .select("id, prospect_id, status, strategy, organization_intel, approved_strategy, created_at")
    .eq("id", args.runId)
    .maybeSingle();
  if (error) return READ_FAILED("That strategy");
  if (!data) return NOT_FOUND("That strategy");
  const run = data as {
    id: string;
    prospect_id: string;
    status: string;
    strategy: unknown;
    organization_intel: unknown;
    approved_strategy: unknown;
  };

  // (1) The run belongs to the prospect named. The entry point never checks.
  if (run.prospect_id !== args.prospectId) {
    return refuse("wrong_prospect", "That strategy belongs to a different prospect than the one named, so nothing was approved.", href);
  }
  // (2) It is waiting for review.
  if (run.status !== "ready_for_review") {
    return refuse("not_ready", "That strategy is not waiting for review (it is still being built, or it failed), so it cannot be approved.", href);
  }
  // (3) It has not already been approved -- a second approval would silently
  // overwrite the first.
  if (run.approved_strategy !== null && run.approved_strategy !== undefined) {
    return refuse("already_approved", "That strategy has already been approved, so nothing was changed.", href);
  }
  // (4) It is the prospect's LATEST run -- the one the panel, the drafting
  // gate and the review count all treat as current.
  const { data: latestRows, error: latestError } = await env.supabase
    .from("strategy_runs")
    .select("id, created_at")
    .eq("prospect_id", args.prospectId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latestError) return READ_FAILED("That prospect's strategies");
  const latest = ((latestRows ?? [])[0] ?? null) as { id: string } | null;
  if (!latest || latest.id !== run.id) {
    return refuse("not_latest", "A newer strategy exists for this prospect, so this one is out of date and was not approved. Ask to see the current one.", href);
  }
  if (!run.strategy || typeof run.strategy !== "object" || !run.organization_intel || typeof run.organization_intel !== "object") {
    return refuse("no_proposal", "That run holds no proposed strategy to approve.", href);
  }

  return {
    prepared: {
      subject: { table: "strategy_runs", id: run.id },
      previous: null,
      // Recomputed from the row just read; the choke point compares it with
      // the fingerprint the displayed card carried.
      liveFingerprint: strategyFingerprint(run.strategy, run.organization_intel),
      effect: async (ep) => {
        try {
          // The existing entry point, called with the STORED proposed strategy
          // and intel -- exactly what the page passes when a person edits
          // nothing. Not reimplemented.
          await ep.approveStrategy(run.id, args.prospectId, run.strategy as Strategy, run.organization_intel as OrganizationIntel);
        } catch (err) {
          return { ok: false, error: errorText(err, "The strategy could not be approved.") };
        }
        // Confirm the write took (approveStrategy returns nothing).
        const { data: after } = await env.supabase.from("strategy_runs").select("id, approved_strategy").eq("id", run.id).maybeSingle();
        const approvedNow = !!after && (after as { approved_strategy: unknown }).approved_strategy !== null;
        if (!approvedNow) return { ok: false, error: "The approval could not be confirmed. Check the prospect's Strategy tab before asking again." };
        return {
          ok: true,
          summary: "Approved the strategy exactly as it was shown. Nothing has been sent to anyone: drafting outreach from it is a separate step.",
          fields: [
            { label: "Strategy run", value: run.id },
            { label: "Approved version", value: `fingerprint ${args.fingerprint.slice(0, 12)}…` },
          ],
          modelResult: { prospectId: args.prospectId, runId: run.id, approved: true },
          result: { runId: run.id, fingerprint: args.fingerprint },
          subject: { table: "strategy_runs", id: run.id },
          href,
        };
      },
    },
  };
};

// --- approve_draft (GATE) -----------------------------------------------------------------------------

const approveDraft: Executor = async (raw, env) => {
  const args = raw as ApproveDraftArgs;
  const href = prospectHref(args.prospectId);
  const { row, failed } = await loadDraft(env, args.draftId);
  if (failed) return READ_FAILED("That draft");
  if (!row) return NOT_FOUND("That draft");

  if (row.prospect_id !== args.prospectId) {
    return refuse("wrong_prospect", "That draft belongs to a different prospect than the one named, so nothing was approved.", href);
  }
  if (row.sent_at) return refuse("already_sent", "That draft has already been delivered, so there is nothing to approve.", href);
  // approveDraft itself has no status guard and would happily re-stamp an
  // approved draft; "still a draft" is checked here.
  if (row.status !== "draft") return refuse("not_a_draft", "That draft is not waiting for review (it is already approved), so nothing was changed.", href);
  const content = row.content ?? "";
  if (content.trim() === "") return refuse("empty", "That draft has no text, so there is nothing to approve.", href);

  return {
    prepared: {
      subject: { table: "drafts", id: row.id },
      previous: { status: "draft" },
      liveFingerprint: draftFingerprint({ kind: row.kind, subject: row.subject, content }),
      effect: async (ep) => {
        try {
          await ep.approveDraft(row.id, args.prospectId);
        } catch (err) {
          return { ok: false, error: errorText(err, "The draft could not be approved.") };
        }
        // approveDraft changes only the status, with no predicate on content:
        // a person editing the same draft in another tab in the instant
        // between the read above and that write would have the edited text
        // approved. Narrow, not impossible -- so confirm, and say so if it
        // happened rather than report a clean approval.
        const { data: after } = await env.supabase.from("drafts").select(DRAFT_COLUMNS).eq("id", row.id).maybeSingle();
        const live = after as DraftRow | null;
        let warning: string | undefined;
        if (!live || live.status !== "approved") {
          return { ok: false, error: "The approval could not be confirmed. Check the draft before asking again." };
        }
        if (draftFingerprint({ kind: live.kind, subject: live.subject, content: live.content }) !== args.fingerprint) {
          warning = "The draft's text changed at the same moment it was approved, so the approved text is not exactly what was shown. Review it, and reopen it for editing if it is wrong.";
        }
        return {
          ok: true,
          summary: "Approved the draft exactly as it was shown. Approving is not sending: nothing has gone to anyone. Delivering it is a separate step, on the prospect's page, with its own confirmation.",
          fields: [
            { label: "Draft", value: draftKindLabel(row.kind) },
            ...(row.subject ? [{ label: "Subject", value: row.subject }] : []),
            { label: "Approved version", value: `fingerprint ${args.fingerprint.slice(0, 12)}…` },
          ],
          modelResult: { prospectId: args.prospectId, draftId: row.id, draftStatus: "approved" },
          result: { draftId: row.id, fingerprint: args.fingerprint, ...(warning ? { warning } : {}) },
          subject: { table: "drafts", id: row.id },
          href,
          warning,
        };
      },
    },
  };
};

export const COMMAND_EXECUTORS: Readonly<Record<string, Executor>> = {
  add_prospect: addProspect,
  edit_draft: editDraft,
  revise_draft_with_feedback: reviseDraft,
  push_back_on_strategy: pushBack,
  generate_outreach_draft: generateDraft,
  unapprove_draft: unapproveDraft,
  log_prospect_interaction: logProspectInteraction,
  set_prospect_next_action: setNextAction,
  log_supporter_interaction: logSupporterInteraction,
  set_prospect_ask_amount: setAskAmount,
  approve_strategy: approveStrategy,
  approve_draft: approveDraft,
};
