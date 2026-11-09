---
id: 0046
title: The funder reference load covers every state, runs unattended on the owner's server, and is complete when its sample has no unexplained mismatch
status: settled
provenance: verbatim
supersedes:
date: 2026-11-09
---

## The ruling

Ruling 0045 authorized the funder reference database and bounded its pilot to
California. The pilot is loaded in production. The owner has asked that the rest
of the country be loaded without a person at the keyboard, on a small rented
server (an AWS Lightsail instance, the owner's), and has said the verification
need not match every value perfectly as long as the load can be stated with
confidence. Five things hold. Everything in ruling 0045 stays in force exactly
as written; this ruling widens its scope and says how the work is run and when a
state counts as done.

1. **Scope: every US state and territory that appears in the IRS filings.** The
   same three-tax-year window (rolling forward as the IRS publishes later years),
   the same size threshold the owner set (at least $1 million in assets or at
   least $100,000 in yearly giving), the same tables, and no new table. A state is
   loaded as a unit. The data stays shared reference data with no
   `organization_id`, written only by the offline loader with a service key, never
   by the application (0045 clause 1).

2. **Where it runs, and with what key.** The loader may run on a server the owner
   controls, started by a schedule or by hand, never from a web request. It holds
   one dedicated, revocable service key created for the loader alone, kept in a
   file only the loader's account can read; the application's own key is never
   placed there, and no key is written to a repository, a log, a run record or a
   chat. The server holds public IRS files and that key and nothing belonging to
   any organization.

3. **A state is complete only when four things are recorded on its run.** The run
   finished; the run's outcome counts sum to the returns it considered; the header
   audit found no return in the state that the header had put elsewhere; and a
   verified sample has no UNEXPLAINED mismatch. The sample is drawn by a fixed
   seeded rule, covers a stated number of funders per state, and always includes
   the funders with the most grants and the most people, because those are the
   ones a paging or size fault reaches first. A mismatch is explained only when its
   cause is named in a written exception list kept with the loader; anything else
   is unexplained. An unexplained mismatch halts that state and every later state,
   leaves the state's rows in place but recorded as not verified, and is shown
   where the run status is shown. Zero mismatches of any kind is not required:
   explained and recorded is.

4. **A full re-verification is required when the code that reads or stores a value
   changes**, and for each state the first time it is loaded after such a change;
   a sample is enough otherwise. A verifier fault found later (as on 2026-11-09,
   when a live database's 1,000-row response cap made the verifier report false
   mismatches) is corrected in the verifier, recorded on the item, and the affected
   funders are verified again before the load is called verified.

5. **Refresh and visibility.** A monthly refresh reads only IRS archives not yet
   read, follows every rule above, never deletes, and records what it superseded.
   A failed, killed or stalled run is never silent: each run and each state's
   status is written to the run table as it goes, so the last thing the loader did
   is readable from the database without the server. The loader sends nothing to
   anyone.

## Why

The owner's aim is a funder database covering the country that is cheap to keep
current. Doing that by hand, a state at a time with a person typing answers, does
not scale, and the cloud container the first attempt used was too small. What must
not change is the thing ruling 0045 protects: every stored value traces to a
filing, a gap is recorded and not filled in, and nothing here decides or sends.
Requiring perfect agreement everywhere would make the work stop for causes that
carry no risk and would not catch a real fault any sooner than a well-drawn sample;
requiring every mismatch to be explained keeps the guarantee that matters, which is
that nothing unknown is left in the data.

## Test of compliance

Load a second state: no table other than the existing reference tables gains a
row, no `organization_id` appears, and the application role still cannot write
them. Read the server's configuration: only the loader's own key is present, in a
file other accounts cannot read. Kill the loader mid-state: the run table shows the
state as started and not finished, and the next start resumes it and writes no
duplicate. Feed the sample an unexplained mismatch: the state is marked not
verified and the run stops before the next state. Feed it an explained one: the run
continues and the exception is listed on the run. Re-run a complete state: zero
rows written.

## Scope

Authorizes item 114: the all-states command, the memory fix that lets the loader
run in a bounded amount of memory, the server setup script and schedule, and the
status record, for the shared reference tables of ruling 0045. Does not authorize
any screen that reads the data (item 113), any use of it in matching, discovery,
scoring or the way-in feature, any web or person enrichment, any write to these
tables from the application, or any change to ruling 0045's seven clauses.
