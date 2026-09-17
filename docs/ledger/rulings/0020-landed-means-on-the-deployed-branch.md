---
id: 0020
title: Landed means on the deployed branch, a landing merges in the same piece of work, and only an additive migration may run ahead of its code
status: settled
provenance: verbatim
supersedes:
date: 2026-09-17
---

## The ruling

**1. "Landed" means present on the deployed branch.** A module wired into call
sites on an unmerged branch has not landed. It is `tested` under ruling 0015, not
`released`, and no ruling may describe it as live.

**2. A landing merges in the same piece of work that performs it.** Ruling 0016
removed the cutover from the code; this removes it from the branch. A module
proven correct is merged when it is wired, not accumulated for a later merge.

**3. A migration may be applied to the live database ahead of its code only if
it is additive**, meaning all of:

- adds a table, column, index, constraint or enum value, and drops, renames or
  re-types nothing;
- every new column is nullable or carries a default;
- every new constraint is satisfied by all existing rows;
- no existing column changes meaning.

A migration that fails any clause is not applied until its code is on the
deployed branch. The declaration is checked statically, not trusted — a file
claiming to be additive while containing `drop column`, `rename`, `alter column
… type`, or a `not null` without `default` fails the check.

## Why

The `build-1-qualification` branch carries 7 commits and 3 migrations
(`0063`–`0065`) that are **already applied to the live database**, while `main` —
the deployed branch — has none of the code.

Two things follow, and the second is the serious one.

**The current state is safe, and by property rather than luck.** Verified
2026-09-17: every new column in 0063, 0064 and 0065 is `not null default <value>`,
every new check constraint bounds only a new column, and `qualification_stages`
is a new table. Nothing deployed can break on any of it. Clause 3 exists to make
that property required rather than incidental — the next migration is one
`not null` without a default away from taking the deployed app down, and nothing
currently checks.

**Nothing has actually shipped.** `lib/discovery-handoff.ts` does not exist on
`main`; `main`'s `discovery/actions.ts` does not import it. Ruling 0016 asserts
that module "went live under ruling 0003 and has a dashboard caller today," and
that its availability counterpart is landing under 0009. Neither is on the
deployed branch. Both are wired into code on a branch nobody is running.

So ruling 0016's **policy stands** — module-by-module, no cutover, each gated by
a ruling — and its **two cited examples were wrong**. It is corrected here rather
than superseded, because the decision it records is right and only its evidence
was false.

## This is ruling 0010 one level further out

0010 was written because Step 4 shipped a module with no callers: the invariant
held in a test and nowhere a user could reach. This is the same defect with the
callers present and the *branch* unreachable — code that is correct, wired, and
running for no one.

0010's compliance test (grep for callers) passes in both cases, which is exactly
why it needed extending. A caller on an unmerged branch is not a caller in the
product.

### And the same error shape as ruling 0018

The claim "it landed" was made in the decision space from a search of the working
tree, without checking `main` — a fact inferred from a proxy rather than read
from the artifact. 0018 was written three rulings earlier, against subagents, on
the same shape. Recording it here because a rule that only ever catches somebody
else is not being applied.

## Test of compliance

`git diff --name-only main...HEAD -- supabase/migrations/` lists every migration
ahead of the deployed branch. Each must pass the additive check.

Any claim that a module is live is verified against `main`, not the working tree.

Branch drift is bounded by clause 2 rather than by a time limit: a long-lived
branch means a landing happened without merging, which is itself the violation.

## Scope

Authorizes the additive-migration check in `scripts/ledger-check.ts` — folded
into the tooling job already queued as item 24, not a separate piece of work.
Does not authorize merging the branch, which remains a decision-space call
(item 6), and does not change what is governed.
