export const CANDIDATE_STATUSES = ["pending", "accepted", "dismissed", "saved"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

// Where a candidate's URL came from, and how far we are entitled to trust it.
//
// A cited search result is not the funder's website -- it is as likely to be
// ProPublica, a news piece or a directory. Now that entity resolution
// consults a prospect's domain BEFORE falling back on ambiguous filings,
// writing an aggregator URL into `website` would let a third-party page be
// read as the organization speaking about itself.
//
// official_confirmed is deliberately not writable by Donor Finder. It is
// earned in Research, the only step that actually tests a domain -- and
// earned by corroboration (a filing linking back, a matching legal name and
// address, a registry entry, a redirect from a verified legacy domain), not
// by demanding an EIN on the page. Many legitimate nonprofits never publish
// one.
export const WEBSITE_STATUSES = ["official_candidate", "third_party_source", "official_confirmed"] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

// Only Research may promote to this.
export const DONOR_FINDER_WEBSITE_STATUSES: WebsiteStatus[] = ["official_candidate", "third_party_source"];

// A domain we may treat as the funder speaking about itself. Null status
// means hand-entered or pre-dating capture, which stays trusted -- only an
// explicit third_party_source is withheld.
export function domainIsFunderOwn(status: string | null | undefined): boolean {
  return status !== "third_party_source";
}

export const CAPTURE_STATUSES = ["captured", "source_missing"] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

// Lower-cased, punctuation and corporate boilerplate removed, so the same
// funder written two ways collapses to one key.
export function normalizeForDedupe(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(inc|incorporated|llc|corp|corporation|the|a|of|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Domain is a strong signal and never sufficient on its own: pcusa.org hosts
// many agencies and programs, so collapsing on it would merge distinct
// funding opportunities into a single row. Two programs from one funder stay
// separate; the same program found twice consolidates.
//
// Only Research, having confirmed two records are the same operating entity,
// may collapse further than this.
export function candidateDedupeKey(input: {
  sourceDomain?: string | null;
  funderName?: string | null;
  opportunityName?: string | null;
  name?: string | null;
}): string {
  const funder = normalizeForDedupe(input.funderName ?? input.name);
  return [input.sourceDomain?.toLowerCase() ?? "", funder, normalizeForDedupe(input.opportunityName)].join("|");
}

export type Candidate = {
  id: string;
  name: string;
  channel: string;
  organization: string | null;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  location: string | null;
  funder_type: string | null;
  geographic_focus: string | null;
  typical_grant_size: string | null;
  focus_areas: string[] | null;
  source: string | null;
  raw: Record<string, unknown> | null;
  suggested_tier: number | null;
  status: CandidateStatus;
  reviewed_by: string | null;
  // "No" is data, not a dead end -- set from the Follow-up page, not
  // part of the one-click dismiss flow itself.
  dismissed_reason: string | null;
  revisit_date: string | null;
  created_at: string;
  updated_at: string;
};

// Minimal RFC4180-ish CSV parser (handles quoted fields containing
// commas) -- no external dependency needed for a fixed known format.
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r\n|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] ?? "").trim();
    });
    return row;
  });
}
