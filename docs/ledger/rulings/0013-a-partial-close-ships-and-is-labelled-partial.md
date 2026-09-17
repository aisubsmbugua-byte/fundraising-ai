---
id: 0013
title: A guard that can only be applied to some sources ships for those sources, and the interface never implies the rest were checked
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

Where obtainability can be decided from evidence the live path actually has, it
is decided and the guard applies. Where it cannot, the facts stay `not_checked`
and continue to be offered — and **no interface string may state or imply that
those facts were checked, looked for, or found absent.**

Concretely, for ruling 0009's wiring: `coverage: null` is the honest input, the
registry-sourced facts become decidable, the site-sourced facts remain obtainable
by construction, and any copy that summarises the whole set as complete is
removed rather than reworded.

`research-tab.tsx`'s *"Every information category was found"* is the specific
string this forbids. It must be unreachable whenever per-purpose coverage was
never computed, because in that state it is not a hedge or an overstatement — it
is false.

## Why this rather than waiting

Build reported that ruling 0009 cannot be fully honoured: `deriveAvailability`
needs per-purpose `coverage`, only Tier 2 produces it, and Tier 2 is not in the
live path. Three options were raised. Two are rejected.

**Rejected: hold 0009 until Tier 2 lands.** That couples a bounded safety fix to
item 8 — Build 1's landing, the largest unresolved architectural question on the
project. The measured harm stays fully live for however long that takes. And the
harm ruling 0006 was actually written from is a *registry* case: one prospect
absorbed five paid runs chasing a document that is not published at that source,
and the rerun targets the live interface offers are `grant_schedule` and
`authoritative_filing` — both registry-sourced. Waiting defers the half that
closes the case that motivated all of this.

**Rejected: infer coverage from what the live run already records.** Build
declined to do this unruled and was right to. A mapping from
`official_site_fetched` to per-purpose coverage has no measurement behind it; it
would be a value the code invented and then treated as a fact, which is the
defect shape this codebase names most often. Ruling 0004 applies directly: the
label and the measurement must be the same thing.

**The partial close costs the user nothing.** Under ruling 0008, `coverage: null`
leaves every site fact `not_checked` and therefore obtainable, so site work is
still offered exactly as it is today. Nothing is suppressed, nothing is hidden.
The registry half stops lying. That is strictly better than the status quo in
one direction and identical in the other, which is what makes waiting
indefensible rather than merely slow.

## The general invariant

A guard that cannot yet be applied everywhere is applied where the evidence
supports it, and its reach is stated rather than implied. The failure this
prevents is not under-applying the guard — it is the opposite: a partial fix
that reads as a complete one, so the remaining half stops being visible as work
and nobody returns to it.

This is why the labelling half is not a nicety attached to the shipping half. A
partial close recorded as a close is worse than no close, because it removes the
evidence that anything is left.

## Precedent already in the repository

`research-actions.ts:599` computes `grantSchedulePresent && !grantScheduleRead` —
the grant schedule is reported missing only when it exists and was not read.
That is obtainability, correct, in the live path, today. `missingInformationSections`
in `lib/research.ts:332` asks no availability question at all, and it is that
function's output which reaches the user. The pattern to follow is one file away
from the defect; this ruling is closer to propagating an existing correct idea
than to introducing a new one.

## Test of compliance

With `coverage: null`, no string anywhere in the interface asserts completeness
over the fact set. The registry-sourced facts reach `not_applicable` and
`checked_not_stated` where warranted and are not offered. The site-sourced facts
are all obtainable and all still offered.

`STATE.md` carries the remaining half as an open item for as long as it remains
open. When Tier 2 reaches the live path, this ruling's restriction lifts on its
own — nothing needs superseding, because the constraint is stated as a function
of what evidence exists rather than as a permanent exemption.
