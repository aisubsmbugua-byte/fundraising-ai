"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary } from "@/lib/channel-match";
import { channelLabel } from "@/lib/prospects";
import type { Strategy } from "@/lib/strategy";
import type { OrgProfile } from "@/lib/organization";
import type { DraftKind } from "@/lib/drafts";

export async function generateDraft(prospectId: string, strategyRunId: string, kind: DraftKind) {
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

  revalidatePath(`/prospects/${prospectId}`);
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
