// The shorter route through person identity (STATE item 109, ruling 0044
// clauses 2 and 9). Pure logic only -- no Next, no Supabase, no model -- so the
// whole flow's rules run offline in scripts/test-network-identity-flow.ts.
//
// The one invariant this file serves: an automatic LOOK is allowed (AI acts
// first and often, CLAUDE.md), an automatic CONFIRMATION never is. Nothing in
// this file can confirm anything: it has no access to a confirm action, it only
// decides who is looked at, in what order, how many per click, what is said
// while that happens, and which strong matches the human is shown.
//
//   * planAutoLook          -- one person added by hand: may we look right now?
//   * buildLookupQueue      -- many people: who, and at most how many per click.
//   * runLookupLoop         -- the client's loop: one person at a time through the
//                              EXISTING single-person action (injected as `look`),
//                              so each call stays inside one request's time limit.
//   * strongMatchPairs      -- the pairs "Confirm your network (N)" posts, and
//                              nothing else.
//   * buildReviewPerson     -- the shape the screens show a person in.

import {
  IDENTITY_STATE_LABEL,
  agreementFor,
  evidenceItems,
  evidenceLine,
  preselectedCandidate,
  refusalForLook,
  type EvidenceItem,
  type IdentityFacts,
  type IdentityState,
  type LookRefusalCode,
  type NetworkIdentityCandidate,
} from "./network-identity";

// ---------------------------------------------------------------------------
// Named limits
// ---------------------------------------------------------------------------

// One click on "Confirm your network" looks at no more than this many people.
// A HARD ceiling: a caller may ask for fewer, never more. The server does not
// rely on it (every look is still one person, one ledger run, refused in code
// for anyone who may not be looked at); it exists so a click's cost is bounded
// and stated before it is spent.
export const IDENTITY_CLICK_CAP = 50;

// The review screen lists this many strong matches at a time, so one click of
// "Confirm your network (N)" covers a screen a person can actually read (and
// stays under the 500 pairs the server accepts in one confirmation). The rest
// appear when these are confirmed.
export const STRONG_MATCHES_PER_SCREEN = 200;

// A loop that meets this many problems in a row stops instead of spending the
// rest of the click on a connection or a setup that is not working.
export const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// What a screen shows about one person
// ---------------------------------------------------------------------------

export type ReviewCandidate = {
  id: string;
  label: string;
  headline: string | null;
  locationText: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  evidence: EvidenceItem[];
  evidenceLine: string;
  // Whether the captured text supports the words the AI wrote (null = nothing to test).
  labelSupported: boolean;
  headlineSupported: boolean | null;
  // True when the stored comparison was out of date (the person was edited after
  // the look) and was worked out again from the stored page text.
  recomputed: boolean;
};

export type ReviewPerson = {
  id: string;
  name: string;
  affiliation: string | null;
  title: string | null;
  city: string | null;
  state: string | null;
  preselectedId: string | null;
  candidates: ReviewCandidate[];
};

type PersonRow = { id: string; person_name: string; affiliation: string | null; title: string | null; city: string | null; state: string | null };

