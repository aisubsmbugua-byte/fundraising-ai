import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { resolveModel } from "@/lib/ai/model-select";
import { channelLabel } from "@/lib/prospects";

export type CitedSource = { url: string; title: string | null; citedText: string };
export type SearchedSource = { url: string; title: string | null; pageAge: string | null };
// A page the model actually fetched and read in full, not just saw as a
// search result. Only produced for purpose: "research_only".
export type FetchedSource = { url: string; title: string | null; retrievedAt: string | null };

// Shared by the live combined deep-dive action and the new (dark,
// superadmin-only) Research Agent action -- same web-search call either
// way, extracted here so neither has to duplicate it. This is a pure,
// behavior-preserving extraction of what deep-dive-actions.ts already did
// inline: same prompt, same model, same tool config, same timeout.
//
// purpose distinguishes the two callers' prompts: "combined" (the default,
// used by deep-dive-actions.ts) keeps the original wording byte-for-byte,
// including "how they prefer to be approached" -- Strategy-flavored
// framing that combined deep-dive genuinely needs. "research_only" (used
// by runResearch) drops that clause entirely -- Research must stay
// upstream of Strategy (see docs/decisions/0002-research-agent.md's
// governing principles), and that framing has no place in findings meant
// to be pure fact-gathering.
export async function searchFunderWeb(
  prospect: {
    name: string;
    organization: string | null;
    website: string | null;
    channel: string;
  },
  purpose: "combined" | "research_only" = "combined",
  // Only meaningful for research_only. "screen" skips page fetching
  // entirely -- see RESEARCH_DEPTHS in lib/research.ts.
  depth: "screen" | "dossier" = "dossier"
): Promise<{
  findings: string;
  // Which model actually ran the search, so the caller can price it.
  model: string;
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
  // Pages fetched and read in full (research_only). fetchedCitations are
  // citation spans into those pages -- same shape as citedSources, but
  // sourced from full page text rather than a search snippet, so they can
  // carry filing-level detail. Empty for purpose: "combined".
  fetchedSources: FetchedSource[];
  fetchedCitations: CitedSource[];
  // False when the fetch tool was rejected by the API and the call fell
  // back to search-only, so a run can say so rather than silently looking
  // like a shallow result.
  fetchAvailable: boolean;
}> {
  // max_uses caps how many searches Claude can run in this pass -- the
  // main lever on latency. Kept tight on purpose: this is meant to be
  // "fast enough to wait for," not exhaustive research. allowed_callers:
  // ["direct"] bypasses the code-execution "dynamic filtering" caller that
  // _20260209-or-later tool versions default to -- extra latency-variance
  // machinery this call doesn't need (Discovery Search's repeated timeouts
  // were traced to this same tool version's default behavior).
  const researchOnlyPrompt = `Research this specific funding organization for a nonprofit's fact-finding record: "${prospect.name}"${prospect.organization ? ` (${prospect.organization})` : ""}${prospect.website ? `, website: ${prospect.website}` : ""}. This is a ${channelLabel(prospect.channel)} channel funder.

Work in two passes:
1. SEARCH to locate the authoritative sources for this organization.
2. Then FETCH and read the most authoritative pages you found. Search-result snippets are far too short to carry real detail, so fetch the page rather than relying on its snippet. Two kinds of page matter most, and you should read BOTH kinds when they exist:
   a. IRS Form 990/990-PF data (e.g. ProPublica's Nonprofit Explorer) -- the only reliable source of financial figures.
   b. The funder's OWN website pages about applying -- FAQ, grant guidelines, "how to apply", eligibility, what they do and do not fund. Application rules, eligibility, exclusions and fiscal-sponsorship terms appear ONLY here; a filing will never contain them. Do not skip these in favour of filings.

Find real, current, verifiable facts: identity (legal name, EIN, location), funding priorities and focus areas, eligibility and application requirements, deadlines, and key people.

Report each of these financial facts SEPARATELY, and name the fiscal or tax year for every single figure:
- total revenue, total expenses, and total assets
- total charitable disbursements / grants paid
- the number of grants made in the year
- grant size range, and median grant size
- named recent grant recipients with amounts, where a filing lists them

Reporting periods are mandatory: attach the fiscal/tax year to every financial figure. If figures from different years appear, prefer the most recent filing and state which year each figure came from. Never blend years, and never call a figure "most recent" without naming its year.

Only report things you actually find -- do not invent facts. If something isn't available, say so plainly rather than approximating. Do NOT recommend an approach, suggest positioning, or draft any outreach language -- this is fact-gathering only, not strategy.`;

  // Triage-depth. Deliberately does NOT ask for filing-level financial
  // detail: that requires reading 990s in full, which is what makes dossier
  // depth expensive. Asking for it here would either be ignored or answered
  // from unreliable snippets, and an undated figure from a snippet is worse
  // than no figure at all.
  const screenPrompt = `Screen this funding organization for a nonprofit's prospect triage: "${prospect.name}"${prospect.organization ? ` (${prospect.organization})` : ""}${prospect.website ? `, website: ${prospect.website}` : ""}. This is a ${channelLabel(prospect.channel)} channel funder.

This is a fast first pass to decide whether the funder is worth pursuing -- not a full dossier. A few well-chosen searches, no exhaustive research.

Find what triage needs to decide whether this funder is worth pursuing:
- Identity: legal name, EIN if stated, location, official website.
- Fit: funder type, the cause areas they fund, geographic focus, whether they fund internationally.
- Capacity: total annual giving, total assets, the range and median size of individual grants, and how many grants they make in a year. A funder whose grants top out well below a typical ask is not worth pursuing however well the mission aligns, so these matter as much as fit.
- Access: whether they accept unsolicited applications, and the names and roles of the people who run the foundation.

Financial figures must be dated or omitted. If a figure appears with its fiscal or tax year clearly stated, report it with that year; if it does not, leave it out rather than reporting an undated or approximate number -- an undated figure is worse than none. If two sources give different figures for the same thing, report both and say which source each came from rather than picking one. Only report things you actually find -- do not invent facts. Do NOT recommend an approach, suggest positioning, or draft any outreach language.`;

  const combinedPrompt = `Research this specific funding organization to help a nonprofit advancement team decide how to approach them: "${prospect.name}"${prospect.organization ? ` (${prospect.organization})` : ""}${prospect.website ? `, website: ${prospect.website}` : ""}. This is a ${channelLabel(prospect.channel)} channel funder.

Find real, current information, but be efficient -- a couple of well-chosen searches, not exhaustive research: funding priorities/focus areas, typical grant or gift size if publicly known, how they prefer to be approached, and anything relevant to fit. Only report things you actually find -- do not invent facts. Keep your written summary concise.`;

  const isResearch = purpose === "research_only";
  const isScreen = isResearch && depth === "screen";

  // The live combined deep-dive keeps its original tool config and token
  // budget byte-for-byte -- a human waits on that call, so its latency
  // budget is the constraint. Research is a background evaluation pipeline
  // where retrieval depth matters more than speed, so it gets more
  // searches, a fetch tool, and room to actually write what it found.
  const searchTool = {
    type: "web_search_20260318" as const,
    name: "web_search" as const,
    max_uses: isScreen ? 3 : isResearch ? 6 : 3,
    allowed_callers: ["direct" as const],
  };
  // citations default to DISABLED on web_fetch -- without this, fetched
  // pages produce no citation spans at all and the evidence ledger would
  // gain nothing from fetching.
  const fetchTool = {
    type: "web_fetch_20260318" as const,
    name: "web_fetch" as const,
    max_uses: 5,
    citations: { enabled: true },
    max_content_tokens: 30_000,
    allowed_callers: ["direct" as const],
  };

  // Research runs on its own (cheaper) model; the live combined deep-dive
  // keeps DRAFT_MODEL untouched -- see resolveModel in lib/ai/model-select.ts.
  const searchModel = isResearch ? resolveModel("research_search").model : DRAFT_MODEL;

  const request = (withFetch: boolean) =>
    anthropic.messages.create(
      {
        model: searchModel,
        max_tokens: isResearch ? 8000 : 2000,
        tools: withFetch ? [searchTool, fetchTool] : [searchTool],
        messages: [{ role: "user", content: isResearch ? researchOnlyPrompt : combinedPrompt }],
      },
      // 150s, down from 240s: real research searches land at 60-90s even
      // with page fetches, so 240 was unused headroom that pushed the
      // search+extraction worst case (240+280) past the route's 450s
      // maxDuration. 150+280 = 430s fits, and still leaves ample room over
      // the observed times. The combined deep-dive keeps its 120s.
      { timeout: isResearch ? 150_000 : 120_000 }
    );

  // Fetch can't be exercised from this repo's local env (no ANTHROPIC_API_KEY
  // here), so rather than let an unsupported-tool rejection turn into a
  // failed run, fall back to search-only once. Worst case this lands exactly
  // on the previous behavior instead of an error; fetchAvailable records
  // which path actually ran.
  let fetchAvailable = isResearch && !isScreen;
  let searchResponse;
  if (isScreen) {
    // No fetch tool at all: page content is the dominant input-token cost, so
    // withholding the tool (rather than asking the model not to use it) is
    // what makes screen depth cheap.
    searchResponse = await request(false);
  } else if (isResearch) {
    try {
      searchResponse = await request(true);
    } catch (err) {
      fetchAvailable = false;
      console.error("web_fetch unavailable, falling back to search-only:", err instanceof Error ? err.message : err);
      searchResponse = await request(false);
    }
  } else {
    fetchAvailable = false;
    searchResponse = await request(false);
  }

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
  // Pages actually fetched, in the order the API returned them. Error
  // blocks (a fetch that failed or was blocked) are skipped -- they carry
  // no document to cite.
  const fetchedSources: FetchedSource[] = [];
  for (const block of searchResponse.content) {
    if (block.type !== "web_fetch_tool_result") continue;
    const content = (block as { content?: unknown }).content as Record<string, unknown> | undefined;
    if (!content || content.type !== "web_fetch_result" || typeof content.url !== "string") continue;
    const doc = content.content as Record<string, unknown> | undefined;
    fetchedSources.push({
      url: content.url,
      title: doc && typeof doc.title === "string" ? doc.title : null,
      retrievedAt: typeof content.retrieved_at === "string" ? content.retrieved_at : null,
    });
  }

  // A char_location citation names a document, not a URL, so it has to be
  // resolved back to the page it came from. document_index is the primary
  // key (fetched documents are the only documents in this request, so they
  // index 0..n in fetch order); document_title is a cross-check and a
  // fallback. If neither resolves, the span is DROPPED rather than guessed
  // -- attributing captured text to the wrong URL is exactly the failure
  // this whole evidence design exists to prevent.
  const resolveFetchedDoc = (documentIndex: unknown, documentTitle: unknown): FetchedSource | null => {
    const byTitle = typeof documentTitle === "string" ? fetchedSources.filter((f) => f.title === documentTitle) : [];
    if (typeof documentIndex === "number") {
      const byIndex = fetchedSources[documentIndex];
      if (byIndex && (typeof documentTitle !== "string" || byIndex.title === null || byIndex.title === documentTitle)) return byIndex;
    }
    return byTitle.length === 1 ? byTitle[0] : null;
  };

  const citedSources: CitedSource[] = [];
  const fetchedCitations: CitedSource[] = [];
  for (const block of searchResponse.content) {
    if (block.type !== "text") continue;
    const citations = (block as { citations?: unknown }).citations;
    if (!Array.isArray(citations)) continue;
    for (const citation of citations) {
      const c = citation as Record<string, unknown>;
      if (c.type === "web_search_result_location" && typeof c.url === "string") {
        citedSources.push({
          url: c.url,
          title: typeof c.title === "string" ? c.title : null,
          citedText: typeof c.cited_text === "string" ? c.cited_text : "",
        });
        continue;
      }
      if (c.type === "char_location" && typeof c.cited_text === "string" && c.cited_text.length > 0) {
        const doc = resolveFetchedDoc(c.document_index, c.document_title);
        if (!doc) continue;
        fetchedCitations.push({ url: doc.url, title: doc.title, citedText: c.cited_text });
      }
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
    model: searchModel,
    stopReason: searchResponse.stop_reason,
    usage: {
      inputTokens: searchResponse.usage?.input_tokens ?? 0,
      outputTokens: searchResponse.usage?.output_tokens ?? 0,
    },
    citedSources,
    searchedSources: Array.from(searchedByUrl.values()),
    fetchedSources,
    fetchedCitations,
    fetchAvailable,
  };
}
