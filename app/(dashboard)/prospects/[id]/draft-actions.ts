"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary } from "@/lib/channel-match";
import { channelLabel } from "@/lib/prospects";
import type { Strategy } from "@/lib/strategy";
import type { OrgProfile } from "@/lib/organization";
import type { OutreachDraftKind } from "@/lib/drafts";
import { beginRun, finalizeRun, newUsage, addResponseUsage } from "@/lib/ai-runs";

// kind is the OUTREACH vocabulary only (intro_email | call_prep): the
// proposal kind has its own action below with its own inputs and its own
// ai_runs operation, so it cannot route through this one.
export async function generateDraft(prospectId: string, strategyRunId: string, kind: OutreachDraftKind) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
  if (!prospect) throw new Error("Prospect not found");

  const { data: run } = await supabase.from("strategy_runs").select("*").eq("id", strategyRunId).single();
  if (!run || !run.approved_strategy) {
    throw new Error("Strategy must be approved before drafting outreach content.");
  }
  const strategy = run.approved_strategy as Strategy;

  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

  const isEmail = kind === "intro_email";

  // Run ledger (ruling 0026): birth before the model call. beginRun throws
  // if the record cannot be written, and then the operation does not run.
  // The drafts row does not exist yet (and source facts are frozen at
  // birth), so the reference points at the prospect being drafted for.
  const aiRunId = await beginRun(supabase, { operation: "draft", sourceTable: "prospects", sourceId: prospectId });
  const usage = newUsage();
  try {
    const response = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 1500,
    tools: [
      {
        name: "submit_draft",
        description: isEmail ? "Submit the drafted intro email." : "Submit the call prep notes.",
        input_schema: {
          type: "object",
          properties: isEmail
            ? {
                subject: { type: "string", description: "Email subject line" },
                content: { type: "string", description: "Full email body" },
              }
            : {
                content: {
                  type: "string",
                  description: "Call prep notes/talking points for the human caller, not a script to read verbatim",
                },
              },
          required: isEmail ? ["subject", "content"] : ["content"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_draft" },
    messages: [
      {
        role: "user",
        content: `Draft ${isEmail ? "an introductory outreach email" : "call prep notes"} for approaching "${prospect.name}" (${channelLabel(prospect.channel)} channel), based on the approved strategy below.

${isEmail ? `Write in a warm, professional, concise tone appropriate to a first outreach email -- it should open the door to a conversation, not close the ask. Write it directly in first person, as if from the person actually sending it. Do not use "on behalf of" or similar third-party framing -- the sender is writing for themselves, not relaying a message for someone else.

Signature block: never include a placeholder or written-out email address -- the recipient will already see the real sender's address in the email's own "From" field, so restating it in the signature is redundant. Only include a phone number in the signature if a real one is given in the "Key people" data below for the person signing -- if no real phone number is available for them, omit the phone line entirely rather than inventing a placeholder like "[Phone Number]".` : "Write as bullet-point talking points a human will glance at right before/during the call -- not a script."}

Approved strategy:
- Outreach approach: ${strategy.outreach_approach}
- Ask positioning: ${strategy.ask_positioning}
- Rationale: ${strategy.rationale}
- Key talking points: ${strategy.key_talking_points?.join("; ") || "(none)"}
- Evidence to highlight: ${strategy.evidence_to_highlight?.join("; ") || "(none)"}

Nonprofit context:
${profile ? buildProfileSummary(profile) : "(no profile data)"}

Contact: ${prospect.contact_name || "(no named contact)"}${prospect.contact_email ? ` <${prospect.contact_email}>` : ""}`,
      },
    ],
  });

    addResponseUsage(usage, response);

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return a structured draft. Try again.");
    }

    const result = toolUse.input as { subject?: string; content?: string };

    const { error } = await supabase.from("drafts").insert({
      prospect_id: prospectId,
      strategy_run_id: strategyRunId,
      kind,
      subject: isEmail ? result.subject || "" : null,
      content: result.content || "",
      status: "draft",
      model: DRAFT_MODEL,
      created_by: user.id,
    });
    if (error) throw new Error(error.message);

    await finalizeRun(supabase, aiRunId, {
      outcome: "completed",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  } catch (err) {
    // Null token counts mean no response ever arrived -- a fact, not a
    // zero. finalizeRun never throws, so the operation's own error is what
    // the caller sees, unmasked.
    await finalizeRun(supabase, aiRunId, {
      outcome: "failed",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      errorNote: err instanceof Error ? err.message : "Draft generation failed",
    });
    throw err;
  }

  revalidatePath(`/prospects/${prospectId}`);
}

// The full grant-proposal draft (STATE item 63, workflow step 6). Same
// machinery as generateDraft -- approved strategy required, birth before
// the model call, the draft lands in review state -- with two additions:
//
//   Evidence by id (the capture pattern): the model is handed the
//   verified + approved-permission evidence pool WITH each item's id,
//   told to ground outcome claims only in listed items, and required to
//   report which ids it used (evidence_cited) -- selecting from what the
//   system holds, never inventing evidence. The items the approved
//   strategy already selected (strategy_runs.evidence_item_ids) are
//   flagged in the list as the human-endorsed ones to feature. An item
//   the strategy cited but that has since lost verified/approved status
//   is NOT re-included: the pool query is the permission gate.
//
//   A distinct operation ('proposal_draft'): decision 0006 prices per
//   operation, and a proposal is not an intro email.
//
// A proposal is NEVER sendable: evaluateSendReadiness refuses any kind
// but intro_email, and the panel renders no send control for it.
//
// Errors are returned, not thrown -- production redacts thrown
// server-action messages (the composeDraft convention; generateDraft
// predates it and is untouched here).
export async function generateProposalDraft(
  prospectId: string,
  strategyRunId: string
): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Fail closed BEFORE any model call when migration 0071 is not applied:
  // filtering the enum column by 'proposal' errors (invalid enum input)
  // while the value does not exist, and then no tokens are spent on a
  // draft that could never be stored.
  const { error: kindProbeError } = await supabase.from("drafts").select("id").eq("kind", "proposal").limit(1);
  if (kindProbeError) {
    return { error: `Proposal drafting is not available on this database yet (is migration 0071 applied?): ${kindProbeError.message}` };
  }

  const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
  if (!prospect) return { error: "Prospect not found." };

  const { data: run } = await supabase.from("strategy_runs").select("*").eq("id", strategyRunId).single();
  if (!run || !run.approved_strategy) {
    return { error: "Strategy must be approved before drafting a proposal." };
  }
  const strategy = run.approved_strategy as Strategy;
  const strategyEvidenceIds = new Set<string>(Array.isArray(run.evidence_item_ids) ? run.evidence_item_ids : []);

  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

  // The same permission gate the strategy prompt uses: only evidence a
  // human has verified AND marked approved is eligible to be cited to a
  // funder (see verifyEvidenceItem in app/(dashboard)/evidence/actions.ts).
  const { data: evidenceRows } = await supabase
    .from("evidence_items")
    .select("id, title, description, type, program, geography")
    .not("verified_at", "is", null)
    .eq("permission", "approved");
  const evidencePool = evidenceRows ?? [];

  // Run ledger (ruling 0026): birth before the model call, as a DISTINCT
  // operation. The drafts row does not exist yet, so the reference points
  // at the prospect being drafted for (generateDraft's reasoning).
  const aiRunId = await beginRun(supabase, { operation: "proposal_draft", sourceTable: "prospects", sourceId: prospectId });
  const usage = newUsage();
  try {
    const response = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        max_tokens: 4000,
        tools: [
          {
            name: "submit_proposal",
            description: "Submit the drafted grant proposal.",
            input_schema: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description:
                    "The full grant proposal, ready for human review: title, need statement, program description, outcomes, ask, and closing. Plain text with clear section headings.",
                },
                evidence_cited: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "IDs (from the Available evidence list) of every evidence item the proposal's outcome claims are grounded in. Only ids from that list -- never invent one. Empty if the list is empty or nothing fit.",
                },
              },
              required: ["content", "evidence_cited"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "submit_proposal" },
        messages: [
          {
            role: "user",
            content: `Draft a full grant proposal for "${prospect.name}" (${channelLabel(prospect.channel)} channel), based on the approved strategy below.

Write it as a complete, submission-ready proposal document a human will review and edit: a title, a statement of need, a program description, expected outcomes, the ask, and a closing. Warm, concrete, professional. Position the ask exactly as the approved strategy does -- do not invent an ask amount the strategy does not state.

Ground every outcome, metric, or story you assert in an item from the Available evidence list below, and report the ids you used in evidence_cited. Never invent an outcome, a figure, or a testimonial: if no listed evidence supports a claim, do not make the claim. Items marked [cited in the approved strategy] were already chosen by a human for this funder -- prefer them.

Approved strategy:
- Outreach approach: ${strategy.outreach_approach}
- Ask positioning: ${strategy.ask_positioning}
- Rationale: ${strategy.rationale}
- Key talking points: ${strategy.key_talking_points?.join("; ") || "(none)"}
- Evidence to highlight: ${strategy.evidence_to_highlight?.join("; ") || "(none)"}

Nonprofit context:
${profile ? buildProfileSummary(profile) : "(no profile data)"}

Available evidence (verified, approved for use -- cite by id in evidence_cited):
${
  evidencePool.length > 0
    ? evidencePool
        .map(
          (e) =>
            `- ${e.id}: [${e.type}]${strategyEvidenceIds.has(e.id) ? " [cited in the approved strategy]" : ""} ${e.title} -- ${e.description}${e.program ? ` (program: ${e.program})` : ""}${e.geography ? ` (geography: ${e.geography})` : ""}`
        )
        .join("\n")
    : "(no verified evidence available yet -- make no outcome claims beyond the strategy's own talking points)"
}`,
          },
        ],
      },
      { timeout: 100_000 }
    );

    addResponseUsage(usage, response);

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return a structured proposal. Try again.");
    }

    const result = toolUse.input as { content?: string; evidence_cited?: unknown };
    const content = (result.content ?? "").trim();

    // Defensive against the AI citing an id outside the pool it was given
    // (the strategy action's guard, same spirit). A dropped id is logged,
    // not silently discarded -- and note the validated set is currently
    // logged only: drafts has no evidence_item_ids column, and adding one
    // was not authorized by item 63 (escalated in the build report).
    const evidencePoolIds = new Set(evidencePool.map((e) => e.id));
    const citedRaw = Array.isArray(result.evidence_cited) ? result.evidence_cited : [];
    const cited = citedRaw.filter((id): id is string => typeof id === "string" && evidencePoolIds.has(id));
    const dropped = citedRaw.filter((id) => typeof id !== "string" || !evidencePoolIds.has(id));
    console.log(
      `[proposal] model cited ${cited.length} evidence item(s)${cited.length ? `: ${cited.join(", ")}` : ""}` +
        (dropped.length ? `; dropped ${dropped.length} id(s) not in the pool: ${dropped.join(", ")}` : "")
    );

    if (!content) {
      // The model ran and produced nothing a human could review -- the
      // strategy action's "empty" outcome, not a completed run.
      await finalizeRun(supabase, aiRunId, {
        outcome: "empty",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      return { error: "The AI returned an empty proposal. Try again." };
    }

    const { error } = await supabase.from("drafts").insert({
      prospect_id: prospectId,
      strategy_run_id: strategyRunId,
      kind: "proposal",
      subject: null,
      content,
      status: "draft",
      model: DRAFT_MODEL,
      created_by: user.id,
    });
    if (error) throw new Error(error.message);

    await finalizeRun(supabase, aiRunId, {
      outcome: "completed",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  } catch (err) {
    // Null token counts mean no response ever arrived -- a fact, not a
    // zero. The error is RETURNED (not rethrown): production redacts
    // thrown server-action messages, and the refusal is what the human
    // needs to see.
    await finalizeRun(supabase, aiRunId, {
      outcome: "failed",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      errorNote: err instanceof Error ? err.message : "Proposal generation failed",
    });
    return { error: err instanceof Error ? err.message : "Proposal generation failed." };
  }

  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true };
}

// A human-composed email draft (STATE item 60): no strategy required, no
// AI call -- and therefore no ai_runs row, because ruling 0026 covers
// model calls and this makes none. The inserted row is an ordinary draft:
// it takes the exact same downstream path as a generated one (review,
// explicit approval, the one confirmed send of ruling 0029 -- none of
// that machinery is touched here). Refusals RETURN plain messages instead
// of throwing, because production redacts thrown server-action errors.
export async function composeDraft(
  prospectId: string,
  subject: string,
  content: string
): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const trimmedSubject = subject.trim();
  const trimmedContent = content.trim();
  if (!trimmedSubject) return { error: "Give the email a subject before saving." };
  if (!trimmedContent) return { error: "Write the email body before saving." };

  const { data: prospect } = await supabase.from("prospects").select("id").eq("id", prospectId).single();
  if (!prospect) return { error: "Prospect not found." };

  // Same insert shape as generateDraft, minus what only an AI draft has:
  // no strategy_run_id (there may be no strategy at all) and no model --
  // a null model is the honest record that no model wrote this. Org
  // scoping is identical to generateDraft's insert: organization_id
  // defaults to my_organization_id() in the database (hard rule 6).
  const { error } = await supabase.from("drafts").insert({
    prospect_id: prospectId,
    kind: "intro_email",
    subject: trimmedSubject,
    content: trimmedContent,
    status: "draft",
    created_by: user.id,
  });
  if (error) return { error: error.message };

  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true };
}

export async function updateDraft(draftId: string, prospectId: string, subject: string | null, content: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("drafts")
    .update({ subject, content, updated_at: new Date().toISOString() })
    .eq("id", draftId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
}

export async function approveDraft(draftId: string, prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("drafts")
    .update({ status: "approved", approved_by: user.id, approved_at: new Date().toISOString() })
    .eq("id", draftId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
}

export async function deleteDraft(draftId: string, prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("drafts").delete().eq("id", draftId);
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
}
