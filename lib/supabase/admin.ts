import { createClient } from "@supabase/supabase-js";

// Server-only, for contexts with no logged-in user -- currently only
// the overnight auto-search cron route. Bypasses RLS entirely via the
// service role key, so it must never be reachable from a request an
// unauthenticated or client-controlled caller could trigger. The cron
// route is the only caller, and it's gated by checking CRON_SECRET
// before this is ever touched.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
