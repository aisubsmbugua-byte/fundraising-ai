export const FIELDS = [
  { value: "channel", label: "Channel" },
  { value: "organization", label: "Organization" },
  { value: "notes", label: "Notes" },
  { value: "website", label: "Website" },
  { value: "contact_name", label: "Contact name" },
  { value: "contact_email", label: "Contact email" },
  { value: "name", label: "Name" },
] as const;

export type Field = (typeof FIELDS)[number]["value"];

export const OPERATORS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "is_set", label: "is filled in" },
  { value: "is_not_set", label: "is empty" },
] as const;

export type Operator = (typeof OPERATORS)[number]["value"];

export type Criterion = {
  field: Field;
  operator: Operator;
  value?: string;
};

export const IMPORTANCE_LEVELS = [
  { value: 1, label: "Nice to have" },
  { value: 3, label: "Important" },
  { value: 5, label: "Critical" },
] as const;

export function importanceLabel(weight: number) {
  return IMPORTANCE_LEVELS.find((l) => l.value === weight)?.label ?? `Weight ${weight}`;
}

// For rules created before this picker existed (or edited via API with
// an arbitrary number), snap to the closest importance level so the
// edit form always has a sane default selected.
export function nearestImportance(weight: number) {
  return IMPORTANCE_LEVELS.reduce((closest, level) =>
    Math.abs(level.value - weight) < Math.abs(closest.value - weight) ? level : closest
  ).value;
}

export type ScreeningRule = {
  id: string;
  label: string;
  description: string | null;
  channel: string | null;
  weight: number;
  criterion: Criterion;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type RuleBreakdown = {
  rule_id: string;
  label: string;
  weight: number;
  passed: boolean;
};

export type ScreeningBreakdown = {
  rules: RuleBreakdown[];
  max_possible: number;
  percentage: number | null;
};

export type ScreeningResult = {
  id: string;
  prospect_id: string;
  tier: 1 | 2 | 3;
  score: number;
  breakdown: ScreeningBreakdown;
  screened_by: string;
  created_at: string;
};

function evaluateCriterion(criterion: Criterion, prospect: Record<string, unknown>): boolean {
  const raw = prospect[criterion.field];
  const fieldValue = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const target = (criterion.value ?? "").toLowerCase();
  const value = fieldValue.toLowerCase();

  switch (criterion.operator) {
    case "equals":
      return value === target;
    case "not_equals":
      return value !== target;
    case "contains":
      return value.includes(target);
    case "not_contains":
      return !value.includes(target);
    case "is_set":
      return fieldValue.trim().length > 0;
    case "is_not_set":
      return fieldValue.trim().length === 0;
    default:
      return false;
  }
}

// Tier thresholds: percentage of applicable rule weight that passed.
// >=70% -> Tier 1, >=40% -> Tier 2, else Tier 3.
// If no active rules apply to this prospect's channel, default to
// Tier 2 (not enough data to judge, so don't presume fit or unfit).
export function screenProspect(
  prospect: { channel: string; [key: string]: unknown },
  rules: ScreeningRule[]
): { tier: 1 | 2 | 3; score: number; breakdown: ScreeningBreakdown } {
  const applicable = rules.filter((r) => r.active && (r.channel === null || r.channel === prospect.channel));

  const ruleBreakdown: RuleBreakdown[] = applicable.map((r) => ({
    rule_id: r.id,
    label: r.label,
    weight: r.weight,
    passed: evaluateCriterion(r.criterion, prospect),
  }));

  const score = ruleBreakdown.filter((r) => r.passed).reduce((sum, r) => sum + r.weight, 0);
  const maxPossible = ruleBreakdown.reduce((sum, r) => sum + r.weight, 0);
  const percentage = maxPossible > 0 ? score / maxPossible : null;

  let tier: 1 | 2 | 3;
  if (percentage === null) {
    tier = 2;
  } else if (percentage >= 0.7) {
    tier = 1;
  } else if (percentage >= 0.4) {
    tier = 2;
  } else {
    tier = 3;
  }

  return { tier, score, breakdown: { rules: ruleBreakdown, max_possible: maxPossible, percentage } };
}

export type ChannelSummary = {
  channel: string;
  activeRuleCount: number;
  maxPoints: number;
  tier1Threshold: number;
  tier2Threshold: number;
};

// What it actually takes to hit each tier, per channel, given today's
// active rules -- makes the abstract 70%/40% thresholds concrete.
export function summarizeByChannel(rules: ScreeningRule[], channels: readonly string[]): ChannelSummary[] {
  return channels.map((channel) => {
    const applicable = rules.filter((r) => r.active && (r.channel === null || r.channel === channel));
    const maxPoints = applicable.reduce((sum, r) => sum + r.weight, 0);
    return {
      channel,
      activeRuleCount: applicable.length,
      maxPoints,
      tier1Threshold: Math.ceil(maxPoints * 0.7),
      tier2Threshold: Math.ceil(maxPoints * 0.4),
    };
  });
}

export function tierLabel(tier: number) {
  if (tier === 1) return "Tier 1 — Strong fit";
  if (tier === 2) return "Tier 2 — Possible";
  return "Tier 3 — Unlikely";
}

export function tierColor(tier: number) {
  if (tier === 1) return "#16a34a";
  if (tier === 2) return "#d97706";
  return "#dc2626";
}
