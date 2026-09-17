// Finding a funder's own pages, without a search provider and without a model.
//
// Measured across 29 live prospect sites: sitemap.xml works for 55%, homepage
// link extraction for a further 31%, four are unreachable, and none of the
// reachable ones yielded nothing. robots.txt disallows crawling on zero.
//
// This module only RETRIEVES a candidate URL list. Reducing that list to
// something a model can be shown is lib/tier2/manifest.ts, and the split is
// deliberate: discovery touches the network and cannot be tested offline,
// reduction is pure and must be.

import { classifyDomain, EXPANSION_AUTHORIZED, type DomainVerdict } from "./domain";
import type { DiscoveredUrl } from "./manifest";

const TIMEOUT_MS = 15_000;
const UA = "FundraisingAI/1.0 (+nonprofit prospect research)";

export const DISCOVERY_METHODS = ["sitemap", "links", "sitemap+links", "none", "unreachable"] as const;
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number];

export type RobotsPolicy = "absent" | "allows" | "disallows-all" | "error";

export type DiscoveryResult = {
  host: string;
  method: DiscoveryMethod;
  urls: DiscoveredUrl[];
  robots: RobotsPolicy;
  httpStatus: number | null;
  // Not "we found nothing" -- a 403 is a retrieval failure and must never be
  // recorded as an absence. Blocking is heterogeneous and NOT user-agent
  // driven: one measured site blocks every agent identically, another blocks a
  // browser agent while allowing ours. Impersonating a browser is ineffective
  // and in one case actively worse, so we do not.
  failure: string | null;
  note: string;
  // True when a safety limit stopped the sweep. A truncated catalogue must
  // never be reported as an exhaustive one.
  sitemapTruncated?: boolean;
  // Does this website actually belong to this prospect? Verified BEFORE any
  // expansion, because crawling around an unverified domain retrieves more
  // confidently irrelevant material -- measured, one prospect row pointed at a
  // domain that was not the funder's and every result described a stranger.
  domain?: DomainVerdict;
  expansionAuthorized?: boolean;
};

