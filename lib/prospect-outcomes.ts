import type { SupabaseClient } from "@supabase/supabase-js";

// Ruling 0019. When a funder declines, the prospect keeps a record carrying the
// reason and a revisit disposition with exactly three values:
//
//   revisit_on <date>   a human set a date to return
//   never               a human deliberately closed this permanently
//   undecided           it is a no; nobody has decided whether to return
//
// The third value is the point. Two states would force a false fact on every
// decline: blank-reads-as-never permanently closes funders nobody chose to
// close, and blank-reads-as-pending fills the revisit list with entries nobody
// scheduled. This is the project's governing defect shape -- two different facts
// collapsed into one value -- and it is the same distinction as ruling 0006's
// not_checked versus checked_not_stated.
//
// So `undecided` is not stored anywhere. It is the absence of a disposition row,
// derived here. Nothing can write it wrongly because nothing writes it at all.

export const OUTCOME_KINDS = ["declined"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const REVISIT_DISPOSITIONS = ["revisit_on", "never", "undecided"] as const;
export type RevisitDisposition = (typeof REVISIT_DISPOSITIONS)[number];

// A value of this type can only be produced by parseRevisitChoice, because the
// brand is a unique symbol no other module can name. Passing a hand-written
// { disposition: "never" } to recordRevisitDisposition is a type error, so
// "never comes only from an explicit human choice" is checked by tsc rather than
// asserted in a comment. Prompt wording is never the last line of defence here
// (CLAUDE.md, "capture, don't retype"); neither is a comment.
declare const chosenByAHuman: unique symbol;
type HumanChoice = { readonly [chosenByAHuman]: true };

export type RevisitChoice =
  | ({ disposition: "undecided" } & HumanChoice)
  | ({ disposition: "revisit_on"; revisitOn: string } & HumanChoice)
  | ({ disposition: "never" } & HumanChoice);

export type ParsedRevisitChoice = { ok: true; value: RevisitChoice } | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Accepts only a real YYYY-MM-DD. "2026-02-31" round-trips to 2026-03-03 and is
// rejected, rather than silently becoming a different day than the one typed.
export function normalizeRevisitDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!ISO_DATE.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === trimmed ? trimmed : null;
}

// The ONLY way a RevisitChoice comes into existence.
//
// The absence rule, stated as code: an absent, blank or non-string field yields
// `undecided`. `never` is returned for exactly one input -- the literal string
// "never" -- and for nothing else. No trimming, no case folding, no coercion,
// because every loosening of that comparison is another input that a human did
// not choose and that would nonetheless close a funder permanently.
//
// A value that is present but unrecognised is NOT quietly folded into
// `undecided`: "nobody answered" and "something answered wrongly" are different
// facts, and the caller is told so it can say so.
export function parseRevisitChoice(rawChoice: unknown, rawRevisitOn?: unknown): ParsedRevisitChoice {
  const undecided = { ok: true as const, value: { disposition: "undecided" } as RevisitChoice };

  // Absent, blank, or not even a string -- FormData.get returns null for a
  // field that was never submitted and a File for a file input.
  if (typeof rawChoice !== "string" || rawChoice.trim() === "") return undecided;

  if (rawChoice === "never") return { ok: true, value: { disposition: "never" } as RevisitChoice };

  if (rawChoice === "undecided") return undecided;

  if (rawChoice === "revisit_on") {
    const revisitOn = normalizeRevisitDate(rawRevisitOn);
    if (!revisitOn) return { ok: false, error: "Pick the date you want to come back to this funder." };
    return { ok: true, value: { disposition: "revisit_on", revisitOn } as RevisitChoice };
  }

  return { ok: false, error: `"${rawChoice}" is not a revisit choice.` };
}

// --- Rows, as stored ------------------------------------------------------

export type ProspectOutcomeRow = {
  id: string;
  prospect_id: string;
  outcome: string;
  reason: string | null;
  occurred_on: string;
  recorded_by: string | null;
  recorded_at: string;
};

export type RevisitDispositionRow = {
  id: string;
  prospect_outcome_id: string;
  disposition: string;
  revisit_on: string | null;
  reason: string | null;
  decided_by: string | null;
  decided_at: string;
};

// --- Derivation -----------------------------------------------------------

export type CurrentDisposition = {
  disposition: RevisitDisposition;
  revisitOn: string | null;
  reason: string | null;
  decidedAt: string | null;
  // Whether a human has ever recorded a disposition on this outcome. Distinct
  // from `disposition === "undecided"`, which is also true after somebody
  // deliberately reverses a `never` back to undecided. "Nobody has decided" and
  // "somebody decided not to decide yet" are different facts and this keeps
  // them apart rather than letting the interface flatten them.
  chosen: boolean;
};

export const NO_DISPOSITION: CurrentDisposition = {
  disposition: "undecided",
  revisitOn: null,
  reason: null,
  decidedAt: null,
  chosen: false,
};

function isKnownDisposition(value: string): value is RevisitDisposition {
  return (REVISIT_DISPOSITIONS as readonly string[]).includes(value);
}

