---
id: 0026
title: A run is recorded before it runs, and how it ended is a second fact — no metering, and no run, without a record
status: settled
provenance: verbatim
supersedes:
date: 2026-09-19
---

## The ruling

1. **Every AI operation writes a run record, and the record is born BEFORE
   the model is called.** The record carries: which operation, which
   organization, when it started, and — once known — which model, tokens in
   and out, and how it ended. An operation that cannot first write its record
   does not run.

2. **"A run happened" and "a run ended" are two facts, written separately.**
   The birth row is written at start; the terminal outcome — completed,
   failed, empty — is written at the end by the code that observed it. A run
   the platform kills writes nothing at its death, and that is precisely why
   the birth row must already exist: a record with no terminal outcome past
   its operation's deadline IS the evidence of a killed run. Absence of a
   record means the run never started; nothing may infer a run from any
   other table.

3. **Consumption is captured, not estimated.** Token counts and model name
   come from the API response the operation actually received (the SDK
   reports them), never recomputed or guessed. A run whose response never
   arrived records that it has no consumption figures — which is a fact, not
   a zero.

4. **Run records are retained like outcomes.** Org-scoped under hard rule 6
   (organization_id, RLS, org-match trigger where a foreign key crosses
   tables), no delete policy, and updates only from unfinalized to terminal —
   a terminal outcome is written once. The isolation test extends to the new
   table, per CLAUDE.md: nothing else catches a table that skips this.

5. **Existing run tables are wrapped, not rewritten.** discovery_search_runs
   and research_runs keep their shapes (ruling 0020: migrations are
   additive); the new table is the unified ledger, and an operation that has
   its own table records its row's id in the ledger record so the two views
   of one run stay joinable. No existing column moves.

## Why

Decision 0006 sets the commercial model: credits as the unit of all AI
usage, priced per operation, with the recorded recommendation that a failed,
empty or platform-killed run costs the customer nothing. None of that is
possible against the current schema: decision 0004 §4 documented a run whose
search and extraction both ran and were both paid for — 707 seconds against
a 280-second ceiling — and nothing was saved. A meter that cannot tell "ran
and produced nothing" from "never ran" will bill for the first while the
customer experienced the second: the project's governing defect, arriving on
an invoice.

The birth-before-work order in clause 1 is the load-bearing choice. Any
record written at the end survives only when the operation does; the runs
this ledger most needs to see are exactly the ones that never reach their
own end. The pattern is migration 0066's, inverted to fit the fact being
encoded: there, absence of a row is the safe state ("undecided"); here,
absence of a terminal outcome on a born row is the honest state
("interrupted, and known to be").

Beyond billing, this is what lets the owner watch the first paying testers
actually use the product — which operations, how often, at what cost —
without which the credit schedule item 25 now waits on would be set from
guesses, against ruling 0021.

## Test of compliance

For any model call reachable in the live product, a reader can point to the
run record it writes and answer: where is the row born before the call, and
where is its terminal outcome written? A model call with no ledger write
before it fails this ruling. For any run row: its organization, operation
and start are present at birth; consumption and outcome appear only from
the code that observed them.

## Scope

Authorizes item 48: one additive migration (0067) creating the run-ledger
table with RLS, org-match enforcement and no delete policy; one server-side
helper that owns birth and finalization; instrumentation of every live
model-calling operation (build enumerates them from the code and reports
the list with its command — currently at least: discovery search,
channel-fit, research, strategy, drafting, revisit); extension of
scripts/test-tenant-isolation.ts; a standalone test for the ledger's own
guarantees. The migration is applied by the owner — SQL delivered per the
standing preference.

Does not authorize: any billing or metering logic, any credit balance, any
UI beyond what testing requires, any change to what the operations
themselves do, or touching lib/tier2 (its selection instrumentation lands
when tier2 does). Dark-pipeline operations record nothing yet.
