export const INTERACTION_KINDS = [
  { value: "email", label: "Email" },
  { value: "call", label: "Call" },
  { value: "meeting", label: "Meeting" },
  { value: "note", label: "Note" },
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number]["value"];

export function interactionKindLabel(kind: string) {
  return INTERACTION_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export type Interaction = {
  id: string;
  prospect_id: string;
  kind: InteractionKind;
  summary: string;
  occurred_at: string;
  created_by: string;
  created_at: string;
};
