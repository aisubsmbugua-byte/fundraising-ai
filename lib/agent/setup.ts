// "Setup pending": the connector's tables or function are not in the database
// yet (migration 0082 not applied; code deployed ahead of it). Safe in both
// deploy orders: the endpoint answers plainly, the page says so, and nothing
// is written.

import { isMissingRelation } from "@/lib/assistant/access";

export const AGENT_MIGRATION = "0082";

export const AGENT_SETUP_PENDING_MESSAGE = `Setup pending: the connector's tables are not in the database yet. The owner applies migration ${AGENT_MIGRATION} (agent delegation) in the Supabase SQL editor, then the connector works. Nothing was done.`;

type ErrLike = { code?: string | null; message?: string | null } | null | undefined;

// A missing table (42P01 / PGRST205) or a missing function (42883 /
// PGRST202): both mean migration 0082 is not applied.
export function isSetupPending(error: ErrLike): boolean {
  if (!error) return false;
  if (isMissingRelation(error)) return true;
  if (error.code === "42883" || error.code === "PGRST202") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}
