# 0016 — A declined prospect keeps its reason, and `undecided` is visible

Item 23, authorized by ruling 0019. Build space, 2026-09-18.

## The invariant

A prospect's recorded negative outcome retains its reason, and its revisit
disposition is a three-valued fact in which `never` exists only as a row an
explicit human action wrote — absence, blankness or a skipped field always
derives `undecided`.

Stated without naming a funder, per `docs/ledger/ROLE-build.md`.

## What changed

| File | What it is |
|---|---|
| `supabase/migrations/0066_prospect_outcomes.sql` | Two new tables, five policies, two org-match triggers. **Not applied.** SQL is inline in the closing message per the standing preference. |
| `lib/prospect-outcomes.ts` | The derivation. Pure except for two loaders. |
| `app/(dashboard)/prospects/[id]/outcome-actions.ts` | The two server actions that write. |
| `components/ProspectOutcomePanel.tsx` | The one interface for recording a decline and setting or reversing a disposition. |
| `app/(dashboard)/prospects/[id]/page.tsx` | Loads the outcome; renders the header chips. |
| `app/(dashboard)/prospects/[id]/overview-tab.tsx` | Renders the panel. |
| `app/(dashboard)/revisit/page.tsx` | Loads the index; splits open questions from scheduled revisits. |
| `app/(dashboard)/revisit/followup-workspace.tsx` | The "Open questions" tab, and declined prospects folded into "Revisit later". |
| `scripts/test-prospect-outcomes.ts` | 121 assertions. New. |
| `scripts/test-tenant-isolation.ts` | Extended to the two new tables. **Did not run** — see check 5. |

## The shape, and why it is two tables

`prospect_outcomes` holds the no. `prospect_outcome_dispositions` holds the
revisit decision, append-only.

The split is what makes the ruling's constraint structural rather than a
property of whichever code last touched a column. `undecided` is not stored
anywhere — it is the absence of a disposition row, derived by
`deriveCurrentDisposition` (`lib/prospect-outcomes.ts:139`). Nothing can write
it wrongly because nothing writes it at all. `never` exists only as a row
somebody inserted on purpose, and `disposition` is `not null` **with no
default**, so an insert that omits it errors rather than taking a value nobody
chose.

The same shape gives the reversal test for free: a reversal is a new row, never
an overwrite, so the original `never` and its reason survive it.

## The five acceptance checks

### (1) Record a decline without touching the revisit field → `undecided`, and no path from absence to `never`

**Met.** Proved four ways, because a negative constraint is not provable from a
happy path.

**By construction.** `recordProspectDecline`
(`app/(dashboard)/prospects/[id]/outcome-actions.ts:27`) inserts into
`prospect_outcomes` and nothing else. The decline form
(`components/ProspectOutcomePanel.tsx:50`) carries two fields, reason and date;
it has no disposition control, so there is nothing for a default to be wrong
about. Asserted mechanically at `scripts/test-prospect-outcomes.ts:376`.

**By the type system.** `RevisitChoice` (`lib/prospect-outcomes.ts:35`) is
branded with a `unique symbol` that no other module can name, and
`writeRevisitDisposition` takes that type. A hand-written
`{ disposition: "never" }` is a compile error. Verified by probe rather than
asserted — a temporary file constructing one produced:

```
error TS2322: Type '{ disposition: "never"; }' is not assignable to type 'RevisitChoice'.
  Property '[chosenByAHuman]' is missing in type '{ disposition: "never"; }'
```

The probe was deleted; `npx tsc --noEmit` exits 0 without it.

**Behaviourally.** 17 absent-shaped inputs (`undefined`, `null`, `""`,
whitespace, tab, newline, `0`, `1`, `false`, `true`, `{}`, `[]`, `NaN`, a
`Date`, a function, an object literally carrying `disposition: "never"`, and
`["never"]`) all parse to `undecided`; 11 near-misses (`"Never"`, `"NEVER"`,
`" never"`, `"never "`, `"never."`, `"nevermind"`, `"nver"`, `"n"`, `"close"`,
`"permanent"`, `"revisit_never"`) all fail to produce `never`. Population: the
28 inputs enumerated at `scripts/test-prospect-outcomes.ts:87` and `:119`.
`parseRevisitChoice` uses strict equality with no trim and no case fold,
deliberately — every loosening is another input nobody chose that would
nonetheless close a funder permanently.

