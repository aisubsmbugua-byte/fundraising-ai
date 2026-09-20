---
id: 0027
title: A recorded outcome can be retracted, and a retraction is an appended fact — the record survives its own reversal
status: settled
provenance: verbatim
supersedes:
date: 2026-09-19
---

## The ruling

1. **A recorded prospect outcome may be retracted by an explicit human
   action** from within the organization that recorded it. Nothing retracts
   automatically, and nothing outside the organization retracts anything.

2. **A retraction is an appended fact, never a deletion or an edit.** It is
   its own row, naming who, when, and optionally why. The original outcome
   row and every disposition row stay exactly as written — ruling 0019's
   retention is untouched, and the database still grants no delete or update
   on any of it. Relationship memory keeps both halves: that the team once
   recorded a no, and that the team took it back.

3. **The outcome in effect is derived, in one place.** Effective outcome =
   the recorded outcome unless a retraction row exists for it. One
   derivation function owns this; every consumer — pages, queries, any
   future export — reads the derivation, never re-implements it
   (capture-don't-retype). After retraction the prospect stands as if no
   outcome were recorded: absence semantics restored, `undecided` by the
   absence of an effective row, exactly as migration 0066 encodes it.

4. **A retraction is itself retained.** Its table follows the same pattern:
   org-scoped, append-only, no delete policy. Recording a decline again
   after a retraction is a new outcome row, not a resurrection of the old
   one.

## Why

Item 34, raised by build correctly: migration 0066 grants no delete on
prospect_outcomes by design, so a misclick that records a funder as
declined is permanent. This codebase has twice held that a confirmation a
person cannot revise is a trap; ruling 0019 holds that a recorded no is
retained. Both are satisfied at once by the shape the disposition log
already uses — append the reversal instead of erasing the act. The owner
intends to add testers on Monday 2026-09-22, and a tester's first misclick
must not become their organization's permanent record.

## Test of compliance

Record an outcome, retract it: the outcome row and the retraction row are
both readable; the derivation reports no outcome in effect; no surface
shows the prospect as closed. Attempt to delete or update either row as the
recording org: the database refuses. Record a new outcome afterward: it is
a new row.

## Scope

Authorizes, within item 49: an additive migration (retraction table,
org-scoped per hard rule 6 with the 0066 pattern, org-match trigger on its
outcome reference, no delete/update policies), the single derivation
function in lib/prospect-outcomes.ts, a human retraction action on the
surfaces that show an outcome, isolation-test extension, and standalone
tests. Does not authorize changing outcome recording itself, the branded
RevisitChoice type, or any automation.
