import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { channelLabel } from "@/lib/prospects";

export type CitedSource = { url: string; title: string | null; citedText: string };
export type SearchedSource = { url: string; title: string | null; pageAge: string | null };

// Shared by the live combined deep-dive action and the new (dark,
// superadmin-only) Research Agent action -- same web-search call either
// way, extracted here so neither has to duplicate it. This is a pure,
// behavior-preserving extraction of what deep-dive-actions.ts already did
// inline: same prompt, same model, same tool config, same timeout.
export async function searchFunderWeb(prospect: {
  name: string;
  organization: string | null;
  website: string | null;
  channel: string;
}): Promise<{
  findings: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  // Real, API-provided citation data -- see lib/ai/research-extract.ts for
  // why this exists: findings alone is flattened prose with no reliable
  // per-fact URLs, so a downstream extraction step asked to write a
  // source_url from that prose alone can only guess. citedSources are the
  // pages actual sentences in `findings` are grounded in (via the API's
  // own TextBlock.citations); searchedSources is the full set of pages
  // examined, cited or not (via WebSearchToolResultBlock.content) -- both
  // auto-populated by the API whenever the web_search tool runs, no extra
  // flag needed. deep-dive-actions.ts (the live combined action) only
  // destructures {findings, stopReason}, so adding these is additive.
  citedSources: CitedSource[];
  searchedSources: SearchedSource[];
}> {
  // max_uses caps how many searches Claude can run in this pass -- the
  // main lever on latency. Kept tight on purpose: this is meant to be
  // "fast enough to wait for," not exhaustive research. allowed_callers:
  // ["direct"] bypasses the code-execution "dynamic filtering" caller that
  // _20260209-or-later tool versions default to -- extra latency-variance
  // machinery this call doesn't need (Discovery Search's repeated timeouts
  // were traced to this same tool version's default behavior).
  const searchResponse = await anthropic.messages.create(
    {
      model: DRAFT_MODEL,
      max_tokens: 2000,
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 3, allowed_callers: ["direct"] }],
      messages: [
        {
          role: "user",
          content: `Research this specific funding organization to help a nonprofit advancement team decide how to approach them: "${prospect.name}"${prospect.organization ? ` (${prospect.organization})` : ""}${prospect.website ? `, website: ${prospect.website}` : ""}. This is a ${channelLabel(prospect.channel)} channel funder.

Find real, current information, but be efficient -- a couple of well-chosen searches, not exhaustive research: funding priorities/focus areas, typical grant or gift size if publicly known, how they prefer to be approached, and anything relevant to fit. Only report things you actually find -- do not invent facts. Keep your written summary concise.`,
        },
      ],
    },
    { timeout: 120_000 }
  );

  const findings = searchResponse.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");

  // Every citation instance is kept, not deduped by url -- a source cited
  // for several different sentences yields several entries, each with its
  // own citedText. Stage 4 (citation consistency -- see lib/research.ts)
  // needs all of them to check an extracted claim's excerpt against
  // anything that was actually cited, not just the first citation to that
  // url. buildIndexedSources() (research-extract.ts) still dedupes by url
  // for the numbered source list shown to the extraction prompt -- that's
  // a different, unrelated use of this same array.
  const citedSources: CitedSource[] = [];
  for (const block of searchResponse.content) {
    if (block.type !== "text") continue;
    const citations = (block as { citations?: unknown }).citations;
    if (!Array.isArray(citations)) continue;
    for (const citation of citations) {
      const c = citation as Record<string, unknown>;
      if (c.type !== "web_search_result_location" || typeof c.url !== "string") continue;
      citedSources.push({
        url: c.url,
        title: typeof c.title === "string" ? c.title : null,
        citedText: typeof c.cited_text === "string" ? c.cited_text : "",
      });
    }
  }

  const searchedByUrl = new Map<string, SearchedSource>();
  for (const block of searchResponse.content) {
    if (block.type !== "web_search_tool_result") continue;
    const content = (block as { content?: unknown }).content;
    if (!Array.isArray(content)) continue; // an error object, not results -- skip
    for (const result of content) {
      const r = result as Record<string, unknown>;
      if (r.type !== "web_search_result" || typeof r.url !== "string") continue;
      if (!searchedByUrl.has(r.url)) {
        searchedByUrl.set(r.url, {
          url: r.url,
          title: typeof r.title === "string" ? r.title : null,
          pageAge: typeof r.page_age === "string" ? r.page_age : null,
        });
      }
    }
  }

  return {
    findings,
    stopReason: searchResponse.stop_reason,
    usage: {
      inputTokens: searchResponse.usage?.input_tokens ?? 0,
      outputTokens: searchResponse.usage?.output_tokens ?? 0,
    },
    citedSources,
    searchedSources: Array.from(searchedByUrl.values()),
  };
}
