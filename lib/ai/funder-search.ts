import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { channelLabel } from "@/lib/prospects";

// Shared by the live combined deep-dive action and the new (dark,
// superadmin-only) Research Agent action -- same web-search call either
// way, extracted here so neither has to duplicate it. This is a pure,
// behavior-preserving extraction of what deep-dive-actions.ts already did
// inline: same prompt, same model, same tool config, same timeout.
export async function searchFunderWeb(prospect: {
  name: string;
  organization: string | null;
  website: string | null;
  channel: string;
}): Promise<{
  findings: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}> {
  // max_uses caps how many searches Claude can run in this pass -- the
  // main lever on latency. Kept tight on purpose: this is meant to be
  // "fast enough to wait for," not exhaustive research. allowed_callers:
  // ["direct"] bypasses the code-execution "dynamic filtering" caller that
  // _20260209-or-later tool versions default to -- extra latency-variance
  // machinery this call doesn't need (Discovery Search's repeated timeouts
  // were traced to this same tool version's default behavior).
  const searchResponse = await anthropic.messages.create(
    {
      model: DRAFT_MODEL,
      max_tokens: 2000,
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 3, allowed_callers: ["direct"] }],
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

  return {
    findings,
    stopReason: searchResponse.stop_reason,
    usage: {
      inputTokens: searchResponse.usage?.input_tokens ?? 0,
      outputTokens: searchResponse.usage?.output_tokens ?? 0,
    },
  };
}
