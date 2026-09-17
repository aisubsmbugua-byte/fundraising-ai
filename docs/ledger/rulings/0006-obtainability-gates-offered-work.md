---
id: 0006
title: Only an obtainable gap may be offered to a user as a reason to spend
status: settled
provenance: reconstructed
supersedes:
date: 2026-09-16
---

## The ruling

Every fact the decision needs carries one of five availability states:

```
found              we have evidence stating it
checked_not_stated we read where it would be, and it is not there
not_checked        we never looked
retrieval_failed   we tried and could not reach it
not_applicable     this subject does not produce this disclosure at all
```

**Only `not_checked` and `retrieval_failed` are obtainable.** Only an obtainable
gap may be surfaced to a user as more work. A gap that cannot close must never be
offered.

## Why

Measured: one prospect absorbed five paid runs chasing a document that direct
probing later showed is not published at that source at all. The system reported
a coverage gap without distinguishing obtainable from unobtainable, so the user
was invited to spend again on something that could never close.

"They do not publish it" is a fact about the funder. "We did not look" is a fact
about us. Collapsing them produced the treadmill.

## Consequences that follow

- A 990 filer's charitable disbursements are `not_applicable`, not a gap — that
  form type's registry extract carries grants *received* and nothing about grants
  made. A 990-PF filer's same field is `checked_not_stated`.
- A page under the substantive-text threshold leaves the fact `not_checked`, not
  `checked_not_stated`. A page that loaded and a page that said something are
  different facts.
- An unreachable site is `retrieval_failed` and *is* offered, because it can
  succeed later.

## Implemented by

`lib/availability.ts` (`OBTAINABLE`, `obtainableGaps`), `scripts/test-availability.ts`.

## Downstream binding

A disqualification rule may fire only on a fact that is `found`.
`checked_not_stated` must never be read as "no restriction exists".

**Provenance: reconstructed** from the session transcript.
