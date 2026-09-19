# 0017 — The tenant-isolation harness stops leaking into the live database

Item 36, under the 2026-09-18 extension of `## Authorized now` (ruling 0019, item
23). Build space. 2026-09-18.

Invariant implemented, stated without naming any specific org or user: **a test
harness that writes to a live database owns its own test identity end to end —
it removes that identity before creating it, removes it again however the run
ends, and fails loudly if either removal did not take.**

Everything below is one file: `scripts/test-tenant-isolation.ts`. No `app/`, no
`lib/`, no migration, no production code path.

## What changed, by file and line

Line numbers are the post-change file.

| lines | change |
|---|---|
| 12–36 | Header comment rewritten. The old text claimed "safe to re-run" and then, four lines later, told the reader how to clean up by hand when it was not. It now states the two mechanisms that make re-running true (idempotent setup, teardown wrapping creation), states that teardown failure is loud and exits non-zero, and states the deletion scoping rule. |
| 54–61 | `ORG_A_NAME`, `ORG_B_NAME`, `TEST_ORG_NAMES`, `TEST_EMAILS` — the entire test identity as four literals, so every delete can be scoped to them by equality. `main` now passes `ORG_A_NAME`/`ORG_B_NAME` into `createTestOrgAndUser` instead of repeating the strings. |
| 83–97 | `findTestAuthUsers` — paginated `listUsers`, keeping only users whose email is exactly one of the two test addresses. |
| 99–107 | `findTestOrgIds` — `organizations` filtered with `.in("name", TEST_ORG_NAMES)` (exact equality, never `like`/`ilike`), then filtered again in TypeScript against the same two literals. Returns a list, not a pair: a run that died between the org insert and the user insert leaves an extra "Isolation Test Org A" behind, and there were four such rows on the live database when this work started. |
| 109–203 | `purgeTestIdentities(phase)` — the whole of both setup healing and teardown. Refuses to proceed if any matched org contains a profile whose email is not a test email; deletes children before parents (prospects in the test orgs → profiles in the test orgs → the test auth users → the orgs); collects a problem string per failed step; **re-queries orgs, auth users and profiles afterwards** and adds a problem for anything still standing; prints every problem as `CLEANUP PROBLEM: …` and prints one line saying what it removed. |
| 219–227 | `main` opens with `purgeTestIdentities("pre-run")` and throws if it returns problems — it will not run assertions against a database it could not clean. |
| 228–234 | `let cleanupProblems`, then the `try`, and **`createTestOrgAndUser` for both orgs moved inside it**. This is the defect: before, both creations sat above the `try` at old lines 69–70, so a failure during creation skipped the `finally` entirely. |
| 559–567 | The `finally` is now one line: `cleanupProblems = await purgeTestIdentities("teardown")`. The previous four-statement teardown (delete profiles by captured id, delete both users, delete both orgs) is gone, along with the by-id prospect delete that used to sit at the end of the `try`. Deleting by identity rather than by captured id is precisely what lets the teardown cover a setup that failed before returning any ids. |
| 569–579 | After the summary line, a non-empty `cleanupProblems` prints an explanation and exits 1 **regardless of the assertion result**; a clean teardown prints `Teardown verified: no test organization, profile or auth user remains.` |
| 582–589 | `main().catch` now also prints `Run aborted. Of the assertions that executed before the abort: N passed, M failed.` "Aborted after 17" and "ran everything, 17 passed" are different facts and were previously indistinguishable from the output. |

No assertion was added, removed, reworded or weakened. `git diff` on this file
also carries item 23's 93 lines of ruling-0019 assertions, which were already in
the working tree when this job started and are not part of this change.

## Why the old code leaked, verified rather than assumed

- `profiles.organization_id references organizations (id)` with no cascade
  (`supabase/migrations/0032_multi_tenant_foundation.sql:30`), and
  `prospects.organization_id references organizations (id)`
  (`supabase/migrations/0033_multi_tenant_rls.sql:18`) likewise. A surviving
  profile or prospect makes the organization delete fail.
- `prospects.owner_id references auth.users (id)`
  (`supabase/migrations/0001_prospects.sql:22`), and the same shape on
  `research_runs.created_by` (`0035_research_agent.sql:49`),
  `research_expected_facts.authored_by` (`:173`),
  `research_eval_reviews.reviewed_by` (`:203`) and
  `prospect_outcomes.recorded_by` (`0066_prospect_outcomes.sql:55`). A surviving
  research row makes the auth-user delete fail.
- The old teardown ignored every one of those return values, so both failures
  were invisible.

