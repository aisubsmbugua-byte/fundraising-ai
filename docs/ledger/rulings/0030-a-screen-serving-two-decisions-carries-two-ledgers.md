---
id: 0030
title: The Research tab serves screening and strategy both, and carries a ledger for each — a second consumer gets a second ledger, not a widened first
status: settled
provenance: verbatim
supersedes:
date: 2026-09-21
---

## The ruling

The Research tab's dossier serves two decisions: screening a funder, and
planning the approach to it. Under ruling 0011 availability is scoped by its
consumer, so the tab carries **two ledgers side by side** — the existing
screening ledger unchanged, and a strategy ledger over strategy's required
set, including the 8 keys screening does not need (accepts_unsolicited,
deadline, invitation_mechanism, fiscal_sponsorship_rules, grant_size_range,
median_grant_size, international_reach, total_assets). Every strategy-needed
fact is displayed with its availability reason per ruling 0017. Neither
consumer's `keys` set is edited to serve the other — a second consumer gets
a second call, never a widened first (that widening is how one number ends
up serving two facts).

## Why

Item 26: the tab named screening as its consumer because ruling 0011 forbids
a default and a call had to be made. But the same dossier is the input a
human reads before approving a strategy, and under ruling 0017 the 8
strategy-only facts currently appear with no reason for their absence. With
strategy live and testers arriving, the person approving a strategy is owed
the same visible honesty about what is and is not known as the person
screening. Deciding which decision a screen serves is direction; the answer
is: both, explicitly, one ledger each.

## Test of compliance

On a prospect's Research tab, each of the 8 strategy-only keys is visible
with a stated availability and reason. The screening ledger renders
byte-identically to before. `deriveAvailability` is called with two distinct
`keys` sets; no call site's set grew to cover the other consumer.

## Scope

Authorizes item 53: the second ledger on the Research tab (display only —
`availabilityForResearchRun`-style wiring for the strategy consumer per
ruling 0011's existing pattern), shared UI tokens, tests updated. Does not
authorize changing either consumer's required set, the availability engine,
or any other screen.
