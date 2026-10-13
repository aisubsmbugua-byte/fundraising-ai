// The model provider adapter (STATE item 87, ruling 0037 clause 4).
//
// Server-only. This is the ONLY file under app/ or lib/ that speaks to the
// assistant's model provider: Meta's Model API, which is OpenAI-compatible
// Chat Completions with function calling. Plain fetch, no new dependency. It
// holds MODEL_API_KEY (via config.ts) and must never be imported by a client
// component (hard rule 5); scripts/test-assistant.ts asserts that by source
// scan, and scripts/test-ai-runs.ts puts this file inside the closed set of
// model-calling files so a second one cannot appear unnoticed.
//
// THE FIRST LIVE CALL IS UNVERIFIED. This adapter was written against the
// documented request/response shape and tested against a fake fetch only;
// scripts/assistant-smoke.ts is the permanent tool the owner runs once a key
// exists.
//
// The wire shape this implements:
//   POST {base}/chat/completions
//   Authorization: Bearer <MODEL_API_KEY>
//   body  { model, messages, tools: [{type:"function", function:{name,
//           description, parameters}}], max_tokens }
//   reply choices[0].message.{content, tool_calls[{id, type:"function",
//           function:{name, arguments:<JSON string>}}]},
//         usage.{prompt_tokens, completion_tokens}
//
// callProvider never throws and never retries. A retry would be a second
// model call with no ledger row in front of it (ruling 0026); the caller
// decides, and today the loop does not.

import type { ProviderConfig } from "./config";

export type ProviderToolCall = { id: string; name: string; argumentsRaw: string };

export type ProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ProviderToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ProviderToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ProviderResult = {
  content: string;
  toolCalls: ProviderToolCall[];
  // Null when the response carried no usage block -- "no figures" is a fact,
  // not a zero (ruling 0026 clause 3).
  usage: { inputTokens: number; outputTokens: number } | null;
  // The model the provider reported answering, or null when it reported none.
  model: string | null;
  finishReason: string | null;
};

export type ProviderError = {
  kind: "timeout" | "network" | "http" | "malformed";
  status?: number;
  // Plain sentence for the user.
  message: string;
  // Server-side detail for the ledger's error note and the logs; never sent
  // to the client.
  detail: string;
};

export type ProviderCallResult = { ok: true; result: ProviderResult } | { ok: false; error: ProviderError };

export const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export function buildRequest(
  config: ProviderConfig,
  input: { messages: ProviderMessage[]; tools: ProviderToolDefinition[]; maxTokens?: number }
): { url: string; method: "POST"; headers: Record<string, string>; body: string } {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: input.messages.map(toWireMessage),
    max_tokens: input.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return {
    url: `${config.baseUrl}/chat/completions`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  };
}

function toWireMessage(m: ProviderMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.argumentsRaw },
      })),
    };
  }
  return { ...m };
}

function asCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

// Pure. Maps a parsed response body to the provider-neutral result, or says
// why it cannot.
export function parseResponse(json: unknown): { ok: true; result: ProviderResult } | { ok: false; detail: string } {
  if (json === null || typeof json !== "object") return { ok: false, detail: "response body was not an object" };
  const body = json as Record<string, unknown>;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { ok: false, detail: "response had no choices" };
  const first = choices[0] as Record<string, unknown> | null;
  const message = first && typeof first === "object" ? (first.message as Record<string, unknown> | undefined) : undefined;
  if (!message || typeof message !== "object") return { ok: false, detail: "first choice had no message" };

  // content is a string in the documented shape; tolerate the parts-array
  // form some compatible servers use by joining its text parts.
  let content = "";
  if (typeof message.content === "string") content = message.content;
  else if (Array.isArray(message.content)) {
    content = message.content
      .map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? ((p as Record<string, unknown>).text as string) : ""))
      .join("");
  }

  const toolCalls: ProviderToolCall[] = [];
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    rawCalls.forEach((c, i) => {
      const call = (c ?? {}) as Record<string, unknown>;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      const args = fn.arguments;
      toolCalls.push({
        id: typeof call.id === "string" && call.id ? call.id : `call_${i}`,
        name: typeof fn.name === "string" ? fn.name : "",
        // Documented as a JSON STRING. An object is tolerated by
        // re-serializing; either way the loop parses and validates it.
        argumentsRaw: typeof args === "string" ? args : args === undefined || args === null ? "" : JSON.stringify(args),
      });
    });
  }

  const usageRaw = body.usage as Record<string, unknown> | undefined;
  const inputTokens = usageRaw ? asCount(usageRaw.prompt_tokens) : null;
  const outputTokens = usageRaw ? asCount(usageRaw.completion_tokens) : null;

  return {
    ok: true,
    result: {
      content,
      toolCalls,
      usage: inputTokens !== null && outputTokens !== null ? { inputTokens, outputTokens } : null,
      model: typeof body.model === "string" && body.model ? body.model : null,
      finishReason: typeof first?.finish_reason === "string" ? (first.finish_reason as string) : null,
    },
  };
}

function providerErrorSnippet(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
    const e = parsed?.error;
    const msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : null;
    if (msg) return msg.slice(0, 200);
  } catch {
    // not JSON; fall through to the raw snippet
  }
  return text.slice(0, 200);
}

export async function callProvider(
  config: ProviderConfig,
  input: { messages: ProviderMessage[]; tools: ProviderToolDefinition[]; maxTokens?: number },
  opts: { timeoutMs: number; fetchImpl?: FetchLike }
): Promise<ProviderCallResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const req = buildRequest(config, input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: {
          kind: "http",
          status: res.status,
          message: `The model provider answered with an error (HTTP ${res.status}).`,
          detail: `HTTP ${res.status}: ${providerErrorSnippet(text)}`,
        },
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          kind: "malformed",
          message: "The model provider's answer could not be read.",
          detail: `response was not JSON: ${text.slice(0, 120)}`,
        },
      };
    }
    const parsed = parseResponse(json);
    if (!parsed.ok) {
      return { ok: false, error: { kind: "malformed", message: "The model provider's answer could not be read.", detail: parsed.detail } };
    }
    return { ok: true, result: parsed.result };
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    if (aborted) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: "The model provider did not answer in time.",
          detail: `no response within ${opts.timeoutMs}ms`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "network",
        message: "The model provider could not be reached.",
        detail: err instanceof Error ? err.message : "network error",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
