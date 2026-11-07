// Researching one confirmed person (STATE item 112, slice B of item 107; ruling
// 0044 clauses 3 and 4). Server-only: never import this into a client component
// (it uses the Anthropic client).
//
// The general invariant: the PUBLIC WEB is searched through the model provider's
// own web-search tool, what that search returns is captured, and the model only
// SELECTS from the captured list. A finding's URL, title and passage are the
// captured ones, never typed by the model; a source on a social network or a
// people-data broker is discarded in code and logged; the model returns, per
// finding, only a source index, a kind from the closed list, an organization and a
// role; a kind outside the list, a source that is not clearly about this person, and
// anything carrying a contact detail are discarded in code and logged.
//
// This file never fetches a page itself. There is no `fetch(`, no page-fetch tool,
// no browser, no crawler, no login and no credential here, and no ProPublica or
// IRS call (official records arrive through item 110): the only outbound call is
// the model provider's messages API, with its web-search tool
// (scripts/test-network-research.ts scans for this). It follows the shape of
// lib/ai/person-search.ts and REUSES it: the same search tool version and
// `allowed_callers`, the same blocked domains, the same model, the same timeouts
// (imported, not copied), the same reading of what the search returned, and the
// same numbered, scrubbed, refused-host-free list of captured sources.
//
// One research run is TWO model calls -- the search, then a forced-tool selection
// from the numbered captured sources -- and ONE ledger run: the caller births the
// run before calling this, passes its usage accumulator, and finalizes it. Tokens
// are added after each call, so a failure in the second still records what the
// first consumed.
//
// Only the recorded name, employer, title, city and state, and the confirmed
// candidate's headline, place and page (the identity anchor) reach the search and
// the model (lib/network-research.ts buildPersonResearchPrompt). Notes and how the
// recorder knows the person are never part of research about them (ruling 0044
// clause 10).

import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { addResponseUsage, type UsageAccumulator } from "@/lib/ai-runs";
import { PERSON_SEARCH_MAX_USES, PERSON_SEARCH_TIMEOUT_MS, PERSON_SELECT_TIMEOUT_MS, capturedSources } from "@/lib/ai/person-search";
import { PERSON_SEARCH_BLOCKED_DOMAINS, indexPersonSources, type IdentityFacts, type RefusedSource } from "@/lib/network-identity";
import {
  PERSON_FINDINGS_TOOL,
  buildFindingsSelectPrompt,
  buildPersonResearchPrompt,
  validatePersonFindings,
  type DiscardedFinding,
  type FindingDraft,
  type ResearchAnchor,
} from "@/lib/network-research";

export type PersonResearchResult = {
  findings: FindingDraft[];
  discarded: DiscardedFinding[];
  // Sources the search returned that were left out because their host is a
  // social or professional network or a people-data broker.
  refusedSources: RefusedSource[];
  sourcesOffered: number;
  searchesUsed: number;
};

export async function findPersonFindings(facts: IdentityFacts, anchor: ResearchAnchor, usage: UsageAccumulator): Promise<PersonResearchResult> {
  // The same search tool and caller restriction as person-search.ts, with the
  // social and people-data domains asked to be left out of results. That is a
  // request to the provider; the refusal that matters is in indexPersonSources
  // and validatePersonFindings.
  const searchTool = {
    type: "web_search_20260318" as const,
    name: "web_search" as const,
    max_uses: PERSON_SEARCH_MAX_USES,
    allowed_callers: ["direct" as const],
    blocked_domains: [...PERSON_SEARCH_BLOCKED_DOMAINS],
  };

  const searchResponse = await anthropic.messages.create(
    {
      model: DRAFT_MODEL,
      max_tokens: 2500,
      tools: [searchTool],
      messages: [{ role: "user", content: buildPersonResearchPrompt(facts, anchor) }],
    },
    { timeout: PERSON_SEARCH_TIMEOUT_MS }
  );
  addResponseUsage(usage, searchResponse);

  const captured = capturedSources(searchResponse.content);
  const { sources, refused } = indexPersonSources(captured.cited, captured.searched);
  for (const r of refused) {
    console.log(
      `[network_research] left out a source (${r.kind === "social_network" ? "social or professional network" : r.kind === "people_data_broker" ? "people-data broker" : "not a web page"}): ${r.url}`
    );
  }
  if (sources.length === 0) {
    return { findings: [], discarded: [], refusedSources: refused, sourcesOffered: 0, searchesUsed: captured.searchesUsed };
  }

  const selectResponse = await anthropic.messages.create(
    {
      model: DRAFT_MODEL,
      max_tokens: 2500,
      tools: [PERSON_FINDINGS_TOOL],
      tool_choice: { type: "tool", name: PERSON_FINDINGS_TOOL.name },
      messages: [{ role: "user", content: buildFindingsSelectPrompt(facts, anchor, sources) }],
    },
    { timeout: PERSON_SELECT_TIMEOUT_MS }
  );
  addResponseUsage(usage, selectResponse);

  const toolUse = selectResponse.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("The AI did not return a structured answer. Try again.");

  const { kept, discarded } = validatePersonFindings((toolUse.input as { findings?: unknown }).findings, sources, facts);
  for (const d of discarded) {
    console.log(`[network_research] discarded a finding (${d.reason})`);
  }
  return { findings: kept, discarded, refusedSources: refused, sourcesOffered: sources.length, searchesUsed: captured.searchesUsed };
}
