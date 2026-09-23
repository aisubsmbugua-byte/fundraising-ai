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
import { parseDeckOutline, ensureOutlineHeader, ensureProposalOutlineHeader } from "@/lib/deck-outline";
import { todaysDateLabel, fillDatePlaceholders } from "@/lib/draft-dates";
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
// STATE item 71: the proposal's CONTENT is now the same lightweight
// structured markup lib/deck-outline.ts defines for decks ("# " section
// headings, plain paragraph/bullet lines, "> evidence: <id>" citations,
// with letterhead lines like "Submitted to:"/"Date:" as plain body text
// before the first "#") instead of free-form prose with ALL-CAPS
// headers -- one shared parser (parseDeckOutline) serves both kinds, and
// the proposal render view (app/prospects/[id]/proposal/[draftId]/page.tsx)
// parses it exactly as deterministically as the deck view parses an
// outline. ensureProposalOutlineHeader prepends the format's own
// self-documentation in CODE, same guarantee as the deck's
// ensureOutlineHeader. The evidence_cited tool field and its validation
// below are UNCHANGED from item 63 -- this only changes what the model
// writes into `content`, not how evidence_cited is captured or checked.
// Existing proposal drafts already stored in the old prose format are not
// migrated: they simply won't parse into sections, which is expected.
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

  // STATE item 69, layer 1: today's real date, computed server-side and
  // handed to the model -- never asked for from the model's own notion of
  // "today".
  const todayLabel = todaysDateLabel();

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
                    'The full grant proposal in exactly this line format (the same format decks use): optional plain letterhead lines BEFORE the first "# " line (e.g. "Submitted to: ...", "Contact: ...", "Date: ..."); then a "# " line opens each section with its title (statement of need, program description, outcomes, the ask, closing); each plain line under a section is one paragraph or bullet; a line "> evidence: <id>" cites an evidence item in that section. No ALL-CAPS headers, no other markup. Do not write any explanatory header -- it is added automatically.',
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

