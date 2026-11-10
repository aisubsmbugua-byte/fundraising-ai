// Item 116 (ruling 0047 clause 8): who is in scope, as a stated rule in code and not a feeling.
//
//   GRANTMAKING PUBLIC CHARITY -- in scope when ANY filing in the periods reports grants to
//   domestic organizations (Form 990, Part IX, line 1, column (A)) totalling at least the threshold.
//   The owner confirmed $100,000 on 2026-11-10. A return that does not state that figure is "not
//   stated", never zero: it neither qualifies nor counts against a funder another return qualifies.
//
//   DONOR-ADVISED FUND SPONSOR -- in scope when ANY filing reports at least one donor advised fund on
//   Schedule D, Part I, line 1, column (a). The main form's box (Part IV, line 6) alone is not enough:
//   it is counted and reported, not used.
//
//   An organization can carry both labels. The labels are computed here, from stored figures and the
//   named rule, and never inferred by a model.
//
// The grants-to-organizations test uses Part IX line 1 ONLY. Part IX line 3 (outside the United States)
// mixes organizations and individuals and cannot be separated, and Part I line 13 includes grants to
// individuals; neither is used (parse-990.ts says why).
//
// Everything here is pure.

import type { ParsedReturn990 } from "./parse-990";

export interface CharityThreshold {
  /** Grants to domestic organizations, in dollars, at or above which a public charity is in scope. */
  minOrgGrantsAmt: number;
  /** The floor of the band reported as "just under the line": a funder whose largest stated figure is from here up to the threshold. */
  justUnderFromAmt: number;
}
export const DEFAULT_CHARITY_THRESHOLD: CharityThreshold = { minOrgGrantsAmt: 100_000, justUnderFromAmt: 50_000 };

export const CHARITY_RULE_TEXT =
  "grantmaking public charity: any filing in the periods states grants to domestic organizations (Form 990, Part IX, line 1, column (A)) of at least the threshold; donor-advised fund sponsor: any filing states at least one donor advised fund (Schedule D, Part I, line 1, column (a)); a figure the return does not state is not stated, never zero";

/** What one return says, for the rule. Small on purpose: it is what the pass-A cache keeps. */
export interface ReturnFacts {
  orgGrantsAmt: number | null; // Part IX line 1 column (A); null = the return does not state it
  dafHeldCnt: number | null; // Schedule D Part I line 1 column (a); null = not stated (or no Schedule D)
  dafBox: boolean | null; // Part IV line 6
}

export function factsOf(f: ParsedReturn990): ReturnFacts {
  return {
    orgGrantsAmt: f.figures.part_ix_line_1_grants_domestic_orgs_total_amt,
    dafHeldCnt: f.daf?.daf_held_cnt ?? null,
    dafBox: f.boxes.part_iv_line_6_donor_advised_fund_box,
  };
}

export interface PeriodFacts extends ReturnFacts {
  taxPeriodEnd: string;
}

export interface FunderKinds {
  isGrantmakingPublicCharity: boolean;
  isDafSponsor: boolean;
  inScope: boolean;
  /** The largest grants-to-organizations figure any return states, or null when none states one. */
  maxOrgGrantsAmt: number | null;
  /** In the just-under band: not in scope, but the largest stated figure is within reach of the line. */
  justUnder: boolean;
  /** A return ticked the donor advised fund box and none stated a fund count: reported, not used. */
  dafBoxWithoutScheduleDCount: boolean;
  /** Every period the rule looked at, with the two figures it used. Stored on the funder, so the label can be checked. */
  basis: Array<{ tax_period_end: string; grants_to_domestic_orgs_amt: number | null; donor_advised_funds_held_cnt: number | null; donor_advised_fund_box: boolean | null }>;
}

export function kindsForFunder(periods: PeriodFacts[], t: CharityThreshold): FunderKinds {
  const stated = periods.map((p) => p.orgGrantsAmt).filter((v): v is number => v !== null);
  const maxOrg = stated.length ? Math.max(...stated) : null;
  const isCharity = maxOrg !== null && maxOrg >= t.minOrgGrantsAmt;
  const isDaf = periods.some((p) => p.dafHeldCnt !== null && p.dafHeldCnt > 0);
  const inScope = isCharity || isDaf;
  return {
    isGrantmakingPublicCharity: isCharity,
    isDafSponsor: isDaf,
    inScope,
    maxOrgGrantsAmt: maxOrg,
    justUnder: !inScope && maxOrg !== null && maxOrg >= t.justUnderFromAmt && maxOrg < t.minOrgGrantsAmt,
    dafBoxWithoutScheduleDCount: !isDaf && periods.some((p) => p.dafBox === true),
    basis: [...periods]
      .sort((a, b) => a.taxPeriodEnd.localeCompare(b.taxPeriodEnd))
      .map((p) => ({ tax_period_end: p.taxPeriodEnd, grants_to_domestic_orgs_amt: p.orgGrantsAmt, donor_advised_funds_held_cnt: p.dafHeldCnt, donor_advised_fund_box: p.dafBox })),
  };
}
