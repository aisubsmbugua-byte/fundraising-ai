// Who may use the assistant: the signed-in user's own organization, resolved
// through the session client (a profiles row, scoped by RLS), checked against
// the ASSISTANT_ENABLED_ORG_IDS list.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAssistantEnabledForOrg, isAssistantEnabledAnywhere, type Env } from "./config";

export type AssistantAccess = { organizationId: string | null; enabled: boolean };

export async function resolveAssistantAccess(
  supabase: SupabaseClient,
  userId: string,
  env: Env = process.env
): Promise<AssistantAccess> {
  // Short-circuit: nobody is enabled, so there is nothing to look up.
  if (!isAssistantEnabledAnywhere(env)) return { organizationId: null, enabled: false };
  // Called from the dashboard layout on every page: a failure here must read
  // as "not enabled", never break navigation.
  try {
    const { data } = await supabase.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
    const organizationId = (data?.organization_id as string | null | undefined) ?? null;
    return { organizationId, enabled: isAssistantEnabledForOrg(organizationId, env) };
  } catch {
    return { organizationId: null, enabled: false };
  }
}

// Postgres says 42P01 for a missing relation; PostgREST (what the client
// actually talks to) says PGRST205 when the table is not in its schema
// cache. Both mean the same fact here: migration 0080 is not applied.
export function isMissingRelation(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  // Some transports drop the code and keep the message.
  return /could not find the table|relation .* does not exist/i.test(error.message ?? "");
}

export const SETUP_PENDING_MESSAGE =
  "Setup pending: the assistant's tables are not in the database yet. The owner applies migration 0080 (assistant) in the Supabase SQL editor, then this page works.";
