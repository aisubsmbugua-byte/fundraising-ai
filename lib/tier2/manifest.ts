// Turning a site's URL list into something a model can be handed.
//
// Discovery is solved; SELECTION is not, and the two were conflated. Measured
// across the live pipeline: EAA Aviation returned 5,566 URLs of which 992
// matched a keyword filter, and Missio Nexus matched 396 of 410 -- a "filter"
// that keeps 96% is not filtering. Handing either list to a model recreates
// the token and latency problem the whole pipeline exists to remove.
//
// So reduction happens HERE, deterministically, before any model sees
// anything. Nothing in this file makes a network call or a judgement call:
// same input, same manifest, every time. The model's only job is to pick a
// handful of pages from a curated list it could never have assembled itself.
//
// Nothing is dropped silently. Every collapse and every cap is reported, so a
// manifest can never imply coverage it does not have.

export const MANIFEST_VERSION = 1;

// Beyond this a site is too large to enumerate for a screening decision, and
// the manifest says so rather than pretending it swept everything.
export const MAX_ENTRIES = 60;
// A parent path with more children than this is a listing -- news, events,
// staff bios -- and its children are collapsed to one representative.
export const GROUP_THRESHOLD = 3;
export const REPRESENTATIVES_PER_GROUP = 2;

export type DiscoveredUrl = { url: string; title?: string | null };

export type ManifestEntry = {
  url: string;
  title: string | null;
  depth: number;
  // Matched a pattern that could carry priorities or eligibility rules. These
  // are never collapsed and never capped away.
  mandatory: boolean;
  // 1 for a page in its own right; higher when this entry stands in for a
  // group of siblings that were collapsed.
  groupSize: number;
  groupPattern: string | null;
};

// Six states, because "we did not see it" and "we saw it and did not look at
// it" send a user to different places. A page dropped by the cap was
// DISCOVERED BUT NOT EVALUATED, and must never be reported as absent.
export const URL_STATES = [
  "discovered",
  "excluded_by_rule",      // an asset, a tag listing, a date archive
  "not_shortlisted_cap",   // survived the rules, lost to the cap -- not absent
  "selected",
  "fetch_succeeded",
  "fetch_failed",
] as const;
export type UrlState = (typeof URL_STATES)[number];

export type DiscoveryManifest = {
  manifestVersion: number;
  host: string | null;
  entries: ManifestEntry[];
  // The COMPLETE catalogue of everything discovery retrieved, after
  // canonicalisation and deduplication only. Cleaning and selection reduce what
  // is SHOWN; they must never erase the record that a URL was discovered --
  // that record is what lets the system say "we saw this and did not read it"
  // instead of implying the funder does not publish it.
  catalog: { url: string; title: string | null; state: UrlState }[];
  // Pages matching the specific opportunity being qualified. Promoted ahead of
  // the general cap: qualification is evaluating a KNOWN opportunity, not
  // discovering every arbitrarily named programme on a funder's site.
  opportunityMatches: ManifestEntry[];
  excludedByRule: number;
  discovered: number;
  afterCleaning: number;
  afterGrouping: number;
  capped: boolean;
  // What was collapsed or cut, so the reduction is auditable rather than
  // implied. A silent cap reads as "we covered everything".
  collapsed: { pattern: string; count: number }[];
  droppedByCap: number;
};

// Paths that could carry funding priorities or eligibility rules. Kept
// deliberately generous: a false positive costs one fetch, a false negative
// costs the decision. These bypass grouping and capping entirely.
// Every term here maps to a fact key the screening decision actually grades --
// fiscal/sponsor to application.fiscal_sponsorship_rules, deadline to
// application.deadline, grantee to funding.recent_grants, and so on. Missing
// one is how Maclellan's /fiscal-sponsorship/ page was nearly dropped.
// "scholar" and its siblings were missing, and the reference set caught it:
// EAA's entire grant programme is flight-training SCHOLARSHIPS, so
// /learn-to-fly/scholarships scored zero. A general class, not one funder --
// aviation, education, medical and arts funders routinely call a grant an
// award, a fellowship or a bursary.
const MANDATORY = /(grant|apply|application|eligib|guideline|criteria|fund(ing)?|program|priorit|who-we|what-we|restrict|faq|grantee|recipient|nonprofit|proposal|rfp|loi|fiscal|sponsor|deadline|scholar|fellowship|bursary|award|prize|stipend)/i;

