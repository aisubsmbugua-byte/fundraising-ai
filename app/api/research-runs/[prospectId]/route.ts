import { createClient } from "@/lib/supabase/server";

// Plain REST endpoint for polling research status, deliberately NOT a Server
// Action -- same reasoning as app/api/strategy-runs/[prospectId]: a research
// run takes minutes, so this is polled dozens of times per run, and repeated
// Server Action calls through that path were implicated in a production-only
// client crash (React error #482) confirmed and fixed for Discovery Search.
//
// Returns the fields the panel actually renders rather than the whole row:
// a research run carries findings, retrieval metrics and cost, none of which
// belong in a payload fetched every 1.2 seconds.
export async function GET(_request: Request, { params }: { params: { prospectId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("research_runs")
    .select("id, status, status_message, started_at, verification_state, completion_state, dossier_confirmed, completed_at, version")
    .eq("prospect_id", params.prospectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return Response.json({ run: data ?? null });
}
