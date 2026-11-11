# 0013 — A margin of error for the charity sample check

status: decided by the owner, 2026-11-11 ("Yes, make that change")
date: 2026-11-11
owner: decision space
under: ruling 0047 clause 6 and decision 0011 condition 2 ("no unexplained difference is ever waved through"); this decision amends that one condition, for the public charity and donor-advised fund sponsor load only. It does not change the foundation load's bar (ruling 0046).

## Why

The reason for this information is to give a fundraising team enough to act on. A single stray value in a
sample of three hundred thousand does not change an action, and no failed check ever rejects or deletes a
return (a check only labels a state). Arizona's sample compared 306,608 values and found one difference.

## The decision

A state is "verified within tolerance" (a status of its own, never called plain "verified") when its
sample check has no structural problem and every difference fits all of:

1. **Facts that decide who a funder is** (its id number, its public-charity or sponsor label, the figures behind
   that label, which return stands): differences in at most 1% of the funders checked (1 of a 150-funder sample).
2. **All other values** (recipient names and amounts, addresses, wording): differences in at most 0.01% of the
   values compared (about 30 of a state-sized sample).
3. **Audits:** at most one miss in the header audit (of 300 returns) and one in the scope audit (of 150).
   Over that is a structural problem and stops the run.
4. **No margin at all** for: arithmetic and whole-return counts (the run's outcomes add up), a stored person's
   name or a stored donor or grant to an individual (ruling 0047 clause 3), and any state with a sample too
   small for a margin to mean anything (the allowance is a rounded-down share of the sample, so 1% of fewer
   than 100 funders is none).

Every difference is still recorded and classified, and a state's record shows its rates against these
allowances. The margin decides a label and whether the run continues; it never changes what is stored.
Repeated differences of one kind across states are a defect to fix, not noise to average away. Rates are in
lib/funder-reference/verify-990.ts (TOLERANCE) and tested.

## What it does not change

Everything else in decisions 0011 and 0012: a failed load or a structural failure stops the run; a state
beyond the margin is recorded as not verified and the run goes on (3 in a row or 8 in all halts it); the
national load is not complete until every not-verified state is explained or fixed and re-checked.
