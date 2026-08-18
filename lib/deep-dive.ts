export const DEEP_DIVE_STATUSES = ["researching", "analyzing", "ready_for_review", "error"] as const;
export type DeepDiveStatus = (typeof DEEP_DIVE_STATUSES)[number];

export type Strategy = {
  outreach_approach: string;
  ask_positioning: string;
  rationale: string;
};

export type DeepDiveRun = {
  id: string;
  prospect_id: string;
  status: DeepDiveStatus;
  status_message: string | null;
  findings: string | null;
  strategy: Strategy | null;
  model: string | null;
  error_message: string | null;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  approved_strategy: Strategy | null;
};
