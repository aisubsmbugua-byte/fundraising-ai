export const CHANNELS = [
  { value: "foundation", label: "Foundation & Family Trust" },
  { value: "regranting", label: "Regranting Ministry" },
  { value: "christian_business", label: "Christian Business" },
  { value: "denomination", label: "Denomination & Network Fund" },
  { value: "daf", label: "Donor-Advised Fund (DAF)" },
  { value: "major_donor", label: "Major Donor" },
] as const;

export type Channel = (typeof CHANNELS)[number]["value"];

export function channelLabel(channel: string) {
  return CHANNELS.find((c) => c.value === channel)?.label ?? channel;
}

export const STAGES = [
  { value: "discovery", label: "Discovery" },
  { value: "screening", label: "Screening" },
  { value: "qualification", label: "Qualification" },
  { value: "cultivation", label: "Cultivation" },
  { value: "ask", label: "Ask" },
  { value: "decision", label: "Decision" },
  { value: "stewardship", label: "Stewardship" },
] as const;

export type Stage = (typeof STAGES)[number]["value"];

export function stageLabel(stage: string) {
  return STAGES.find((s) => s.value === stage)?.label ?? stage;
}

export type Prospect = {
  id: string;
  name: string;
  channel: Channel;
  organization: string | null;
  contact_name: string | null;
  contact_email: string | null;
  website: string | null;
  notes: string | null;
  owner_id: string;
  stage: Stage;
  // Funder intelligence -- populated from AI deep-dive research when
  // a human approves the strategy, not hand-entered.
  location: string | null;
  funder_type: string | null;
  geographic_focus: string | null;
  typical_grant_size: string | null;
  focus_areas: string[] | null;
  created_at: string;
  updated_at: string;
};

export type StageChange = {
  id: string;
  prospect_id: string;
  from_stage: Stage;
  to_stage: Stage;
  changed_by: string;
  changed_by_email: string;
  note: string | null;
  created_at: string;
};
