---
id: 0035
title: A funder's past gifts are a ledger, not a note — the same append-only pattern ruling 0034 gave supporters, extended to the institutional funders a prospect already is
status: settled
provenance: verbatim
supersedes:
date: 2026-10-02
---

## The ruling

1. **A prospect's actual giving history is a separate, append-only record —
   the same pattern ruling 0034 already settled for supporters, not a new
   argument.** `ask_amount` on a prospect is what is being asked for now,
   forward-looking, singular. What a funder — major donor, foundation,
   church, denomination, any channel — has actually given in the past is a
   different fact, and today it has nowhere to live but a free-text notes
   box. A new, parallel historical table closes this, exactly as
   `supporter_gifts` did for supporters: one row per real gift, amount and
   date, never edited or deleted once logged.

2. **This stays a separate table, keyed to prospects, not a shared column
   on `supporter_gifts`.** Same reasoning ruling 0034 clause gave
   `supporter_interactions` over a nullable second foreign key on the
   existing `interactions` table: a prospect and a supporter are genuinely
   different entities, and giving one gift-history table two mutually
   exclusive foreign keys invites exactly the kind of ambiguity this
   project's rulings exist to prevent.

3. **Applies to every prospect, not only the Major Donor channel.** The
   owner's framing named major donors and organizations, and a foundation
   or a church is as capable of having given before as an individual
   major donor is. The table carries no channel restriction.

4. **This is capture, not a new stewardship clock.** This ruling authorizes
   recording and displaying giving history. Whether a prospect's past
   gifts should change the existing Nurture queue's (item 75) quiet
   threshold the way pledge size does for supporters (item 80) is a real,
   related question this ruling deliberately leaves open rather than
   silently deciding — a separate item, if and when wanted.

## Why

The gap was named the moment item 79 shipped: "the giving-history part has
nowhere to live except a notes box... I'd treat it as its own decision."
Item 80 then built exactly this pattern for supporters. The owner has now
asked for the institutional side of the same fact. Building it as a second,
independent re-derivation of the same shape would be slower and riskier
than citing the settled precedent and applying it.

## Test of compliance

A prospect's giving history is a list of dated, amounted rows, never a
single number or a notes paragraph. Deleting or editing a logged gift is
refused by the database. `ask_amount` is unchanged in meaning by this
ruling — it still means what is being asked for now.

## Scope

Authorizes item 83: one additive migration creating the parallel
gift-history table for prospects (append-only: insert and select policies
only, no update, no delete; an org-match trigger on its foreign key,
mirroring `supporter_gifts`'s exact shape in `supabase/migrations/0078_supporters.sql`);
a "Log a gift" action and a giving-history display on the prospect's
Overview tab, beside the existing Opportunity summary card; a server-side
bulk CSV import for backfilling history on existing prospects, mirroring
item 82's exact match-or-error discipline (an identifier that resolves to
exactly one existing prospect, or the row is a named error — never a
guess, never a newly created prospect). Does not authorize any change to
`ask_amount`'s meaning, any change to the Nurture queue's timing logic, or
any change to the supporter model itself.
