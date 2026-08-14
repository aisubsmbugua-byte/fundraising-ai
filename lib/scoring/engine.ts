// Pure screening engine (Slice 3). No I/O — takes rules + a prospect, returns a tier.
// Kept dependency-free so it is unit-testable.

export type Rule = {
  id: string;
  label: string;
  weight: number;
  // criterion is intentionally open; Slice 3 defines the evaluable predicate spec.
  criterion: Record<string, unknown>;
  active: boolean;
};

export type ProspectInput = Record<string, unknown>;

export type ScreeningResult = {
  tier: 1 | 2 | 3;
  score: number;
  breakdown: { ruleId: string; label: string; passed: boolean; contribution: number }[];
};

// Placeholder scaffold — Slice 3 implements real predicate evaluation.
export function screen(_prospect: ProspectInput, _rules: Rule[]): ScreeningResult {
  throw new Error("Not implemented — build in Slice 3.");
}