Write it as a complete, submission-ready proposal document a human will review and edit, in the plain-text structured format: a few plain letterhead lines before the first "# " line (who it's submitted to, a contact, the date), then a "# " line per section covering a title, a statement of need, a program description, expected outcomes, the ask, and a closing, with short paragraph or bullet lines under each. Warm, concrete, professional. Position the ask exactly as the approved strategy does -- do not invent an ask amount the strategy does not state.

Today's date is ${todayLabel}. If the letterhead or any section includes a date, write exactly that date -- never a bracketed placeholder like "[Insert Date]" or "[Date]". A human is going to review this before it goes anywhere, and a placeholder left in reviewable output is a defect.

Ground every outcome, metric, or story you assert in an item from the Available evidence list below by adding a "> evidence: <id>" line to the section that uses it, with the id copied exactly from the list, AND report the same ids in evidence_cited. Never invent an outcome, a figure, a testimonial, or an evidence id: if no listed evidence supports a claim, do not make the claim. Items marked [cited in the approved strategy] were already chosen by a human for this funder -- prefer them.

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
    // STATE item 69, layer 2: even with the instruction above, replace any
    // bracketed date placeholder the model wrote anyway with today's real
    // date -- the safety net that does not depend on the model complying.
    const content = fillDatePlaceholders((result.content ?? "").trim(), todayLabel);

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
      // The format's self-documentation is prepended in code, so every
      // stored proposal explains itself in the editor -- never left to
      // the model to remember (same guarantee as the deck outline's
      // ensureOutlineHeader, worded for a document instead of a deck).
      content: ensureProposalOutlineHeader(content),
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

// The pitch-deck outline (STATE item 66, decision 0007 phase 3's second
// half). generateProposalDraft's machinery exactly -- approved strategy
// required, org profile, the permission-gated evidence pool handed over
// WITH ids, birth before the model call as a DISTINCT ai_runs operation
// ('deck_draft'), fail-closed enum probe before any tokens are spent,
// errors returned not thrown -- with one difference in the artifact:
//
//   The model produces a structured OUTLINE in the plain-text format
//   lib/deck-outline.ts defines (# title lines, bullet lines,
//   "> evidence: <id>" citations). A human shapes and approves it in the
//   ordinary draft editor, and the deck view renders the APPROVED text
//   deterministically -- what was approved is what appears (rule 3 all
//   the way down). The format's explanatory header is prepended HERE, in
//   code (ensureOutlineHeader), never trusted to the model.
//
//   Cited ids are captured IN the outline text itself ("> evidence:"
//   lines), so validation parses them back out with the same shared
//   parser the renderer uses and checks them against the pool the model
//   was given -- one copy of the fact, not a second model-typed list that
//   could disagree. An unknown id is logged and KEPT in the text (never
//   silently dropped): the human sees it in review, and the deck view
//   renders it as explicitly unresolved.
//
// A deck is NEVER sendable: evaluateSendReadiness refuses any kind but
// intro_email, and the panel renders no send control for it.
export async function generateDeckOutline(
  prospectId: string,
  strategyRunId: string
): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Fail closed BEFORE any model call when migration 0072 is not applied:
  // filtering the enum column by 'deck' errors (invalid enum input) while
  // the value does not exist, and then no tokens are spent on an outline
  // that could never be stored.
  const { error: kindProbeError } = await supabase.from("drafts").select("id").eq("kind", "deck").limit(1);
  if (kindProbeError) {
    return { error: `Deck drafting is not available on this database yet (is migration 0072 applied?): ${kindProbeError.message}` };
  }

  const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
  if (!prospect) return { error: "Prospect not found." };

  const { data: run } = await supabase.from("strategy_runs").select("*").eq("id", strategyRunId).single();
  if (!run || !run.approved_strategy) {
    return { error: "Strategy must be approved before drafting a deck outline." };
  }
  const strategy = run.approved_strategy as Strategy;
  const strategyEvidenceIds = new Set<string>(Array.isArray(run.evidence_item_ids) ? run.evidence_item_ids : []);

  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

  // The same permission gate the strategy and proposal prompts use: only
  // evidence a human has verified AND marked approved is eligible to be
  // cited to a funder.
  const { data: evidenceRows } = await supabase
    .from("evidence_items")
    .select("id, title, description, type, program, geography")
    .not("verified_at", "is", null)
    .eq("permission", "approved");
  const evidencePool = evidenceRows ?? [];

  // STATE item 69, layer 1: same as generateProposalDraft -- a title
  // slide is the plausible place a date placeholder would show up here,
  // so the outline gets the same real date handed to the model.
  const todayLabel = todaysDateLabel();

  // Run ledger (ruling 0026): birth before the model call, as a DISTINCT
  // operation. The drafts row does not exist yet, so the reference points
  // at the prospect being drafted for (generateDraft's reasoning).
  const aiRunId = await beginRun(supabase, { operation: "deck_draft", sourceTable: "prospects", sourceId: prospectId });
  const usage = newUsage();
  try {
    const response = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        max_tokens: 3000,
        tools: [
          {
            name: "submit_deck_outline",
            description: "Submit the drafted pitch-deck outline.",
            input_schema: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description:
                    'The deck outline as plain text in exactly this line format: a line starting "# " opens a new slide with that title; each plain line under it is one bullet point on that slide; a line "> evidence: <id>" cites an evidence item on that slide. No other markup. Do not write any explanatory header -- it is added automatically.',
                },
              },
              required: ["content"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "submit_deck_outline" },
        messages: [
          {
            role: "user",
            content: `Draft a pitch-deck outline for "${prospect.name}" (${channelLabel(prospect.channel)} channel), based on the approved strategy below.

Write it in the plain-text outline format: a "# " line per slide title, short bullet lines under each, and "> evidence: <id>" lines citing evidence. A human will edit and approve this outline before any deck is shown, so keep bullets short and concrete -- talking points, not paragraphs. Aim for roughly 6 to 10 slides covering: a title slide, the need, the program, outcomes, the ask, and next steps. Position the ask exactly as the approved strategy does -- do not invent an ask amount the strategy does not state.

Today's date is ${todayLabel}. If any slide includes a date (for example, the title slide), write exactly that date -- never a bracketed placeholder like "[Insert Date]" or "[Date]". A human is going to review this before it goes anywhere, and a placeholder left in reviewable output is a defect.

Ground every outcome, metric, or story you assert in an item from the Available evidence list below by adding a "> evidence: <id>" line to the slide that uses it, with the id copied exactly from the list. Never invent an outcome, a figure, a testimonial, or an evidence id: if no listed evidence supports a claim, do not make the claim. Items marked [cited in the approved strategy] were already chosen by a human for this funder -- prefer them.

Approved strategy:
- Outreach approach: ${strategy.outreach_approach}
- Ask positioning: ${strategy.ask_positioning}
- Rationale: ${strategy.rationale}
- Key talking points: ${strategy.key_talking_points?.join("; ") || "(none)"}
- Evidence to highlight: ${strategy.evidence_to_highlight?.join("; ") || "(none)"}

Nonprofit context:
${profile ? buildProfileSummary(profile) : "(no profile data)"}

Available evidence (verified, approved for use -- cite by id in "> evidence:" lines):
${
  evidencePool.length > 0
    ? evidencePool
        .map(
          (e) =>
            `- ${e.id}: [${e.type}]${strategyEvidenceIds.has(e.id) ? " [cited in the approved strategy]" : ""} ${e.title} -- ${e.description}${e.program ? ` (program: ${e.program})` : ""}${e.geography ? ` (geography: ${e.geography})` : ""}`
        )
        .join("\n")
    : "(no verified evidence available yet -- make no outcome claims beyond the strategy's own talking points, and cite nothing)"
}`,
          },
        ],
      },
      { timeout: 100_000 }
    );

    addResponseUsage(usage, response);

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return a structured deck outline. Try again.");
    }

    const result = toolUse.input as { content?: string };
    // STATE item 69, layer 2: the safety net, same as generateProposalDraft
    // -- replace any bracketed date placeholder the model wrote anyway with
    // today's real date, before the outline is parsed or stored. Applied
    // before parsing: the placeholder pattern (a bracketed span) never
    // collides with "> evidence: <id>" or "# " lines, so citation parsing
    // is unaffected.
    const content = fillDatePlaceholders((result.content ?? "").trim(), todayLabel);

    // Cited ids come back INSIDE the outline text; parse them out with the
    // same shared parser the deck view renders with (one definition, no
    // drift) and validate against the pool the model was handed. Unknown
    // ids are logged and stay in the text -- the human reviewing the
    // outline sees exactly what the model wrote, and the renderer marks
    // an unresolvable citation instead of hiding it.
    const evidencePoolIds = new Set(evidencePool.map((e) => e.id));
    const citedInOutline = parseDeckOutline(content).evidenceIds;
    const cited = citedInOutline.filter((id) => evidencePoolIds.has(id));
    const unknown = citedInOutline.filter((id) => !evidencePoolIds.has(id));
    console.log(
      `[deck] model cited ${cited.length} evidence item(s)${cited.length ? `: ${cited.join(", ")}` : ""}` +
        (unknown.length ? `; ${unknown.length} id(s) not in the pool (kept in the outline for human review): ${unknown.join(", ")}` : "")
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
      return { error: "The AI returned an empty deck outline. Try again." };
    }

    const { error } = await supabase.from("drafts").insert({
      prospect_id: prospectId,
      strategy_run_id: strategyRunId,
      kind: "deck",
      subject: null,
      // The format's self-documentation is prepended in code, so every
      // stored outline explains itself in the editor -- never left to the
      // model to remember.
      content: ensureOutlineHeader(content),
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
      errorNote: err instanceof Error ? err.message : "Deck outline generation failed",
    });
    return { error: err instanceof Error ? err.message : "Deck outline generation failed." };
  }

  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true };
}

