import type { Prospect, Stage } from "@/lib/prospects";
import type { Interaction } from "@/lib/interactions";
import { isClosedToWork, type ProspectOutcome } from "@/lib/prospect-outcomes";

// STATE item 75 -- Nurture v1. Post-yes relationships that have gone quiet.
//
// Invariant: a surface that offers a prospect as work asks the shared
// predicates what "closed" means (ruling 0028) and reads one derivation for
// what "quiet" means -- so the page, and any future badge, cannot disagree.
//
// This module is PURE: it takes what the caller loaded and returns rows. It
// reads no database and no clock (`now` is a parameter), so the boundary cases
// are testable offline.

// The stages where a "yes" has been given and the relationship is being kept.
// Identifiers are the ones in STAGES (lib/prospects.ts).
export const NURTURE_STAGES: readonly Stage[] = ["awarding", "stewardship"];

// OWNER-TUNABLE v1 DEFAULT. A prospect is "quiet" when its most recent
// interaction is OLDER than this many days. The boundary is strict: a last
// touch exactly 30 whole days ago is NOT yet quiet; 31 is. Days are whole
// calendar days (UTC dates), so the answer does not flip with the time of day.
export const NURTURE_QUIET_DAYS = 30;

export type NurtureRow = {
  prospect: Prospect;
  // Whole calendar days since the most recent interaction; null when the
  // prospect has none ("never touched" is a different fact from "0 days").
  daysSinceLastTouch: number | null;
  lastInteractionKind: Interaction["kind"] | null;
  lastInteractionSummary: string | null;
};

const MS_PER_DAY = 86400000;

// Interactions store a calendar date (YYYY-MM-DD); a full timestamp is
// truncated to its date so both shapes count in the same unit.
function utcDay(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / MS_PER_DAY);
}

// The most recent interaction, chosen here rather than trusting the caller's
// query order: latest occurred_at, then latest created_at, then id.
function latestInteraction(list: readonly Interaction[]): Interaction | null {
  let best: Interaction | null = null;
  for (const i of list) {
    if (Number.isNaN(utcDay(i.occurred_at))) continue;
    if (!best) {
      best = i;
      continue;
    }
    const byDay = utcDay(i.occurred_at) - utcDay(best.occurred_at);
    const byCreated = Date.parse(i.created_at) - Date.parse(best.created_at) || 0;
    if (byDay > 0 || (byDay === 0 && (byCreated > 0 || (byCreated === 0 && i.id > best.id)))) best = i;
  }
  return best;
}

// Selection, in order: stage is Awarding or Stewardship; the effective outcome
// does not close it (isClosedToWork -- a `revisit_on` or `undecided` outcome
// does not); it has no interaction or its latest is older than
// NURTURE_QUIET_DAYS.
//
// Order: stalest first. A never-touched prospect has no last touch at all, the
// stalest possible state, so it sorts before every touched one; ties (equal
// days, or several never-touched) break by name, then id, so the order is
// deterministic.
export function selectNurtureQueue(
  prospects: readonly Prospect[],
  interactionsByProspect: Readonly<Record<string, readonly Interaction[]>>,
  outcomeIndex: ReadonlyMap<string, ProspectOutcome>,
  now: Date,
): NurtureRow[] {
  const today = utcDay(now.toISOString());
  const rows: NurtureRow[] = [];

  for (const prospect of prospects) {
    if (!NURTURE_STAGES.includes(prospect.stage)) continue;
    if (isClosedToWork(outcomeIndex.get(prospect.id))) continue;

    const last = latestInteraction(interactionsByProspect[prospect.id] ?? []);
    const days = last ? today - utcDay(last.occurred_at) : null;
    if (days !== null && !(days > NURTURE_QUIET_DAYS)) continue;

    rows.push({
      prospect,
      daysSinceLastTouch: days,
      lastInteractionKind: last?.kind ?? null,
      lastInteractionSummary: last?.summary ?? null,
    });
  }

  return rows.sort((a, b) => {
    const da = a.daysSinceLastTouch;
    const db = b.daysSinceLastTouch;
    if (da === null && db !== null) return -1;
    if (da !== null && db === null) return 1;
    if (da !== null && db !== null && da !== db) return db - da;
    return a.prospect.name.localeCompare(b.prospect.name) || a.prospect.id.localeCompare(b.prospect.id);
  });
}
