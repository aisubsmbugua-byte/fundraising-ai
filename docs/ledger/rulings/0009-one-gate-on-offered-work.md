---
id: 0009
title: Every offer of paid work is computed from the availability ledger, and there is no second path
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

Anything the interface presents to a user as a reason to spend — a gap list, a
"still missing" line, a confirm dialog naming what a run would go after, the
search directives that run is given — is computed from `obtainableGaps()` over
the availability ledger. There is no second way to compute what is missing.

A fact whose state is `checked_not_stated` or `not_applicable` must not appear
in any of them, in any wording.

## Why

Ruling 0006 states that only an obtainable gap may be surfaced to a user as more
work. As of Step 4, that is true of `lib/availability.ts` and of nothing else.
The module has zero production callers — the only file in the repository that
imports it is `scripts/test-availability.ts`.

The live path is untouched and still binary. `missingInformationSections()`
returns "sections this run obtained nothing for", `research-tab.tsx` renders each
as `— not found`, and `research-panel.tsx` puts them under **"Still missing for
this funder:"** above a paid button. `found` versus `not found` is precisely the
collapse ruling 0006 exists to prevent: a document the funder does not publish
and a document we never opened both render as "still missing" and both are
offered.

What stands in for the guard today is copy. The button's dialog hedges — "Whether
a funder publishes any of it varies — some do not", "if they publish one" — and
one test (`test-entity-scoring.ts:374`) asserts that hedge is present. That is
careful writing doing a structural job, in a codebase whose own stated rule is
that prompt and interface wording is never the last line of defence. A hedge
cannot stop the fifth paid run; it can only apologise for it in advance.

So the measured failure ruling 0006 was written against — one prospect absorbing
five paid runs chasing a document that is not published at that source at all —
is, as of Step 4, still fully live in the product.

## What this does not say

It does not say the gap *vocabulary* moves. `outstandingIntelligence` and
`FOCUS_SEARCH_DIRECTIVES` translate a gap into what it is worth to a fundraiser
and what to search for; both are good and both stay. What changes is their
input: the keys they receive are the obtainable ones, filtered once, upstream,
rather than every key that lacks a claim.

Nor does it say the button disappears when there are no obtainable gaps. A
funder can publish something new. But the message in that case is already
written and already honest — "everything looked for was found" — and it must now
also cover the case where things were looked for, are absent, and will stay
absent. Those two are different sentences, and an interface that says the first
when the second is true is making the same collapse one layer up.

## Test of compliance

Grep for every place the interface names something as missing, outstanding, a
gap, or a target of a run. Each must trace back to `obtainableGaps()`. If any
one of them computes its own answer from the presence or absence of claims, the
ruling is not met — a guard wired into five of six call sites is failure shape 1,
and this project's most persistent defect.

The negative test is the one that matters: a prospect whose pages were read and
are silent, and whose registry says the disclosure does not exist, offers
nothing and is described as settled rather than as missing.
