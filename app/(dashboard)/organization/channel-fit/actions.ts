"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary, buildChannelList, type ChannelEvaluation } from "@/lib/channel-match";
import { CHANNELS } from "@/lib/prospects";
import type { OrgProfile } from "@/lib/organization";

const TOOL_NAME = "submit_channel_fit_analysis";

export async function runChannelMatch() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();
  if (!profile) {
    throw new Error("Fill in the Organization Profile before running a channel-fit analysis.");
  }

  const message = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 2000,
    tools: [
      {
        name: TOOL_NAME,
        description: "Submit the channel fit analysis for this nonprofit.",
        input_schema: {
          type: "object",
          properties: {
            evaluations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  channel: { type: "string", enum: CHANNELS.map((c) => c.value) },
                  recommended: { type: "boolean" },
                  confidence: { type: "string", enum: ["low", "medium", "high"] },
                  rationale: { type: "string" },
                },
                required: ["channel", "recommended", "confidence", "rationale"],
              },
              minItems: CHANNELS.length,
              maxItems: CHANNELS.length,
            },
          },
          required: ["evaluations"],
        },
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: `You are helping a nonprofit advancement team assess funder-channel fit. Given the nonprofit's profile below, evaluate its fit against each of the following six funding channels. For EACH channel (even ones you don't recommend), give a boolean recommendation, a confidence level, and a short rationale (2-3 sentences) grounded specifically in the profile details provided -- do not invent facts not present in the profile.

Nonprofit profile:
${buildProfileSummary(profile) || "(no profile data provided)"}

Channels to evaluate:
${buildChannelList()}`,
      },
    ],
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a structured analysis. Try again.");
  }

  const evaluations = (toolUse.input as { evaluations: ChannelEvaluation[] }).evaluations;

  const { error } = await supabase.from("channel_match_runs").insert({
    model: DRAFT_MODEL,
    evaluations,
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/organization/channel-fit");
}

export async function reviewChannelMatch(runId: string, approvedChannels: string[]) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("channel_match_runs")
    .update({
      approved_channels: approvedChannels,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) throw new Error(error.message);

  revalidatePath("/organization/channel-fit");
}