// Things that are never a funder describing itself.
const ASSET_EXTENSION = /\.(jpe?g|png|gif|svg|webp|ico|css|js|mjs|zip|gz|mp[34]|mov|avi|woff2?|ttf|eot|xml|rss|json|csv|xlsx?|docx?|pptx?)$/i;
const NON_CONTENT_SEGMENT = /\/(tag|tags|category|categories|author|authors|feed|comments|wp-content|wp-json|wp-admin|cart|checkout|account|login|signin|sign-in|register|search|print|amp|embed)(\/|$)/i;
// /page/2, /p/3 -- pagination of a listing we will collapse anyway.
const PAGINATION = /\/(page|p)\/\d+\/?$/i;
// /2019/07/12/... -- date archives.
const DATE_ARCHIVE = /\/(19|20)\d{2}(\/\d{1,2}){0,2}(\/|$)/;

const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_|_hs|ref|source|campaign)/i;

// Canonicalize so two spellings of one page cannot occupy two manifest slots.
export function canonicalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.protocol = "https:";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    u.pathname = u.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/(.)\/$/, "$1");
    return u.toString();
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function segments(url: string): string[] {
  return pathOf(url).split("/").filter(Boolean);
}

// Depth no longer EXCLUDES. Measured against human ground truth: every page we
// found sat at path depth 1-2 and every page we missed sat at 3-5 --
// eaa.org/eaa/learn-to-fly/scholarships/eaa-flight-training-scholarships,
// cmalliance.org/our-work/church-ministries/pastoral-financial-health-initiative.
// A depth limit was right for the sites it was tested against and wrong for
// every funder that nests a programme under a section, which is the normal
// shape for large organisations.
//
// It remains a RANKING signal: shallower is still likelier, all else equal.
export const DEPTH_RANK_PENALTY = 1;

// Mandatory means "this page could carry priorities or eligibility rules", and
// it buys a page an exemption from grouping AND from the cap -- so a loose test
// here undoes the entire reduction.
//
// It was loose, and the measurement caught it. Substring-matching the whole
// path made 60 of EAA's 60 manifest entries "mandatory", all of them newsletter
// articles: /chaptergram-articles/2018-03-13-faq-balancing-the-needs matched
// "faq", /airventure/become-a-sponsor/why-exhibit-video matched "sponsor",
// /03-21-2017-chapter-fundraising-opp matched "fund". 679 of them bypassed
// collapsing on that basis and the cap then chose 60 at random.
//
// The fix is POSITION rather than presence: the keyword must BEGIN a path
// segment -- a page named "grants", not a slug mentioning them. A depth limit
// was also applied at first and has since been removed: it excluded real
// guidance pages nested under a section, and the position rule alone rejects
// every false positive it was catching.
export function isMandatoryPath(url: string, title?: string | null): boolean {
  const segs = segments(url);
  if (segs.some((s) => MANDATORY.test(s) && new RegExp(`^(${MANDATORY.source})`, "i").test(s))) {
    return true;
  }
  // A title is prose, so a word boundary is the right anchor there. This is
  // what rescues link-discovered pages whose URL is an opaque id.
  return title ? new RegExp(`\\b(${MANDATORY.source})`, "i").test(title) : false;
}

// Is this URL worth considering at all? Assets, listings furniture and date
// archives are removed before anything else runs, so grouping and capping
// operate on pages rather than noise.
export function isContentUrl(url: string): boolean {
  const path = pathOf(url);
  if (ASSET_EXTENSION.test(path)) return false;
  if (NON_CONTENT_SEGMENT.test(path)) return false;
  if (PAGINATION.test(path)) return false;
  // A dated path is an archive UNLESS it also looks like guidance -- some
  // funders publish "2026-grant-guidelines".
  if (DATE_ARCHIVE.test(path) && !MANDATORY.test(path)) return false;
  return true;
}

