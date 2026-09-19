# Review 0019 — selection, fetch and absence precision, first measurement

Decision space, 2026-09-19. The owner ran the paid half of the reference
measurement (item 30) and supplied the full output; this review records it,
counterchecked from the per-fact rows rather than accepted from the summary.
Run: `npx tsx --env-file=.env.local scripts/reference-recall.ts`, all 12
cases, 60/60 judgements, `frozen: true`. The run predates item 39's
distribution lines landing in the tool, so its summary printed bare rates;
every distribution below is hand-tallied from the run's own per-fact rows.

## The numbers, each with its denominator and its distribution

Unit throughout: one (fact key, ground-truth URL) pair for the recalls,
population the 43 `stated` judgements in `docs/reference-set/cases.json`
across 10 contributing cases; one `not_stated` judgement for absence
precision, population the 17 across 6 cases.

**Retrieval recall 31/43 (72%)** — per case: 6 complete, 2 partial, 2 zero,
of 10. Identical to both `--discovery-only` runs (2026-09-18 and -19), third
consecutive reproduction, same verdict on every row.

**Shortlist recall 26/43 (60%)** — per case: 5 complete, 2 partial, 3 zero,
of 10. Also identical to prior runs.

**Selection recall 17/43 (40%)** — per case: 2 complete (stewardship 5/5,
missio-nexus 4/4), 2 partial (maclellan 4/5, antioch 4/5), 6 zero (eaa, ncf,
cma, mariners, signatry, pma), of 10. **The mean is once again the wrong
number to read** (ruling 0022): conditional on pages actually reaching the
shortlist, 7 cases had something to select from, and they split 3
select-everything (maclellan 4/4 of available, stewardship 5/5, missio-nexus
4/4), 1 near-complete (antioch 4/5), 3 select-NOTHING (ncf 0/2, mariners
0/3, signatry 0/3). Selection, like retrieval, fails by site rather than by
degree.

**Fetch recall 17/43 (40%)** — per case identical to selection. Conditional
on selection the number that matters: **17 of 17 selected pages were read.
Fetch lost nothing.** The 40% is selection's ceiling passed through, not a
fetch failure — quoting "fetch recall 40%" without this would be exactly the
collapse ruling 0004 forbids.

**Absence precision 6/17 (35%)** — where a human recorded "this funder does
not publish this", the system selected a page for that purpose anyway in 11
of 17 judgements. Per case, and this is the finding: the 6 correct absences
are **all** on the two sites that publish nothing at all (ronald-blue 4/5,
saddleback 2/5). On the four mixed sites — funders that publish some facts
and not others — absence precision is **0 of 7** (ncf 0/2, missio-nexus 0/1,
mariners 0/2, signatry 0/2). The 35% averages "sometimes honest where
everything is absent" with "never honest where honesty is hard", and
describes neither.

## What this measurement establishes

1. **The pipeline's weakest measured stage is selection, not retrieval.**
   Retrieval is 8-of-10-perfect with two structural failures (item 33);
   selection adds three more all-or-nothing site failures on top of pages it
   demonstrably had (ncf, mariners, signatry).
2. **Misdirection, not abstention.** On those three sites the selector was
   not empty-handed: it selected pages tagged for the very purposes the human
   recorded as unpublished (the over-claim rows), while leaving the true
   pages unselected on the same sites. The model chose wrong pages for absent
   facts over right pages for present facts. Cause not established here — a
   candidate is purpose-tagging error rather than page-ranking error — and
   per review 0009 no per-case fix follows from this.
3. **Fetch needs no work on this evidence.** Zero loss on 17 attempts.
4. **The absence number is a selection-layer proxy, honestly labelled.** It
   measures whether the selector claims coverage for an unpublished fact,
   which is the upper bound of the pipeline's caution at its cheapest stage —
   not yet what a user would be told after the reading stage. It is the
   number the platform brief called the most important unmeasured one, and
   its first value on mixed sites is zero.

## Caveats

- Single paid run; retrieval's three-run stability does not extend to
  selection, whose model call is not deterministic. A second run would price
  the variance.
- The 43/17 split and the dead-URL decay recorded in items 32 (two 404s
  inside `stated`) apply to this run identically to prior ones.
- Re-running today would also print per-case distributions (item 39,
  released after this run was taken); the hand-tallies above are what that
  output will automate.

## Handed to the ledger

Item 30 closes as measured. Two new decision items: selection's per-site
all-or-nothing failure (with the misdirection observation), and absence
precision on mixed sites at 0 of 7 — the latter touching the product's core
honesty claim, not just retrieval plumbing.
