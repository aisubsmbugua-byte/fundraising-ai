import Anthropic from "@anthropic-ai/sdk";

// Server-only. Never import this into a client component.
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export const DRAFT_MODEL = "claude-sonnet-4-6";
