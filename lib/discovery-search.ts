import type { Channel } from "./prospects";

// Truthiness for operational env-var switches (STATE.md item 64:
// DISCOVERY_CRON_PAUSED). No prior convention exists in this codebase --
// the only env-flag reads (lib/send-draft.ts) test presence, not value --
// so this encodes the least-surprising reading for a var set by hand in
// the Vercel dashboard: any non-empty value pauses, EXCEPT an explicit
// "0" or "false" (any casing, surrounding whitespace ignored), so that
// flipping the value to "false" is as valid a way to resume as deleting
// the var. Pure and exported so the parse is testable directly
// (scripts/test-cron-gate.ts).
export function envFlagTruthy(value: string | null | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export const DISCOVERY_SEARCH_STATUSES = ["searching", "extracting", "screening", "done", "error"] as const;
export type DiscoverySearchStatus = (typeof DISCOVERY_SEARCH_STATUSES)[number];

export type DiscoverySearchRun = {
  id: string;
  channel: Channel;
  status: DiscoverySearchStatus;
  status_message: string | null;
  started_at: string | null;
  found_count: number | null;
  error_message: string | null;
  created_by: string;
  created_at: string;
};
