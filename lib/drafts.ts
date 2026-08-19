export const DRAFT_KINDS = [
  { value: "intro_email", label: "Intro Email" },
  { value: "call_prep", label: "Call Prep Notes" },
] as const;

export type DraftKind = (typeof DRAFT_KINDS)[number]["value"];

export function draftKindLabel(kind: string) {
  return DRAFT_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export type DraftStatus = "draft" | "approved";

export type Draft = {
  id: string;
  prospect_id: string;
  deep_dive_run_id: string | null;
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
};
