---
id: 0015
title: Work reports one of six states, they are not interchangeable, and anything past implemented names its evidence
status: settled
provenance: verbatim
supersedes:
date: 2026-09-17
---

## The ruling

Every work item in `STATE.md` carries exactly one state:

```
proposed      a direction exists; nobody has approved it
approved      authorized by a ruling; not started
implemented   code written and passing locally
tested        exercised against its acceptance checks, with results recorded
released      merged to the deployed branch, or applied to the live database
verified      observed working in the environment it was built for
```

Decision items carry only `proposed` or `approved` — the rest describe code and
do not apply.

Three rules bind the ladder:

1. **No skipping.** A state may only be claimed if every state below it is true.
2. **Past `implemented`, evidence is named.** A claim of `tested`, `released` or
   `verified` cites what was run, what was merged, or what was observed. An
   uncited state claim is `implemented` with a stronger adjective.
3. **One state per item.** If parts of an item are at different states, it is
   two items.

## Why

The previous vocabulary was "done" or nothing, and it could not describe the
situations this project is actually in.

Item 6 is the standing example: migrations 0063–0065 are **applied to the live
database** while the code that uses them sits on an unmerged branch. The schema
is released and the code is not. Under one status field that is unsayable, so it
went unsaid for a day and survives only as prose in an item body.

Step 4 is the other: reported done, 29 tests passing, zero production callers.
That is `tested` and nothing beyond it. Ruling 0010 had to be written because
there was no word for the distance between a passing test suite and a working
product — this ruling supplies it, and 0010 becomes the test that moves an item
from `tested` to `released` rather than a separate principle to remember.

## Rule 3 is the one that will bite

It is the project's own governing rule applied to status. A single state over a
bundle averages over its parts, exactly as "78% coverage" averaged over a
keyword-match rate — and it fails in the direction that flatters, because a
bundle is reported at the state of its most advanced piece and the laggard
disappears.

A migration applied and its consumer unmerged is two items. A guard shipped for
registry facts and pending for site facts is two items — which ruling 0013
already forced into existence as items 2 and 16, before this ruling gave the
reason.

## Test of compliance

`ledger-check` rejects a state outside the vocabulary, rejects a work state on a
decision item, and fails on any item at `tested` or beyond whose row names no
evidence.

`released` is mechanically checkable and must be checked: if an item claims it,
its commits are on the deployed branch. An item claiming `released` from a
feature branch is the failure this rule exists to catch, and it is the one a
human reviewer is least likely to notice, because the work genuinely is finished
everywhere except where it counts.

`verified` cannot be mechanically checked and must therefore never be set by
either space on its own authority. It is set when a human has observed the
behaviour, or when a named artifact records the observation.

## Scope

Authorizes the `status` column in `STATE.md`, its vocabulary, and the
`ledger-check` validation above. Does not authorize changing what is governed,
and does not retroactively assign states to closed items — they closed under the
old vocabulary and relabelling them now would be inventing a history nobody
observed.
