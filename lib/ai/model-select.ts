import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";

// Deliberately thin -- not a provider router. Every AI task in this app
// resolves to the same Claude client/model today; this exists only so a
// future build that actually needs to route by task (once a second
// provider exists, or a measured need to route by cost/latency/quality
// shows up) doesn't have to touch every call site again. No config, no
// abstraction beyond this one function -- building a real router before
// there's a second provider to route to would be exactly the premature
// abstraction this project's own build philosophy warns against.
export type AITask = "research_search" | "research_extract";

export function resolveModel(_task: AITask) {
  return { client: anthropic, model: DRAFT_MODEL };
}
