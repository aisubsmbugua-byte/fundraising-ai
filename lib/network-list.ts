// Large-list management on the Network page (STATE item 103, ruling 0040
// clause 2): search, paging and bulk removal. Pure -- the page size, the page
// arithmetic, the search filter and the id checks are provable by running them.
//
// The general invariant: the page never renders (or reads) every person at
// once, and a removal is only ever of ids the person selected and confirmed.

// People per page on the Network page.
export const NETWORK_PAGE_SIZE = 50;
// Longest search text honoured.
export const NETWORK_SEARCH_MAX_LENGTH = 100;
// The most people one removal request may carry, and how many go in one
// delete statement (an id list rides in the request URL).
export const NETWORK_DELETE_MAX_IDS = 10_000;
export const NETWORK_DELETE_CHUNK_SIZE = 100;

// A page number from the URL: a positive integer, else 1.
export function parsePage(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^\d{1,9}$/.test(v)) return 1;
  const n = Number(v);
  return n >= 1 ? n : 1;
}

// Search text from the URL: trimmed, whitespace collapsed, capped.
export function normalizeSearch(raw: string | string[] | undefined): string {
  const v = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return v.replace(/\s+/g, " ").trim().slice(0, NETWORK_SEARCH_MAX_LENGTH);
}

export type PageWindow = { page: number; totalPages: number; from: number; to: number; first: number; last: number };

// The window for `page` over `total` people, clamped so a stale link to a page
// past the end lands on the last page. `from`/`to` are the zero-based inclusive
// range for the query; `first`/`last` are the one-based positions shown
// ("51-100 of 230"). An empty list is one empty page.
export function pageWindow(page: number, total: number, size: number = NETWORK_PAGE_SIZE): PageWindow {
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const from = (p - 1) * size;
  const to = Math.min(from + size, Math.max(total, 0)) - 1;
  return { page: p, totalPages, from, to: Math.max(to, from), first: total === 0 ? 0 : from + 1, last: total === 0 ? 0 : to + 1 };
}

// The PostgREST `or` filter for a case-insensitive substring match on name or
// affiliation, or null for no search. The text is data, never syntax: LIKE
// wildcards (% _ \) are escaped so they match themselves, and the value is
// double-quoted (with \ and " escaped) so a comma or parenthesis in it cannot
// end the filter or add one.
export function searchOrFilter(q: string): string | null {
  if (!q) return null;
  const like = q.replace(/[\\%_]/g, "\\$&");
  const quoted = `"%${like.replace(/[\\"]/g, "\\$&")}%"`;
  return `person_name.ilike.${quoted},affiliation.ilike.${quoted}`;
}

// The same match in code, for tests and fakes: a filter the person sees, not a
// matcher the AI relies on.
export function matchesSearch(c: { person_name: string; affiliation: string | null }, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return c.person_name.toLowerCase().includes(needle) || (c.affiliation ?? "").toLowerCase().includes(needle);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDeleteIds(raw: unknown): { error: string } | { ids: string[] } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Select at least one person to remove." };
  if (raw.length > NETWORK_DELETE_MAX_IDS) {
    return { error: `You selected ${raw.length} people and one removal takes at most ${NETWORK_DELETE_MAX_IDS}. Nothing was removed.` };
  }
  if (!raw.every((v) => typeof v === "string" && UUID.test(v))) return { error: "The selection was not understood. Nothing was removed." };
  return { ids: Array.from(new Set(raw as string[])) };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// The Network page's own address for a search and a page, so Next/Previous and
// the search form agree on what the URL carries.
export function networkHref(q: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/network?${qs}` : "/network";
}
