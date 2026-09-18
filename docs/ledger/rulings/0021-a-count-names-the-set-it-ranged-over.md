---
id: 0021
title: A count reported as evidence names the set it ranged over and how that set was determined
status: settled
provenance: verbatim
supersedes:
date: 2026-09-18
---

## The ruling

**A count offered as evidence names its denominator.** Three things, together:

1. **What was counted** — the unit. (Ruling 0004 already requires this.)
2. **The set it ranged over** — the population the count was taken across.
3. **How that set was determined** — the command, glob, query or filter that
   produced it, such that a reader holding only the report can reproduce the
   population and get the same number.

A count missing (2) or (3) is not evidence. It may not support an item at
`tested` or beyond under ruling 0015, and no ruling or review may rely on it.

This binds the decision space exactly as it binds the build space. The failure
that produced it was recorded in the decision space's own countercheck.

## Why

Item 24's evidence row read "407 citations verified per run". The figure is 337.

The 70-citation gap was 17 duplicate files named `* 2.*` — artifacts of the
project being moved between directories — that the run happened to include
because they matched the same glob as the originals. Nothing about the report
disclosed which files were scanned, so nothing about the report could have
revealed the error.

**This passed every rule the ledger already had.** The number was correctly
labelled: it was citations, verified, per run. It did not average two facts.
Ruling 0004 catches a number wearing the wrong name and a number hiding two
facts; 407 was wearing its own name and carrying one fact. It was simply taken
over a population nobody stated and nobody could have questioned.

The item was at `released` on that row.

## What makes this the third occurrence, not the first

- "78% coverage" — a keyword-match rate. Caught by reading the underlying words.
- "47% discovery recall" — never-retrieved conflated with retrieved-then-reduced.
  Caught by reading the underlying words.
- "407 citations" — correct label, single fact, unstated population. **Not
  caught by reading the words, because the words were accurate.** It surfaced
  only because the file set changed underneath it and the number moved.

That is the distinction this ruling exists for. The first two were defects in
*description* and a careful reader could find them. The third was a defect in
*scope*, and no amount of careful reading finds it, because the report and the
run agree with each other perfectly. Only the population was wrong, and the
population was invisible.

## Relationship to ruling 0004

0004 governs the label; this governs the denominator. They are the same
discipline applied to the two halves of a measurement, and neither implies the
other: a number can name precisely what it measured and still measure it over
the wrong things.

0004 is not superseded. A report must satisfy both.

## Test of compliance

For any count in a build report, a review, a ruling, or a `STATE.md` evidence
row, a reader with only that document can answer: *which things were counted,
and what would I run to enumerate them?* If reproducing the population requires
information the document does not contain, the count fails.

The cheap form: state the count and the command in the same breath — "337
citations across the 54 `.md` files under `docs/`, walked at
`scripts/ledger-check.ts:387`" rather than "337 citations".

That example was itself wrong on first writing. It read "41 files", a number
chosen because it looked plausible and never checked; `find docs -name "*.md"
-type f | wc -l` returns 54. The error was caught before sealing, inside the
ruling that defines the error, by the author who had just finished describing
it. Recorded rather than quietly fixed, because it establishes the cost of the
rule: naming a denominator takes one command, and the failure mode is not
carelessness but the ease of writing a number that reads correctly.

A count whose population is genuinely not enumerable is reported as an estimate
and labelled one.

## Scope

Authorizes one change in `scripts/ledger-check.ts`: its own summary line must
name the population it scanned alongside each count it prints, so that the next
divergence is visible in the output rather than discoverable only by accident.
The check currently prints `N doc citation(s)` with no indication of the file
set — the precise shape this ruling forbids, emitted by the tool the ledger uses
to police itself.

Does not authorize any other code change, and does not change what is governed.
Existing counts already recorded are not retroactively invalidated; they are
corrected when found, as item 24's was.
