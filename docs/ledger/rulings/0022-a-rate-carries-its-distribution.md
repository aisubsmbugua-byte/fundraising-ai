---
id: 0022
title: A rate aggregated over cases carries its per-case distribution, and a rate no case resembles is not evidence of behaviour
status: settled
provenance: verbatim
supersedes:
date: 2026-09-19
---

## The ruling

**A rate offered as evidence that aggregates over enumerable cases is reported
with its per-case distribution** — at minimum: how many cases sit at each
extreme, and how many lie between.

**Where no case behaves approximately like the rate, the rate may not stand as
evidence of system behaviour.** It is evidence of set composition — the ratio
of cases that work to cases that do not — and must be reported as that. The
finding in such a result is the split and the classification of the failing
cases, never the number.

Consequence for direction, binding on both spaces: a bimodal result does not
authorize tuning aimed at the mean. The question it opens is *what class of
case fails completely, and how common is that class in the real population* —
and work follows only from an answer to that, not from the rate.

## Why

The first retrieval measurement reported 72% recall (31/43), 76% (31/41) over
the judgements whose URLs were still live. Both figures comply with ruling
0004 — correctly labelled, nothing blended — and with ruling 0021 — unit,
population and reproduction command all stated.

Both are still misleading, because of the ten cases contributing judgements,
**eight retrieve 100% of their live ground-truth URLs and two retrieve 0%.
None is in between.** (Population: the 41 `stated` judgements returning 200 on
2026-09-18; per-case table in `docs/reviews/0015-discovery-recall-measurement.md`,
counterchecked in the decision space.)

So 76% describes no funder this system has ever been pointed at. On any given
site the observed behaviour is "finds everything" or "finds nothing". Read as
an accuracy rate, 76% invites exactly the wrong work — general tuning of a
retrieval that is not generally weak — and hides exactly the right question:
the two zeros have *named, different, structural* causes (one funder keeps its
grant pages on a subdomain the crawler never leaves; one large site never
surfaces pages that exist and answer), and nobody knows how common those site
shapes are among real funders.

## Relationship to rulings 0004 and 0021

The three govern the three parts of a measurement, and no one of them implies
another:

- **0004 — the label.** What the number claims to be.
- **0021 — the denominator.** The set it ranged over, reproducibly.
- **0022 — the shape.** Whether the cases it aggregates actually resemble it.

The 72% passed the first two and failed the third. Naming a denominator does
not make a mean meaningful; a mean is a summary, and a summary that summarizes
nothing in the set is the project's governing defect — two different facts
(works completely, fails completely) collapsed into one value — wearing a
percent sign.

## Test of compliance

For any aggregated rate in a build report, review, ruling or `STATE.md`
evidence row, a reader holding only that document can answer: **how many of
the units this rate aggregates behave approximately as the rate says?** If the
document does not let them answer, the report fails. If the answer is "none",
the rate fails as evidence and the distribution is the finding.

The cheap form is one line beside the rate: "76% (31/41) — per case: 8 of 10
complete, 2 of 10 zero, none partial."

This does not demand a histogram of every number. A count is not a rate;
rulings 0004 and 0021 already govern counts. This binds aggregations over
cases offered as evidence of how the system behaves.

## Scope

Authorizes one change in `scripts/reference-recall.ts`: the summary block
reports, beside each recall it prints, the per-case distribution over the
cases contributing to it — complete / partial / zero — so that the next
bimodal result is visible in the tool's own output rather than discoverable
only by reading a review's table, and so the day a case first lands *between*
the modes is announced by the run that observes it.

Does not authorize any change to discovery, selection, fetch, the manifest
cap, or the reference set. The two structural failures and the cap loss remain
open under items 33 and 32; per review 0009, a fix for one case is not a fix,
and per this ruling, work on them follows from classifying the failing site
shapes, not from moving the mean.
