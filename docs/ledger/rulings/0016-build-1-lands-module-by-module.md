---
id: 0016
title: A Build 1 module lands when a ruling establishes it is correct, not when Build 1 is complete
status: settled
provenance: verbatim
supersedes:
date: 2026-09-17
---

## The ruling

There is no cutover event. Each Build 1 module is wired into the live path as
soon as a ruling establishes that it is correct, authorized by that ruling, and
gated by ruling 0010's test — the invariant holds in the running product, or the
step is not finished.

"Build 1 complete" is therefore not a launch milestone. It is the point at which
nothing is left dark.

While the pipeline is partly landed, the interface states which facts it decides
and which it does not. A partially landed system that reads as a whole one is
ruling 0013's failure at the scale of the build.

## Why

This ratifies what was already happening, unnamed. `lib/discovery-handoff.ts`
went live under ruling 0003 and has a dashboard caller today. `lib/availability.ts`
is going live under ruling 0009. Two landings, both module-scoped, both
ruling-gated, neither ever described as a landing — which is why
`docs/decisions/0002` could still say the live workflow keeps its own path
"indefinitely, until (if ever) a later build migrates it" while the migration was
already under way in two places.

The alternative — finish steps 5–10, then land everything — was rejected on
evidence from this project rather than on principle. Step 4 shipped with zero
callers and a defect its 29 tests could not see, precisely because nothing real
ever reached it. Six more steps built the same way would accumulate six more
sets of assumptions that no production input has tested. Integration is not the
last chore of a build; it is the only thing that tells a module it is wrong.

The cost is accepted openly: two screening systems coexist for months, and the
interface carries the burden of being honest about which is answering what. That
is a real cost and it is smaller than shipping six untested steps at once.

## What this does not decide

**The display question is deferred.** When the live Slice 3 rules engine and the
qualification pipeline both have something to say about one prospect, what the
user sees is a genuine design decision — but it is not a *precedence* decision,
because neither system acts. Hard rule 3 and ruling 0002 mean both are advisory
to a human, so nothing needs to win.

It is deferred rather than dropped, on the same reasoning as ruling 0007:
`lib/qualification.ts` is dark and steps 5–8 come first, so designing the display
now would design it against a system whose output is still changing. Revisit
when qualification approaches landing.

## Test of compliance

No ruling authorizes a "cutover", "migration", or "launch" of Build 1 as a whole.
If one is ever proposed, this ruling is what it must supersede.

Every module landing cites the ruling that authorized it and the call sites it
reached, per ruling 0010.
