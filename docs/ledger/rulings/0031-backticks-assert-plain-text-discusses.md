---
id: 0031
title: Backticks assert, plain text discusses — the citation vocabulary, and the exemption a sealed error requires
status: settled
provenance: verbatim
supersedes:
date: 2026-09-21
---

## The ruling

1. **In every document under docs/, backticks assert existence.** A
   backticked token that looks like a path, a table, or a checkable symbol
   is a claim that the artifact exists right now, and the check may fail
   the run when it does not. Writing about something absent, planned,
   hypothetical, or merely named — a package, a URL, a provider id, a
   failure example — uses plain text. This has been the working convention
   since build discovered it; it is now the rule.

2. **The check's checkable vocabulary grows to table names.** The
   migrations define the table set; a backticked identifier matching
   `[a-z_]+` that names no table and no file is checked against that set
   where it is unambiguous. Symbol checking stays OFF: measured noise (19
   misses, most legitimately planned-not-present) says the vocabulary
   cannot yet carry it.

3. **A sealed document's own violation is exempted, not fixed.** Ruling
   0018 contains, in its table of wrong claims, a table name with no table
   behind it — immutable by its own seal. The check's baseline carries an
   `exempted` entry naming the file, the token, the reason and the date.
   An exemption is only for content inside sealed rulings; everything
   else gets corrected instead.

4. **Hex looks like many things.** A hex run in a `released` row is read
   as a commit only when the row offers it as one; provider ids, UUIDs
   and hashes that are not commits stay out of released rows or appear in
   prose that cannot parse as a citation (the cheap form: don't write the
   hex). The mechanical shape is build's choice within clause 1's
   principle: the check must not read a quoted value as an asserted
   commit.

## Why

Four live instances, three of them this ruling's absence taxing real work:
a case-and-fact pair, two package names, and tonight a Resend message id
in a released row parsed as a commit and failing the run after it was
already pushed. Each cost a correction commit. The convention that
resolves them has existed since build wrote six bad paths without
backticks so its own report would pass — the cost of leaving it informal
is no longer hypothetical, item 28 said so on 2026-09-18, and it kept
being right.

## Test of compliance

Backtick a path that does not exist: the check fails. Write the same
token in plain text as discussion: it passes. Backtick a known table:
passes; a nonexistent one: fails, except the one exempted, dated entry.
A released row citing its commit still verifies ancestry; a released row
describing a provider id in prose does not trip the commit check.

## Scope

Authorizes item 61 in scripts/ledger-check.ts and its test file: the
table-name check per clause 2 with the migrations as its population
(named in the summary per ruling 0021), the `exempted` baseline schema
per clause 3 with the single 0018 entry, and the clause-4 adjustment to
commit parsing in released rows. Nothing else changes; no document is
retroactively edited beyond corrections already made.
