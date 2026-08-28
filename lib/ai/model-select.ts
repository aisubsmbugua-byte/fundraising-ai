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

// Search and extraction run on different models, chosen from measurement
// rather than assumption -- see scripts/replay-extraction.ts.
//
// Extraction stays on Sonnet 4.6. Replaying ONE frozen evidence set three
// times per model (so search variance could not confound it) put Sonnet 5
// behind on every quality measure that matters here:
//
//   claims                62.3 -> 53.3   (-15%)
//   high-confidence       51.7 -> 39.0   (-25%)
//   financial figures      80% -> 52%    carrying a reporting period
//   cost per extraction  $0.181 -> $0.129
//
// A third off extraction is about $0.05 a run, which does not buy back a
// quarter of the high-confidence claims or a collapse in dated figures.
//
// Search runs on Sonnet 5: it is a retrieval task rather than careful
// structured output, the saving applies to the larger half of the run, and a
// real screen run on it found every triage key. Search quality cannot be
// isolated with frozen evidence, so this is the weaker-evidence half of the
// decision and is worth revisiting if screen coverage drifts.
//
// Both are scoped to research tasks rather than changing DRAFT_MODEL, which
// six live features share.
const RESEARCH_SEARCH_MODEL = "claude-sonnet-5";
const RESEARCH_EXTRACT_MODEL = "claude-sonnet-4-6";

export function resolveModel(task: AITask) {
  if (task === "research_search") return { client: anthropic, model: RESEARCH_SEARCH_MODEL };
  if (task === "research_extract") return { client: anthropic, model: RESEARCH_EXTRACT_MODEL };
  return { client: anthropic, model: DRAFT_MODEL };
}