That is not theory. The live database at the start of this job held **four**
organizations named as test orgs (created 2026-09-18 at 23:36:54, 23:36:55,
23:45:10 and 23:47:37), **two** leftover auth users, and **two** leftover
prospects with their research rows — beside the project's two real
organizations, Village Worship Initiative and Tunde Aviation, which were
untouched throughout. The 23:36 pair is the run item 36 describes as passing
nine assertions and leaving its user behind; 23:45 and 23:47 are two later runs
that died on the duplicate email *after* inserting another org each, which is
the self-blocking behaviour compounding itself.

## Scoping of the deletions

Everything deleted is reached from four literals: two org names and two email
addresses, matched by equality. Concretely:

- orgs: `.in("name", ["Isolation Test Org A", "Isolation Test Org B"])`, then
  re-checked in TypeScript against the same array.
- auth users: `listUsers` walked page by page, keeping `u.email` exactly equal
  to one of the two `@fundraising-ai-test.local` addresses.
- profiles and prospects: `.in("organization_id", <those org ids>)` — never by
  name, never by a `[test]` prefix, never by a pattern.
- everything else: reached only by `on delete cascade` from those prospects.

One extra guard that is not strictly needed today: if a matched org contains a
profile whose email is not a test email, `purgeTestIdentities` throws and
deletes nothing. The org-name match alone would be enough to delete a real
organization if someone ever named one identically; this makes that impossible
without a second coincidence.

## Both runs, consecutive, no manual SQL between them

### Run 1

```
[pre-run] nothing to remove -- no test org, profile or auth user present.
Seeded one row per table (seven total) under Org A.

PASS: Org B cannot SELECT Org A's research_runs row by id
PASS: Org B cannot SELECT Org A's research_claims row by id
PASS: Org B cannot SELECT Org A's research_expected_facts row by id
PASS: Org B cannot SELECT Org A's research_eval_reviews row by id
PASS: Org B cannot SELECT Org A's research_sources row by id
PASS: Org B cannot SELECT Org A's research_claim_sources row by id
PASS: Org B cannot SELECT Org A's research_evidence row by id
PASS: Org B cannot SELECT Org A's research_claim_verifications row by id
PASS: Org B cannot INSERT a research_claims row against Org A's run (org-match trigger)
PASS: Org B cannot INSERT a research_eval_reviews row against Org A's run (org-match trigger)
PASS: Org B cannot INSERT a research_claim_sources row citing Org A's source (org-match trigger)
PASS: Org B cannot INSERT a research_claim_sources row against its own run pointing at Org A's claim (org-match trigger)
PASS: Org B cannot INSERT a research_evidence row against its own run pointing at Org A's source (source-run-match trigger)
PASS: Org B cannot INSERT a research_claim_verifications row against its own run pointing at Org A's claim (claim-run-match trigger)
PASS: Org B's UPDATE on Org A's research_runs row affects 0 rows
PASS: research_sources has no update policy -- even Org A's own UPDATE on its own row affects 0 rows
PASS: research_evidence has no update policy -- even Org A's own UPDATE on its own row affects 0 rows
[teardown] removed 2 test org(s), 2 test auth user(s), 2 prospect(s) in those orgs (cascade covers their research and outcome rows).
FAILED: Error: Org A prospect_outcomes insert failed: Could not find the table 'public.prospect_outcomes' in the schema cache
    at main (/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai/scripts/test-tenant-isolation.ts:468:43)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
Run aborted. Of the assertions that executed before the abort: 17 passed, 0 failed.
RUN1_EXIT=1
```

### Run 2 — issued immediately after, nothing else touched the database

