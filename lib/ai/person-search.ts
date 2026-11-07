// Finding candidate matches for a recorded person (STATE item 107 slice A,
// ruling 0044 clauses 2 and 4). Server-only: never import this into a client
// component (it uses the Anthropic client).
//
// The general invariant: the PUBLIC WEB is searched through the model provider's
// own web-search tool, what that search returns is captured, and the model only
// SELECTS from the captured list. A candidate's URL, title and passage are the
// captured ones, never typed by the model; a candidate on a social network or a
// people-data broker is discarded in code and logged; the model returns, per
// candidate, only a source index, a name, what the source says they do and where.
//
// This file never fetches a page itself. There is no `fetch(`, no browser, no
// crawler, no login and no credential here: the only outbound call is the model
// provider's messages API, with its web-search tool (scripts/test-network-
// identity.ts scans for this). It follows the shape of lib/ai/funder-search.ts:
// the same search tool version and `allowed_callers`, the same capture of
// citations (citedSources) and surfaced pages (searchedSources), the same model
// as the other live, human-waited-on calls, and the same timeouts (120 s for the
// search; 60 s for the selection, as findNetworkPaths).
//
// One look is TWO model calls -- the search, then a forced-tool selection from
// the numbered captured sources -- and ONE ledger run: the caller births the run
// before calling this, passes its usage accumulator, and finalizes it. Tokens are
// added after each call, so a failure in the second call still records what the
// first consumed.
//
// Only the recorded name, employer, title, city and state reach the model
// (lib/network-identity.ts recordedFactLines). Notes and how the recorder knows
// the person are never part of a search about them (ruling 0044 clause 10).

import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { addResponseUsage, type UsageAccumulator } from "@/lib/ai-runs";
import {
  PERSON_CANDIDATES_TOOL,
  PERSON_SEARCH_BLOCKED_DOMAINS,
  buildPersonSearchPrompt,
  buildPersonSelectPrompt,
  indexPersonSources,
  validatePersonCandidates,
  type CandidateDraft,
  type DiscardedCandidate,
  type IdentityFacts,
  type PersonCitedSource,
  type PersonSearchedSource,
  type RefusedSource,
} from "@/lib/network-identity";

export const PERSON_SEARCH_MAX_USES = 3;
export const PERSON_SEARCH_TIMEOUT_MS = 120_000;
export const PERSON_SELECT_TIMEOUT_MS = 60_000;

export type PersonLookResult = {
  candidates: CandidateDraft[];
  discarded: DiscardedCandidate[];
  // Sources the search returned that were left out because their host is a
  // social or professional network or a people-data broker.
  refusedSources: RefusedSource[];
  sourcesOffered: number;
  searchesUsed: number;
};

// What the search actually returned, read off the response the way
// searchFunderWeb reads it: the pages sentences were cited to (with the text
// cited) and every page the search surfaced.
export function capturedSources(content: readonly unknown[]): { cited: PersonCitedSource[]; searched: PersonSearchedSource[]; searchesUsed: number } {
  const cited: PersonCitedSource[] = [];
  const searched = new Map<string, PersonSearchedSource>();
  let searchesUsed = 0;
  for (const block of content) {
    const b = block as { type?: string; citations?: unknown; content?: unknown };
    if (b.type === "web_search_tool_result") {
      searchesUsed++;
      if (!Array.isArray(b.content)) continue; // an error object, not results
      for (const result of b.content) {
        const r = result as Record<string, unknown>;
        if (r.type !== "web_search_result" || typeof r.url !== "string") continue;
        if (!searched.has(r.url)) {
          searched.set(r.url, { url: r.url, title: typeof r.title === "string" ? r.title : null, pageAge: typeof r.page_age === "string" ? r.page_age : null });
        }
      }
      continue;
    }
    if (b.type !== "text" || !Array.isArray(b.citations)) continue;
    for (const citation of b.citations) {
      const c = citation as Record<string, unknown>;
      if (c.type === "web_search_result_location" && typeof c.url === "string") {
        cited.push({ url: c.url, title: typeof c.title === "string" ? c.title : null, citedText: typeof c.cited_text === "string" ? c.cited_text : "" });
      }
    }
  }
  return { cited, searched: Array.from(searched.values()), searchesUsed };
}

export async function findPersonCandidates(facts: IdentityFacts, usage: UsageAccumulator): Promise<PersonLookResult> {
  // The same search tool and caller restriction as funder-search.ts, with the
  // social and people-data domains asked to be left out of results. That is a
  // request to the provider; the refusal that matters is in indexPersonSources
  // and validatePersonCandidates.
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
      max_tokens: 2000,
      tools: [searchTool],
      messages: [{ role: "user", content: buildPersonSearchPrompt(facts) }],
    },
    { timeout: PERSON_SEARCH_TIMEOUT_MS }
  );
  addResponseUsage(usage, searchResponse);

  const captured = capturedSources(searchResponse.content);
  const { sources, refused } = indexPersonSources(captured.cited, captured.searched);
  for (const r of refused) {
    console.log(`[network_identity] left out a source (${r.kind === "social_network" ? "social or professional network" : r.kind === "people_data_broker" ? "people-data broker" : "not a web page"}): ${r.url}`);
  }
  if (sources.length === 0) {
    return { candidates: [], discarded: [], refusedSources: refused, sourcesOffered: 0, searchesUsed: captured.searchesUsed };
  }

  const selectResponse = await anthropic.messages.create(
    {
      model: DRAFT_MODEL,
      max_tokens: 1500,
      tools: [PERSON_CANDIDATES_TOOL],
      tool_choice: { type: "tool", name: PERSON_CANDIDATES_TOOL.name },
      messages: [{ role: "user", content: buildPersonSelectPrompt(facts, sources) }],
    },
    { timeout: PERSON_SELECT_TIMEOUT_MS }
  );
  addResponseUsage(usage, selectResponse);

  const toolUse = selectResponse.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("The AI did not return a structured answer. Try again.");

  const { kept, discarded } = validatePersonCandidates((toolUse.input as { candidates?: unknown }).candidates, sources, facts);
  for (const d of discarded) {
    console.log(`[network_identity] discarded a candidate (${d.reason})`);
  }
  return { candidates: kept, discarded, refusedSources: refused, sourcesOffered: sources.length, searchesUsed: captured.searchesUsed };
}