// Feedback that gets incorporated (STATE item 70): a human reviewing an
// unapproved proposal or deck outline can ask the AI to revise it with
// notes, instead of hand-editing or starting over. Re-grounds EXACTLY
// like the original generation for that kind (generateProposalDraft /
// generateDeckOutline above) -- approved strategy re-verified, org
// profile, the SAME permission-gated evidence pool handed over with ids,
// cited ids validated the same way -- PLUS the draft's current content
// and the human's feedback, so the model revises in place rather than
// starting from nothing. The grounding instruction is reused, not
// weakened: "feedback about tone, structure, or emphasis is never
// license to loosen it" is said explicitly in the prompt below.
//
// Refuses, in this order: draft not found; status 'approved' (item 67's
// guard, extended here -- an approved draft's content is locked, so a
// revision needs the same un-approve-first path as a hand edit); kind
// outside ('proposal', 'deck') -- intro_email/call_prep are not
// evidence-cited, strategy-grounded artifacts, so there is nothing here
// to re-ground; empty/whitespace-only feedback.
//
// Two distinct ai_runs operations, 'proposal_revise' and 'deck_revise'
// (lib/ai-runs.ts) -- following generateProposalDraft/generateDeckOutline's
// own precedent of one operation per kind (decision 0006 prices per
// operation), rather than a single 'draft_revise' tagged by kind: the
// existing set already has two entries per artifact type (X_draft,
// X_revise mirrors that shape) and AI_RUN_OPERATIONS is a short, flat
// list, not something two more entries meaningfully burden.
//
// No new enum probe: 'proposal' and 'deck' are only reachable in this
// action at all because a drafts ROW with that kind already exists (the
// re-read below selects it) -- and drafts.kind is a REAL Postgres enum
// (migration 0017, widened by 0071/0072), so a stored row with that
// value is already proof the enum literal exists; an unapplied migration
// would have made the ORIGINAL insert impossible, not this one. The
// ai_runs.operation column, unlike drafts.kind, is unconstrained text
// (lib/ai-runs.ts's own comment) -- there is no database enum for
// 'proposal_revise'/'deck_revise' to be probed against in the first
// place.
//
// On success, `content` is overwritten in place and status is NEVER
// touched -- a revision is not an approval. The write is predicated on
// status 'draft' (item 67's race-proof style), so an approve landing
// between the re-read above and this write makes the revision a no-op,
// exactly like updateDraft's own edit-vs-approve race. Errors are
// RETURNED, not thrown (the composeDraft/generateProposalDraft
// convention: production redacts thrown server-action messages).
//
// Deck-specific (STATE item 70 clause 5): the revised text is parsed with
// the SAME shared parser the deck view renders with (lib/deck-outline.ts)
// before it is stored. A revision that stops using "# " title lines
// entirely -- prose instead of an outline -- breaks the format contract
// the deck view depends on, and is refused before it overwrites a
// reviewable draft with something that no longer behaves like an
// outline.
export async function reviseDraftWithFeedback(
  draftId: string,
  feedback: string
): Promise<{ ok: true; content: string } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Re-read the draft's CURRENT row server-side (item 67's rule: the
  // client's belief about status is never trusted). Every fact this
  // action needs -- prospect, strategy run, kind, current content -- is
  // re-derived from this one row, never passed in from the client.
  const { data: draft, error: draftError } = await supabase
    .from("drafts")
    .select("id, kind, status, content, strategy_run_id, prospect_id")
    .eq("id", draftId)
    .single();
  if (draftError || !draft) return { error: "Draft not found." };

  if (draft.status === "approved") {
    return {
      error:
        "This draft has been approved, so its content is locked to exactly what was approved. Revising it requires un-approving it first — use the Un-approve button on the draft's card, which reopens editing.",
    };
  }

  if (draft.kind !== "proposal" && draft.kind !== "deck") {
    return { error: "Only a grant proposal or a deck outline can be revised with feedback here." };
  }

  const trimmedFeedback = feedback.trim();
  if (!trimmedFeedback) {
    return { error: "Write feedback for the AI to address before revising." };
  }

  const prospectId = draft.prospect_id as string;
  const isDeck = draft.kind === "deck";

  // Approved strategy, re-verified here rather than trusted from the
  // draft's mere existence -- an approval can in principle be reversed
  // between the original generation and this revision.
  const { data: run } = await supabase
    .from("strategy_runs")
    .select("*")
    .eq("id", draft.strategy_run_id ?? "")
    .maybeSingle();
  if (!run || !run.approved_strategy) {
    return { error: "Strategy must be approved before revising this draft." };
  }
  const strategy = run.approved_strategy as Strategy;
  const strategyEvidenceIds = new Set<string>(Array.isArray(run.evidence_item_ids) ? run.evidence_item_ids : []);

  const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
  if (!prospect) return { error: "Prospect not found." };

  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

  // The same permission gate generateProposalDraft/generateDeckOutline
  // use: only evidence a human has verified AND marked approved is
  // eligible to be cited to a funder.
  const { data: evidenceRows } = await supabase
    .from("evidence_items")
    .select("id, title, description, type, program, geography")
    .not("verified_at", "is", null)
    .eq("permission", "approved");
  const evidencePool = evidenceRows ?? [];
  const evidencePoolIds = new Set(evidencePool.map((e) => e.id));

  const evidenceListText =
    evidencePool.length > 0
      ? evidencePool
          .map(
            (e) =>
              `- ${e.id}: [${e.type}]${strategyEvidenceIds.has(e.id) ? " [cited in the approved strategy]" : ""} ${e.title} -- ${e.description}${e.program ? ` (program: ${e.program})` : ""}${e.geography ? ` (geography: ${e.geography})` : ""}`
          )
          .join("\n")
      : `(no verified evidence available yet -- make no outcome claims beyond the strategy's own talking points${isDeck ? ", and cite nothing" : ""})`;

  // STATE item 69's discipline carried into the revision prompt too: a
  // revision is exactly the kind of pass where a stray "[Insert Date]"
  // could get reintroduced or left untouched.
  const todayLabel = todaysDateLabel();

  // Two literal call sites, not a ternary: ruling 0026's closed-set scan
  // proves instrumentation by finding the literal string `operation:
  // "..."` at each model-calling site (scripts/test-ai-runs.ts). A
  // ternary is correct at runtime but invisible to that literal-string
  // proof -- the scan is the guarantee, not the reader's trust that the
  // ternary was written correctly.
  const aiRunId = isDeck
    ? await beginRun(supabase, { operation: "deck_revise", sourceTable: "prospects", sourceId: prospectId })
    : await beginRun(supabase, { operation: "proposal_revise", sourceTable: "prospects", sourceId: prospectId });
  const usage = newUsage();
  try {
    const response = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        max_tokens: isDeck ? 3000 : 4000,
        tools: [
          isDeck
            ? {
                name: "submit_deck_outline",
                description: "Submit the revised pitch-deck outline.",
                input_schema: {
                  type: "object",
                  properties: {
                    content: {
                      type: "string",
                      description:
                        'The revised deck outline as plain text in exactly this line format: a line starting "# " opens a new slide with that title; each plain line under it is one bullet point on that slide; a line "> evidence: <id>" cites an evidence item on that slide. No other markup. Do not write any explanatory header -- it is added automatically.',
                    },
                  },
                  required: ["content"],
                },
              }
            : {
                name: "submit_proposal",
                description: "Submit the revised grant proposal.",
                input_schema: {
                  type: "object",
                  properties: {
                    content: {
                      type: "string",
                      description:
                        'The full revised grant proposal in exactly this line format (the same format decks use, and the same format the original was drafted in): optional plain letterhead lines BEFORE the first "# " line (e.g. "Submitted to: ...", "Contact: ...", "Date: ..."); then a "# " line opens each section with its title; each plain line under a section is one paragraph or bullet; a line "> evidence: <id>" cites an evidence item in that section. No ALL-CAPS headers, no other markup. Do not write any explanatory header -- it is added automatically.',
                    },
                    evidence_cited: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "IDs (from the Available evidence list) of every evidence item the revised proposal's outcome claims are grounded in. Only ids from that list -- never invent one. Empty if the list is empty or nothing fit.",
                    },
                  },
                  required: ["content", "evidence_cited"],
                },
              },
        ],
        tool_choice: { type: "tool", name: isDeck ? "submit_deck_outline" : "submit_proposal" },
        messages: [
          {
            role: "user",
            content: `Revise the ${isDeck ? "pitch-deck outline" : "grant proposal"} below for "${prospect.name}" (${channelLabel(prospect.channel)} channel) to address the human's feedback. It was originally drafted from the same approved strategy given below -- keep following that strategy unless the feedback says otherwise.

${
  isDeck
    ? 'Keep the plain-text outline format exactly: a "# " line per slide title, short bullet lines under each, and "> evidence: <id>" lines citing evidence. Do not write any explanatory header -- it is added automatically.'
    : 'Keep the plain-text structured format exactly: optional plain letterhead lines before the first "# " line, then a "# " line per section (statement of need, program description, outcomes, the ask, closing) with short paragraph or bullet lines under each, and "> evidence: <id>" lines citing evidence in the section that uses it. No ALL-CAPS headers, no other markup. Warm, concrete, professional. Do not write any explanatory header -- it is added automatically.'
}

Today's date is ${todayLabel}. If the document includes a date, write exactly that date -- never a bracketed placeholder like "[Insert Date]" or "[Date]".

Ground every outcome, metric, or story you assert in an item from the Available evidence list below${isDeck ? ' by adding a "> evidence: <id>" line to the slide that uses it' : ", and report the ids you used in evidence_cited"}. Never invent an outcome, a figure, a testimonial${isDeck ? ", or an evidence id" : ""}: if no listed evidence supports a claim, do not make the claim. Position the ask exactly as the approved strategy does -- do not invent an ask amount the strategy does not state. This grounding rule applies to the revision exactly as it did to the original draft -- feedback about tone, structure, or emphasis is never license to loosen it.

Approved strategy:
- Outreach approach: ${strategy.outreach_approach}
- Ask positioning: ${strategy.ask_positioning}
- Rationale: ${strategy.rationale}
- Key talking points: ${strategy.key_talking_points?.join("; ") || "(none)"}
- Evidence to highlight: ${strategy.evidence_to_highlight?.join("; ") || "(none)"}

Nonprofit context:
${profile ? buildProfileSummary(profile) : "(no profile data)"}

Available evidence (verified, approved for use -- cite by id${isDeck ? ' in "> evidence:" lines' : " in evidence_cited"}):
${evidenceListText}

Current ${isDeck ? "outline" : "proposal"} (this is what a human reviewed and asked to change):
${draft.content}

Human feedback to address:
${trimmedFeedback}`,
          },
        ],
      },
      { timeout: 100_000 }
    );

    addResponseUsage(usage, response);

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error(`AI did not return a structured revised ${isDeck ? "deck outline" : "proposal"}. Try again.`);
    }

    let finalContent: string;

    if (isDeck) {
      const result = toolUse.input as { content?: string };
      const content = fillDatePlaceholders((result.content ?? "").trim(), todayLabel);

      if (!content) {
        await finalizeRun(supabase, aiRunId, {
          outcome: "empty",
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        return { error: "The AI returned an empty revised outline. Try again." };
      }

      // Cited ids come back INSIDE the outline text -- parsed with the
      // same shared parser the deck view renders with and validated
      // against the pool the model was handed, same as generateDeckOutline.
      const citedInOutline = parseDeckOutline(content).evidenceIds;
      const cited = citedInOutline.filter((id) => evidencePoolIds.has(id));
      const unknown = citedInOutline.filter((id) => !evidencePoolIds.has(id));
      console.log(
        `[deck revise] model cited ${cited.length} evidence item(s)${cited.length ? `: ${cited.join(", ")}` : ""}` +
          (unknown.length
            ? `; ${unknown.length} id(s) not in the pool (kept in the outline for human review): ${unknown.join(", ")}`
            : "")
      );

      // STATE item 70 clause 5: the outline contract must survive
      // revision. parseDeckOutline never throws -- any text parses into
      // SOME structure -- so "breaks the format" means the model stopped
      // using "# " title lines at all and wrote prose instead. That is
      // refused here, before it overwrites a reviewable draft with
      // something the deck view would render as one undifferentiated
      // slide rather than an outline.
      const candidate = ensureOutlineHeader(content);
      const parsed = parseDeckOutline(candidate);
      const hasTitledSlide = parsed.slides.some((s) => s.title !== null);
      if (!hasTitledSlide) {
        await finalizeRun(supabase, aiRunId, {
          outcome: "empty",
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        return {
          error:
            'The revised outline did not use any "# " slide-title lines, so the deck format was not preserved. It was not saved -- try again, or adjust the feedback.',
        };
      }

      finalContent = candidate;
    } else {
      const result = toolUse.input as { content?: string; evidence_cited?: unknown };
      const content = fillDatePlaceholders((result.content ?? "").trim(), todayLabel);

      if (!content) {
        await finalizeRun(supabase, aiRunId, {
          outcome: "empty",
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        return { error: "The AI returned an empty revised proposal. Try again." };
      }

      // Defensive against the AI citing an id outside the pool it was
      // given, same as generateProposalDraft -- checked both ways the
      // structured format can carry a citation: the evidence_cited array
      // and the inline "> evidence: <id>" lines the shared parser reads.
      const citedRaw = Array.isArray(result.evidence_cited) ? result.evidence_cited : [];
      const citedInline = parseDeckOutline(content).evidenceIds;
      const citedAll = new Set([...citedRaw.filter((id): id is string => typeof id === "string"), ...citedInline]);
      const cited = [...citedAll].filter((id) => evidencePoolIds.has(id));
      const dropped = [...citedAll].filter((id) => !evidencePoolIds.has(id));
      console.log(
        `[proposal revise] model cited ${cited.length} evidence item(s)${cited.length ? `: ${cited.join(", ")}` : ""}` +
          (dropped.length ? `; dropped ${dropped.length} id(s) not in the pool: ${dropped.join(", ")}` : "")
      );

      // STATE item 70 clause 5, extended to proposals per item 71's
      // format change: the structured contract must survive revision.
      // parseDeckOutline never throws, so "broke the format" means the
      // model stopped using "# " section-title lines and reverted to the
      // old free-form prose this action used to ask for -- refused before
      // it overwrites a reviewable proposal with something the proposal
      // view (item 71c) would render as one undifferentiated block.
      const candidate = ensureProposalOutlineHeader(content);
      const parsed = parseDeckOutline(candidate);
      const hasTitledSection = parsed.slides.some((s) => s.title !== null);
      if (!hasTitledSection) {
        await finalizeRun(supabase, aiRunId, {
          outcome: "empty",
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        return {
          error:
            'The revised proposal did not use any "# " section-title lines, so the structured format was not preserved. It was not saved -- try again, or adjust the feedback.',
        };
      }

      finalContent = candidate;
    }

    // Race-proof write, item 67's style: predicated on status 'draft', so
    // an approve landing between the re-read above and this write makes
    // the revision a no-op instead of overwriting approved content --
    // exactly updateDraft's own edit-vs-approve race, extended here.
    // Status is never touched: a revision is not an approval.
    const { error } = await supabase
      .from("drafts")
      .update({ content: finalContent, updated_at: new Date().toISOString() })
      .eq("id", draftId)
      .eq("status", "draft");
    if (error) throw new Error(error.message);

    await finalizeRun(supabase, aiRunId, {
      outcome: "completed",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    revalidatePath(`/prospects/${prospectId}`);
    return { ok: true, content: finalContent };
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
      errorNote: err instanceof Error ? err.message : "Draft revision failed",
    });
    return { error: err instanceof Error ? err.message : "Draft revision failed." };
  }
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

// STATE item 67: an approved draft is server-side immutable until it is
// un-approved. The CURRENT status is re-read here, at write time -- the
// client's belief about status is never trusted, because the UI hiding
// its edit controls on approved drafts is a courtesy, not a guard (a
// stale card, a second tab, or a hand-built request could all still
// reach this action). Sent drafts are already pinned at the database by
// migration 0069's trigger; these guards close the approved-but-unsent
// gap so the deck view and the send confirmation always show text a
// human actually approved. DB-level pinning of approved-but-unsent
// drafts is deliberately NOT here -- that is item 55's fuller decision.
//
// The refusals are RETURNED plain messages (the composeDraft
// convention: production redacts thrown server-action errors, and the
// refusal is what the human needs to see). The pre-existing DB-error
// throws below stay exactly as they were -- only the new refusals use
// the returned transport.
//
// The un-approve control the messages name is unapproveDraft below
// (STATE item 68) -- the one legal way back for an approved, unsent
// draft. Item 67's original escalation (no edit path at all once
// approved) is closed by it.

export async function updateDraft(
  draftId: string,
  prospectId: string,
  subject: string | null,
  content: string
): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Re-read the draft's CURRENT status server-side (item 67).
  const { data: existing, error: statusError } = await supabase
    .from("drafts")
    .select("status")
    .eq("id", draftId)
    .single();
  if (statusError || !existing) return { error: "Draft not found." };
  if (existing.status === "approved") {
    return {
      error:
        "This draft has been approved, so its content is locked to exactly what was approved. Editing it requires un-approving it first — use the Un-approve button on the draft's card, which reopens editing.",
    };
  }

  // The write is additionally predicated on status 'draft', narrowing
  // the window between the read above and this update -- an approve
  // landing in between makes this a no-op instead of an edit.
  const { error } = await supabase
    .from("drafts")
    .update({ subject, content, updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("status", "draft");
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true };
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

export async function deleteDraft(draftId: string, prospectId: string): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Re-read the draft's CURRENT status server-side (item 67) -- the
  // same guard as updateDraft: an approved draft cannot be deleted any
  // more than it can be edited. (A SENT draft is already undeletable at
  // the database: its attempt rows hold a no-cascade FK.)
  const { data: existing, error: statusError } = await supabase
    .from("drafts")
    .select("status")
    .eq("id", draftId)
    .single();
  if (statusError || !existing) return { error: "Draft not found." };
  if (existing.status === "approved") {
    return {
      error:
        "This draft has been approved, so it can't be deleted. Deleting it requires un-approving it first — use the Un-approve button on the draft's card.",
    };
  }

  // Predicated on status 'draft' like updateDraft's write, so an approve
  // landing between the read and this delete makes it a no-op.
  const { error } = await supabase.from("drafts").delete().eq("id", draftId).eq("status", "draft");
  if (error) throw new Error(error.message);

  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true };
}

// STATE item 68: the way back. Item 67 made an approved draft server-side
// immutable; this is the one legal reversal. Un-approving sets the draft
// back to status 'draft' and clears who approved it and when -- and by
// doing ONLY that, everything downstream follows from status alone: the
// editor reopens, delete becomes possible again, and the deck view stops
// rendering (it refuses any non-approved draft by construction). Nothing
// here rewrites content, and nothing downstream is touched directly.
//
// It REFUSES -- returned plain messages, the composeDraft convention --
// whenever the reversal would touch something that reached, or may have
// reached, a funder:
//   * a SENT draft (sent_at set): migration 0069's drafts trigger pins a
//     sent draft's status at the database for every role regardless; the
//     refusal here is the readable layer over the same fact.
//   * a draft with a LIVE (outcome null) or CONFIRMED ('sent') send
//     attempt in the ledger: the message may or may not have been
//     delivered, so the draft stays exactly as sent/attempted. A FAILED
//     attempt blocks nothing -- nothing was delivered.
//
// The write is race-proof in the item-67 style: predicated on status
// 'approved' AND sent_at null, so a send confirmed between the reads
// above and this write makes it a no-op instead of un-approving a sent
// draft. The attempt check runs LAST, immediately before the write, to
// keep the check-to-write window as narrow as the transport allows; a
// send that still lands inside it is additionally walled off by 0069's
// birth trigger, which refuses to birth an attempt for a draft that is
// no longer 'approved'.
export async function unapproveDraft(draftId: string, prospectId: string): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Re-read the draft's CURRENT state server-side (item 67's rule: the
  // client's belief about status is never trusted).
  const { data: existing, error: statusError } = await supabase
    .from("drafts")
    .select("status, sent_at")
    .eq("id", draftId)
    .single();
  if (statusError || !existing) return { error: "Draft not found." };
  if (existing.sent_at) {
    return {
      error:
        "This draft has been sent, so it stays exactly as sent — approval included. Sent facts are never unwound; further work happens on a new draft.",
    };
  }
  if (existing.status !== "approved") {
    return { error: "This draft is not approved, so there is nothing to un-approve." };
  }

  // The send-attempt ledger, checked last: a live or confirmed attempt
  // means the message reached, or may have reached, the funder, and the
  // draft stays exactly as attempted. Only 'failed' does not block. If
  // the ledger cannot be read, fail closed -- nothing is changed.
  const { data: blockingAttempts, error: attemptsError } = await supabase
    .from("draft_send_attempts")
    .select("id, outcome")
    .eq("draft_id", draftId)
    .or("outcome.eq.sent,outcome.is.null")
    .limit(1);
  if (attemptsError) {
    return { error: `Could not verify this draft's send history, so nothing was changed: ${attemptsError.message}` };
  }
  if ((blockingAttempts ?? []).length > 0) {
    return blockingAttempts![0].outcome === "sent"
      ? { error: "This draft has a confirmed send on record, so it stays exactly as sent — approval included." }
      : {
          error:
            "A send of this draft was attempted and its outcome is unconfirmed — the message may have reached the funder, so the draft stays exactly as attempted, approval included.",
        };
  }

  // Predicated on status 'approved' and no sent fact: anything that
  // changed in the window since the reads above makes this a no-op.
  const { error } = await supabase
    .from("drafts")
    .update({ status: "draft", approved_by: null, approved_at: null, updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("status", "approved")
    .is("sent_at", null);
  if (error) return { error: error.message };

  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true };
}
