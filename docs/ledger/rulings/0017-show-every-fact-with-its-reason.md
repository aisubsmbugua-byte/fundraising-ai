---
id: 0017
title: Every fact the decision needs is shown with the reason it is missing; only a fact more work could change carries an action
status: settled
provenance: verbatim
supersedes:
date: 2026-09-17
---

## The ruling

No fact disappears from the interface because it cannot be obtained.

Every fact in the consuming decision's required set is displayed, each carrying
the reason it is in the state it is in. Only `not_checked` and `retrieval_failed`
carry an action the user can spend on. The other three are shown, plainly, and
offer nothing.

The wording for each state must let a reader tell *we checked and they are
silent* from *we never looked* without knowing any internal vocabulary. That
distinction is the entire point; a phrasing that blurs it fails this ruling even
if the underlying state is correct.

## Relationship to ruling 0009

0009 governs the **offer**: what may be presented as a reason to spend. It stands
unchanged — `checked_not_stated` and `not_applicable` never appear in a
"still missing" list, a confirm dialog, or a follow-up search target.

0017 governs the **display**: what the user can see at all. The two are not in
tension once separated. A fact the funder does not publish appears in the
coverage view with its reason, and appears in no paid action anywhere.

## Why

Raised by the user, and it catches a defect the earlier rulings created.

0009 correctly removes an unobtainable fact from the list of things worth paying
for. But it says nothing about what replaces it, and the natural implementation
is to remove it from view entirely. Then the fundraiser sees a blank — and a
blank cannot distinguish *we read their eligibility page and they state no
denominational restriction* from *nobody has looked at their eligibility page*.

That is the same collapse this entire build exists to remove, relocated from the
data layer to the screen. The states would be computed correctly and thrown away
one render before the person who needed them.

It is also a loss of real information. "We read their stated rules and they do
not restrict by denomination" is a finding a fundraiser can act on. Ruling 0006
forbids reading it as proof that no restriction exists — it does not make it
worthless, and suppressing it protects nobody.

## What was rejected alongside it

Surfacing model-produced information that no captured source supports, flagged
with a warning, was considered and not adopted.

The evidence is in this product already. The re-search dialog carries the hedge
*"Whether a funder publishes any of it varies — some do not."* That warning was
present for all five of the wasted paid runs. A label did not change a single
decision.

So the reliable thing to label is **status**, which the code computes and cannot
misreport. The unreliable thing to label is **content**, which depends on a
reader noticing a caveat and acting differently — measured on this codebase at
52–80%. This ruling labels status only.

## Test of compliance

Every fact in the required set is reachable on screen, in every state. A fact
whose state is `checked_not_stated` is visibly different from one that is
`not_checked`, to a reader who has never seen this document.

Count the actions: exactly the obtainable facts have one.

## Scope

This changes work currently in flight under ruling 0013. The acceptance checks in
`STATE.md` are amended rather than replaced — the guard on the offer is
unchanged; a display requirement is added beside it. Build should treat any
already-written "remove from view" behaviour as superseded by this, and say so in
its report rather than silently reworking it.