**By exhaustive source enumeration.** `grep -rn "['\"]never['\"]" app lib
components supabase` returns **16 occurrences**, and they are all of them:

| Count | Kind | Where |
|---|---|---|
| 7 | prose in a comment or a `comment on` string | `lib/prospect-outcomes.ts` :28, :59, :137, :151; `app/(dashboard)/prospects/[id]/outcome-actions.ts:79`; `supabase/migrations/0066_prospect_outcomes.sql` :107, :110 |
| 2 | type or vocabulary declaration | `lib/prospect-outcomes.ts` :23, :38 |
| 4 | comparison — reads the value, never writes it | `app/(dashboard)/prospects/[id]/outcome-actions.ts:92`; `lib/prospect-outcomes.ts:222`; `components/ProspectOutcomePanel.tsx` :123, :210 |
| 1 | check constraint bounding the vocabulary | `supabase/migrations/0066_prospect_outcomes.sql:89` |
| 1 | the radio option a human clicks | `components/ProspectOutcomePanel.tsx:29` |
| **1** | **the only site that produces the value** | **`lib/prospect-outcomes.ts:73`**, guarded by `rawChoice === "never"` |

No `default 'never'` exists in any of the 66 migrations — the grep above covers
`supabase/` entire and only 0066 matches at all, at its check constraint.

One refinement the ruling does not require and I judged to be within it: a
present-but-unrecognised value is **not** folded into `undecided`. It returns an
error. "Nobody answered" and "something answered wrongly" are different facts,
and collapsing them would be the ruling's own defect shape reappearing one level
down.

### (2) Set `never`, reverse it, both readable

**Met.** A reversal appends; `deriveCurrentDisposition` reports the newest row
and `ProspectOutcome.history` carries every row, oldest first
(`lib/prospect-outcomes.ts:172`). The panel renders the full history at
`components/ProspectOutcomePanel.tsx:227`.

This is enforced below the code, not by it: `prospect_outcome_dispositions` has
an insert policy and a select policy and **no update policy and no delete
policy**, so the owning organisation cannot edit or remove its own recorded
decision either. `prospect_outcomes` likewise has no delete policy. Asserted
statically at `scripts/test-prospect-outcomes.ts:316` and live (unrun) at
`scripts/test-tenant-isolation.ts`.

Tested at `scripts/test-prospect-outcomes.ts:186`: the current state is the
reversal, the reversal's own reason is readable, the original `never` and its
reason are still in the history, and `chosen` distinguishes a reversal from
never having decided — the two render as different sentences, asserted rather
than assumed.

### (3) `undecided` is visible — the surface I chose

**Met. This is the choice ruling 0019 left open, and I made it rather than
escalating.** Reasoning below; the decision space should overrule it if it reads
as direction.

**Chosen surface: a new "Open questions" tab on the Follow-ups page
(`/revisit`), second in the tab bar, directly after "Due now".**

Why that one:

- The page already exists for exactly this purpose. Its own subtitle is "Keep
  promising relationships warm and past decisions useful"
  (`app/(dashboard)/revisit/page.tsx:59`), and it already carries "Revisit
  later" and "Past decisions" for dismissed **candidates**. Ruling 0019's whole
  argument is that a prospect is remembered less well than a candidate; putting
  the prospect half beside the candidate half closes that asymmetry where a user
  already looks for it.
- The tab prints its count (`Open questions 2`), so the state is a number on a
  screen rather than a row somebody has to go looking for.
- The two alternatives I rejected: the Dashboard's "Today's priorities" would
  make every decline a task, and a decline is not urgent, only unresolved; a
  chip on the Pipeline board would show it only to someone already on that
  board.

Verified in the running app, not inferred: `next start` on the production build,
`GET /revisit` → 200, and the rendered markup contains `Due now| |2||Open
questions| |0|`. Zero because migration 0066 is not applied — see the caveat
below.

Three further places it surfaces, so it is not one tab's problem:

1. The prospect header carries a `Declined` chip **beside** the unchanged stage
   chip, plus the disposition chip (`app/(dashboard)/prospects/[id]/page.tsx:150`).
   Both labels come from `describeDisposition`, never restated.
2. The Overview tab leads with the outcome panel
   (`app/(dashboard)/prospects/[id]/overview-tab.tsx:34`).
