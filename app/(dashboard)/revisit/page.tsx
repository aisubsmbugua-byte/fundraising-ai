import { createClient } from "@/lib/supabase/server";
import { computeHealthStatus, type Prospect } from "@/lib/prospects";
import type { Candidate } from "@/lib/candidates";
import type { Interaction } from "@/lib/interactions";
import { loadOutcomeIndex, isOpenQuestion, isScheduledRevisit, type ProspectOutcome } from "@/lib/prospect-outcomes";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import FollowupWorkspace from "./followup-workspace";

export default async function RevisitPage() {
  const supabase = createClient();
  const [{ data: prospects, error }, { data: dismissedCandidates }, { data: interactions }, outcomeIndex] =
    await Promise.all([
      supabase.from("prospects").select("*").returns<Prospect[]>(),
      supabase.from("candidates").select("*").eq("status", "dismissed").returns<Candidate[]>(),
      supabase.from("interactions").select("*").order("occurred_at", { ascending: false }).returns<Interaction[]>(),
      loadOutcomeIndex(supabase),
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

  // Ruling 0019: `undecided` is a visible state, not a silent one. A funder that
  // declined and that nobody has ruled on is an open question for a human, and
  // this is the screen where open questions live -- the same page that already
  // exists to keep past decisions useful.
  //
  // Two lists, from one derivation, because the three dispositions are three
  // different situations: undecided is work, a scheduled revisit is a diary
  // entry, and `never` is closed and deliberately appears in neither. The
  // prospect's own page still shows all three.
  const declinedProspects: { prospect: Prospect; outcome: ProspectOutcome }[] = [];
  for (const p of all) {
    const outcome = outcomeIndex.get(p.id);
    if (outcome) declinedProspects.push({ prospect: p, outcome });
  }
  const openQuestions = declinedProspects.filter((d) => isOpenQuestion(d.outcome));
  const scheduledRevisits = declinedProspects.filter((d) => isScheduledRevisit(d.outcome));

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
        openQuestions={openQuestions}
        scheduledRevisits={scheduledRevisits}
        interactionsByProspect={interactionsByProspect}
      />
    </div>
  );
}
