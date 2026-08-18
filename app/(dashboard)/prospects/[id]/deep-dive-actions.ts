"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary } from "@/lib/channel-match";
import { channelLabel } from "@/lib/prospects";
import type { Strategy, DeepDiveRun } from "@/lib/deep-dive";
import type { OrgProfile } from "@/lib/organization";

// The heavy-lifting call. Called by the client without being awaited
// (fire-and-poll pattern) so the UI can navigate to the prospect page
// and show live progress immediately rather than blocking on the
// full research + strategy sequence. Each stage writes its own
// status update, which is what the polling UI actually reads.
export async function runDeepDive(runId: string, prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  try {
    const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
    if (!prospect) throw new Error("Prospect not found");

    const { data: profile } = await supabase
      .from("org_profile")
      .select("*")
      .limit(1)
      .maybeSingle<OrgProfile>();

    const searchResponse = await anthropic.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 3000,
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 5 }],
      messages: [
        {
          role: "user",
          content: `Research this specific funding organization to help a nonprofit advancement team decide how to approach them: "${prospect.name}"${prospect.organization ? ` (${prospect.organization})` : ""}${prospect.website ? `, website: ${prospect.website}` : ""}. This is a ${channelLabel(prospect.channel)} channel funder.

Find real, current information: funding priorities/focus areas, typical grant or gift size if publicly known, application process or how they prefer to be approached, recent notable gifts, and anything relevant to whether they're a good fit. Only report things you actually find -- do not invent facts.`,
        },
      ],
    });

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

    const strategyResponse = await anthropic.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 1500,
      tools: [
        {
          name: "submit_strategy",
          description: "Submit the proposed outreach and ask strategy for this prospect.",
          input_schema: {
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
                description: "Why this approach, grounded in the research findings and the nonprofit's profile",
              },
            },
            required: ["outreach_approach", "ask_positioning", "rationale"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_strategy" },
      messages: [
        {
          role: "user",
          content: `Based on the research findings below about "${prospect.name}", propose a strategy for pursuing this funder.

Research findings:
${findings || "(no findings)"}

Nonprofit profile:
${profile ? buildProfileSummary(profile) : "(no profile data)"}`,
        },
      ],
    });

    const toolUse = strategyResponse.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return a structured strategy. Try again.");
    }

    const strategy = toolUse.input as Strategy;

    await supabase
      .from("deep_dive_runs")
      .update({
        status: "ready_for_review",
        status_message: "Strategy ready for review",
        findings,
        strategy,
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
      status_message: `Searching the web for information about ${prospect.name}...`,
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

export async function approveStrategy(runId: string, prospectId: string, approvedStrategy: Strategy) {
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

  revalidatePath(`/prospects/${prospectId}`);
}