3. Declined prospects with a date join dismissed candidates in "Revisit later"
   (`app/(dashboard)/revisit/followup-workspace.tsx:82`), so all three
   dispositions have somewhere to be: `undecided` is work, `revisit_on` is a
   diary entry, and `never` appears in neither list and only on the record
   itself.

### (4) Ruling 0010 — the invariant in the running product

**Met in code; one half is by construction outside my reach.**

`deriveCurrentDisposition` is the only function that decides the disposition,
and `parseRevisitChoice` is the only function that mints one. Every call site,
by grep:

| Symbol | Call site |
|---|---|
| `loadProspectOutcome` | `app/(dashboard)/prospects/[id]/page.tsx:17` |
| `describeDisposition` | `app/(dashboard)/prospects/[id]/page.tsx:17`; `app/(dashboard)/revisit/followup-workspace.tsx:16`; `components/ProspectOutcomePanel.tsx:6` |
| `loadOutcomeIndex`, `isOpenQuestion`, `isScheduledRevisit` | `app/(dashboard)/revisit/page.tsx:5` |
| `parseRevisitChoice` | `app/(dashboard)/prospects/[id]/outcome-actions.ts:6` |
| `ProspectOutcomePanel` | `app/(dashboard)/prospects/[id]/overview-tab.tsx:9`; `app/(dashboard)/revisit/followup-workspace.tsx:19` |
| `recordProspectDecline`, `setRevisitDisposition` | `components/ProspectOutcomePanel.tsx:5` |

Six production files, two user-facing screens. Not the module and its test.

`deriveCurrentDisposition` and `buildOutcomeIndex` are reached through
`loadProspectOutcome` and `loadOutcomeIndex` rather than directly — a page never
derives for itself, which is what keeps the tab, the chip and the panel from
describing the same state differently.

**What is not met, and cannot be by me:** migration 0066 is user-applied by
instruction, so at the time of writing the tables do not exist and no real
disposition has been stored. I verified that this degrades rather than breaks —
`GET /revisit`, `/dashboard` and `/pipeline` all return 200 against the live
database with the tables absent, and a prospect page renders "No outcome
recorded. A decline is kept with its reason" — but "a human clicked never and it
came back as never" has not been observed end to end. It is the last step and it
belongs to whoever applies the SQL.

### (5) Tenant isolation

**Met in the migration; verified statically, not live.**

Both tables carry
`organization_id uuid not null references organizations (id) default my_organization_id()`,
RLS enabled, an `organization_id` index each, and five policies, **all five**
scoped by `my_organization_id()` — asserted by reading the file at
`scripts/test-prospect-outcomes.ts:305`, not by claiming it. No policy is
written `using (true)`.

Beyond the pattern in `supabase/migrations/0033_multi_tenant_rls.sql`, 0066 adds
two `before insert` org-match triggers, copying
`enforce_research_run_org_match` from
`supabase/migrations/0035_research_agent.sql:148`. A foreign key check runs as
the table owner and does not respect RLS, so the insert policies stop one org
*reading* another's row and do not stop one org *pointing at* it.
`docs/decisions/0001-multi-tenancy.md` records that hole as an accepted open gap
on eight existing columns. These tables are new, so it cost nothing to close
here rather than inherit it.

`scripts/test-tenant-isolation.ts` is extended with 10 assertions covering both
tables in both directions, including both cross-org FK attempts and the
no-update/no-delete properties. **It did not run**, and deliberately so: it
writes two real organisations and two real users to the live database, and with
0066 unapplied it would throw partway through and leave seeded rows its cleanup
path does not reach. Run it as
`npx tsx --env-file=.env.local scripts/test-tenant-isolation.ts` **after**
applying 0066. Until then those 10 assertions are untested code, and I am
counting them as such.

## Measurements

Every number names the set it ranged over, per ruling 0021.

**Test suite** — every `scripts/test-*.ts`, 17 files, run individually:

