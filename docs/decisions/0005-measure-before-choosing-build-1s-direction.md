# 0005 — Measure Build 1's retrieval before choosing its direction

**Date:** 2026-09-18
**Status:** **Satisfied 2026-09-18**, same day it was written. The measurement
landed; see "Outcome" at the foot of this document. The stopping condition
worked as intended and this objective is spent — it is not carried forward.

## Why this exists

The owner asked what the standing objective was and when the UI would change.
Neither had an answer in the ledger.

`STATE.md`'s `## Authorized now` stated its objective as making
`scripts/ledger-check.ts` name the population beside each count it prints. That
is a true objective for a job and not one for a product. The last product-level
objective — ruling 0013's "close the paid-rerun treadmill for every gap the live
path can honestly decide" — closed as item 27 on 2026-09-17 and nothing replaced
it.

So the ledger held 21 rulings and 17 open items with no stated goal above the
current job. Every job was being judged on its own merits, which is precisely
how a queue fills with defensible work that adds up to no direction. The owner
noticed this before the decision space did, and that is the part worth
recording: this role is supposed to be the one holding the altitude.

## The decision

**Measure Build 1's discovery and shortlist recall before committing to a
direction for Build 1.**

Build 1 is 4 steps into 10. Steps 5–10 all sit on top of retrieval whose recall
has never been measured. With two organizations on the system there is no usage
data, so `docs/reference-set/cases.json` — 12 cases, 60 recorded judgements,
`frozen: true` — is the only evidence that exists about whether any of this
works.

Choosing a direction for Build 1 before taking that number means choosing
between options whose feasibility is unknown. The number is cheap: the discovery
half needs no API key.

## What this means for the queue

- **Item 4 runs now.** `npx tsx scripts/reference-recall.ts --discovery-only`.
- **Item 29 stays authorized but queued.** It is real work under a sealed ruling
  and is not cancelled. It is held because the reason for pausing was too much
  invisible work running at once, and starting a second invisible job in the
  same breath would answer the concern by contradicting it.
- **Item 23 is the next user-visible work** and waits on the outcome.
- **Item 30** — the selection and fetch half — stays blocked on the owner's API
  key, and its absence is itself a limit on what this measurement can conclude.

## What the measurement can and cannot settle

It reports retrieval recall and shortlist recall, separately, and refuses to
blend them — `scripts/reference-recall.ts` carries that constraint in its own
header, written after an earlier "78% coverage" figure turned out to be a
keyword-match rate.

It **cannot** report selection recall, fetch recall, or absence precision. Those
need the model call in item 30. Absence precision is the notable loss: whether
the system claims a find where a human recorded that a funder publishes nothing
has no discovery-only equivalent, and over-claiming an absence is how a user
ends up trusting a qualification resting on nothing.

Discovery recall is nonetheless the right first number, because it is the
ceiling on every stage after it. A fact never retrieved cannot be selected or
read.

## A correction this surfaced

[0003](0003-two-tracks-and-build-1s-landing.md) states that Build 1 "ships
dark — no nav entry, no button any ordinary tenant user sees or can trigger."
**That is no longer true**, verified 2026-09-18 against the code rather than the
document: `app/admin/layout.tsx` does gate `/admin` on `is_superadmin`, but
`app/(dashboard)/prospects/[id]/research-tab.tsx`,
`app/(dashboard)/prospects/[id]/research-panel.tsx` and
`app/(dashboard)/prospects/[id]/research-actions.ts` are ordinary dashboard
routes and all three call `lib/availability.ts`.

This is ruling 0016's module-by-module landing working as intended, not a
violation. 0003 is stale rather than wrong in its reasoning, and is corrected
here rather than rewritten, in the same way ruling 0020 corrected 0016's
examples while leaving its policy standing.

## What would change this decision

The measurement itself. If discovery recall is high, the direction conversation
is about landing Build 1. If it is low, the direction conversation is about
retrieval, and steps 5–10 are built on sand until it improves. Either way the
next decision is made against a number instead of against a preference.

## Outcome — 2026-09-18

**Retrieval recall 31/43 (72%). Shortlist recall 26/43 (60%).** Evidence:
`docs/reviews/0015-discovery-recall-measurement.md`, recorded as item 4.

The framing above — high means land, low means fix retrieval — **turned out to
be the wrong question**, and that is the most useful thing this measurement
produced.

Both numbers are means over a population with no middle. Of the 10 cases
contributing judgements, **8 retrieve 100% of their live ground-truth URLs and
2 retrieve 0%. None is in between.** Over the 41 judgements whose URL still
returned 200 that day, retrieval is 31/41 (76%) and shortlist 26/41 (63%); the
shape is identical either way.

So "72%" does not describe the system's behaviour on any case. Nothing performs
at 72%. It is the ratio of sites that work to sites that do not, wearing the
costume of an accuracy rate — and a direction chosen from it, in either
branch, would have been chosen from a number that describes nothing.

This is ruling 0004's failure — one value averaging two different facts —
inside a report that complied fully with ruling 0021. Naming a denominator does
not make a mean meaningful. Carried as item 33, with the two structural misses
(`pma` cross-subdomain, `eaa` cause not established) and the cap loss (`cma`)
that together account for every judgement lost.

**The direction question is therefore reopened, not answered**, and it is a
narrower question than the one asked: not "is retrieval good enough to land
Build 1" but "what shape of site does retrieval miss entirely, and is that
shape common among real funders?" Two examples and one unexplained cause are
not enough to answer it, and the reference set has 12 cases, of which the two
that record no `stated` facts contributed nothing here (item 32).
