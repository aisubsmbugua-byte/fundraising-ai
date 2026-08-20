import Anthropic from "@anthropic-ai/sdk";

// Server-only. Never import this into a client component.
// Explicit timeout: the SDK default (~10 min) is far longer than our
// route's maxDuration, so a stalled call would otherwise hang past
// what Vercel allows with no clean error -- fail fast instead.
// maxRetries: 0 by default -- when a call is genuinely slow (not a
// transient blip), the SDK's default retry-with-backoff just repeats
// the same slow call and burns most of a route's time budget without
// getting any closer to success. Calls that specifically want a retry
// budget can still pass { maxRetries } per-request.
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  timeout: 110_000,
  maxRetries: 0,
});

export const DRAFT_MODEL = "claude-sonnet-4-6";
