"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { loadApprovedIntelligence, strategyReadiness, type ApprovedClaim } from "@/lib/prospect-intelligence";
import { approveVerifiedIntelligence } from "./research-actions";
import { hasStatedPeriod } from "@/lib/research";
import { searchFunderWeb } from "@/lib/ai/funder-search";
import { buildProfileSummary } from "@/lib/channel-match";
import type { Strategy, OrganizationIntel, StrategyRun } from "@/lib/strategy";
import type { OrgProfile } from "@/lib/organization";

// The heavy-lifting call. Triggered by the DESTINATION page (the
// prospect's own StrategyPanel) on mount, not by whatever page
// navigated there -- a component that's about to unmount (like the
// candidates list right before router.push) risks the browser
// cancelling its in-flight request, which would silently kill the
// research with no error and no result. started_at acts as a lock so
// a page refresh mid-run doesn't fire a duplicate.
export async function runStrategy(runId: string, prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: claimed } = await supabase
    .from("strategy_runs")
    .update({ started_at: new Date().toISOString() })
    .eq("id", runId)
    .is("started_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return; // already started (or started elsewhere) -- don't run it twice

  try {
    const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
    if (!prospect) throw new Error("Prospect not found");

    const { data: profile } = await supabase
      .from("org_profile")
      .select("*")
      .limit(1)
      .maybeSingle<OrgProfile>();

    // Only evidence a human has actually verified and marked approved
    // is eligible to be cited to a funder -- see verifyEvidenceItem in
    // app/(dashboard)/evidence/actions.ts.
    const { data: evidenceRows } = await supabase
      .from("evidence_items")
      .select("id, title, description, type")
      .not("verified_at", "is", null)
      .eq("permission", "approved");
    const evidencePool = evidenceRows ?? [];

    // Shared with the (dark, superadmin-only) Research Agent action --
    // see lib/ai/funder-search.ts. Same prompt/model/tool config as
    // before this was extracted; behavior-preserving refactor only.
    const { findings, stopReason } = await searchFunderWeb(prospect);
    console.log(`[strategy] search call resolved, stop_reason=${stopReason}`);

    await supabase
      .from("strategy_runs")
      .update({
        status: "analyzing",
        status_message: "Reviewing findings and checking fit against your organization profile...",
      })
      .eq("id", runId);

    // Approved intelligence, when it exists, is the ONLY structured research
    // Strategy is given -- and it arrives pre-filtered. This action never
    // queries research_claims itself and never decides what is safe: that
    // policy lives in loadApprovedIntelligence, in one place, so it can be
    // changed and tested once rather than re-implemented per consumer.
    //
    // It returns null when identity was never resolved, so a strategy can
    // never be built on research that may describe a different organization.
    const approved = await loadApprovedIntelligence(supabase, prospectId);

    // hasStatedPeriod, not a truthiness check: "unstated" and
    // "not_time_bound" are internal sentinels, and rendering them raw wrote
    // "(unstated)" into the prompt as though it were a period the evidence
    // gave.
    const line = (c: ApprovedClaim) =>
      `- ${c.claim}${hasStatedPeriod(c.reportingPeriod) ? ` (${c.reportingPeriod})` : ""}${
        c.limitation ? ` [${c.limitation}]` : ""
      }${c.humanOverride ? ` [accepted by a reviewer despite limited evidence${c.overrideNote ? `: ${c.overrideNote}` : ""}]` : ""}`;

    // Two blocks, not one list with a mixed caveat. Confirmed facts and
    // unconfirmed context are different kinds of input and a model given
    // them as one list will treat them as one kind. Each advisory line also
    // carries its own limitation inline, because a caveat in a heading does
    // not reliably reach the twentieth bullet beneath it.
    const confirmed = (approved?.claims ?? []).filter((c) => !c.advisory);
    const advisory = (approved?.claims ?? []).filter((c) => c.advisory);
    const approvedBlock = [
      confirmed.length
        ? `\nConfirmed intelligence about this funder (checked against sources and human-approved; prefer this over the raw findings where they differ):\n${confirmed.map(line).join("\n")}\n`
        : "",
      advisory.length
        ? `\nUnconfirmed context (NOT verified and NOT approved -- use only to shape framing and tone. Never state any of this to the funder as fact, never size an ask from it, and never treat it as an eligibility rule):\n${advisory.map(line).join("\n")}\n`
        : "",
    ].join("");
    // Logged, not silent: a withheld claim is one a person approved and the
    // strategy never saw, and that gap should be findable in the run log
    // rather than only by reading the gate.
    if (approved?.withheld.length) {
      console.log(`[strategy] withheld ${approved.withheld.length} approved claim(s) from the prompt: ${approved.withheld.map((w) => w.claimKey).join(", ")}`);
    }

    const strategyResponse = await anthropic.messages.create(
      {
      model: DRAFT_MODEL,
      max_tokens: 2000,
      tools: [
        {
          name: "submit_strategy_results",
          description: "Submit the extracted funder intelligence and proposed strategy for this prospect.",
          input_schema: {
            type: "object",
            properties: {
              organization_intel: {
                type: "object",
                description:
                  "Structured facts about the funder extracted from research. Use an empty string / empty array for anything not determinable -- do not guess.",
                properties: {
                  location: { type: "string", description: "City/state/country the funder is based in, if found" },
                  funder_type: {
                    type: "string",
                    description:
                      "e.g. private foundation, corporate giving program, family foundation, denominational fund, individual/DAF",
                  },
                  geographic_focus: {
                    type: "string",
                    description: "Where this funder typically gives, e.g. 'nationwide', 'California only'",
                  },
                  typical_grant_size: {
                    type: "string",
                    description: "Typical grant/gift range if publicly determinable, e.g. '$5,000-$25,000'",
                  },
                  focus_areas: {
                    type: "array",
                    items: { type: "string" },
                    description: "Cause areas or program areas this funder typically supports",
                  },
                },
                required: ["location", "funder_type", "geographic_focus", "typical_grant_size", "focus_areas"],
              },
              strategy: {
                type: "object",
                properties: {
                  outreach_approach: {
                    type: "string",
                    description: "How to make first contact and build the relationship",
                  },
                  ask_positioning: {
                    type: "string",
                    description:
                      "How to position the proposal/grant/ask, including likely ask size or type if determinable",
                  },
                  rationale: {
                    type: "string",
                    description:
                      "Why this approach, grounded in the research findings and the nonprofit's profile",
                  },
                  key_talking_points: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "3-5 concrete, reusable talking points to anchor any communication with this funder -- email, call, proposal, or presentation. Should be consistent across all of them.",
                  },
                  evidence_to_highlight: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "What kinds of outcomes, metrics, or proof points would resonate most with this specific funder given their focus areas -- guides what evidence to gather/cite later.",
                  },
                },
                required: [
                  "outreach_approach",
                  "ask_positioning",
                  "rationale",
                  "key_talking_points",
                  "evidence_to_highlight",
                ],
              },
              evidence_used: {
                type: "array",
                items: { type: "string" },
                description:
                  "IDs (from the Available evidence list below) of any evidence items that genuinely fit this strategy and are worth citing. Only include ids from that list -- never invent one. Leave empty if none fit or the list is empty.",
              },
            },
            required: ["organization_intel", "strategy"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_strategy_results" },
      messages: [
        {
          role: "user",
          content: `Based on the research findings below about "${prospect.name}", extract structured funder intelligence and propose a strategy for pursuing this funder.
${approvedBlock}
Research findings:
${findings || "(no findings)"}

Nonprofit profile:
${profile ? buildProfileSummary(profile) : "(no profile data)"}

Available evidence (verified, approved for use -- cite by id in evidence_used if relevant):
${
  evidencePool.length > 0
    ? evidencePool.map((e) => `- ${e.id}: [${e.type}] ${e.title} -- ${e.description}`).join("\n")
    : "(no verified evidence available yet)"
}`,
        },
      ],
      },
      { timeout: 60_000 }
    );

    const toolUse = strategyResponse.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return a structured result. Try again.");
    }

    const result = toolUse.input as { organization_intel: OrganizationIntel; strategy: Strategy; evidence_used?: unknown };

    // Defensive against the AI citing an id that isn't in the pool it
    // was given (or hallucinating one) -- same spirit as the
    // Array.isArray guards below.
    const evidencePoolIds = new Set(evidencePool.map((e) => e.id));
    const evidenceItemIds = Array.isArray(result.evidence_used)
      ? result.evidence_used.filter((id): id is string => typeof id === "string" && evidencePoolIds.has(id))
      : [];

    // The tool schema is a strong hint, not a server-enforced
    // contract -- guard against the AI omitting a field or returning
    // the wrong shape (e.g. focus_areas as something other than an
    // array) so malformed output can't crash the review UI later.
    const aiFocusAreas = Array.isArray(result.organization_intel?.focus_areas)
      ? result.organization_intel.focus_areas
      : [];

    // AI fills gaps, never overwrites data that's already there --
    // if this candidate had location/funder_type/etc. entered
    // manually at intake, an empty AI result shouldn't clobber it.
    const mergedIntel: OrganizationIntel = {
      location: prospect.location || result.organization_intel?.location || "",
      funder_type: prospect.funder_type || result.organization_intel?.funder_type || "",
      geographic_focus: prospect.geographic_focus || result.organization_intel?.geographic_focus || "",
      typical_grant_size: prospect.typical_grant_size || result.organization_intel?.typical_grant_size || "",
      focus_areas: prospect.focus_areas && prospect.focus_areas.length > 0 ? prospect.focus_areas : aiFocusAreas,
    };

    const safeStrategy: Strategy = {
      outreach_approach: result.strategy?.outreach_approach || "",
      ask_positioning: result.strategy?.ask_positioning || "",
      rationale: result.strategy?.rationale || "",
      key_talking_points: Array.isArray(result.strategy?.key_talking_points)
        ? result.strategy.key_talking_points
        : [],
      evidence_to_highlight: Array.isArray(result.strategy?.evidence_to_highlight)
        ? result.strategy.evidence_to_highlight
        : [],
    };

    // The || "" fallbacks above stop a missing field from crashing the
    // review UI, but they'll just as happily let a strategy with
    // NOTHING in it through -- e.g. web search turned up too little
    // for the AI to responsibly propose anything (it's told not to
    // invent facts). That's a failure to surface and retry, not a
    // "ready for review" strategy a human is expected to approve.
    const hasSubstance =
      safeStrategy.outreach_approach.trim() ||
      safeStrategy.ask_positioning.trim() ||
      safeStrategy.rationale.trim();

    if (!hasSubstance) {
      await supabase
        .from("strategy_runs")
        .update({
          status: "error",
          status_message: "Research didn't turn up enough to propose a strategy",
          error_message: `Web search found too little on "${prospect.name}" for the AI to responsibly propose an approach. Try again, or add what you know manually.`,
          findings,
        })
        .eq("id", runId);
    } else {
      await supabase
        .from("strategy_runs")
        .update({
          status: "ready_for_review",
          status_message: "Strategy ready for review",
          findings,
          strategy: safeStrategy,
          // Which approved intelligence this was built from. Null means it
          // was generated from unstructured legacy research and has not been
          // checked against anything a person approved -- the UI says so.
          approved_intelligence_run_id: approved?.researchRunId ?? null,
          organization_intel: mergedIntel,
          model: DRAFT_MODEL,
          evidence_item_ids: evidenceItemIds,
        })
        .eq("id", runId);
    }
  } catch (err) {
    await supabase
      .from("strategy_runs")
      .update({
        status: "error",
        status_message: "Research failed",
        error_message: err instanceof Error ? err.message : "Something went wrong during research",
      })
      .eq("id", runId);
  }

  revalidatePath(`/prospects/${prospectId}`);
}

// The only way a strategy_runs row gets created. Guarded, because the whole
// point of the research-first workflow is that a strategy is written from
// intelligence a person approved -- a strategy generated from an empty
// payload would silently fall back to the model's own web search and look
// exactly like a grounded one.
//
// The guard therefore refuses rather than degrading: research that failed,
// is still blocked on identity, or has not been reviewed yet all leave the
// prospect where it is, with a message saying which of those it is.
async function createStrategyRun(prospectId: string): Promise<string> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The same check the Strategy tab uses to decide whether to offer the
  // button at all, so the control on screen and the rule behind it cannot
  // disagree. Advisory context shapes a strategy; it may not be the sole
  // basis for one.
  const readiness = await strategyReadiness(supabase, prospectId);
  if (!readiness.ready) throw new Error(readiness.reason ?? "A strategy cannot be generated for this prospect yet.");

  const { data: prospect } = await supabase.from("prospects").select("name").eq("id", prospectId).single();
  if (!prospect) throw new Error("Prospect not found");

  const { data: run, error } = await supabase
    .from("strategy_runs")
    .insert({
      prospect_id: prospectId,
      status: "researching",
      status_message: `Building a strategy for ${prospect.name} from approved intelligence...`,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !run) throw new Error(error?.message ?? "Failed to start strategy run");

  revalidatePath(`/prospects/${prospectId}`);
  return run.id as string;
}

// Returns rather than throws. createStrategyRun's guard is correct to refuse
// -- a strategy with no approved intelligence behind it would be written from
// nothing -- but a Server Action that THROWS gives the browser a bare 500 and
// "Application error: a server-side exception has occurred", which tells the
// user neither what went wrong nor what to do. The refusal is a normal
// outcome, so it travels back as data.
export async function retryStrategy(prospectId: string): Promise<{ error: string } | { runId: string }> {
  try {
    return { runId: await createStrategyRun(prospectId) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not start a strategy run" };
  }
}

// The explicit handoff from research to strategy, named after what the
// person is actually doing. Approving and generating are one action on
// screen because they are one decision -- "these are the facts, write from
// them" -- but they stay two writes, so a failure to create the run cannot
// silently discard the approvals.
//
// Returns rather than throws for the usual production-redaction reason; the
// guard messages in createStrategyRun are the ones a user most needs to see.
export async function approveIntelligenceAndGenerateStrategy(
  researchRunId: string,
  prospectId: string
): Promise<{ error: string } | { success: true; runId: string; approved: number }> {
  try {
    const result = await approveVerifiedIntelligence(researchRunId);
    if ("error" in result) return { error: result.error };

    const runId = await createStrategyRun(prospectId);
    return { success: true, runId, approved: result.approved };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not generate the strategy" };
  }
}

export async function approveStrategy(
  runId: string,
  prospectId: string,
  approvedStrategy: Strategy,
  approvedIntel: OrganizationIntel
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("strategy_runs")
    .update({
      approved_strategy: approvedStrategy,
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(error.message);

  // Applying the (human-reviewed, possibly edited) funder intel to
  // the prospect record happens in this same approval step -- one
  // gate covers both the strategy and the CRM data it's grounded in.
  const { error: prospectError } = await supabase
    .from("prospects")
    .update({
      location: approvedIntel.location || null,
      funder_type: approvedIntel.funder_type || null,
      geographic_focus: approvedIntel.geographic_focus || null,
      typical_grant_size: approvedIntel.typical_grant_size || null,
      focus_areas: approvedIntel.focus_areas?.length ? approvedIntel.focus_areas : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId);
  if (prospectError) throw new Error(prospectError.message);

  revalidatePath(`/prospects/${prospectId}`);
}
