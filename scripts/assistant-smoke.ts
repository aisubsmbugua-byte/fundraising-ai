// The assistant's permanent live-call smoke test (STATE item 87).
//
// WHY THIS EXISTS. The provider adapter (lib/assistant/provider.ts) was written
// against Meta's documented OpenAI-compatible Chat Completions shape and tested
// ONLY against a fake fetch (scripts/test-assistant.ts). No live call has ever
// been made by the build. This script is how the owner makes the first one --
// and how anyone re-checks the connection later (a model rename, a base-URL
// change, a rotated key).
//
// WHAT IT DOES. One real request to the provider with a trivial prompt and ONE
// tool, through the SAME buildRequest/callProvider the assistant uses -- so a
// pass here is a pass of the real code path, not of a re-implementation. It
// prints the model the provider reported, the token usage, and whether the
// tool call came back and parsed. It touches no database, writes no ledger row
// and sends no organization data: the prompt is a fixed sentence.
//
// WHAT IT COSTS. A handful of tokens, once.
//
// USAGE (from the project folder, with the key in .env.local):
//
//   cd "/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai"
//   npx tsx --env-file=.env.local scripts/assistant-smoke.ts
//
// FULL-LIST MODE (STATE item 97). The one-tool check above proves the wire
// works; it does not prove the provider accepts the assistant's real 23-tool
// list or picks sensible tools from it. Pass --full and a message:
//
//   npx tsx --env-file=.env.local scripts/assistant-smoke.ts --full "What's going on?"
//
// It offers the REAL tool definitions and the REAL system prompt, makes ONE
// call, and prints which tool(s) the model chose with their arguments. It
// EXECUTES NOTHING: no database, no ledger row, no entry point. For a command
// ability it also reports whether the model's authorizing_quote would pass the
// platform's own quote check against the message you typed. Sends no
// organization data: the only content is the sentence you give it.
//
// Reads MODEL_API_KEY (required), MODEL_API_BASE_URL and ASSISTANT_MODEL
// (optional; defaults in lib/assistant/config.ts). With no key it says so and
// exits 2 without making any request. Exit 0: the call succeeded and was
// readable. Exit 1: the call failed or could not be read. The key is never
// printed.

import { readProviderConfig } from "../lib/assistant/config";
import { callProvider, buildRequest } from "../lib/assistant/provider";
import { parseArgumentsJson } from "../lib/assistant/validate";
import { toolDefinitions } from "../lib/assistant/abilities";
import { buildSystemPrompt } from "../lib/assistant/prompt";
import { verifyQuote } from "../lib/assistant/command";

