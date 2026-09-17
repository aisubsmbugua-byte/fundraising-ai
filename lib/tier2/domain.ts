// Does this website actually belong to this prospect?
//
// Layer 1, and it comes first for a reason: expanding discovery around an
// unverified domain retrieves more confidently irrelevant material. Measured --
// the Antioch prospect row carries theantiochfoundation.org while the funder is
// at antiochfoundation.org, and every measurement taken against that row
// described a different website. A Step 3 change was partly justified on it.
//
// Nothing here decides on absence. A site that loads and does not name the
// prospect is `unverified`, not `rejected`: failing to find a name is a fact
// about our matching, and only affirmative evidence of a DIFFERENT organization
// justifies rejection.

import { distinctiveNameTokens } from "../legitimacy";

export const DOMAIN_STATES = [
  "unverified",             // loaded, but nothing confirms it is theirs
  "confirmed_official",     // the site names the prospect
  "confirmed_parent",       // the site names a confirmed parent organization
  "redirected_to_current",  // the stored host redirects somewhere else
  "rejected",               // affirmatively identifies a different organization
  "shared_platform",        // a hosting domain; siblings are strangers
  "unreachable",
] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];

// Only these two authorize related-subdomain discovery.
export const EXPANSION_AUTHORIZED: ReadonlySet<DomainState> = new Set(["confirmed_official", "confirmed_parent"]);

// Hosting and site-builder domains. A sibling subdomain here belongs to an
// unrelated customer, so `*.squarespace.com` must never be treated as related.
// The church-platform entries matter for this sector specifically.
const SHARED_PLATFORMS = [
  "squarespace.com", "wixsite.com", "wix.com", "wordpress.com", "weebly.com",
  "godaddysites.com", "myshopify.com", "blogspot.com", "sites.google.com",
  "github.io", "netlify.app", "vercel.app", "pages.dev", "webflow.io",
  "churchcenter.com", "subsplash.com", "ministryplatform.com", "clover.com",
  "breezechms.com", "tithe.ly", "elexiochms.com",
];

// The boundary for "related". Deliberately the registrable domain rather than
// any shared suffix: centernet.pcusa.org and pcusa.org are one organization;
// pcusa.org and other-church.org are not.
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  // Two-part public suffixes we actually meet (co.uk, org.uk, org.au).
  const twoPart = /^(co|org|net|gov|ac|edu)\.(uk|au|nz|za|in)$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPart ? -3 : -2).join(".");
}

export function isSharedPlatform(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return SHARED_PLATFORMS.some((p) => h === p || h.endsWith(`.${p}`));
}

// Is `candidate` a subdomain of the same registrable domain as `official`?
export function isRelatedHost(candidate: string, official: string): boolean {
  if (isSharedPlatform(candidate) || isSharedPlatform(official)) return false;
  return registrableDomain(candidate) === registrableDomain(official);
}

// Organization-shaped words. A title containing one of these AND none of our
// tokens is affirmative evidence of a different entity -- not merely a failure
// to match.
const ORG_SHAPED = /\b(foundation|fund|trust|church|ministries|ministry|association|society|institute|college|university|incorporated|inc|llc)\b/i;

export type DomainVerdict = { state: DomainState; reason: string; officialHost: string | null };

