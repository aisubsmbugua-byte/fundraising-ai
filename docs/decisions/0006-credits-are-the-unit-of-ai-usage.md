# 0006 — Commercial model: credits are the unit of all AI usage

**Date:** 2026-09-19
**Status:** **Decided by the owner** (in conversation with the decision
space). Direction, not a ruling: mutable, but downstream work may now build
toward it. **Supersedes decision 0004**, whose reasoning is carried forward
below rather than re-argued.

## The model

Subscription plans that include a **credit allowance**, with additional
credits purchasable. Credits are the single unit of **all** AI usage — not an
overflow mechanism after a search quota, and not a synonym for one feature.

**Credits are priced per operation type, never per token.** A discovery run
costs a fixed number of credits; a research run costs its own fixed number; a
strategy run, a draft, and any future AI operation each carry their own
price. The customer sees stable, predictable per-operation prices; the owner
re-costs the schedule privately as underlying model and fetch costs move. A
credit that tracked raw usage would wobble with page sizes and model changes
— a taxi meter, and small nonprofit teams ration against taxi meters.

Plans include an allowance sized so a typical team rarely thinks about
credits at all. Credits are the accounting truth, not the daily experience.

## Why credits, and why now

- The product already has **four** AI-consuming operations (discovery, the
  research agent, strategy runs, drafting) and a fifth waiting (content-
  informed selection, ruling 0025 clause 4). Under "searches," every new
  operation forces a pricing renegotiation; under credits it gets a price.
- Decision 0004's hardest open question — "what counts as one search?" — is
  **dissolved rather than answered**: "search" stops being a billing word.
  The two operations it conflated simply carry different prices.
- Ruling 0025 gates the church/DAF capability experiment on a settled cost
  of a search. Under this model the gate becomes concrete: the experiment
  raises discovery's credit price from X to Y, and the decision is whether
  that is worth charging.

## What this does not settle

1. **The credit schedule itself.** Pricing each operation requires its
   measured cost. The system already captures token counts on its model
   calls (selection records input and output tokens; research runs
   likewise), so this is measurable, not guessable. Set the schedule from
   measured runs, not estimates — ruling 0021 applies to a price's basis the
   same as to any count.
2. **The failed-run policy.** Recommendation recorded here: a failed, empty
   or platform-killed run costs the customer nothing. That policy is only
   *possible* once every run is recorded — see the prerequisite below.

## The prerequisite: a run ledger

Nothing can be metered that is not recorded. Before any billing: every AI
operation is recorded with what it was, which organization ran it, when,
what it consumed (model, tokens in and out), and how it ended — completed,
failed, empty, or killed by the platform. Decision 0004 §4 documented the
gap: a run's outcome does not map onto any existing column, and a
platform-killed run writes nothing at all. Under a credit system that gap is
not an accounting nuisance, it is the difference between honoring "that run
failed, refund my credits" and having no record to check.

The familiar shape, stated once more so the build inherits it: **a run
happened** and **a run produced something** are different facts. The ledger
records both, separately. The absence of a record means the run did not
happen — the same absence-encoding migration 0066 uses for dispositions.

This is a new org-scoped table and therefore hard-rule-6 territory; it needs
a ruling before code (STATE item 47).

## Carried forward from 0004, still binding on this model

- **The dead-end guard precondition (0004 §3).** Charging credits while the
  product invites runs that cannot succeed is not defensible. Ruling 0013's
  treadmill work remains a precondition for metering, not just margin
  protection.
- **Honest wording until balances exist (0004 §1).** The live string — "it
  costs real money and takes several minutes" — is true under this model
  too, and stays until a real balance is displayable.

## Open, in order

1. Ruling + build for the run ledger (item 47). Before any metering.
2. Measure per-operation costs from recorded runs; set the credit schedule.
3. Then, and only then, the ruling-0025-clause-4 experiment can be priced.

## Revisit

If the model changes materially, supersede this document rather than editing
it.
