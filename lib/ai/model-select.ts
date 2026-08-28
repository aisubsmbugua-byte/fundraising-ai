import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";

// Per-million-token list prices, used to record a per-run cost estimate.
// Not read from a live source -- good enough to compare runs to each other;
// re-check against current Anthropic pricing before trusting the dollar
// figure for anything else.
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICING[model] ?? MODEL_PRICING[DRAFT_MODEL];
  return (inputTokens * price.inputPerMTok) / 1_000_000 + (outputTokens * price.outputPerMTok) / 1_000_000;
}

export type AITask = "research_search" | "research_extract";

// The Research Agent runs on Sonnet 5: same generation as the DRAFT_MODEL
// used elsewhere, but $2/$10 per MTok against $3/$15 -- a third cheaper for
// equal-or-better capability.
//
// Scoped to the research tasks ON PURPOSE rather than changing DRAFT_MODEL.
// That constant is shared by six live features (deep dive, drafts, discovery
// search, revisit, channel fit), and the Research Agent is a dark
// superadmin-only path -- so a model change is proven here first and only
// then considered for the live workflow. This is exactly the seam this
// module was created for; it is still not a provider router.
const RESEARCH_MODEL = "claude-sonnet-5";

export function resolveModel(task: AITask) {
  return { client: anthropic, model: task === "research_search" || task === "research_extract" ? RESEARCH_MODEL : DRAFT_MODEL };
}
