import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { channelLabel, type Prospect } from "@/lib/prospects";
import type { DeepDiveRun } from "@/lib/deep-dive";
import { spacing, colors, cardStyle, buttonPrimary } from "@/lib/ui";

export default async function ReviewStrategiesPage() {
  const supabase = createClient();

  // deep_dive_runs has no "latest per prospect" query built in, so
  // fetch newest-first and take the first run seen per prospect in
  // JS -- simplest correct way to dedupe without a DB view, and cheap
  // at the volumes this app deals with.
  const { data: runs } = await supabase
    .from("deep_dive_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<DeepDiveRun[]>();

  const latestByProspect = new Map<string, DeepDiveRun>();
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

  return (
    <div>
      <h1>Strategy review</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Prospects whose AI deep-dive is done and waiting on your review. Click into each one to
        approve or edit the strategy -- nothing here has been approved yet.
      </p>

      <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.lg }}>
        {readyRuns.map((run) => {
          const prospect = prospectById.get(run.prospect_id);
          if (!prospect) return null;
          return (
            <Link
              key={run.id}
              href={`/prospects/${prospect.id}`}
              style={{ ...cardStyle, display: "block", textDecoration: "none", color: "inherit" }}
            >
              <strong>{prospect.name}</strong>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
                {channelLabel(prospect.channel)}
                {prospect.organization ? ` · ${prospect.organization}` : ""}
              </div>
              {run.strategy?.rationale && (
                <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, maxWidth: 640 }}>
                  {run.strategy.rationale}
                </p>
              )}
            </Link>
          );
        })}
        {readyRuns.length === 0 && (
          <p style={{ color: colors.textFaint }}>Nothing waiting on review right now.</p>
        )}
      </div>

      <div style={{ marginTop: spacing.xl }}>
        <Link href="/pipeline?view=list" style={buttonPrimary}>
          ← All Prospects
        </Link>
      </div>
    </div>
  );
}
