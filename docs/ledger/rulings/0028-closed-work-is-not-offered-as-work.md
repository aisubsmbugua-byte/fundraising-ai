---
id: 0028
title: A surface that offers work consults the outcome in effect — closed is shown, not worked
status: settled
provenance: verbatim
supersedes:
date: 2026-09-19
---

## The ruling

1. **No surface offers work on a prospect whose effective outcome closes
   it.** A prospect with an effective outcome whose disposition is `never`
   does not appear in any list of due, actionable or suggested work — "Due
   now", follow-up queues, or any future equivalent. "Effective" is ruling
   0027's derivation: a retracted outcome closes nothing.

2. **Closed is displayed, never hidden.** A no is data (relationship
   memory): the prospect stays visible wherever prospects are listed, its
   outcome shown as a fact with its reason (ruling 0017) — on the Pipeline
   board and the prospect's own page at minimum. Exclusion applies to work
   lists only.

3. **A `revisit_on` disposition is scheduled work, not closed work.** It
   surfaces as due when its date arrives and not before. `undecided` — the
   absence of a disposition — changes nothing about how the prospect was
   already offered.

4. **Every consumer derives, none restates.** Work-list queries and display
   surfaces consult the same effective-outcome derivation; no surface keeps
   its own copy of what closed means.

## Why

Item 35, found by build and correctly left unfixed: both existing surfaces
filter on next_action_due and know nothing about outcomes, so a prospect
closed with `never` keeps resurfacing as work, and the Pipeline board shows
no outcome at all. A tester who records a decline and then watches the
system keep nagging them about the same funder concludes the feature does
not work — the first user-visible contradiction between what the system
recorded and what it displays, which is this project's second governing
defect shape (an interface asserting what the code already decided
otherwise).

Item 20's general question — how the rules engine and the qualification
pipeline share a screen — stays open and deferred with lib/tier2; this
ruling covers only outcomes, which are live now and in front of testers on
Monday.

## Test of compliance

Record a `never` outcome on a prospect with a past next_action_due: it
appears in no work list, and the Pipeline board and prospect page both show
the outcome with its reason. Retract it: the prospect returns to the work
lists its dates put it in. Set `revisit_on` tomorrow: absent today, due
tomorrow.

## Scope

Authorizes, within item 49: outcome-awareness in the Due-now/follow-up
queries and the Pipeline board display, via ruling 0027's derivation; the
minimal display of an outcome with its reason where clause 2 requires it,
using the shared UI tokens. Does not authorize hiding prospects, changing
stages or stage gating (hard rule 2 untouched), item 20's tier2 display
question, or any automation.