// Does this URL look like the specific opportunity we were sent to qualify?
//
// Deterministic and deliberately narrow: distinctive tokens of the opportunity
// name must appear in the path or title. "Ministry Innovation Fund" finds
// /innovation/ and /innovation/2023-innovation-fund/ -- pages no keyword
// vocabulary could ever have predicted, because grant programmes are named
// arbitrarily. This is why the opportunity name is worth more than any list of
// words we could invent.
const OPPORTUNITY_STOPWORDS = new Set([
  "the", "and", "for", "of", "fund", "funds", "grant", "grants", "program",
  "programme", "initiative", "project", "foundation", "trust", "ministries",
  "ministry", "donor", "advised", "general", "annual",
]);

export function opportunityTokens(name: string | null | undefined): string[] {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !OPPORTUNITY_STOPWORDS.has(t));
}

export function matchesOpportunity(url: string, title: string | null | undefined, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const haystack = `${pathOf(url)} ${title ?? ""}`.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

export function buildManifest(
  discovered: DiscoveredUrl[],
  opts: {
    host?: string | null;
    maxEntries?: number;
    // From Discovery. A missing name or URL is an UPSTREAM deficiency, not a
    // retrieval one -- we were sent to qualify something nobody named.
    opportunityName?: string | null;
    sourceUrl?: string | null;
  } = {}
): DiscoveryManifest {
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const oppTokens = opportunityTokens(opts.opportunityName);

  // 1. Canonicalize and deduplicate. Titles survive the merge -- the first
  //    non-empty one wins, since a sitemap rarely carries one and a link does.
  const byUrl = new Map<string, ManifestEntry>();
  for (const d of discovered) {
    const url = canonicalizeUrl(d.url);
    if (!url || !isContentUrl(url)) continue;
    const existing = byUrl.get(url);
    if (existing) {
      if (!existing.title && d.title) existing.title = d.title;
      continue;
    }
    byUrl.set(url, {
      url,
      title: d.title ?? null,
      depth: segments(url).length,
      mandatory: isMandatoryPath(url, d.title),
      groupSize: 1,
      groupPattern: null,
    });
  }
  const cleaned = [...byUrl.values()];

  // The catalogue records everything retrieved, including what the rules
  // excluded. States are filled in as later stages run.
  const catalog: { url: string; title: string | null; state: UrlState }[] = [];
  const excludedUrls = new Set<string>();
  for (const d of discovered) {
    const url = canonicalizeUrl(d.url);
    if (!url) continue;
    if (!isContentUrl(url)) {
      if (!excludedUrls.has(url)) { excludedUrls.add(url); catalog.push({ url, title: d.title ?? null, state: "excluded_by_rule" }); }
      continue;
    }
    if (!catalog.some((c) => c.url === url)) catalog.push({ url, title: d.title ?? null, state: "discovered" });
  }

  // The opportunity we were actually sent to qualify. Matched against the FULL
  // catalogue, not the shortlist, and promoted outside the general cap.
  const opportunityMatches = cleaned.filter((e) => matchesOpportunity(e.url, e.title, oppTokens));
  const sourceUrl = opts.sourceUrl ? canonicalizeUrl(opts.sourceUrl) : null;
  if (sourceUrl && !opportunityMatches.some((e) => e.url === sourceUrl)) {
    const existing = cleaned.find((e) => e.url === sourceUrl);
    // Donor Finder's own source URL always belongs in the shortlist: it is the
    // page a human already saw describing this opportunity.
    opportunityMatches.unshift(existing ?? { url: sourceUrl, title: null, depth: 0, mandatory: true, groupSize: 1, groupPattern: null });
  }

  // 2. Collapse repeated path patterns. A parent with many children is a
  //    listing; its children are one shape of page, not many kinds. This is
  //    what turns 5,566 URLs into something enumerable.
  const byParent = new Map<string, ManifestEntry[]>();
  for (const e of cleaned) {
    const segs = segments(e.url);
    const parent = segs.length > 1 ? `/${segs.slice(0, -1).join("/")}` : "/";
    byParent.set(parent, [...(byParent.get(parent) ?? []), e]);
  }

  const grouped: ManifestEntry[] = [];
  const collapsed: { pattern: string; count: number }[] = [];
  for (const [parent, children] of byParent) {
    // Mandatory pages are never collapsed: a grant guidelines page must not be
    // represented by a sibling.
    const mandatory = children.filter((c) => c.mandatory);
    const rest = children.filter((c) => !c.mandatory);
    grouped.push(...mandatory);

    // The root's children are the site's navigation, not a listing. Collapsing
    // them is how Maclellan's manifest kept /cookies as a "representative"
    // while discarding /our-foundations and /multi-year -- the latter mapping
    // directly onto application.multiyear_grant_rules. Depth is bounded by the
    // cap instead.
    if (parent === "/" || rest.length <= GROUP_THRESHOLD) {
      grouped.push(...rest);
      continue;
    }
    const pattern = `${parent === "/" ? "" : parent}/*`;
    const reps = [...rest].sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url)).slice(0, REPRESENTATIVES_PER_GROUP);
    for (const r of reps) grouped.push({ ...r, groupSize: rest.length, groupPattern: pattern });
    collapsed.push({ pattern, count: rest.length - reps.length });
  }

  // 3. Cap, with PATH DIVERSITY.
  //
  // Ordering by depth alone lets one large shallow section consume the entire
  // cap -- a funder with 200 news posts at /news/x fills 60 slots before a
  // grants page three levels down is ever considered. So entries are grouped by
  // their first path segment and taken round-robin: every section of the site
  // gets representation before any section gets a second pass.
  //
  // Mandatory pages are still taken first and in full. Within a section,
  // shallower ranks higher.
  const mandatoryEntries = grouped.filter((e) => e.mandatory).sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
  const rest = grouped.filter((e) => !e.mandatory);

  const sections = new Map<string, ManifestEntry[]>();
  for (const e of rest) {
    const section = segments(e.url)[0] ?? "";
    sections.set(section, [...(sections.get(section) ?? []), e]);
  }
  for (const list of sections.values()) {
    list.sort((a, b) => a.depth * DEPTH_RANK_PENALTY - b.depth * DEPTH_RANK_PENALTY || a.url.localeCompare(b.url));
  }

  const roundRobin: ManifestEntry[] = [];
  const queues = [...sections.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list);
  for (let round = 0; roundRobin.length < rest.length; round++) {
    let placed = false;
    for (const q of queues) {
      if (round < q.length) { roundRobin.push(q[round]); placed = true; }
    }
    if (!placed) break;
  }

  // Opportunity matches first and in full -- they bypass the general cap.
  const oppUrls = new Set(opportunityMatches.map((e) => e.url));
  const ordered = [...mandatoryEntries, ...roundRobin].filter((e) => !oppUrls.has(e.url));
  const entries = [...opportunityMatches, ...ordered.slice(0, Math.max(0, maxEntries - opportunityMatches.length))];

  const shortlisted = new Set(entries.map((e) => e.url));
  for (const c of catalog) {
    if (c.state === "discovered" && !shortlisted.has(c.url)) c.state = "not_shortlisted_cap";
    else if (shortlisted.has(c.url)) c.state = "discovered";
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    host: opts.host ?? (cleaned[0] ? new URL(cleaned[0].url).hostname : null),
    entries,
    catalog,
    opportunityMatches,
    excludedByRule: catalog.filter((c) => c.state === "excluded_by_rule").length,
    discovered: discovered.length,
    afterCleaning: cleaned.length,
    afterGrouping: grouped.length,
    capped: ordered.length + opportunityMatches.length > entries.length,
    collapsed: collapsed.filter((c) => c.count > 0).sort((a, b) => b.count - a.count),
    droppedByCap: catalog.filter((c) => c.state === "not_shortlisted_cap").length,
  };
}

// What the selection call is actually shown. One line per entry, with the
// group size when an entry stands for many -- so the model can tell "the
// guidelines page" from "one of 400 news posts" without being handed 400.
export function renderManifest(manifest: DiscoveryManifest): string {
  return manifest.entries
    .map((e, i) => {
      const group = e.groupSize > 1 ? ` [1 of ~${e.groupSize} under ${e.groupPattern}]` : "";
      const title = e.title ? ` — "${e.title}"` : "";
      return `[${i}] ${e.url}${title}${group}`;
    })
    .join("\n");
}
