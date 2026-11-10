# Item 116 build note: the Form 990 reader, the kind rule, migration 0089 and the loader (written, tested, not run on anything real)

Date: 2026-11-10. Ruling 0047 allows reader code, tests and the migration to be written before the
national foundation load ends, with nothing loaded. That is all this is. Nothing was run on the
Lightsail server, nothing was written to the production database, and migration 0089 has not been
applied anywhere except a local test database.

## In plain words

A grantmaking public charity (a community foundation, a federation, a school foundation that makes real
grants) or a donor-advised fund sponsor can now be read from the IRS Form 990 returns we already hold,
labeled as what it is, and stored in six new tables kept apart from the private-foundation tables. A
funder is in scope when any of its returns in the three periods states grants to domestic organizations
of $100,000 or more (the owner's figure), or reports at least one donor-advised fund on Schedule D. It can
be both. A figure a return does not state is stored as "not stated", never as zero. Grants to individuals
are never read. Nothing in the schema can name the person behind a donor-advised fund.

The tests run the ruling's compliance list against a real Postgres and five real returns (and variants
of them): 122 checks, all passing. The California trial is the next step and cannot start until the
national foundation load is complete and verified and the owner says so.

## What was built

- Reader: `lib/funder-reference/parse-990.ts`. Takes a Form 990 return and refuses a 990-PF, a 990-EZ,
  malformed XML, a missing period or EIN, or an amount that is not a whole number, each with a reason.
  Reads the main form's figures (named for the Part and line), Part IX line 1, the yes/no boxes (written
  `true`/`false` and `1`/`0`, read the same), Schedule I's recipient rows (anything the reader has no
  column for is kept in a document, not dropped), and Schedule D Part I.
- The rule: `lib/funder-reference/charity-scope.ts`. Clause 8 in code, with the threshold and the
  just-under floor as parameters.
- Row builder: `lib/funder-reference/document-990.ts`. Every figure column has its place on the form
  recorded beside it; every Schedule I row names where it sat.
- Database write layer: `lib/funder-reference/sink-990.ts`, over migration
  `supabase/migrations/0089_funder_reference_public_charities.sql`: six tables, no organization_id,
  read-only for signed-in members, written only by one service-role function.
- The loader: `lib/funder-reference/pipeline-990.ts` and its entry point `scripts/load-public-charities.ts`.
- Tests: `scripts/test-public-charities.ts`; five real returns under `scripts/fixtures/public-charities`.
- One change to existing code, additive only: `lib/funder-reference/pipeline.ts` now exports six
  helpers it already had (the archive locator, the per-archive walker, the header scan, the memory line
  and two constants), and `lib/funder-reference/parse-990pf.ts` exports two small helpers. No behaviour of
  the foundation pipeline, the supervisor, the all-states command or the server scripts changed, and a
  test asserts none of them mentions the new loader.

## Decisions I made that the ruling does not spell out (please confirm or change)

1. **Table names are `charity_reference_*`, not `funder_reference_*`.** The older suites count the
   `funder_reference_*` tables (eight) and policies, so a shared prefix would have forced edits to them.
   The run record is still the shared `funder_reference_runs`, and says which kind a run was.
2. **A Form 990 return outside the scope rule is counted in the run record and stored nowhere.** About 9
   in 10 returns are not in scope; a row for each would be roughly a million rows and, at the write
   rate the foundation load measured (about 8 a second), more than a day of loading for nothing. An
   unreadable return IS stored as unread with the reason (ruling 0045 clause 6). The outcomes still add up.
3. **The $100,000 test uses Part IX line 1 only** (grants to domestic organizations and governments).
   Report 0034 said "domestic plus foreign"; the element it guessed for the foreign figure does not
   exist. The real one, Part IX line 3, mixes organizations and individuals outside the United States, so it
   cannot honestly be tested as "grants to organizations". It is stored in its own column and not used.
   Part I line 13 includes individuals and is also stored and not used. The 8.9% in report 0034 was
   therefore measured on line 1 alone, which is what this builds.
4. **A main-form box ticked with no fund count on Schedule D does not make a sponsor.** The ruling says "reports
   any donor-advised fund on Schedule D". Such funders are counted and reported, not stored (one in the test).
5. **The just-under band starts at $50,000** (half the line). The ruling asks for the count to be
   reportable; the floor is a parameter.
6. **People (Part VII) are not stored in this stage.** The ruling lists no people table for these kinds.
7. **Changing the threshold needs `--rewrite-all`.** The labels are stored with each funder, and a return
   already stored identically is otherwise skipped.
8. **A year's coverage row is written only when this run can say what happened.** A return left to another
   state's run (a funder that moved) gets no row for that year, rather than a false "not in the index".

## What the California trial will need

- The owner's go and a completed, verified national foundation load (ruling clause 7). The entry point
  also refuses to write while any loader run is recorded as running, and refuses production without
  `--confirm-write-to-supabase`.
- Migration 0089 applied to the production database (owner's say), and the 2022 and 2023 indexes:
  they carry no archive column, so every one of their returns is found by reading archive directories (the
  foundation loader does the same; 372,494 of the 1,069,962 returns in report 0034 are in that case).
- Time and memory are unmeasured. California is about a tenth of the country, so on the order of 100,000
  Form 990 returns to read whole in pass A. The foundation loader's settings (4 GB heap) are the
  starting point; the first trial should be run with the diary and the memory line on.

## What I could not verify

- **Nothing here touched a real project.** The Supabase sink is a thin wrapper that is not exercised
  against a live database, and PGlite is not PostgREST.
- **The "place on the form" wording** (Part, line, column) is written from the element names I saw in
  real returns and my knowledge of the printed forms. I did not check it line by line against the IRS
  instructions for each year. The Schedule I counts (Part II lines 2 and 3) and the Schedule D column
  letters are the most likely to be off by one.
- **Return versions.** The five fixtures are versions 2022v5.0, 2023v5.0 and 2023v5.1. The 2024 versions
  (2024v5.0 to 2024v5.2) were seen in report 0034 and their elements looked the same, but none is in the
  tests. Five returns prove the shapes, not the country.
- **Memory** for a large state, and the real number of in-scope funders (the 8.9% and 0.7% are from a
  sample of 753, and the 0.7% from five returns).
- **Existing suites.** The foundation suites (161, 125, 38, 78 checks), the database screen suite (122)
  and this suite (122) pass. Two checks in `scripts/test-all-states.ts` fail, and did not before this
  item: one says nothing under `app/` may mention the loader library (the item 113 screen does), one says no
  migration numbered 0085 or higher with "funder" in its name may exist (0086 to 0088 already do). Both
  were true before this work; neither involves a file written here. `scripts/test-network-import.ts` fails
  on a git-status check while 0089 is uncommitted, because its allow-list of migration files stops at
  0088; it needs 0089 added when 0089 is committed to main, as 0086 to 0088 were.
