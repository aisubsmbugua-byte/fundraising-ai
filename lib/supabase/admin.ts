import { createClient } from "@supabase/supabase-js";

// Server-only. Bypasses RLS entirely via the service role key, so it
// must never be reachable from a request an unauthenticated or
// client-controlled caller could trigger. Callers: the overnight
// auto-search cron route (gated by checking CRON_SECRET first), and
// the org-invite actions in app/admin and app/(dashboard)/settings/team
// (each re-verifies the caller's own auth/permissions via the normal
// session client before ever touching this) -- both need it because
// organizations has zero RLS policies for the authenticated role, and
// inviting a user requires the Auth admin API.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
