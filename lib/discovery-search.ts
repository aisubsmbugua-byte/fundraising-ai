import type { Channel } from "./prospects";

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
