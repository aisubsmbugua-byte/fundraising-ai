import { createClient } from "@/lib/supabase/server";
import type { DiscoverySearchRun } from "@/lib/discovery-search";

// Plain REST endpoint for polling run status, deliberately NOT a
// Server Action. The client polls this every ~1.2s for however long a
// search runs (1-3+ minutes, so dozens of calls per run) -- routing
// that through Server Actions' RSC wire protocol repeatedly was the
// prime suspect for a production-only client crash (React error #482,
// "async Client Component") that never reproduced locally and
// survived ruling out Skew Protection, stale cache, and prefetching.
// A plain fetch/JSON response sidesteps that machinery entirely.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("discovery_search_runs")
    .select("*")
    .eq("id", params.id)
    .maybeSingle<DiscoverySearchRun>();

  return Response.json({ run: data ?? null });
}
