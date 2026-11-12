// Item 116 (the moved-filer reconcile): a funder whose returns carry different state addresses is loaded by
// each state's run from that state's returns alone, so its stored kind labels and kind_basis can rest on a
// subset of its returns. This is the pure part of the pass that puts them right: given every return stored for
// the funder (standing and superseded), recompute the labels and the basis with the loader's own rule
// (kindsForFunder) and say what, if anything, must change. Nothing here reads or writes anything.

import { kindsForFunder, type CharityThreshold, type PeriodFacts } from "./charity-scope";

export interface StoredKinds {
  is_grantmaking_public_charity: boolean;
  is_daf_sponsor: boolean;
  kind_basis: unknown;
}

export interface KindsPatch {
  is_grantmaking_public_charity: boolean;
  is_daf_sponsor: boolean;
  kind_basis: PeriodBasis[];
}
export type PeriodBasis = { tax_period_end: string; grants_to_domestic_orgs_amt: number | null; donor_advised_funds_held_cnt: number | null; donor_advised_fund_box: boolean | null };

export type Reconciled =
  | { action: "none" }
  | { action: "patch"; patch: KindsPatch; labelChanged: boolean; basisAdded: number }
  | { action: "refuse"; why: string };

const canon = (b: unknown): string[] => (Array.isArray(b) ? b.map((e) => JSON.stringify(sortKeys(e))).sort() : []);
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** `periods` is one entry per stored return (standing and superseded), read from the return itself. */
export function reconcileKinds(stored: StoredKinds, periods: PeriodFacts[], t: CharityThreshold): Reconciled {
  if (periods.length === 0) return { action: "refuse", why: "no stored return could be read for this funder" };
  const k = kindsForFunder(periods, t);
  // A funder is stored only because some stored return puts it in scope. Recomputing over every one of its stored
  // returns can never take that away; if it does, something is wrong with what was read, and nothing is changed.
  if (!k.inScope) return { action: "refuse", why: "recomputed over all its stored returns the funder is not in scope under either kind" };
  const labelChanged = k.isGrantmakingPublicCharity !== stored.is_grantmaking_public_charity || k.isDafSponsor !== stored.is_daf_sponsor;
  const before = canon(stored.kind_basis);
  const after = canon(k.basis);
  if (!labelChanged && before.length === after.length && before.every((x, i) => x === after[i])) return { action: "none" };
  return {
    action: "patch",
    patch: { is_grantmaking_public_charity: k.isGrantmakingPublicCharity, is_daf_sponsor: k.isDafSponsor, kind_basis: k.basis },
    labelChanged,
    basisAdded: Math.max(0, after.length - before.length),
  };
}

/** Funders to look at: those whose stored basis does not list exactly the periods of their stored returns. */
export function needsReconcile(basis: unknown, storedReturnPeriods: string[]): boolean {
  const have = (Array.isArray(basis) ? basis : []).map((e) => String((e as { tax_period_end?: unknown }).tax_period_end ?? "")).sort();
  const want = [...storedReturnPeriods].sort();
  return have.length !== want.length || have.some((p, i) => p !== want[i]);
}
