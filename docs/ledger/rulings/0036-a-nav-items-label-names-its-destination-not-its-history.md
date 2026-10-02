---
id: 0036
title: A nav item's label and icon name what is at its destination now, not what was there when it was first built
status: settled
provenance: verbatim
supersedes:
date: 2026-10-02
---

## The ruling

A sidebar nav item's label and icon are a claim about what currently lives
at its destination route. That claim is checked against the route's actual
content at the time the nav item is built — and nowhere else, after that,
unless something revisits it. A route's content keeps changing (CLAUDE.md's
"vertical slices" build order guarantees it); the label pointing at it does
not update itself. So whenever a route gains content substantial enough to
change what a user would call it, the nav item naming that route is
reconsidered for whether its label and icon still describe it — this is not
deferred to a dedicated design pass, the same standing instruction CLAUDE.md
already gives for spacing, color, and alignment.

This generalizes past the one case that surfaced it: it is not "rename Home
to Dashboard" but "a nav label is revisited whenever its destination's
content changes enough to make the existing label misleading" — true for
every nav item, not only the one renamed today.

## Why

`/dashboard`'s nav entry was labeled "Home" and iconed with a house from the
page's very first build. Item 85 added real aggregate numbers to that page
(a Supporters count and a forecast total) — and the owner could not find
them, not because the numbers were missing, but because the nav item never
said "Dashboard" anywhere a user would look for one. The page's purpose had
measurably grown; the four-character label describing it had not moved with
it. The failure is not specific to this one label — any nav item whose
destination accumulates meaning over slices is exposed to the identical gap.

## Test of compliance

If the justification for a change can only be written by naming the single
feature just shipped ("add Dashboard because of the Supporters numbers"),
restate it as the general rule first ("a nav label is revisited when its
destination's content changes enough to mislead") and show the one case is
an instance of that, not the whole of it.

## Worked examples

- Not a ruling: "Home should say Dashboard now."
- A ruling: "A nav item's label and icon are revisited whenever its
  destination route's content changes enough that the existing label would
  mislead a user about what they'll find there — checked at build time, not
  assumed to hold indefinitely from when the nav item was first written."
