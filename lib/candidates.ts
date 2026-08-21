export const CANDIDATE_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

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