// One person and their stored candidates, shown with the evidence worked out by
// code. Used by the review screen and by the "just added" panel, so there is one
// place that decides what a candidate looks like and which one is preselected.
export function buildReviewPerson(p: PersonRow, cands: readonly NetworkIdentityCandidate[]): ReviewPerson {
  const facts: IdentityFacts = { person_name: p.person_name, affiliation: p.affiliation, title: p.title, city: p.city, state: p.state };
  const pre = preselectedCandidate(cands, facts);
  return {
    id: p.id,
    name: p.person_name,
    affiliation: p.affiliation,
    title: p.title,
    city: p.city,
    state: p.state,
    preselectedId: pre?.id ?? null,
    candidates: cands.map((c) => {
      const { agreement, recomputed } = agreementFor(c, facts);
      return {
        id: c.id,
        label: c.label,
        headline: c.headline,
        locationText: c.location_text,
        sourceUrl: c.source_url,
        sourceTitle: c.source_title,
        evidence: evidenceItems(agreement),
        evidenceLine: evidenceLine(agreement),
        labelSupported: agreement.model_text.label,
        headlineSupported: agreement.model_text.headline,
        recomputed,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// One person added by hand
// ---------------------------------------------------------------------------

export type AutoLookPlan =
  | { look: true }
  | { look: false; reason: Extract<LookRefusalCode, "do_not_research" | "too_few_facts" | "no_name">; message: string };

type AddedPerson = {
  person_name: string;
  affiliation?: string | null;
  title?: string | null;
  city?: string | null;
  state?: string | null;
  do_not_research?: boolean;
};

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

// May the platform look for this person's matches the moment they are saved?
// The same refusal the server applies (refusalForLook), asked first so a person
// who cannot be looked at is told why in plain words instead of being sent to
// the server to be refused. The server still decides: this is courtesy, not the
// guard. A look is allowed; this never decides anything about identity.
export function planAutoLook(person: AddedPerson): AutoLookPlan {
  const refusal = refusalForLook(
    {
      person_name: person.person_name,
      affiliation: blank(person.affiliation),
      title: blank(person.title),
      city: blank(person.city),
      state: blank(person.state),
      do_not_research: person.do_not_research === true,
      identity_status: "unconfirmed",
    },
    { candidateCount: 0, lookedAt: false },
    "single"
  );
  if (!refusal) return { look: true };
  if (refusal.code === "do_not_research") {
    return { look: false, reason: "do_not_research", message: "Saved. This person is marked do not research, so nothing is looked up about them." };
  }
  if (refusal.code === "too_few_facts") {
    return {
      look: false,
      reason: "too_few_facts",
      message: "Saved. Add an employer, title or city so we can find the right person. A name alone could be anyone.",
    };
  }
  return { look: false, reason: "no_name", message: "This person has no name recorded, so nothing is looked up." };
}

// ---------------------------------------------------------------------------
// Many people: who is looked at, and how many per click
// ---------------------------------------------------------------------------

export type LookupQueue = {
  // Who this click will look at, in order.
  queue: string[];
  // How many people are waiting to be looked at in all (after removing anyone
  // already done and any repeat).
  eligible: number;
  // How many of those this click does not reach.
  beyondCap: number;
  capped: boolean;
};

// The people one click looks at: the first `cap` of those still to do, never
// more than IDENTITY_CLICK_CAP whatever the caller asks for. `done` is whoever
// has already been looked at (resumability: a person already done is skipped, so
// stopping and clicking again carries on where it left off).
export function buildLookupQueue(eligibleIds: readonly string[], opts: { cap?: number; done?: ReadonlySet<string> } = {}): LookupQueue {
  const cap = Math.max(0, Math.min(Number.isFinite(opts.cap) ? Math.floor(opts.cap as number) : IDENTITY_CLICK_CAP, IDENTITY_CLICK_CAP));
  const seen = new Set<string>();
  const todo: string[] = [];
  for (const id of eligibleIds) {
    if (seen.has(id) || opts.done?.has(id)) continue;
    seen.add(id);
    todo.push(id);
  }
  const queue = todo.slice(0, cap);
  return { queue, eligible: todo.length, beyondCap: todo.length - queue.length, capped: todo.length > queue.length };
}

const people = (n: number) => (n === 1 ? "person" : "people");

// "the next 50 of 212" / "all 20".
export function nextBatchText(q: Pick<LookupQueue, "queue" | "eligible" | "capped">): string {
  return q.capped ? `the next ${q.queue.length} of ${q.eligible}` : `all ${q.eligible}`;
}

// The statement that sits at the click that spends: the count, the cost, the
// cap. `eligible` is how many people are waiting; the click looks at the next
// `cap` of them.
export function lookupCostStatement(eligible: number, cap: number = IDENTITY_CLICK_CAP): string {
  const q = buildLookupQueue(Array.from({ length: eligible }, (_, i) => String(i)), { cap });
  if (eligible === 0) return "Everyone who can be looked up has been looked at.";
  return `${eligible} ${people(eligible)} not yet identified. Each one costs one AI run. This click looks up ${nextBatchText(q)}${q.capped ? "; click again for the rest" : ""}.`;
}

export function progressText(position: number, total: number): string {
  return `Looking up ${position} of ${total}`;
}

export type LookResultLike = { error: string } | { success: true; stored: number };

export type LookupProgress = { position: number; total: number; looked: number; failed: number };

export type LookupLoopOutcome = {
  attempted: number;
  looked: number;
  withCandidates: number;
  noCandidatesFound: number;
  failed: number;
  notReached: number;
  stoppedBy: "done" | "user" | "problems";
  // Who was looked at (completed a look), so a later pass can skip them.
  doneIds: string[];
  // The first few distinct reasons a look did not happen, in the server's words.
  errors: string[];
};

// The client's loop. One person at a time, in order, by calling `look` -- the
// existing single-person action -- so each call is one request, one person and
// one ledger run, refused on the server for anyone who may not be looked at. The
// loop adds nothing to what the server allows: it passes the person's id and
// nothing else. It enforces the per-click cap itself (never more than
// IDENTITY_CLICK_CAP), stops when asked, and stops after MAX_CONSECUTIVE_FAILURES
// problems in a row. It has no way to confirm anyone.
export async function runLookupLoop(args: {
  queue: readonly string[];
  look: (personId: string) => Promise<LookResultLike>;
  shouldStop: () => boolean;
  onProgress?: (p: LookupProgress) => void;
  cap?: number;
}): Promise<LookupLoopOutcome> {
  const { queue } = buildLookupQueue(args.queue, { cap: args.cap });
  const out: LookupLoopOutcome = { attempted: 0, looked: 0, withCandidates: 0, noCandidatesFound: 0, failed: 0, notReached: 0, stoppedBy: "done", doneIds: [], errors: [] };
  let inARow = 0;
  for (let i = 0; i < queue.length; i++) {
    if (args.shouldStop()) {
      out.stoppedBy = "user";
      out.notReached = queue.length - i;
      break;
    }
    if (inARow >= MAX_CONSECUTIVE_FAILURES) {
      out.stoppedBy = "problems";
      out.notReached = queue.length - i;
      break;
    }
    args.onProgress?.({ position: i + 1, total: queue.length, looked: out.looked, failed: out.failed });
    out.attempted++;
    let result: LookResultLike;
    try {
      result = await args.look(queue[i]);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "The look did not complete." };
    }
    if ("error" in result) {
      out.failed++;
      inARow++;
      if (out.errors.length < 3 && !out.errors.includes(result.error)) out.errors.push(result.error);
    } else {
      inARow = 0;
      out.looked++;
      out.doneIds.push(queue[i]);
      if (result.stored > 0) out.withCandidates++;
      else out.noCandidatesFound++;
    }
  }
  return out;
}

export function lookupLoopAddsUp(o: LookupLoopOutcome, queued: number): boolean {
  return o.looked + o.failed === o.attempted && o.attempted + o.notReached === queued && o.withCandidates + o.noCandidatesFound === o.looked;
}

// The sentence after a click: what happened, plainly, and what is next.
export function lookupSummary(o: LookupLoopOutcome, queued: number, eligibleBefore: number): string {
  const parts: string[] = [];
  parts.push(
    `Looked up ${o.looked} of ${queued} ${people(queued)}: ${o.withCandidates} now ${o.withCandidates === 1 ? "has" : "have"} matches to review and ${o.noCandidatesFound} had none found.`
  );
  if (o.failed > 0) parts.push(`${o.failed} could not be looked up${o.errors.length > 0 ? ` (${o.errors.join("; ")})` : ""}; they stay waiting.`);
  if (o.stoppedBy === "user") parts.push(`You stopped it, so ${o.notReached} ${o.notReached === 1 ? "was" : "were"} not looked up. Click again to carry on.`);
  if (o.stoppedBy === "problems") parts.push(`It stopped after ${MAX_CONSECUTIVE_FAILURES} problems in a row, so ${o.notReached} ${o.notReached === 1 ? "was" : "were"} not looked up.`);
  const left = eligibleBefore - o.looked;
  if (o.stoppedBy === "done" && left > 0 && o.failed === 0) parts.push(`${left} more ${left === 1 ? "is" : "are"} waiting; click again for the next batch.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// The review screen
// ---------------------------------------------------------------------------

export type StateCounts = Record<IdentityState, number>;

// The compact status line at the top of the review screen.
export function statusLineParts(c: StateCounts): { key: IdentityState; text: string }[] {
  const lines: [IdentityState, string][] = [
    ["confirmed", "confirmed"],
    ["candidates", "still to review"],
    ["none_of_these", "none of these"],
    ["do_not_research", "do not research"],
    ["no_candidates_found", "looked up, no match found"],
    ["not_looked_at", "not looked at"],
  ];
  return lines.map(([key, text]) => ({ key, text: `${c[key]} ${text}` }));
}

export function statusLineText(c: StateCounts): string {
  return statusLineParts(c).map((p) => p.text).join(" · ");
}

export const STATUS_STATES = Object.keys(IDENTITY_STATE_LABEL) as IdentityState[];

// The pairs "Confirm your network (N)" posts: each person with a strong
// (preselected) match, and the candidate that match is -- minus anyone the human
// left out. Nothing here is a decision; the server re-derives the preselection
// from stored data and confirms only a pair that is still the preselected one.
export function strongMatchPairs(peopleToReview: readonly ReviewPerson[], excluded: ReadonlySet<string> = new Set()): { personId: string; candidateId: string }[] {
  const out: { personId: string; candidateId: string }[] = [];
  for (const p of peopleToReview) {
    if (p.preselectedId === null || excluded.has(p.id)) continue;
    if (!p.candidates.some((c) => c.id === p.preselectedId)) continue;
    out.push({ personId: p.id, candidateId: p.preselectedId });
  }
  return out;
}
