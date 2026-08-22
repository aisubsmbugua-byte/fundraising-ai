import { createClient } from "@/lib/supabase/server";
import { computeHealthStatus, type Prospect } from "@/lib/prospects";
import type { Candidate } from "@/lib/candidates";
import type { Interaction } from "@/lib/interactions";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import FollowupWorkspace from "./followup-workspace";

export default async function RevisitPage() {
  const supabase = createClient();
  const [{ data: prospects, error }, { data: dismissedCandidates }, { data: interactions }] = await Promise.all([
    supabase.from("prospects").select("*").returns<Prospect[]>(),
    supabase.from("candidates").select("*").eq("status", "dismissed").returns<Candidate[]>(),
    supabase.from("interactions").select("*").order("occurred_at", { ascending: false }).returns<Interaction[]>(),
  ]);

  if (error) {
    return <p style={{ color: colors.danger }}>Error loading follow-ups: {error.message}</p>;
  }

  const all = prospects ?? [];
  const dueNow = all.filter((p) => {
    const h = computeHealthStatus(p.next_action_due);
    return h === "due_soon" || h === "stalled";
  });
  const waiting = all.filter((p) => p.next_action && !p.next_action_due);
  const scheduled = all.filter((p) => p.next_action_due && computeHealthStatus(p.next_action_due) === "on_track");
  const revisitLater = (dismissedCandidates ?? []).filter((c) => c.revisit_date);
  const pastDecisions = (dismissedCandidates ?? []).filter((c) => !c.revisit_date);

  const interactionsByProspect: Record<string, Interaction[]> = {};
  for (const i of interactions ?? []) {
    (interactionsByProspect[i.prospect_id] ??= []).push(i);
  }

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Follow-ups</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
        Keep promising relationships warm and past decisions useful.
      </p>

      <FollowupWorkspace
        dueNow={dueNow}
        waiting={waiting}
        scheduled={scheduled}
        revisitLater={revisitLater}
        pastDecisions={pastDecisions}
        interactionsByProspect={interactionsByProspect}
      />
    </div>
  );
}
