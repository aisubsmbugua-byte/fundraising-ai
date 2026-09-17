// The nonprofit registry client. Tier 1 of the qualification pipeline.
//
// Plain HTTP, no model, no search provider. Two endpoints: search a name for
// candidate organizations, and fetch one organization with its filing series.
// A single organization fetch returns legal identity, address, foundation
// code, assets, income and up to ~14 years of filings -- in roughly half a
// second, with no run-to-run variance.
//
// This file only RETRIEVES. Every judgement about what the data means lives in
// lib/legitimacy.ts, so the rules can be tested without a network.

const BASE = "https://projects.propublica.org/nonprofits/api/v2";
const TIMEOUT_MS = 10_000;
const UA = "FundraisingAI/1.0 (nonprofit prospect qualification)";

// Codes come back as integers and are the authoritative classification -- not
// something a model infers from prose.
//
// pf_filing_requirement_code === 1 means the organization files a 990-PF, and
// that is the ONLY form whose structured extract carries grants PAID. This
// distinction drives predicate 1 and was verified against the live API, not
// assumed: a 990 filer's extract exposes gftgrntsrcvd170 (grants RECEIVED) and
// nothing at all about grants made.
export const PF_FILING_REQUIRED = 1;
export const FORMTYPE_990PF = 2;

export type RegistryCandidate = {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  score: number | null;
};

export type RegistryFiling = {
  taxYear: number | null;
  formType: number | null;
  // Contributions/grants PAID, from a 990-PF extract. Null for every other
  // form type, because the field does not exist there.
  grantsPaid: number | null;
  totalAssetsEnd: number | null;
  totalRevenue: number | null;
  pdfUrl: string | null;
};

export type RegistryOrganization = {
  ein: string;
  name: string;
  careOfName: string | null;
  city: string | null;
  state: string | null;
  subsectionCode: number | null;
  foundationCode: number | null;
  pfFilingRequirementCode: number | null;
  assetAmount: number | null;
  incomeAmount: number | null;
  dataSource: string | null;
  filings: RegistryFiling[];
  filingsWithoutDataCount: number;
};

export type RegistryError = { kind: "not_found" | "unreachable" | "malformed"; detail: string };

function isError(v: unknown): v is RegistryError {
  return Boolean(v) && typeof v === "object" && "kind" in (v as object);
}
export const registryFailed = isError;

// A 404 means two different things on these two endpoints, and conflating
// them manufactures exactly the confusion this pipeline exists to remove.
//
// On /search.json it is how the API says "nothing matched" -- verified
// directly: "Ronald Blue Trust" returns 404 while "Mariners Church" returns
// 200. That is an EMPTY RESULT, and reporting it as a retrieval failure would
// tell a user to retry something that will never succeed.
//
// On /organizations/{ein}.json it genuinely means no such filer exists.
const EMPTY_RESULT = Symbol("empty-result");

async function getJson(path: string, notFound: "error" | "empty"): Promise<unknown | RegistryError | typeof EMPTY_RESULT> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
      return notFound === "empty" ? EMPTY_RESULT : { kind: "not_found" as const, detail: `no registry record for ${path}` };
    }
    if (!res.ok) return { kind: "unreachable", detail: `HTTP ${res.status} for ${path}` };
    return (await res.json()) as unknown;
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// EINs arrive as integers and lose their leading zero. A nine-digit string is
// the only form anything downstream should ever see.
export function padEin(value: string | number | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 1 && digits.length <= 9 ? digits.padStart(9, "0") : null;
}

// The search endpoint returns 25 results per page and reports the true total
// separately. Not paginating is not a minor omission: "Stewardship Foundation"
// reports 80 results, returns 25, and the correct funder sits on page 3. Every
// downstream decision -- token containment, state filtering, the verdict --
// was operating on a page that could not contain the answer.
const PAGE_SIZE = 25;
// 8 pages = 200 organizations. Beyond that a name is too generic for a name
// search to settle, and `complete: false` says so rather than pretending.
const MAX_PAGES = 8;

export type SearchOutcome = {
  candidates: RegistryCandidate[];
  totalResults: number;
  pagesFetched: number;
  // Did we actually see every result the API says exists? A truncated sweep
  // must never be reported as a settled ambiguity -- see the incomplete_search
  // identity state in lib/legitimacy.ts.
  complete: boolean;
};

function parseCandidates(body: unknown): RegistryCandidate[] | RegistryError {
  const orgs = (body as { organizations?: unknown }).organizations;
  if (!Array.isArray(orgs)) return { kind: "malformed", detail: "search.json had no organizations array" };
  return orgs.flatMap((raw) => {
    const o = raw as Record<string, unknown>;
    const ein = padEin(str(o.strein) ?? (typeof o.ein === "number" ? o.ein : null));
    const nm = str(o.name);
    if (!ein || !nm) return [];
    return [{ ein, name: nm, city: str(o.city), state: str(o.state), score: num(o.score) }];
  });
}

