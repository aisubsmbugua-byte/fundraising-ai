// The OUTREACH kinds (workflow step 4): the artifacts generateDraft
// produces from an approved strategy for first contact. The proposal
// (workflow step 6, STATE item 63) is deliberately NOT in this list --
// the panel maps DRAFT_KINDS into the generateDraft buttons, and the
// proposal has its own control and its own action (generateProposalDraft,
// a distinct ai_runs operation), so putting it here would route it
// through the wrong one.
export const DRAFT_KINDS = [
  { value: "intro_email", label: "Intro Email" },
  { value: "call_prep", label: "Call Prep Notes" },
] as const;

export type OutreachDraftKind = (typeof DRAFT_KINDS)[number]["value"];

// Everything the drafts.kind enum can hold (migration 0017 + 0071).
export type DraftKind = OutreachDraftKind | "proposal";

export function draftKindLabel(kind: string) {
  if (kind === "proposal") return "Grant Proposal";
  return DRAFT_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export type DraftStatus = "draft" | "approved";

export type Draft = {
  id: string;
  prospect_id: string;
  strategy_run_id: string | null;
  kind: DraftKind;
  subject: string | null;
  content: string;
  status: DraftStatus;
  model: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  approved_at: string | null;
  // Send facts (migration 0069) -- written once by the send handler,
  // never cleared (ruling 0029 clause 3). Optional because a database
  // that predates 0069 simply doesn't return them; both absent and null
  // mean "no confirmed send on record".
  sent_at?: string | null;
  sent_by?: string | null;
  resend_message_id?: string | null;
};