| File | Result |
|---|---|
| test-availability.ts | 65 passed, 0 failed |
| test-candidate-attestation.ts | 19 passed, 0 failed |
| test-candidate-intake.ts | 16 passed, 0 failed |
| test-citation-consistency.ts | 7 passed, 0 failed |
| test-decision-contract.ts | 69 passed, 0 failed |
| test-discovery-handoff.ts | 31 passed, 0 failed |
| test-entity-scoring.ts | 71 passed, 0 failed |
| test-entity-validation.ts | 140 passed, 0 failed |
| test-identity-predicate.ts | 28 passed, 0 failed |
| test-legitimacy.ts | 78 passed, 0 failed |
| **test-prospect-outcomes.ts** | **121 passed, 0 failed (new)** |
| test-prospect-workflow.ts | 23 passed, 0 failed |
| test-tier2-manifest.ts | 70 passed, 0 failed |
| test-tier2-selection.ts | 43 passed, 0 failed |
| test-ledger-check.ts | 76 of 76 checks passing — a different unit, not summed below |
| test-research-concurrency.ts | **did not run** — "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" |
| test-tenant-isolation.ts | **did not run** — by choice, see check 5 |

**781 assertions passed, 0 failed, across the 14 files that report assertions.**
The ledger-check figure is kept separate because its unit is a check, not an
assertion, and adding them would be one number over two populations.

Of the 121 new assertions, counted by section from the run rather than
estimated: **78** are behavioural over `parseRevisitChoice`,
`normalizeRevisitDate`, `deriveCurrentDisposition`, `buildOutcomeIndex` and
`describeDisposition`; **28** read migration 0066 and assert its text (7 on
vocabulary and defaults, 17 on tenant isolation, 4 on ruling 0020 additivity);
**15** scan the six production source files for a cast or a literal that would
route around the brand. 78 + 28 + 15 = 121.

**`npx tsc --noEmit`** — exit 0, no output.

**`npx next build`** — compiled, 28 routes, same count as before this change (no
new route). `/prospects/[id]` 8.03 kB / 116 kB first load; `/revisit` 6.93 kB /
106 kB.

**`npx tsx scripts/ledger-check.ts`** — `protocol intact`, authorized 0019, 21
rulings, 19 open items, 404 doc citations across 57 files, 0 migrations ahead of
main. The last is 0 because 0066 is untracked; it will become 1 when committed
and must pass the additive check, which `scripts/test-prospect-outcomes.ts:341`
already asserts locally (nothing dropped, renamed or re-typed, and no
`add column` at all).

## What I am not confident about

1. **A decline recorded by mistake has no way back.** There is no delete policy,
   by design, and I did not add a retraction flag because ruling 0019's
   "reversible" attaches to `never`, not to the outcome itself. So a misclick is
   permanent. This codebase has twice written that a confirmation a person
   cannot revise is a trap (`app/(dashboard)/prospects/actions.ts:296` and
   `:399`). I did not decide it — whether a retraction is retention or a hole in
   it is a decision-space call. Worth an item.
2. **A `never` prospect can still appear under "Due now".** The existing tabs
   filter on `next_action_due` and know nothing about outcomes
   (`app/(dashboard)/revisit/page.tsx:24`). A permanently closed funder with a
   stale next action will still show as due. Changing those filters is a
   behaviour change the ruling does not authorize, so I left them alone.
   Same for the Pipeline board, which shows no outcome at all.
3. **The 10 tenant-isolation assertions are unrun**, per check 5. Everything I
   claim about isolation is read from the migration text, which is evidence
   about what will be applied, not about what is applied.
4. **`describeDisposition` casts at `components/ProspectOutcomePanel.tsx:232`**
   when rendering a history row, because a stored row's `disposition` is `string`
   and not the union. The check constraint makes a bad value unreachable, and
   `describeDisposition` falls through to "Undecided" rather than to `never` if
   one ever occurred, so the failure mode is safe — but it is a cast, and casts
   are how brands get routed around.
5. **`occurred_on` is a date the user types and nothing validates it server-side**
   beyond Postgres's own date parse. An empty value falls back to today
   (`app/(dashboard)/prospects/[id]/outcome-actions.ts:47`). Not load-bearing for
   the ruling, but it is a model-free field I did not guard.

## Noticed in passing, outside this work

`parseOpenItems` skipping malformed ids is already item 31. Nothing new found.
The `* 2.*` duplicate files listed in this session's opening git status are
**not on disk** — `find . -name "* 2.*"` excluding `node_modules` and `.git`
returns one entry, a webpack cache pack under `.next/`. The status snapshot was
stale; the tree is clean and the 57-file citation population is real.