// The current disposition is the most recently decided row, and `undecided`
// when there is none. Every route out of this function that is not an explicit
// stored "never" returns something other than "never" -- including the empty,
// null, undefined and unrecognised-value routes.
export function deriveCurrentDisposition(rows: readonly RevisitDispositionRow[] | null | undefined): CurrentDisposition {
  if (!rows || rows.length === 0) return NO_DISPOSITION;

  // Sorted here rather than trusting the caller's query order: a derivation
  // that is only correct when its input arrives pre-sorted is a derivation with
  // a silent precondition.
  const latest = [...rows].sort((a, b) => {
    const byTime = Date.parse(a.decided_at) - Date.parse(b.decided_at);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  })[rows.length - 1];

  // A stored value outside the vocabulary cannot be trusted to mean anything,
  // and the one thing it must not be allowed to mean is "never". The check
  // constraint in 0066 makes this unreachable through the database; it is
  // handled anyway because "unreachable" is a claim about today's schema.
  if (!isKnownDisposition(latest.disposition)) {
    return { disposition: "undecided", revisitOn: null, reason: latest.reason, decidedAt: latest.decided_at, chosen: true };
  }

  return {
    disposition: latest.disposition,
    revisitOn: latest.disposition === "revisit_on" ? latest.revisit_on : null,
    reason: latest.reason,
    decidedAt: latest.decided_at,
    chosen: true,
  };
}

export type ProspectOutcome = {
  outcome: ProspectOutcomeRow;
  current: CurrentDisposition;
  // Oldest first. Retained in full -- the reversal test in ruling 0019 is that
  // the original reason and the reversal are BOTH still readable.
  history: RevisitDispositionRow[];
};

// The latest outcome per prospect, with its disposition derived. One pass, so
// a page showing every declined prospect does not issue a query per row.
export function buildOutcomeIndex(
  outcomes: readonly ProspectOutcomeRow[] | null | undefined,
  dispositions: readonly RevisitDispositionRow[] | null | undefined,
): Map<string, ProspectOutcome> {
  const byOutcome = new Map<string, RevisitDispositionRow[]>();
  for (const d of dispositions ?? []) {
    const list = byOutcome.get(d.prospect_outcome_id);
    if (list) list.push(d);
    else byOutcome.set(d.prospect_outcome_id, [d]);
  }

  const latestPerProspect = new Map<string, ProspectOutcomeRow>();
  for (const o of outcomes ?? []) {
    const held = latestPerProspect.get(o.prospect_id);
    if (!held || Date.parse(o.recorded_at) > Date.parse(held.recorded_at)) latestPerProspect.set(o.prospect_id, o);
  }

  const index = new Map<string, ProspectOutcome>();
  for (const [prospectId, outcome] of latestPerProspect) {
    const history = sortByDecidedAt(byOutcome.get(outcome.id) ?? []);
    index.set(prospectId, { outcome, current: deriveCurrentDisposition(history), history });
  }
  return index;
}

export function sortByDecidedAt(rows: readonly RevisitDispositionRow[]): RevisitDispositionRow[] {
  return [...rows].sort((a, b) => {
    const byTime = Date.parse(a.decided_at) - Date.parse(b.decided_at);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

// --- Display, derived from the rule rather than restated ------------------

export type DispositionPresentation = {
  label: string;
  detail: string;
  tone: "teal" | "amber" | "red" | "neutral";
};

// Every screen reads its wording from here. A page that spelled out its own
// "Never revisit" string would be an interface asserting something the code had
// already decided otherwise -- the second of the two defect shapes CLAUDE.md
// names.
export function describeDisposition(current: CurrentDisposition): DispositionPresentation {
  if (current.disposition === "never") {
    return { label: "Never revisit", detail: "A person closed this permanently. It can be reversed.", tone: "red" };
  }
  if (current.disposition === "revisit_on") {
    return {
      label: `Revisit ${current.revisitOn ?? ""}`.trim(),
      detail: "A person set a date to come back to this funder.",
      tone: "teal",
    };
  }
  return {
    label: "Undecided",
    detail: current.chosen
      ? "Reopened: it is a no again, and whether to return is an open question."
      : "It is a no. Nobody has decided whether to return.",
    tone: "amber",
  };
}

// The open-question test. A declined prospect nobody has ruled on is work
// waiting for a human, and ruling 0019 requires it to be visible as such rather
// than to sit silently.
export function isOpenQuestion(outcome: ProspectOutcome): boolean {
  return outcome.current.disposition === "undecided";
}

export function isScheduledRevisit(outcome: ProspectOutcome): boolean {
  return outcome.current.disposition === "revisit_on";
}

// --- Loading --------------------------------------------------------------

// Both queries are scoped by RLS to the caller's own organization; neither adds
// an organization_id filter of its own, matching every other loader in this
// codebase (see lib/prospect-intelligence.ts). Isolation is enforced in the
// database so an action cannot forget it.

export async function loadProspectOutcome(
  supabase: SupabaseClient,
  prospectId: string,
): Promise<ProspectOutcome | null> {
  const { data: outcomes } = await supabase
    .from("prospect_outcomes")
    .select("*")
    .eq("prospect_id", prospectId)
    .order("recorded_at", { ascending: false })
    .returns<ProspectOutcomeRow[]>();

  const outcome = outcomes?.[0];
  if (!outcome) return null;

  const { data: dispositions } = await supabase
    .from("prospect_outcome_dispositions")
    .select("*")
    .eq("prospect_outcome_id", outcome.id)
    .returns<RevisitDispositionRow[]>();

  const history = sortByDecidedAt(dispositions ?? []);
  return { outcome, current: deriveCurrentDisposition(history), history };
}

export async function loadOutcomeIndex(supabase: SupabaseClient): Promise<Map<string, ProspectOutcome>> {
  const [{ data: outcomes }, { data: dispositions }] = await Promise.all([
    supabase.from("prospect_outcomes").select("*").returns<ProspectOutcomeRow[]>(),
    supabase.from("prospect_outcome_dispositions").select("*").returns<RevisitDispositionRow[]>(),
  ]);
  return buildOutcomeIndex(outcomes, dispositions);
}
