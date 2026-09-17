---
id: 0012
title: How a ruling was written and whether it was later confirmed are two facts, recorded separately
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

`provenance` records how a ruling came to be written — `verbatim` if copied from
a written decision, `reconstructed` if rebuilt from a transcript. It is fixed at
the moment of writing and never changes.

**Confirmation is a separate, later act by a different party**, and it is
recorded outside the sealed file, in `rulings/.confirmed.json`, written only by
the decision space. A confirmation entry carries three things:

1. the ruling id,
2. the **verdict**, and
3. **what it was checked against** — a file and symbol, a migration, or a
   transcript quote.

The verdict has three values, never two:

```
unconfirmed  nobody has checked it
confirmed    checked against a named artifact, and it holds
refuted      checked, and it misstates what was decided
```

`ledger-check` warns on `reconstructed` **and** `unconfirmed` together. A
confirmed ruling stops warning. A refuted one fails rather than warns, and is
closed by a superseding ruling — not by editing the original.

## Why

The ledger had one field doing two jobs, so confirming a reconstructed ruling was
impossible without an illegal edit. As of 2026-09-16, rulings 0002, 0003 and 0006
were verified against the code and migrations themselves — `EMPTY_DENOMINATION_REGISTRY`
resolving nothing and `lib/qualification.ts:235` carrying 0002's user-facing
string verbatim; `lib/discovery-handoff.ts` and `0065_discovery_handoff.sql`
carrying 0003's contract and its `handoff_version 0` legacy rule; `lib/availability.ts`
carrying 0006's five states and `OBTAINABLE`. All three keep warning anyway,
because there is nowhere to put the result.

A check that cries wolf gets ignored, and then stops catching the case it was
built for. Two of the five — 0005 and 0007 — are genuinely unverified, and the
warning that matters for them is currently buried in three that do not.

Superseding was considered and rejected. Supersession is the instrument for
*changing* a decision; using it to record that an unchanged decision was verified
would make every `supersedes:` chain ambiguous about whether the earlier ruling
was wrong or merely unchecked.

## The invariant underneath

This is the project's own governing rule applied to the ledger's own machinery.
`provenance` was averaging over two different facts, exactly as "78% coverage"
averaged over a keyword-match rate and "discovery recall 47%" averaged over
never-retrieved and retrieved-then-reduced.

The three-valued verdict is ruling 0006's shape in the same place: `unconfirmed`
and `refuted` are not the same state, and collapsing them would let a ruling
found to be *wrong* sit indistinguishable from one nobody has looked at yet. A
refuted ruling is the more urgent of the two, and a two-valued field would hide
it behind the quieter one.

## Test of compliance

Remove a confirmation entry and the warning must return. Set a verdict to
`refuted` and the check must fail rather than warn. If `--seal` writes or alters
`.confirmed.json`, the separation has been lost — sealing records what a ruling
*says*, confirmation records whether it is *true*, and one command must not do
both.

## Scope

Authorizes `rulings/.confirmed.json`, the `ledger-check` logic that reads it, and
documenting it in `docs/ledger/README.md` alongside the `--seal` escape hatch —
it is the second decision-space-only instrument and belongs next to the first.
Does not authorize changing what `--seal` does, or any existing ruling's text.
