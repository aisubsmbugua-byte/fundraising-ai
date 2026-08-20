// Client for ProPublica's Nonprofit Explorer API -- free, no API key,
// built from IRS Form 990/990-EZ/990-PF filings. Covers both funders
// (990-PF filers disclose grants made) and recipient nonprofits, but
// NOT individual churches -- they're generally exempt from 990
// filing, so this won't help for the `church` channel specifically.

export type ProPublicaSearchResult = {
  ein: number;
  name: string;
  city: string | null;
  state: string | null;
  ntee_code: string | null;
  subseccd: number | null;
  score: number;
};

export type ProPublicaOrgDetail = {
  ein: number;
  name: string;
  city: string | null;
  state: string | null;
  ntee_code: string | null;
  filings_with_data?: {
    tax_prd_yr: number;
    totrevenue: number | null;
    totfuncexpns: number | null;
    totassetsend: number | null;
    totcntrbgfts: number | null;
  }[];
};

// Bounded so a slow/unresponsive ProPublica endpoint can't hang an
// entire discovery search indefinitely -- this is a best-effort
// enrichment step, not a required one.
const FETCH_TIMEOUT_MS = 6000;

export async function searchProPublica(query: string): Promise<ProPublicaSearchResult[]> {
  try {
    const res = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/search.json?q=${encodeURIComponent(query)}`,
      { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.organizations ?? [];
  } catch {
    return [];
  }
}

export async function getProPublicaOrgDetail(ein: number): Promise<ProPublicaOrgDetail | null> {
  try {
    const res = await fetch(`https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.organization ? { ...data.organization, filings_with_data: data.filings_with_data } : null;
  } catch {
    return null;
  }
}

// Best-effort: takes the top search result only if there is one --
// doesn't try to disambiguate further. False matches are possible for
// common org names; this is meant to enrich, not to be authoritative.
export async function bestEffortLookup(name: string): Promise<ProPublicaOrgDetail | null> {
  const results = await searchProPublica(name);
  if (results.length === 0) return null;
  return getProPublicaOrgDetail(results[0].ein);
}