async function fullMode(message: string) {
  const cfg = readProviderConfig(process.env);
  if (!cfg.ok) {
    console.error("MODEL_API_KEY is not set (or the base URL is unusable). Nothing was sent.");
    process.exit(2);
  }
  const tools = toolDefinitions();
  const input = {
    messages: [
      { role: "system" as const, content: buildSystemPrompt(new Date()) },
      { role: "user" as const, content: message },
    ],
    tools,
    maxTokens: 1200,
  };
  console.log(`model requested: ${cfg.config.model}`);
  console.log(`tools offered:   ${tools.length}`);
  console.log(`message:         ${JSON.stringify(message)}\n`);
  const started = Date.now();
  const res = await callProvider(cfg.config, input, { timeoutMs: 60_000 });
  const ms = Date.now() - started;
  if (!res.ok) {
    console.error(`FAILED after ${ms}ms: ${res.error.kind}${res.error.status ? ` (HTTP ${res.error.status})` : ""}`);
    console.error(`  ${res.error.detail}`);
    process.exit(1);
  }
  const r = res.result;
  console.log(`OK in ${ms}ms  usage: ${r.usage ? `${r.usage.inputTokens} in / ${r.usage.outputTokens} out` : "(none)"}  finish: ${r.finishReason ?? "(none)"}`);
  console.log(`text: ${r.content.trim() === "" ? "(none)" : JSON.stringify(r.content.trim().slice(0, 400))}`);
  if (r.toolCalls.length === 0) {
    console.log("tool calls: none (the model answered in text)");
    return;
  }
  console.log(`tool calls: ${r.toolCalls.length}  (NOT executed)`);
  for (const call of r.toolCalls) {
    const parsed = parseArgumentsJson(call.argumentsRaw);
    console.log(`  - ${call.name}`);
    if (!parsed.ok) {
      console.log(`    arguments did not parse: ${parsed.error}`);
      continue;
    }
    console.log(`    arguments: ${JSON.stringify(parsed.value)}`);
    if ("authorizing_quote" in parsed.value) {
      const v = verifyQuote(parsed.value.authorizing_quote, message);
      console.log(`    quote check against your message: ${v.ok ? `PASS (as typed: ${JSON.stringify(v.wordsAsTyped)})` : `REFUSED (${v.code})`}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--full") {
    const message = argv.slice(1).join(" ").trim();
    if (!message) {
      console.error('Give a message, e.g. --full "What\'s going on?"');
      process.exit(2);
    }
    return fullMode(message);
  }
  const cfg = readProviderConfig(process.env);
  if (!cfg.ok) {
    if (cfg.reason === "missing_key") {
      console.error("MODEL_API_KEY is not set. Nothing was sent. Put it in .env.local and run this again.");
    } else {
      console.error("MODEL_API_BASE_URL is not a usable address (it must be https). Nothing was sent.");
    }
    process.exit(2);
  }
  const config = cfg.config;

  const tool = {
    name: "echo_number",
    description: "Returns the number it is given. Call it exactly once with the number the user asks for.",
    parameters: {
      type: "object",
      properties: { number: { type: "integer", description: "The number to echo." } },
      required: ["number"],
      additionalProperties: false,
    },
  };
  const input = {
    messages: [
      { role: "system" as const, content: "You are a connectivity check. Use the tool you are given when asked." },
      { role: "user" as const, content: "Call the echo_number tool with the number 7." },
    ],
    tools: [tool],
    maxTokens: 200,
  };

  const req = buildRequest(config, input);
  console.log(`POST ${req.url}`);
  console.log(`model requested: ${config.model}`);
  console.log(`tools offered:   ${tool.name}`);

  const started = Date.now();
  const res = await callProvider(config, input, { timeoutMs: 45_000 });
  const ms = Date.now() - started;

  if (!res.ok) {
    console.error(`\nFAILED after ${ms}ms: ${res.error.kind}${res.error.status ? ` (HTTP ${res.error.status})` : ""}`);
    console.error(`  ${res.error.detail}`);
    console.error("\nThe assistant will not work until this passes. If the error names a parameter, tell the build space exactly what it says.");
    process.exit(1);
  }

  const r = res.result;
  console.log(`\nOK in ${ms}ms`);
  console.log(`model reported:  ${r.model ?? "(the response named no model)"}`);
  console.log(
    `usage:           ${r.usage ? `${r.usage.inputTokens} in / ${r.usage.outputTokens} out` : "(the response carried no usage block -- the ledger would record null)"}`
  );
  console.log(`finish reason:   ${r.finishReason ?? "(none)"}`);
  console.log(`text:            ${r.content.trim() === "" ? "(none)" : JSON.stringify(r.content.trim().slice(0, 200))}`);

  if (r.toolCalls.length === 0) {
    console.log("tool call:       NOT MADE (the model answered in text). The call itself worked; function calling is unconfirmed.");
    return;
  }
  const call = r.toolCalls[0];
  const parsed = parseArgumentsJson(call.argumentsRaw);
  console.log(`tool call:       ${call.name} id=${call.id}`);
  console.log(`  arguments raw:    ${JSON.stringify(call.argumentsRaw)}`);
  console.log(`  arguments parsed: ${parsed.ok ? JSON.stringify(parsed.value) : `NO (${parsed.error})`}`);
  const good = call.name === tool.name && parsed.ok && parsed.value.number === 7;
  console.log(good ? "\nFunction calling works as the adapter expects." : "\nThe model returned a tool call, but not the expected one; read the lines above.");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
