import { createClient } from "@/lib/supabase/server";
import { colors } from "@/lib/ui";
import type { Prospect } from "@/lib/prospects";
import type { StrategyRun } from "@/lib/strategy";
import StrategyReviewWorkspace from "./strategy-review-workspace";

export default async function ReviewStrategiesPage() {
  const supabase = createClient();

  // strategy_runs has no "latest per prospect" query built in, so
  // fetch newest-first and take the first run seen per prospect in
  // JS -- simplest correct way to dedupe without a DB view, and cheap
  // at the volumes this app deals with.
  const { data: runs } = await supabase
    .from("strategy_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<StrategyRun[]>();

  const latestByProspect = new Map<string, StrategyRun>();
  for (const run of runs ?? []) {
    if (!latestByProspect.has(run.prospect_id)) {
      latestByProspect.set(run.prospect_id, run);
    }
  }
  const readyRuns = [...latestByProspect.values()].filter(
    (run) => run.status === "ready_for_review" && !run.approved_strategy
  );

  const prospectIds = readyRuns.map((run) => run.prospect_id);
  const { data: prospects } = prospectIds.length
    ? await supabase.from("prospects").select("*").in("id", prospectIds).returns<Prospect[]>()
    : { data: [] as Prospect[] };
  const prospectById = new Map((prospects ?? []).map((p) => [p.id, p]));

  const items = readyRuns
    .map((run) => {
      const prospect = prospectById.get(run.prospect_id);
      return prospect ? { prospect, run } : null;
    })
    .filter((item): item is { prospect: Prospect; run: StrategyRun } => item !== null);

  return (
    <div>
      <h1>Strategy review</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Prospects whose AI strategy is done and waiting on your review. Select one to approve or
        edit the strategy -- nothing here has been approved yet.
      </p>

      <StrategyReviewWorkspace items={items} />
    </div>
  );
}
