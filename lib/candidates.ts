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

// Hostname or nothing. A malformed URL must not throw inside candidate
// mapping and take a whole search run with it.
export function safeHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Words that carry no distinguishing information in a program name. Stripped
// before comparison so a trailing "Program" cannot split one opportunity into
// two, and so attestation never fails on filler.
//
// Observed live: "Vital Worship, Vital Preaching Grants" and "Vital Worship,
// Vital Preaching Grants Program" were captured from the same page on the same
// night, under two channels, and were stored as two candidates. The funder
// names were byte-identical; one trailing word defeated the whole key.
const GENERIC_PROGRAM_WORDS = new Set([
  "grant",
  "grants",
  "program",
  "programs",
  "programme",
  "fund",
  "funds",
  "funding",
  "initiative",
  "initiatives",
  "award",
  "awards",
  "the",
  "and",
  "of",
  "for",
  "a",
  "an",
  "to",
  "in",
  "on",
]);

// Lowercase, ampersand spelled out, everything non-alphanumeric reduced to a
// space. Deliberately shared by dedupe and attestation: two strings that
// compare equal for one purpose should not compare unequal for the other.
function normalizeForMatch(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The words in a name that actually identify it. Tokens under three characters
// are dropped alongside the generic ones -- "of", "us", "II" match almost any
// page and would make attestation meaningless.
export function distinctiveTokens(value: string | null | undefined): string[] {
  return normalizeForMatch(value)
    .split(" ")
    .filter((t) => t.length >= 3 && !GENERIC_PROGRAM_WORDS.has(t));
}

// A program name with its filler removed, for keying. "Vital Worship, Vital
// Preaching Grants Program" and "Vital Worship, Vital Preaching Grants" both
// reduce to "vital worship vital preaching" -- while two genuinely different
// programs from one funder ("1001 New Worshiping Communities" vs "Mission
// Program Grants") still reduce to different strings and stay separate.
export function normalizeOpportunityForDedupe(value: string | null | undefined): string {
  return distinctiveTokens(value).join(" ");
}

// Domain is a strong signal and never sufficient on its own: pcusa.org hosts
// many agencies and programs, so collapsing on it would merge distinct
// funding opportunities into a single row. Two programs from one funder stay
// separate; the same program found twice consolidates.
//
// An UNATTESTED opportunity name is excluded from the key entirely. A program
// name the source does not support is not evidence that this is a different
// opportunity -- treating it as a discriminator would let an invented phrase
// manufacture a duplicate, which is precisely backwards.
//
// Only Research, having confirmed two records are the same operating entity,
// may collapse further than this.
export function candidateDedupeKey(input: {
  sourceDomain?: string | null;
  funderName?: string | null;
  opportunityName?: string | null;
  opportunityAttested?: boolean;
  name?: string | null;
}): string {
  const funder = normalizeForDedupe(input.funderName ?? input.name);
  const opportunity = input.opportunityAttested === false ? "" : normalizeOpportunityForDedupe(input.opportunityName);
  return [input.sourceDomain?.toLowerCase() ?? "", funder, opportunity].join("|");
}

// The captured text a claim about this candidate can be checked against: the
// search result's own title plus the words in its URL. Thin compared to
// Research's evidence ledger -- it is what this pipeline actually captures, and
// checking against thin real data beats checking against nothing.
export function attestationCorpus(source: { url: string; title?: string | null } | null | undefined): string {
  if (!source) return "";
  return normalizeForMatch(`${source.title ?? ""} ${source.url}`);
}

// Does the captured source support this string?
//
// Every distinctive token must appear. Deliberately token containment rather
// than fuzzy or edit-distance similarity, for the same reason the entity gate
// uses substring matching: a similarity score generous enough to accept real
// wording variance is also generous enough to accept an invented phrase that
// happens to share a word, and the false negative it produces is the exact
// failure being guarded against.
//
// A value with no distinctive tokens at all attests true. There is nothing to
// check, and manufacturing a failure from an absence would put a caution on
// rows we have no reason to doubt.
export function isAttested(value: string | null | undefined, corpus: string): boolean {
  const tokens = distinctiveTokens(value);
  if (tokens.length === 0) return true;
  return tokens.every((t) => corpus.includes(t));
}

// The display name, DERIVED from the structured parts rather than typed
// separately.
//
// Previously the model wrote `name` as free text alongside funder_name and
// opportunity_name, so the three could disagree -- and did: "Mustard Seed
// Foundation - General Grants" was stored with opportunity_name null, the
// structured field correctly declining a program the display name asserted.
// A derived name cannot contradict its own parts.
//
// An unattested opportunity is left out. It stays in its own column, flagged,
// rather than being deleted -- but it does not get to speak in the name the
// reviewer reads.
export function candidateDisplayName(input: {
  funderName?: string | null;
  opportunityName?: string | null;
  opportunityAttested?: boolean;
  fallback: string;
}): string {
  const funder = input.funderName?.trim() || input.fallback.trim();
  const opportunity = input.opportunityAttested === false ? null : input.opportunityName?.trim() || null;
  if (!opportunity) return funder;
  // Already glued together by the model -- don't say it twice.
  if (normalizeForMatch(funder).includes(normalizeForMatch(opportunity))) return funder;
  return `${funder} — ${opportunity}`;
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
  // Capture and attestation (0055, 0056). Null across the board on rows
  // written before those migrations -- "not evaluated", never "passed".
  funder_name: string | null;
  opportunity_name: string | null;
  source_url: string | null;
  source_domain: string | null;
  source_title: string | null;
  official_website_candidate: string | null;
  website_status: WebsiteStatus | null;
  capture_status: CaptureStatus | null;
  dedupe_key: string | null;
  asserted_fields: string[] | null;
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