export async function searchOrganizations(name: string): Promise<SearchOutcome | RegistryError> {
  const query = name.trim();
  if (!query) return { candidates: [], totalResults: 0, pagesFetched: 0, complete: true };

  const candidates: RegistryCandidate[] = [];
  const seen = new Set<string>();
  let totalResults = 0;
  let page = 0;

  for (; page < MAX_PAGES; page++) {
    const body = await getJson(`/search.json?q=${encodeURIComponent(query)}&page=${page}`, "empty");
    if (body === EMPTY_RESULT) break;
    if (isError(body)) return body;

    const reported = num((body as Record<string, unknown>).total_results);
    if (reported !== null) totalResults = reported;

    const parsed = parseCandidates(body);
    if (isError(parsed)) return parsed;
    for (const c of parsed) {
      if (seen.has(c.ein)) continue;
      seen.add(c.ein);
      candidates.push(c);
    }
    if (parsed.length < PAGE_SIZE) break;
  }

  const pagesFetched = page + 1;
  return {
    candidates,
    totalResults: Math.max(totalResults, candidates.length),
    pagesFetched,
    complete: candidates.length >= Math.max(totalResults, candidates.length),
  };
}

// Run several controlled variants of a name and merge by EIN.
//
// Deliberately additive rather than normalizing: a leading article is not
// noise to this endpoint, it changes the result set entirely -- "The
// Stewardship Foundation" returns 6 organizations and "Stewardship Foundation"
// returns 80. Stripping it globally would trade one blind spot for another, so
// both are asked and the answers are combined.
export async function searchOrganizationsMerged(variants: string[]): Promise<SearchOutcome | RegistryError> {
  const queries = [...new Set(variants.map((v) => v.trim()).filter(Boolean))];
  if (queries.length === 0) return { candidates: [], totalResults: 0, pagesFetched: 0, complete: true };

  const merged: RegistryCandidate[] = [];
  const seen = new Set<string>();
  let totalResults = 0;
  let pagesFetched = 0;
  let complete = true;
  let lastError: RegistryError | null = null;
  let anySucceeded = false;

  for (const q of queries) {
    const outcome = await searchOrganizations(q);
    if (registryFailed(outcome)) {
      // One variant failing is not the whole search failing -- but if every
      // one fails, the caller must hear about it rather than see an empty set.
      lastError = outcome;
      complete = false;
      continue;
    }
    anySucceeded = true;
    pagesFetched += outcome.pagesFetched;
    totalResults = Math.max(totalResults, outcome.totalResults);
    if (!outcome.complete) complete = false;
    for (const c of outcome.candidates) {
      if (seen.has(c.ein)) continue;
      seen.add(c.ein);
      merged.push(c);
    }
  }

  if (!anySucceeded && lastError) return lastError;
  return { candidates: merged, totalResults: Math.max(totalResults, merged.length), pagesFetched, complete };
}

export async function getOrganization(ein: string): Promise<RegistryOrganization | RegistryError> {
  const padded = padEin(ein);
  if (!padded) return { kind: "malformed", detail: `not an EIN: ${ein}` };

  const body = await getJson(`/organizations/${padded}.json`, "error");
  if (body === EMPTY_RESULT) return { kind: "not_found", detail: `no registry record for EIN ${padded}` };
  if (isError(body)) return body;

  const root = body as Record<string, unknown>;
  const o = root.organization as Record<string, unknown> | undefined;
  if (!o) return { kind: "malformed", detail: "organizations.json had no organization" };

  const withData = Array.isArray(root.filings_with_data) ? root.filings_with_data : [];
  const withoutData = Array.isArray(root.filings_without_data) ? root.filings_without_data : [];

  return {
    ein: padEin(str(o.strein) ?? (typeof o.ein === "number" ? o.ein : null)) ?? padded,
    name: str(o.name) ?? "",
    careOfName: str(o.careofname),
    city: str(o.city),
    state: str(o.state),
    subsectionCode: num(o.subsection_code),
    foundationCode: num(o.foundation_code),
    pfFilingRequirementCode: num(o.pf_filing_requirement_code),
    assetAmount: num(o.asset_amount),
    incomeAmount: num(o.income_amount),
    dataSource: str(o.data_source),
    filings: withData
      .map((raw) => {
        const f = raw as Record<string, unknown>;
        return {
          taxYear: num(f.tax_prd_yr),
          formType: num(f.formtype),
          // Only meaningful on a 990-PF. Left null elsewhere rather than
          // reaching for a similarly-named field that means something else --
          // gftgrntsrcvd170 is grants RECEIVED and would invert the answer.
          grantsPaid: num(f.formtype) === FORMTYPE_990PF ? num(f.contrpdpbks) : null,
          totalAssetsEnd: num(f.totassetsend),
          totalRevenue: num(f.totrevenue),
          pdfUrl: str(f.pdf_url),
        };
      })
      .sort((a, b) => (b.taxYear ?? 0) - (a.taxYear ?? 0)),
    filingsWithoutDataCount: withoutData.length,
  };
}