export function classifyDomain(input: {
  requestedHost: string;
  // After following redirects. Null when nothing loaded.
  finalHost: string | null;
  pageTitle: string | null;
  pageText: string | null;
  prospectNames: (string | null | undefined)[];
  parentNames?: (string | null | undefined)[];
}): DomainVerdict {
  const requested = input.requestedHost.toLowerCase().replace(/^www\./, "");

  if (!input.finalHost) {
    return { state: "unreachable", reason: "nothing loaded", officialHost: null };
  }
  const final = input.finalHost.toLowerCase().replace(/^www\./, "");

  if (isSharedPlatform(final)) {
    // Still usable as a site; just not a family whose siblings we may crawl.
    return { state: "shared_platform", reason: `${final} is a hosting domain; sibling subdomains are unrelated customers`, officialHost: final };
  }

  const haystack = `${input.pageTitle ?? ""}\n${(input.pageText ?? "").slice(0, 4000)}`.toLowerCase();
  const ours = input.prospectNames.filter(Boolean).map((n) => distinctiveNameTokens(n)).filter((t) => t.length > 0);
  const matchesUs = ours.some((tokens) => tokens.every((t) => haystack.includes(t)));

  if (registrableDomain(final) !== registrableDomain(requested)) {
    // A redirect is itself evidence: the organization moved. Report it so the
    // stored row can be corrected rather than silently followed forever.
    return {
      state: "redirected_to_current",
      reason: `${requested} redirects to ${final}${matchesUs ? ", which names the prospect" : ""}`,
      officialHost: final,
    };
  }

  if (matchesUs) {
    return { state: "confirmed_official", reason: "the site names the prospect", officialHost: final };
  }

  const parents = (input.parentNames ?? []).filter(Boolean).map((n) => distinctiveNameTokens(n)).filter((t) => t.length > 0);
  if (parents.some((tokens) => tokens.every((t) => haystack.includes(t)))) {
    return { state: "confirmed_parent", reason: "the site names a confirmed parent organization", officialHost: final };
  }

  // Affirmative evidence of somebody else: an organization-shaped title with no
  // overlap at all. Anything weaker is unverified, because not finding a name
  // is a fact about our matching.
  const title = input.pageTitle ?? "";
  if (title && ORG_SHAPED.test(title) && ours.length > 0) {
    const titleTokens = new Set(distinctiveNameTokens(title));
    const anyOverlap = ours.some((tokens) => tokens.some((t) => titleTokens.has(t)));
    if (!anyOverlap) {
      return { state: "rejected", reason: `the site identifies a different organization: "${title.trim().slice(0, 80)}"`, officialHost: null };
    }
  }

  return { state: "unverified", reason: "the site loaded but does not name the prospect", officialHost: final };
}

// ---------------------------------------------------------------------------
// Which additional hosts may be crawled, and on what grounds
// ---------------------------------------------------------------------------

export const HOST_ADMISSION_REASONS = [
  "official",             // the verified site itself
  "linked_from_official", // reachable from a page on the official site
  "sitemap_reference",    // named in the official sitemap
  "redirect_target",      // the official host redirects here
  "parent_evidence",      // a confirmed parent organization's site
] as const;
export type HostAdmissionReason = (typeof HOST_ADMISSION_REASONS)[number];

export type AdmittedHost = { host: string; reason: HostAdmissionReason };

// Deliberately evidence-driven rather than pattern-driven. "Any subdomain of
// the registrable domain" would admit staging servers, donor portals and
// third-party tenants; requiring a link, a sitemap entry or a redirect means
// every extra host can say how it got in.
export const MAX_ADMITTED_HOSTS = 4;

export function admitRelatedHosts(input: {
  officialHost: string;
  domainState: DomainState;
  // Hosts observed while reading the official site.
  linkedHosts?: string[];
  sitemapHosts?: string[];
  redirectTargets?: string[];
}): AdmittedHost[] {
  const admitted: AdmittedHost[] = [{ host: input.officialHost, reason: "official" }];
  if (!EXPANSION_AUTHORIZED.has(input.domainState)) return admitted;

  const seen = new Set([input.officialHost]);
  const consider = (hosts: string[] | undefined, reason: HostAdmissionReason) => {
    for (const raw of hosts ?? []) {
      const host = raw.toLowerCase().replace(/^www\./, "");
      if (seen.has(host) || !isRelatedHost(host, input.officialHost)) continue;
      if (admitted.length >= MAX_ADMITTED_HOSTS) return;
      seen.add(host);
      admitted.push({ host, reason });
    }
  };

  // Strongest evidence first, so a host admitted for several reasons records
  // the best one.
  consider(input.redirectTargets, "redirect_target");
  consider(input.sitemapHosts, "sitemap_reference");
  consider(input.linkedHosts, "linked_from_official");
  return admitted;
}