```
[pre-run] nothing to remove -- no test org, profile or auth user present.
Seeded one row per table (seven total) under Org A.

PASS: Org B cannot SELECT Org A's research_runs row by id
PASS: Org B cannot SELECT Org A's research_claims row by id
PASS: Org B cannot SELECT Org A's research_expected_facts row by id
PASS: Org B cannot SELECT Org A's research_eval_reviews row by id
PASS: Org B cannot SELECT Org A's research_sources row by id
PASS: Org B cannot SELECT Org A's research_claim_sources row by id
PASS: Org B cannot SELECT Org A's research_evidence row by id
PASS: Org B cannot SELECT Org A's research_claim_verifications row by id
PASS: Org B cannot INSERT a research_claims row against Org A's run (org-match trigger)
PASS: Org B cannot INSERT a research_eval_reviews row against Org A's run (org-match trigger)
PASS: Org B cannot INSERT a research_claim_sources row citing Org A's source (org-match trigger)
PASS: Org B cannot INSERT a research_claim_sources row against its own run pointing at Org A's claim (org-match trigger)
PASS: Org B cannot INSERT a research_evidence row against its own run pointing at Org A's source (source-run-match trigger)
PASS: Org B cannot INSERT a research_claim_verifications row against its own run pointing at Org A's claim (claim-run-match trigger)
PASS: Org B's UPDATE on Org A's research_runs row affects 0 rows
PASS: research_sources has no update policy -- even Org A's own UPDATE on its own row affects 0 rows
PASS: research_evidence has no update policy -- even Org A's own UPDATE on its own row affects 0 rows
[teardown] removed 2 test org(s), 2 test auth user(s), 2 prospect(s) in those orgs (cascade covers their research and outcome rows).
FAILED: Error: Org A prospect_outcomes insert failed: Could not find the table 'public.prospect_outcomes' in the schema cache
    at main (/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai/scripts/test-tenant-isolation.ts:468:43)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
Run aborted. Of the assertions that executed before the abort: 17 passed, 0 failed.
RUN2_EXIT=1
```

The two outputs are identical, which is the point: run 2's `[pre-run] nothing to
remove` is the evidence that run 1 left nothing, and run 2 starting at all is
the evidence that the self-blocking behaviour is gone. Both runs abort at the
same place for a reason that has nothing to do with the leak — see the finding
below.

### The heal case, separately

The first execution of the fixed script — before the pair above, on the dirty
database described earlier — opened with:

```
[pre-run] removed 4 test org(s), 2 test auth user(s), 2 prospect(s) in those orgs (cascade covers their research and outcome rows).
```

and then ran the same 17 assertions. Under the committed version that same
database state produced, with no assertion executing at all:

```
FAILED: Error: Failed to create user isolation-test-a@fundraising-ai-test.local: A user with this email address has already been registered
    at createTestOrgAndUser (.../scripts/test-tenant-isolation.ts:60:41)
    at async main (.../scripts/test-tenant-isolation.ts:71:13)
