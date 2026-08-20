import Anthropic from "@anthropic-ai/sdk";

// Server-only. Never import this into a client component.
// Explicit timeout: the SDK default (~10 min) is far longer than our
// route's maxDuration, so a stalled call would otherwise hang past
// what Vercel allows with no clean error -- fail fast instead.
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  timeout: 110_000,
});

export const DRAFT_MODEL = "claude-sonnet-4-6";
