---
id: 0010
title: A step is done when its invariant holds in the running product, not when its module passes its tests
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

A Build 1 step may be reported complete only when the invariant it exists to
establish is true of the system a user touches. A pure module with passing tests
and no consumer is an unfinished step, regardless of test count.

The completion report for a step must name, for each invariant it claims:

1. the function that decides it, and
2. every call site now routed through that function.

"Added X" is not a completion claim. "X is the only path to Y, and here are the
N places that now reach Y" is.

## Why

Step 4 was reported done and is, as a module, good work: five states, a clear
obtainability predicate, 29 tests that all pass, and comments that state the
reasoning better than most of this codebase. None of it runs. Nothing imports
`lib/availability.ts` except its own test, so the measured user harm it was built
to remove is untouched (ruling 0009), and a defect in its core derivation
survived 29 tests because no real input ever reached it (ruling 0008).

Both of those are the same fact viewed twice: a module with no consumer has no
feedback. Its tests can only assert what its author already believed. Wiring is
not the last chore of a step — it is the step's only source of evidence that it
is right.

This also explains how the step passed review at all. The report was accurate
about what was built and silent about what was connected, and "29 tests pass" is
a true sentence that answers a question nobody should have been asking.

## The general form

This is failure shape 1 stated as a schedule rather than as a bug. A concept
wired into some call sites and not others is the project's most persistent
defect; a concept wired into *no* call sites is that defect at its limit, and it
is easier to ship because there is no inconsistency to notice. Small steps were
adopted (ruling 0005) so that the boundary of each change would make gaps
obvious. A step that ends at a module boundary defeats that, because the gap
falls exactly on the line where the review stops.

## Test of compliance

Before a step is reported: grep for the name of the function the step
introduced. If the only hits are its own file and its own test, the step is not
finished.

## Consequence for the build sequence

Ruling 0005's step table is amended in effect, not in text: Step 4 returns to
open. Step 5 does not begin until Step 4's invariant holds in the product, since
Step 5's disqualification rules read the ledger Step 4 was meant to produce and
would otherwise be built against a derivation with no evidence behind it.