```

So the before/after on the identical database state is: 0 assertions and one
more leaked org, versus 17 assertions and a clean database.

## Counts, each naming the set it ranged over

- **17 passed, 0 failed** — over the assertions that executed before the abort,
  i.e. the 17 covering the seven Build 1 research tables plus
  `research_claim_verifications`. Same in both runs.
- **9 assertions did not execute** — the 8 ruling-0019 ones (`prospect_outcomes`
  and `prospect_outcome_dispositions`, at file lines 479, 485, 492, 504, 515,
  527, 537, 543) plus the symmetry check at line 557, which sits after them.
  Counted by `grep -c "^\s*check(" scripts/test-tenant-isolation.ts` and reading
  the line numbers, not from the output, since they produced none.
- **26 `check(` calls exist in the file in total** (17 executed + 9 not).
  Minor discrepancy worth recording rather than smoothing over: item 23's row
  in `STATE.md` says it added "10 new assertions", but the committed version at
  `HEAD` has **18** `check(` calls and the working tree has **26**, so the item
  23 diff added **8** — exactly the outcome block, and exactly the 8 that cannot
  run. `research_claim_verifications` was already asserted at `HEAD` (5
  occurrences there), so those two checks are not new. Counted with
  `git show HEAD:scripts/test-tenant-isolation.ts | grep -c "^\s*check("`.
- **Exit code 1 on both runs**, driven by the abort, not by a failed assertion
  and not by a cleanup problem. `CLEANUP PROBLEM` appeared zero times across
  both runs.

## The finding: migration 0066 is not on the live database

The job pointer states that 0066 has been applied and that `prospect_outcomes`
and `prospect_outcome_dispositions` now exist. Against the live project they do
not. Three independent probes, all run today with the service-role key:

1. The insert in the harness itself:
   `PGRST205 — Could not find the table 'public.prospect_outcomes' in the schema
   cache`, with the hint `Perhaps you meant the table 'public.prospects'`.
2. `select id from prospect_outcome_dispositions limit 1` → the same `PGRST205`.
   `select id from qualification_stages limit 1` (migration 0064) → OK, so this
   is not a general staleness in everything recent.
3. `GET /rest/v1/` — PostgREST's own schema document — exposes **29** table
   definitions. Filtering them for `prospect` yields exactly `prospects`;
   filtering for `qualification|discovery|outcome` yields
   `discovery_search_runs, qualification_stages` and nothing else. 29 is the
   pre-0066 table count recorded in item 28.

I did not apply it: migrations are user-applied on this project, and the SQL
already exists at `supabase/migrations/0066_prospect_outcomes.sql` from item 23.
What I cannot distinguish from outside the database is "never applied" versus
"applied and PostgREST's schema cache never reloaded" — I have no direct
Postgres connection (`.env.local` holds no `DATABASE_URL`, checked by listing
its variable names) and therefore no way to run `notify pgrst, 'reload schema'`
or to read `information_schema`. Probe 2 makes staleness unlikely, since 0064's
table is visible, but it does not make it impossible. **Item 23 cannot reach
`tested` until this resolves, and the 10 ruling-0019 assertions remain unrun.**

This is a finding, not something I adjusted around. No assertion was relaxed to
get past it.

## Confirmation that no rows remain

Queried after run 2, with the service-role client:

- `organizations`: 2 rows — `Village Worship Initiative` and `Tunde Aviation`,
  both created 2026-08-23. **0** named as a test org.
- `profiles`: 2 rows — `kanjii@kijijiagency.com`, `bfolayan17@gmail.com`. **0**
  with a test email.
- auth users: **6** total, **0** with a test email. It was 8 before this work;
  the two removed are exactly the two leaked test accounts.
- `prospects`: **32** rows, **0** whose name begins with `[test]`. The same
  probe read 32 before the two runs, so no real prospect was removed. The
  `[test]` prefix was used here only as a *read-only* probe; nothing is ever
  deleted by name.
- Research tables, whole-table counts across all orgs, as a check that nothing
  real was cascaded away: `research_runs` 56, `research_claims` 1671,
  `research_sources` 1077, `research_evidence` 2483, `research_claim_sources`
  2756, `research_eval_reviews` 2, `research_expected_facts` 0,
  `research_claim_verifications` 253.

Method, stated plainly: this was a temporary read-only script under `scripts/`
using the same service-role client, run after the two runs and **deleted
afterwards** — it is not part of the tree. It is reproducible from the
description above in a few lines. The harness also checks a narrower version of
the same thing internally, by re-querying after its own deletes.

## The rest of the suite, and the build

Run today with `npx tsx --env-file=.env.local <file>`, over the 16 files matching
`scripts/test-*.ts` other than `test-tenant-isolation.ts` itself:

`test-prospect-outcomes` 121, `test-availability` 65, `test-prospect-workflow`
23, `test-candidate-attestation` 19, `test-candidate-intake` 16,
`test-citation-consistency` 7, `test-decision-contract` 69,
`test-discovery-handoff` 31, `test-entity-scoring` 71, `test-entity-validation`
140, `test-identity-predicate` 28, `test-legitimacy` 78, `test-tier2-manifest`
70, `test-tier2-selection` 43 — **781 passed, 0 failed** summed over those 14
files. `test-research-concurrency` reports no count line; counted from its
output, 1 `PASS` and 0 `FAIL`. `test-ledger-check` uses its own format: **76 of
76 checks passing**.

`npx tsc --noEmit` exits 0. `npx next build` compiles successfully, 31 route
rows in its table.

## What I am not confident about

- **Whether 0066 is unapplied or merely invisible to PostgREST.** Covered above.
  It is the one thing in this report I could not settle from inside the sandbox.
- **The 10 ruling-0019 assertions have still never executed.** This job made
  them *reachable* — the harness no longer blocks itself — but reaching them
  needs the table. Nothing here should be read as evidence about the isolation
  of those two tables.
- **A run killed between two deletes still leaks.** `purgeTestIdentities` is
  not transactional: PostgREST gives one HTTP request per delete, so a
  `SIGKILL` midway through teardown leaves a partial state. The next run's
  pre-run purge heals it, which is the whole design, but a single run's
  teardown is not atomic and I would rather say so than imply it is.
- **Orgs are matched by name, which is not unique.** The stranger-profile guard
  makes an accidental match safe in practice, but the honest statement is that
  the test identity is a convention rather than a key. A `test_fixture boolean`
  column on `organizations` would make it structural; that is a schema change
  and therefore a decision, not something to slip into a harness fix.
- **The `[test]` prefix probe.** I used it to report that zero test prospects
  remain. If a real prospect were ever named starting with `[test]`, that count
  would be wrong — it is a reporting statistic only, and no code deletes on it.
- **`scripts/test-tenant-isolation.ts` is not covered by any test.** It is the
  thing doing the testing. Its correctness rests on the two runs above and on
  the post-run query, not on an assertion somewhere.

## Not done here, deliberately

`STATE.md` is untouched: the decision space was editing it live and the job said
not to. The matching open-item update for item 36 — and the new finding about
0066 — need to be entered there by the decision space; this file is the record
until they are. `scripts/ledger-check.ts --seal` was not run.
