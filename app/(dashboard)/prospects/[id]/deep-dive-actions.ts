"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary } from "@/lib/channel-match";
import { channelLabel } from "@/lib/prospects";
import type { Strategy, OrganizationIntel, DeepDiveRun } from "@/lib/deep-dive";
import type { OrgProfile } from "@/lib/organization";

// The heavy-lifting call. Triggered by the DESTINATION page (the
// prospect's own DeepDivePanel) on mount, not by whatever page
// navigated there -- a component that's about to unmount (like the
// candidates list right before router.push) risks the browser
// cancelling its in-flight request, which would silently kill the
// research with no error and no result. started_at acts as a lock so
// a page refresh mid-run doesn't fire a duplicate.
export async function runDeepDive(runId: string, prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: claimed } = await supabase
    .from("deep_dive_runs")
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

    // max_uses caps how many searches Claude can run in this pass --
    // the main lever on latency. Kept tight on purpose: this is
    // meant to be "fast enough to wait for," not exhaustive research.
    const searchResponse = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        max_tokens: 2000,
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 3 }],
        messages: [
          {
            role: "user",
            content: `Research this specific funding organization to help a nonprofit advancement team decide how to approach them: "${prospect.name}"${prospect.organization ? ` (${prospect.organization})` : ""}${prospect.website ? `, website: ${prospect.website}` : ""}. This is a ${channelLabel(prospect.channel)} channel funder.

Find real, current information, but be efficient -- a couple of well-chosen searches, not exhaustive research: funding priorities/focus areas, typical grant or gift size if publicly known, how they prefer to be approached, and anything relevant to fit. Only report things you actually find -- do not invent facts. Keep your written summary concise.`,
          },
        ],
      },
      { timeout: 120_000 }
    );

    const findings = searchResponse.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");

    await supabase
      .from("deep_dive_runs")
      .update({
        status: "analyzing",
        status_message: "Reviewing findings and checking fit against your organization profile...",
      })
      .eq("id", runId);

    const strategyResponse = await anthropic.messages.create(
      {
      model: DRAFT_MODEL,
      max_tokens: 2000,
      tools: [
        {
          name: "submit_deep_dive_results",
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
            },
            required: ["organization_intel", "strategy"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_deep_dive_results" },
      messages: [
        {
          role: "user",
          content: `Based on the research findings below about "${prospect.name}", extract structured funder intelligence and propose a strategy for pursuing this funder.

Research findings:
${findings || "(no findings)"}

Nonprofit profile:
${profile ? buildProfileSummary(profile) : "(no profile data)"}`,
        },
      ],
      },
      { timeout: 60_000 }
    );

    const toolUse = strategyResponse.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return a structured result. Try again.");
    }

    const result = toolUse.input as { organization_intel: OrganizationIntel; strategy: Strategy };

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

    await supabase
      .from("deep_dive_runs")
      .update({
        status: "ready_for_review",
        status_message: "Strategy ready for review",
        findings,
        strategy: safeStrategy,
        organization_intel: mergedIntel,
        model: DRAFT_MODEL,
      })
      .eq("id", runId);
  } catch (err) {
    await supabase
      .from("deep_dive_runs")
      .update({
        status: "error",
        status_message: "Research failed",
        error_message: err instanceof Error ? err.message : "Something went wrong during research",
      })
      .eq("id", runId);
  }

  revalidatePath(`/prospects/${prospectId}`);
}

export async function retryDeepDive(prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prospect } = await supabase.from("prospects").select("name").eq("id", prospectId).single();
  if (!prospect) throw new Error("Prospect not found");

  const { data: run, error } = await supabase
    .from("deep_dive_runs")
    .insert({
      prospect_id: prospectId,
      status: "researching",
      status_message: `Researching ${prospect.name} and drafting a strategy...`,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !run) throw new Error(error?.message ?? "Failed to start deep dive");

  revalidatePath(`/prospects/${prospectId}`);
  return run.id as string;
}

export async function getLatestDeepDiveRun(prospectId: string): Promise<DeepDiveRun | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("deep_dive_runs")
    .select("*")
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<DeepDiveRun>();
  return data ?? null;
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
    .from("deep_dive_runs")
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
