import { createClient } from "@/lib/supabase/server";
import { computeHealthStatus, type Prospect } from "@/lib/prospects";
import type { Candidate } from "@/lib/candidates";
import type { Interaction } from "@/lib/interactions";
import {
  loadOutcomeIndex,
  isOpenQuestion,
  isScheduledRevisit,
  isClosedToWork,
  isRevisitDue,
  type ProspectOutcome,
} from "@/lib/prospect-outcomes";
import { selectNurtureQueue } from "@/lib/nurture";
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
  // Ruling 0028 clause 1: these three are WORK lists, so a prospect whose
  // effective outcome closes it (`never`, per ruling 0027's derivation --
  // outcomeIndex only holds outcomes in effect, a retracted one is absent)
  // appears in none of them, whatever its dates say. It stays visible on the
  // Pipeline board and its own page, outcome shown as a fact.
  const offered = all.filter((p) => !isClosedToWork(outcomeIndex.get(p.id)));
  // A declined prospect whose revisit date has arrived shows up in "Due now"
  // as a declined row (dueRevisits below) -- it must not ALSO appear here as a
  // plain prospect row, or one funder would be listed twice under one tab.
  const todayIso = new Date().toISOString().slice(0, 10);
  const dueAsRevisit = (p: Prospect) => {
    const outcome = outcomeIndex.get(p.id);
    return outcome != null && isRevisitDue(outcome, todayIso);
  };
  const dueNow = offered.filter((p) => {
    if (dueAsRevisit(p)) return false;
    const h = computeHealthStatus(p.next_action_due);
    return h === "due_soon" || h === "stalled";
  });
  const waiting = offered.filter((p) => p.next_action && !p.next_action_due);
  const scheduled = offered.filter((p) => p.next_action_due && computeHealthStatus(p.next_action_due) === "on_track");
  const revisitLater = (dismissedCandidates ?? []).filter((c) => c.revisit_date);
  const pastDecisions = (dismissedCandidates ?? []).filter((c) => !c.revisit_date);

  // Ruling 0019: `undecided` is a visible state, not a silent one. A funder that
  // declined and that nobody has ruled on is an open question for a human, and
  // this is the screen where open questions live -- the same page that already
  // exists to keep past decisions useful.
  //
  // Three lists, from one derivation, because the three dispositions are three
  // different situations: undecided is work, a scheduled revisit is a diary
  // entry until its date arrives and due work after (ruling 0028 clause 3),
  // and `never` is closed and deliberately appears in none. The prospect's own
  // page still shows all three.
  const declinedProspects: { prospect: Prospect; outcome: ProspectOutcome }[] = [];
  for (const p of all) {
    const outcome = outcomeIndex.get(p.id);
    if (outcome) declinedProspects.push({ prospect: p, outcome });
  }
  const openQuestions = declinedProspects.filter((d) => isOpenQuestion(d.outcome));
  const dueRevisits = declinedProspects.filter((d) => isRevisitDue(d.outcome, todayIso));
  const scheduledRevisits = declinedProspects.filter(
    (d) => isScheduledRevisit(d.outcome) && !isRevisitDue(d.outcome, todayIso),
  );

  const interactionsByProspect: Record<string, Interaction[]> = {};
  for (const i of interactions ?? []) {
    (interactionsByProspect[i.prospect_id] ??= []).push(i);
  }

  // Nurture v1 (STATE item 75): one shared derivation, same outcome index.
  const nurture = selectNurtureQueue(all, interactionsByProspect, outcomeIndex, new Date());

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Follow-ups</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
        Keep promising relationships warm and past decisions useful.
      </p>

      <FollowupWorkspace
        dueNow={dueNow}
        dueRevisits={dueRevisits}
        waiting={waiting}
        scheduled={scheduled}
        revisitLater={revisitLater}
        pastDecisions={pastDecisions}
        openQuestions={openQuestions}
        scheduledRevisits={scheduledRevisits}
        nurture={nurture}
        interactionsByProspect={interactionsByProspect}
      />
    </div>
  );
}
