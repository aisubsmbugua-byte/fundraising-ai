// Reading the pages selection chose.
//
// Code fetches, not the model. That is not a stylistic preference: the model's
// own fetch tool may only open a URL that already appeared in a search result,
// and three of eight fetches in the last measured agentic run failed with
// url_not_in_prior_context -- the model reaching for a page it had not been
// shown. Fetching from our own server removes that failure class entirely.
//
// Every outcome is recorded with a state that distinguishes "we could not
// reach it" from "it does not say". Those send a user to different next
// actions, and collapsing them is what invites a rerun that can never succeed.

import { canonicalizeUrl } from "./manifest";
import type { PageSelection, SelectionPurpose } from "./select";

const TIMEOUT_MS = 20_000;
const UA = "FundraisingAI/1.0 (+nonprofit prospect research)";
// Enough for a guidelines page; short of a page that is really a document
// dump. Truncation is recorded rather than silent.
export const MAX_TEXT_CHARS = 40_000;
const CONCURRENCY = 4;

// A subset of the availability vocabulary, covering what a fetch can conclude.
// found / retrieval_failed / not_applicable are shared with the ledger in
// Step 4; a fetch never returns checked_not_stated, because whether a page
// STATES something is extraction's judgement, not retrieval's.
export const FETCH_STATES = ["found", "retrieval_failed", "empty"] as const;
export type FetchState = (typeof FETCH_STATES)[number];

// Below this, a page loaded but said almost nothing.
//
// Measured on a real funder: maclellan.net/fund is 104KB of HTML that yields
// 528 characters, because the page delivers "what we fund" as an embedded
// video. Nothing failed -- extraction is correct and the page genuinely has no
// prose -- but reporting that purpose as "found" would assert we had read
// their priorities when we had read their navigation.
//
// The threshold sits between that page and the thinnest real content on the
// same site (/our-foundations at 2,244 chars). It is a first cut and should be
// revisited once the reference set exists; being wrong here costs an extra
// look, while having no threshold at all costs a false claim of coverage.
export const MIN_SUBSTANTIVE_CHARS = 1_200;

export type FetchedPage = {
  url: string;
  purposes: SelectionPurpose[];
  state: FetchState;
  httpStatus: number | null;
  text: string;
  chars: number;
  truncated: boolean;
  contentType: string | null;
  fetchedAt: string;
  // Populated only when state is retrieval_failed. A 403 belongs here, never
  // in an "unavailable" bucket: blocking is heterogeneous, sometimes
  // intermittent, and may be path-specific.
  failure: string | null;
};

// Strip a page to readable text. Deliberately crude: this is not a renderer,
// and a funder's guidelines are prose in the DOM rather than something that
// needs JavaScript. Sites that genuinely require JS come back thin, and a thin
// page is visible in `chars` rather than pretending to be content.
export function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level boundaries become newlines so list items and headings do not
    // run into each other and read as one sentence.
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

async function fetchOne(selection: PageSelection): Promise<FetchedPage> {
  const url = canonicalizeUrl(selection.url) ?? selection.url;
  const base: FetchedPage = {
    url,
    purposes: selection.purposes,
    state: "retrieval_failed",
    httpStatus: null,
    text: "",
    chars: 0,
    truncated: false,
    contentType: null,
    fetchedAt: new Date().toISOString(),
    failure: null,
  };

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const contentType = res.headers.get("content-type");
    if (!res.ok) {
      return { ...base, httpStatus: res.status, contentType, failure: `HTTP ${res.status}` };
    }
    if (contentType && !/text\/html|text\/plain|xhtml/i.test(contentType)) {
      // A PDF or binary. Not a failure and not content we can read here --
      // recorded so a later pass can decide whether it is worth extracting.
      return { ...base, state: "empty", httpStatus: res.status, contentType, failure: null };
    }

    const html = await res.text();
    const full = extractText(html);
    const text = full.slice(0, MAX_TEXT_CHARS);
    return {
      ...base,
      state: text.trim().length > 0 ? "found" : "empty",
      httpStatus: res.status,
      contentType,
      text,
      chars: full.length,
      truncated: full.length > MAX_TEXT_CHARS,
      failure: null,
    };
  } catch (err) {
    return { ...base, failure: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchSelectedPages(selections: PageSelection[]): Promise<FetchedPage[]> {
  const out: FetchedPage[] = new Array(selections.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, selections.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= selections.length) return;
        out[i] = await fetchOne(selections[i]);
      }
    })
  );
  return out;
}

// Which purposes actually came back with something readable.
//
// A purpose the model declared unavailable and a purpose whose page failed to
// load are different facts and are kept apart: the first is about the site,
// the second about the fetch, and only the second is worth retrying.
export const PURPOSE_COVERAGE_STATES = ["found", "found_thin", "retrieval_failed", "not_offered", "not_checked"] as const;
export type PurposeCoverage = (typeof PURPOSE_COVERAGE_STATES)[number];

export function purposeCoverage(
  pages: FetchedPage[],
  unavailablePurposes: SelectionPurpose[]
): Record<SelectionPurpose, PurposeCoverage> {
  const all: SelectionPurpose[] = ["priorities", "eligibility", "process", "grants", "identity"];
  const coverage = {} as Record<SelectionPurpose, PurposeCoverage>;
  for (const p of all) {
    const forPurpose = pages.filter((page) => page.purposes.includes(p));
    const loaded = forPurpose.filter((page) => page.state === "found");
    if (loaded.some((page) => page.text.length >= MIN_SUBSTANTIVE_CHARS)) coverage[p] = "found";
    // Loaded, but every page for this purpose was too thin to have said
    // anything. Distinct from "found" because a downstream stage reading
    // "found" would assert we had read their priorities when we had read
    // their navigation -- and distinct from a failure, because nothing failed
    // and re-fetching will return the same video embed.
    else if (loaded.length > 0) coverage[p] = "found_thin";
    else if (forPurpose.length > 0) coverage[p] = "retrieval_failed";
    else if (unavailablePurposes.includes(p)) coverage[p] = "not_offered";
    else coverage[p] = "not_checked";
  }
  return coverage;
}
