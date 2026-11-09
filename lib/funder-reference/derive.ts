// Item 110 (ruling 0045 clauses 3 and 4): the size threshold and the derived
// figures. Everything here is pure.
//
// INVARIANT. A derived figure never exists without a sentence naming the set it
// ranged over and the figures it used, and an empty set yields nulls, not zeros.

import type { ParsedFiling, ParsedGrant } from "./parse-990pf";

/**
 * THE SIZE THRESHOLD. The owner has NOT set this (STATE item 110, "open for the
 * owner"). These defaults are the suggestion in docs/decisions/0010-funder-
 * reference-database.md: at least $1 million in assets OR at least $100,000 in
 * yearly giving. Each is a named parameter, recorded on every run, and changing
 * either is a command-line flag, not a code change.
 *
 * Which figures the two tests read is fixed here and stated, because "giving"
 * has several honest meanings (ruling 0045 clause 3):
 *   assets  = total_assets_eoy_fmv_amt (Part II, end of year, fair market value),
 *             falling back to fmv_assets_eoy_amt when the Part II column is absent;
 *   giving  = contributions_paid_per_books_amt (Part I line 25, column (a)).
 * A foundation is in scope when ANY of its filings in the pilot's periods meets
 * either test.
 */
export interface Threshold {
  minAssetsFmvAmt: number;
  minContributionsPaidPerBooksAmt: number;
}
export const DEFAULT_THRESHOLD: Threshold = { minAssetsFmvAmt: 1_000_000, minContributionsPaidPerBooksAmt: 100_000 };

export interface ThresholdResult {
  meets: boolean;
  byAssets: boolean;
  byGiving: boolean;
  assetsUsed: number | null;
  givingUsed: number | null;
}

// The judgement from the two figures alone, so that a cached pass-A result (the
// figures, not the verdict) can be judged again against the CURRENT cutoff: a
// resumed run with a different threshold must not reuse an old verdict.
export function thresholdFromFigures(assets: number | null, giving: number | null, t: Threshold): ThresholdResult {
  const byAssets = assets !== null && assets >= t.minAssetsFmvAmt;
  const byGiving = giving !== null && giving >= t.minContributionsPaidPerBooksAmt;
  return { meets: byAssets || byGiving, byAssets, byGiving, assetsUsed: assets, givingUsed: giving };
}

export function assessThreshold(f: ParsedFiling, t: Threshold): ThresholdResult {
  const assets = f.figures.total_assets_eoy_fmv_amt ?? f.figures.fmv_assets_eoy_amt;
  const giving = f.figures.contributions_paid_per_books_amt;
  return thresholdFromFigures(assets, giving, t);
}

export interface GrantStats {
  count: number | null;
  sum: number | null;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  inFilerStateCount: number | null;
  inFilerStateSum: number | null;
  minusStated: number | null;
  derivation: string;
}

export function deriveGrantStats(grants: ParsedGrant[], filerState: string | null, statedTotal: number | null): GrantStats {
  const set =
    `the ${grants.length} row(s) in this filing's Part XV "grants and contributions paid during the year" list ` +
    `(funder_reference_grants where kind = 'paid_during_year')`;
  const amounts = grants.map((g) => g.amountAmt).filter((a): a is number => a !== null);
  if (amounts.length === 0) {
    return {
      count: null,
      sum: null,
      avg: null,
      median: null,
      min: null,
      max: null,
      inFilerStateCount: null,
      inFilerStateSum: null,
      minusStated: null,
      derivation: `not computed: ${set} holds no row with an amount`,
    };
  }
  const sorted = [...amounts].sort((a, b) => a - b);
  const sum = amounts.reduce((a, b) => a + b, 0);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const st = filerState?.toUpperCase() ?? null;
  const inState = st
    ? grants.filter((g) => g.amountAmt !== null && g.address !== null && g.address.country === null && g.address.state?.toUpperCase() === st)
    : [];
  const noAmount = grants.length - amounts.length;
  return {
    count: amounts.length,
    sum,
    avg: Math.round((sum / amounts.length) * 100) / 100,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    inFilerStateCount: st ? inState.length : null,
    inFilerStateSum: st ? inState.reduce((a, g) => a + (g.amountAmt ?? 0), 0) : null,
    minusStated: statedTotal === null ? null : sum - statedTotal,
    derivation:
      `computed over ${set}` +
      (noAmount ? `; ${noAmount} row(s) with no amount are excluded` : "") +
      `; count, sum, average, median, smallest and largest use the row amounts; ` +
      (st ? `"in filer state" counts rows whose US address state is ${st}, the state on this filing's filer address; ` : `"in filer state" is not computed because the filer's state is not on this filing; `) +
      `grants_listed_minus_stated_amt = grants_listed_sum_amt - grants_paid_stated_total_amt` +
      (statedTotal === null ? ` (not computed: the return states no total)` : ""),
  };
}

export interface PayoutRatio {
  ratio: number | null;
  derivation: string | null;
}
/** qualifying distributions / minimum investment return, same filing, both stated by the return. */
export function derivePayoutRatio(qualifying: number | null, minimumReturn: number | null): PayoutRatio {
  if (qualifying === null || minimumReturn === null || minimumReturn === 0) return { ratio: null, derivation: null };
  return {
    ratio: Math.round((qualifying / minimumReturn) * 10000) / 10000,
    derivation:
      "qualifying_distributions_amt / minimum_investment_return_amt, both read from this same filing " +
      "(Part XII line 4 over Part X line 6); a ratio of 1.0 means the foundation distributed exactly the minimum",
  };
}
