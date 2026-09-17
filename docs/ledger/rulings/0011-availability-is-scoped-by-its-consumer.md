---
id: 0011
title: An availability ledger is scoped by the decision that consumes it, and the consumer always names the scope
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

There is no such thing as "the availability ledger for a prospect." A ledger is
always *for a decision* — screening, strategy, or a later consumer — and its key
set is that consumer's required set.

Therefore `deriveAvailability` takes its consumer explicitly. The caller names
`screening` or `strategy`; it does not fall back to a default. A ledger is never
stored and re-read by a different consumer than the one that derived it.

## Why

Open item 3 asked whether defaulting to screening's required set was right, on
the worry that "the ledger a user sees at qualification is narrower than a
strategy run would need."

The narrowness is correct and is not the problem. Step 1 established per-consumer
grading precisely because screening and strategy need different facts: screening
requires `funding.recent_grants` because for the 22% of prospects with no
reachable site, revealed giving is the only evidence of fit there is, while
strategy treats the same key as advisory. Grading all 43 facts against every
decision would resurrect the undifferentiated coverage number that produced the
treadmill.

The defect is the *default*. An optional `keys` parameter that silently resolves
to screening is a consumer choice made by the callee, which is the same move as
a model writing a value the code already knew: the caller holds the fact — which
decision is being made — and the function guesses it. The guess is invisible at
the call site, which is exactly where a reviewer would look to see which
decision's facts are being reported.

It also makes a latent error unreachable by review: a strategy-stage caller that
forgets to pass keys gets a screening ledger that is well-formed, plausible, and
answering a different question. Nothing in the types or the output says so.

## What follows

A fact is `checked_not_stated` *for a consumer*, because which sources were
worth reading depends on which facts were needed. Screening's silence about a
fact strategy never asked for is not a finding about the funder. So a derived
ledger is not a cacheable property of a prospect and must not be persisted as
one; the per-source retrieval outcomes it is derived *from* are the durable
record.

## Test of compliance

`deriveAvailability` has no parameter with a default value. Every call site
reads as a sentence naming its decision.
