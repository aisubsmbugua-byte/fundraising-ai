import { createClient } from "@/lib/supabase/server";
import type { DeepDiveRun } from "@/lib/deep-dive";

// Plain REST endpoint for polling run status, deliberately NOT a
// Server Action. Same reasoning as app/api/discovery-search-runs/[id]:
// a real deep dive runs for a minute or two, meaning this gets polled
// dozens of times per run via setInterval, and repeated Server Action
// calls through that path were implicated in a production-only client
// crash (React error #482) confirmed and fixed for Discovery Search.
export async function GET(_request: Request, { params }: { params: { prospectId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("deep_dive_runs")
    .select("*")
    .eq("prospect_id", params.prospectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<DeepDiveRun>();

  return Response.json({ run: data ?? null });
}