async function get(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

export function hostOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

export async function checkRobots(host: string): Promise<RobotsPolicy> {
  const r = await get(`https://${host}/robots.txt`);
  if (!r) return "error";
  if (r.status >= 400) return "absent";
  const wildcard = r.body.split(/user-agent:/i).find((b) => b.trimStart().startsWith("*"));
  if (wildcard && /^\s*disallow:\s*\/\s*$/im.test(wildcard)) return "disallows-all";
  return "allows";
}

export async function discoverSitePages(
  host: string,
  opts: {
    checkRobotsFirst?: boolean;
    // Supplied, the domain is verified before anything is crawled. Omitted,
    // discovery still runs but records the domain as unverified rather than
    // silently assuming it belongs to the prospect.
    prospectNames?: (string | null | undefined)[];
    parentNames?: (string | null | undefined)[];
  } = {}
): Promise<DiscoveryResult> {
  const base: DiscoveryResult = {
    host, method: "none", urls: [], robots: "absent", httpStatus: null, failure: null, note: "",
  };
  if (opts.checkRobotsFirst !== false) {
    base.robots = await checkRobots(host);
    if (base.robots === "disallows-all") {
      return { ...base, method: "none", note: "robots.txt disallows crawling; not fetched" };
    }
  }

  // BOTH sources, merged -- not one or the other.
  //
  // Sitemap-first is right on average and wrong often enough to matter. The
  // Antioch Foundation's sitemap produced 39 entries from which selection chose
  // nothing; its homepage links produce /how-to-apply, /what-we-do,
  // /grant-highlights and /faq. One source having a page the other lacks is
  // common, and choosing between them discards it.
  //
  // This is BROADER DISCOVERY, not automatically better coverage: more
  // candidates also means more noise, and whether recall actually improves is
  // for the page-selection reference test to measure, not for this comment to
  // assert.
  const [sitemap, homepage] = await Promise.all([discoverFromSitemap(host), discoverFromHomepage(host)]);
  const sitemapUrls = sitemap.urls;

  if (!homepage.reachable && sitemapUrls.length === 0) {
    return { ...base, method: "unreachable", httpStatus: homepage.status, failure: homepage.failure ?? "homepage unreachable", note: homepage.failure ?? "unreachable" };
  }

  // Canonicalization and deduplication happen in buildManifest, which owns
  // both. Merging here only concatenates, so a URL found by both sources
  // arrives twice and its title -- which only the homepage carries -- survives
  // the merge there.
  // Verify before expanding. A rejected domain still returns what it found --
  // deleting evidence is never the answer -- but nothing downstream may treat
  // it as the funder speaking about itself, and no related host is admitted.
  const domain = opts.prospectNames?.length
    ? classifyDomain({
        requestedHost: host,
        finalHost: homepage.reachable ? host : null,
        pageTitle: homepage.title,
        pageText: homepage.text,
        prospectNames: opts.prospectNames,
        parentNames: opts.parentNames,
      })
    : { state: "unverified" as const, reason: "no prospect name supplied to verify against", officialHost: host };

  const urls = [...sitemapUrls, ...homepage.urls];
  const method: DiscoveryMethod =
    sitemapUrls.length && homepage.urls.length ? "sitemap+links"
    : sitemapUrls.length ? "sitemap"
    : homepage.urls.length ? "links"
    : "none";

  return {
    ...base,
    method,
    httpStatus: homepage.status,
    urls,
    domain,
    expansionAuthorized: EXPANSION_AUTHORIZED.has(domain.state),
    note: `${sitemapUrls.length} from sitemap${sitemap.childrenTotal ? ` (${sitemap.childrenFollowed}/${sitemap.childrenTotal} children)` : ""}, ${homepage.urls.length} from homepage links`,
    sitemapTruncated: sitemap.truncated,
  };
}

// A sitemap index lists several children and we used to follow exactly ONE,
// picked by a /page/ name heuristic. Everything in the others was invisible.
// Measured: eaa.org has 5 children, cmalliance.org has 10, maclellan.net has 2,
// and human-verified grant pages sat in children we never opened. That is a
// structural defect against every CMS that splits its sitemap -- WordPress and
// Yoast between them cover most of this pipeline.
//
// Bounded rather than unlimited: a documented safety limit, reported when hit,
// so a truncated sweep is never mistaken for an exhaustive one.
export const MAX_SITEMAP_CHILDREN = 12;
export const MAX_SITEMAP_URLS = 25_000;

async function discoverFromSitemap(host: string): Promise<{ urls: DiscoveredUrl[]; childrenFollowed: number; childrenTotal: number; truncated: boolean }> {
  const empty = { urls: [], childrenFollowed: 0, childrenTotal: 0, truncated: false };
  const sm = await get(`https://${host}/sitemap.xml`);
  if (!sm || sm.status >= 400 || !/<(urlset|sitemapindex)/i.test(sm.body)) return empty;

  if (!/<sitemapindex/i.test(sm.body)) {
    const urls = locs(sm.body).slice(0, MAX_SITEMAP_URLS);
    return { urls: urls.map((u) => ({ url: u })), childrenFollowed: 0, childrenTotal: 0, truncated: false };
  }

  const children = locs(sm.body);
  // Order matters only for what survives the safety limit: pages before posts,
  // because priorities live on pages and news does not.
  const ordered = [...children].sort((a, b) => Number(/post|news|video|tag|categor/i.test(a)) - Number(/post|news|video|tag|categor/i.test(b)));
  const toFollow = ordered.slice(0, MAX_SITEMAP_CHILDREN);

  const seen = new Set<string>();
  const urls: DiscoveredUrl[] = [];
  const fetched = await Promise.all(toFollow.map((c) => get(c)));
  for (const child of fetched) {
    if (!child || child.status >= 400) continue;
    for (const u of locs(child.body)) {
      if (seen.has(u) || urls.length >= MAX_SITEMAP_URLS) continue;
      seen.add(u);
      urls.push({ url: u });
    }
  }
  return {
    urls,
    childrenFollowed: toFollow.length,
    childrenTotal: children.length,
    truncated: children.length > toFollow.length || urls.length >= MAX_SITEMAP_URLS,
  };
}

async function discoverFromHomepage(host: string): Promise<{ urls: DiscoveredUrl[]; status: number | null; reachable: boolean; failure: string | null; title: string | null; text: string | null }> {
  const home = await get(`https://${host}/`);
  if (!home) return { urls: [], status: null, reachable: false, failure: "homepage fetch failed or timed out", title: null, text: null };
  if (home.status >= 400) return { urls: [], status: home.status, reachable: false, failure: `homepage HTTP ${home.status}`, title: null, text: null };

  const anchors = [...home.body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const urls: DiscoveredUrl[] = [];
  for (const [, href, inner] of anchors) {
    try {
      const abs = new URL(href, `https://${host}/`);
      if (!abs.hostname.replace(/^www\./, "").endsWith(host)) continue;
      const title = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      urls.push({ url: abs.toString(), title: title || null });
    } catch {
      // Not a resolvable href.
    }
  }
  const title = home.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  // Enough text to find an organization naming itself, not the whole page.
  const text = home.body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);
  return { urls, status: home.status, reachable: true, failure: null, title, text };
}
