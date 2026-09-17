# 0004 — Commercial model: subscription plus credits

**Date:** 2026-09-17
**Status:** **Provisional.** The owner's best current thinking, stated as
subject to change. Nothing downstream may treat this as settled — no ruling
cites it, and no code should depend on it until it is confirmed.

## The model

A hybrid: a subscription that includes a set number of searches, with additional
credits purchasable beyond the allowance.

## Why this is written down

It existed only in the owner's head. Both AI spaces were reasoning about spend
guard-rails without knowing whether a wasted run costs the company margin or
costs the customer their allowance — and those lead to different products. This
records it so the question stops being invisible.

## What follows from it

### 1. "Credits" is currently a false promise, and this does not fix it yet

`research-panel.tsx:172` and `:201` tell the user a search "spends credits."
There is no credits concept in the schema — searched across all 65 migrations for
credits, quota, balance, plan tier: nothing.

Under this model the word eventually becomes true. It is not true today, and the
gap between now and billing is not short. A nonprofit either rations against a
balance that does not exist, or goes looking for it and finds nothing.

**Recommendation: make the language honest now, in wording that stays honest
later.** The button does cost real money and takes real time; that can be said
without naming a balance that has not been built.

### 2. "A set number of searches" needs *search* to mean one thing

The product currently has two unrelated operations a user would call searching:

- a **discovery search** (`discovery_search_runs`, migration 0020) — one run
  scans a whole channel and returns many candidates;
- a **research run** (`research_runs`, migration 0035) — one run investigates a
  single prospect, and the "gather more intelligence" button starts another one
  on the same prospect.

These differ in cost and in value by a wide margin. An allowance of "50 searches"
means something very different depending on which is being counted, or whether
both are.

This does not block anything today, but it should be settled **before a plan is
priced**, because changing what a customer's allowance buys after they have
bought it is not a change you get to make quietly.

### 3. Metering cannot ship before the dead-end guard does

This is the sharp one.

Today a wasted research run costs the company money. Under this model it costs
**the customer a search from their allowance**. The measured case — one prospect
absorbing five paid runs chasing a document that is not published at that source
at all (ruling 0006) — becomes five searches billed to a nonprofit for a question
that could never be answered.

So the work currently in flight under ruling 0013 is not only a trust fix and not
only margin protection. **It is a precondition for billing by usage at all.**
Charging per search while the product invites searches that cannot succeed is not
a defensible position, and it is the kind of thing a customer notices exactly
once.

### 4. A failed run is not a search, and the schema does not yet say which is which

`research_runs.status` is `researching | extracting | ready | error` (migration
0035) and `completion_state` was added separately (migration 0048). A run can
also be killed by the platform with no status written at all — documented in
`lib/research.ts`, where a follow-up ran 707 seconds against a 280-second ceiling:
the search and the extraction both ran and were both paid for, and nothing was
saved.

So the billing question *did this consume a search?* does not map cleanly onto
any existing column. It needs its own answer, and it is the familiar shape: **a
run happened** and **a run produced something** are different facts, and a meter
that cannot tell them apart will bill for the first while the customer
experienced the second.

## Open, in order of when they must be answered

1. Make the "credits" wording honest. Cheap, and wrong every day it waits.
2. Define what counts as one search. Before pricing.
3. Decide what a failed, empty or platform-killed run consumes. Before metering.

None of these blocks work in flight. All three become expensive after customers
are on a plan.

## Revisit

When the model firms up. If it changes materially, supersede this document
rather than editing it, so the reasoning above stays attached to the version of
the model it was reasoning about.
