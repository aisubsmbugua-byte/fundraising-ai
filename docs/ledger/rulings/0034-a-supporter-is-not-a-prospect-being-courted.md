---
id: 0034
title: A supporter is not a prospect being courted — individual, recurring givers get their own shape, their own ledger, and stewardship scaled to size
status: settled
provenance: verbatim
supersedes:
date: 2026-10-02
---

## The ruling

1. **A supporter is a new, separate concept — not a prospect at a stage.**
   The prospect model (channel, stage, screening, research, strategy,
   proposal) exists to court institutional funders through a multi-step ask.
   An individual giving $20/month from a website signup has already said
   yes; nothing about discovery, screening, or proposal applies. This is the
   opposite case from STATE item 79 (an existing institutional relationship
   still gets courted, just starting further along) — there, extending the
   one model was right because it was genuinely the same kind of thing.
   Here it would force empty, meaningless fields (EIN, typical grant size,
   channel) onto a record that has none of that shape. A supporter is its
   own org-scoped table, with its own minimal fields: name, contact, how
   they arrived (event or website, with a free-text detail), and what they
   committed to giving and how often.

2. **A commitment and an actual gift are two different facts, and must not
   collapse into one.** The supporter record carries the pledge as told
   (amount, frequency) — what the person said. A separate, append-only
   gift-history record carries what was actually received — one row per
   real gift, amount and date, never edited or deleted once logged. If a
   logged gift was wrong, the fix is a correction row, not a silent edit,
   the same posture ruling 0019 takes with a recorded no.

3. **Stewardship care scales with size, operationalized, not just
   displayed.** The owner's own framing: stewardship must be done from
   least to greatest. This is implemented as tiers — a small monthly giver
   gets checked on once a year; a mid-size giver quarterly; a larger giver
   or a substantial one-time gift every three months — each tier a named,
   owner-tunable constant, not a hidden number. The existing Nurture queue
   (item 75) is the right model to extend, not replace: same shape
   (quiet-threshold, stalest first), applied to a population these tiers
   define instead of one fixed number for everyone.

4. **Bulk entry is a first-class path, not an afterthought.** A live event
   or a website form can produce many supporters in one sitting. The
   existing candidate CSV import (`importCandidatesCsv`,
   `app/(dashboard)/discovery/actions.ts`) is the pattern to mirror exactly
   — same required/optional-field contract, same skipped-vs-imported
   counting, so a nonprofit's team already knows this flow when they meet
   it a second time under a different name.

5. **This platform does not move money.** It records what is already known
   to be true (a pledge, a received gift) the same way every other fact in
   this system is recorded — never a charge, a payment-processor
   integration, or anything that touches a card number. Hard rule 5 and the
   platform's own stated boundary (CRM, not a payment system) are unchanged.

## Why

The seven channels and the courtship-stage model are a good fit for the
funders this platform was built to help a nonprofit pursue — each one
individually researched, each one worth real effort. A retail-scale
individual donor is categorically different, and arrived at a decision
space's attention for a reason: there was genuinely nowhere for them to
go. Building that nowhere into "prospects, awkwardly" would have produced
exactly the shape this project's rulings keep naming as the failure to
avoid — a record that is mostly empty fields pretending to be full ones, and
a single number (one quiet-threshold) hiding a spectrum of different needs
within it.

## Test of compliance

A supporter record carries no channel, no stage, no screening result. A
pledge and a received gift are two different rows that can disagree (a
pledge of $20/month with zero gifts logged is a legible, honest state, not
an error). The stewardship queue names which tier a supporter fell into and
why its threshold applied. Deleting or editing a logged gift is refused by
the database, not merely discouraged by the interface.

## Scope

Authorizes item 80: the core schema (an org-scoped supporter record; a
separate, append-only gift-history record keyed to it; a separate
interaction-history record keyed to it, parallel to the existing one
prospects use rather than a shared column on that heavily-used table) with
full tenant isolation and tests; manual add; a list-plus-detail page
reusing the Follow-up page's existing split-pane pattern; gift logging;
interaction logging reusing the shared log-interaction component by
parameterizing it, not duplicating it; the tiered stewardship queue as a
new tab on the Follow-up page. Also authorizes item 81: CSV bulk import,
mirroring `importCandidatesCsv` exactly.

Does not authorize any payment integration, any change to the
prospect/funder model, or any change to existing Nurture queue behavior for
prospects. Names of the new tables themselves are build's choice, reported
and cited with file and line once they exist.
