"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary } from "@/lib/channel-match";
import { channelLabel } from "@/lib/prospects";
import { interactionKindLabel } from "@/lib/interactions";
import type { Strategy } from "@/lib/strategy";
import type { OrgProfile } from "@/lib/organization";
import type { Interaction, InteractionKind } from "@/lib/interactions";

export async function logInteraction(prospectId: string, kind: InteractionKind, summary: string, occurredAt: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("interactions").insert({
    prospect_id: prospectId,
    kind,
    summary,
    occurred_at: occurredAt,
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/revisit");
}

export async function deleteInteraction(id: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("interactions").delete().eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/revisit");
}

// A proposal, never applied automatically -- writes only to
// suggested_* on the prospect. A human reviews it and either applies
// it (useSuggestedNextStep) or dismisses it (dismissSuggestedNextStep).
export async function suggestNextStep(prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
  if (!prospect) throw new Error("Prospect not found");

  const [{ data: latestRun }, { data: recentInteractions }, { data: profile }] = await Promise.all([
    supabase
      .from("strategy_runs")
      .select("approved_strategy")
      .eq("prospect_id", prospectId)
      .not("approved_strategy", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("interactions")
      .select("*")
      .eq("prospect_id", prospectId)
      .order("occurred_at", { ascending: false })
      .limit(5)
      .returns<Interaction[]>(),
    supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>(),
  ]);

  const strategy = latestRun?.approved_strategy as Strategy | null;
  const interactions = recentInteractions ?? [];

  const response = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 800,
    tools: [
      {
        name: "submit_next_step",
        description: "Submit a suggested next step for pursuing this prospect.",
        input_schema: {
          type: "object",
          properties: {
            next_action: { type: "string", description: "A short, concrete next action, e.g. 'Send follow-up email with impact data'" },
            next_action_due: {
              type: "string",
              description: "Suggested due date as YYYY-MM-DD, or empty string if no specific date makes sense",
            },
            reasoning: { type: "string", description: "1-2 sentences on why this is the right next step right now" },
          },
          required: ["next_action", "next_action_due", "reasoning"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_next_step" },
    messages: [
      {
        role: "user",
        content: `Suggest the single best next step for pursuing "${prospect.name}" (${channelLabel(prospect.channel)} channel, currently at the ${prospect.stage} stage).

${strategy ? `Approved strategy:
- Outreach approach: ${strategy.outreach_approach}
- Ask positioning: ${strategy.ask_positioning}
- Key talking points: ${strategy.key_talking_points?.join("; ") || "(none)"}` : "(no approved strategy yet)"}

Recent interactions, most recent first:
${
  interactions.length > 0
    ? interactions.map((i) => `- ${i.occurred_at} (${interactionKindLabel(i.kind)}): ${i.summary}`).join("\n")
    : "(none logged yet)"
}

Current next action on file: ${prospect.next_action || "(none set)"}${prospect.next_action_due ? `, due ${prospect.next_action_due}` : ""}

Nonprofit context:
${profile ? buildProfileSummary(profile) : "(no profile data)"}`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a structured suggestion. Try again.");
  }
  const result = toolUse.input as { next_action?: string; next_action_due?: string; reasoning?: string };

  const { error } = await supabase
    .from("prospects")
    .update({
      suggested_next_action: result.next_action || "",
      suggested_next_action_due: result.next_action_due || null,
      suggested_reasoning: result.reasoning || "",
      suggested_at: new Date().toISOString(),
    })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath("/revisit");
  revalidatePath(`/prospects/${prospectId}`);
}

// Human accepts the suggestion -- copies it into the real next_action
// fields and clears the proposal.
export async function useSuggestedNextStep(prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prospect } = await supabase
    .from("prospects")
    .select("suggested_next_action, suggested_next_action_due")
    .eq("id", prospectId)
    .single();
  if (!prospect) throw new Error("Prospect not found");

  const { error } = await supabase
    .from("prospects")
    .update({
      next_action: prospect.suggested_next_action,
      next_action_due: prospect.suggested_next_action_due,
      suggested_next_action: null,
      suggested_next_action_due: null,
      suggested_reasoning: null,
      suggested_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath("/revisit");
  revalidatePath(`/prospects/${prospectId}`);
}

export async function dismissSuggestedNextStep(prospectId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("prospects")
    .update({
      suggested_next_action: null,
      suggested_next_action_due: null,
      suggested_reasoning: null,
      suggested_at: null,
    })
    .eq("id", prospectId);
  if (error) throw new Error(error.message);

  revalidatePath("/revisit");
}

export async function updateCandidateRevisit(candidateId: string, reason: string, revisitDate: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("candidates")
    .update({
      dismissed_reason: reason || null,
      revisit_date: revisitDate || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", candidateId);
  if (error) throw new Error(error.message);

  revalidatePath("/revisit");
}
