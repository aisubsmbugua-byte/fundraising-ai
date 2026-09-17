# 0013 — Ledger tooling: five rulings, one pass over one file

**Build report for the decision space.** Item 24. Branch `ledger-tooling`, an
isolated worktree; nothing merged, nothing pushed, `--seal` never run against
this tree.

Rulings implemented: **0014** (the flag split), **0012** (the confirmation
register), **0015** (the six states), **0018** (path citations), **0020** (the
additive-migration check).

Files changed: `scripts/ledger-check.ts` (rewritten, 931 lines),
`scripts/test-ledger-check.ts` (new, 455 lines), `docs/ledger/.baseline.json`
(schema migrated), `docs/ledger/rulings/.confirmed.json` (new, empty of
verdicts), `docs/ledger/STATE.md` (item 24 to `tested`; items 26 and 27 raised).
Nothing under `lib/` or `app/` was touched, and neither was the other job's
review file (docs/reviews/0012-\*, which does not exist yet in this worktree).

---

## Numbers

| measurement | value |
|---|---|
| `npx tsc --noEmit` | clean, no output |
| `npx tsx scripts/test-ledger-check.ts` | **61 of 61 passing** |
| 13 pre-existing suites, re-run | **624 assertions, 0 failed** |
| `npx tsx scripts/ledger-check.ts` on this worktree | **6 violations, 18 warnings** — all six pre-date this work; see *What is red, and why* |
| doc citations now checked every run | 261 at the time of writing — the count includes this report's own, so it moves when the report does |
| migrations ahead of `main` | 3 (0063, 0064, 0065) — all additive |

Pre-existing suites re-run, none of which this job touches: `test-availability`
29, `test-discovery-handoff` 31, `test-legitimacy` 78, `test-decision-contract`
69, `test-tier2-manifest` 70, `test-tier2-selection` 43, `test-prospect-workflow`
23, `test-entity-scoring` 71, `test-entity-validation` 140,
`test-identity-predicate` 28, `test-citation-consistency` 7,
`test-candidate-attestation` 19, `test-candidate-intake` 16.

One number needs qualifying rather than repeating. `STATE.md`'s item 17 cites
`scripts/test-availability.ts` at "29 → 37 passing". In **this** worktree it
reports 29, because it sits at commit `9dacb5b` and item 17's work is
uncommitted in the other worktree. That is not a defect and not a contradiction
— it is evidence that is not verifiable from this branch, which is exactly the
distinction ruling 0020 is about. Recorded, not resolved.

---

## What each check now rejects, with one failing example each

Every example below is executable. The fixture ones are in
`scripts/test-ledger-check.ts` and run on every invocation; the two marked
**live** were run against this repository and reverted.

### Ruling 0014 — sealing and baselining are separate commands

`--seal` (`scripts/ledger-check.ts:830`) writes `docs/ledger/rulings/.settled.json`
and returns. It does not read, write or re-derive `docs/ledger/.baseline.json`,
and it does not touch `docs/ledger/rulings/.confirmed.json`.

`--baseline` (`scripts/ledger-check.ts:845`) is the escape hatch, now on its own
flag and unable to run silently.

**Rejects:**

1. `--baseline` with no `--reason`.
2. A `.baseline.json` exemption with no ISO date.
3. A `.baseline.json` exemption with no reason.
4. (warning) The pre-0014 flat `{ note, paths }` schema, which cannot tell a
   grandfathered path from a later exemption.

**Failing example, run live:**

```
$ npx tsx scripts/ledger-check.ts --baseline
  FAIL  --baseline requires --reason "why". Ruling 0014: every exemption writes
        a dated reason naming what was exempted and why.
exit=1
```

**0014's own test of compliance, run against a fixture**
(`scripts/test-ledger-check.ts:139`): seal with a dirty tree containing a
governed path absent from the baseline, then compare the baseline file
byte-for-byte. It is identical. The pre-0014 script replaced the 28-path
grandfather list with whatever happened to be dirty — that call site was
`scripts/ledger-check.ts:132` in the previous version, the `writeFileSync` that
ran inside the `if (seal)` block.

`--seal` was **not** run against this repository. It was exercised through
`sealRulings()`, the same function the CLI calls, against a throwaway ledger
under the OS temp directory.

**The new schema**, `docs/ledger/.baseline.json`:

```json
{
  "grandfathered": { "note": "...", "date": "2026-09-16", "paths": [ 28 paths ] },
  "exempted": [ { "path": "...", "date": "2026-09-17", "reason": "..." } ]
}
```

The 28 grandfathered paths are carried over verbatim; none was re-examined or
pruned, per the ruling's scope. `exempted` is empty. A later entry is
distinguishable from a grandfathered one by reading the file alone — it is in a
different key and carries a date and a reason that a grandfathered path does not
have. Demonstrated live and reverted:

```
$ npx tsx scripts/ledger-check.ts --baseline --reason "demonstration ...; reverted immediately"
exempted 1 path(s), 0 already exempt:
  + scripts/test-ledger-check.ts
```

with `grandfathered.paths` still at 28 afterwards.

### Ruling 0012 — provenance and confirmation are two facts

`docs/ledger/rulings/.confirmed.json`, read at `scripts/ledger-check.ts:284`.
Flat, keyed by ruling id:

```json
{ "0005": { "verdict": "unconfirmed", "checked_against": null, "date": null } }
```

**Rejects:**

1. A verdict outside `unconfirmed | confirmed | refuted`.
2. `confirmed` or `refuted` with no `checked_against` — a verdict with no
   artifact behind it is an opinion (ruling 0018).
3. A key that is not a ruling id, or names a ruling that does not exist.
4. Any ruling whose verdict is `refuted`, whatever its provenance.

**Warns** only when a ruling is `reconstructed` **and** `unconfirmed`. A
confirmed one stops warning.

**Failing example** (`scripts/test-ledger-check.ts:221`):

```
FAIL  ruling 0002 is REFUTED — checked against transcript 2026-09-16 and found
      to misstate what was decided. Supersede it; do not edit it, and do not
      rely on it meanwhile.
```

and the warning half, 0012's stated compliance test: remove the confirmation
entry and the warning returns (`scripts/test-ledger-check.ts:204`), add it back
and it stops.

`--seal` not touching this file is asserted as a byte-comparison at
`scripts/test-ledger-check.ts:147`.

**What build did and did not write.** The register now exists carrying all five
reconstructed rulings (0002, 0003, 0005, 0006, 0007 — read from their front
matter) at `unconfirmed`, which is the default and asserts nothing. Build wrote
no verdict. `STATE.md`'s item 1 already records 0002, 0003 and 0006 as confirmed
against named artifacts; moving those three verdicts into the file is the
decision space's act, and is item 26(b).

Creating the file at all was a judgement call, and it is the one place in this
job where build touched a decision-space instrument. The reason: `STATE.md:115`
and three lines in ruling 0012 (`:17`, `:74`, `:80`) cite that path, and 0018's new check fails on a
citation to a file that does not exist. Leaving it absent would have made the
ledger red with the remedy sitting inside an immutable ruling. If the decision
space would rather build had not, delete it — the check degrades to "everything
unconfirmed", which is where it was.

### Ruling 0015 — six states, not interchangeable

`checkItemStatus()` at `scripts/ledger-check.ts:738`, over the rows parsed by
`parseOpenItems()` at `:525`.

**Rejects:**

1. A status outside `proposed | approved | implemented | tested | released |
   verified`.
2. Any of the four code states on a `decision`-owned item.
3. An item at `tested` or beyond whose row names no evidence. "Evidence" is
   mechanical (`namesEvidence()`, `:544`): a repo path with a known extension, a
   migration number, a test count, or a commit sha. Prose is not evidence.
4. An item claiming `released` whose cited artifacts are not on `main`.
5. An item claiming `released` that cites nothing checkable at all.

**Failing examples** (`scripts/test-ledger-check.ts:264`, `:268`, `:273`):

```
FAIL  STATE.md item 1: status "done" is not one of proposed | approved |
      implemented | tested | released | verified (ruling 0015)

FAIL  STATE.md item 2: a decision-owned item cannot be "implemented" — the code
      states describe work, not direction (ruling 0015).

FAIL  STATE.md item 3 claims "tested" but its row names no evidence — no file,
      migration, commit or test result. An uncited state claim is "implemented"
      with a stronger adjective (ruling 0015).
```

**Failing example, run live** against this repository — a row was inserted into
`STATE.md`'s open-items table, the check run, and the file restored byte-identical:

```
| 99 | build | released | ... Shipped `lib/availability.ts` and `lib/discovery-handoff.ts`. | 2026-09-17 |

FAIL  STATE.md item 99 claims "released" but lib/availability.ts is not on main
      — it is on a feature branch. Ruling 0020 clause 1: landed means present on
      the deployed branch; this is "tested".
FAIL  STATE.md item 99 claims "released" but lib/discovery-handoff.ts is not on
      main — it is on a feature branch.
```

That is acceptance check (4), and it is the failure ruling 0015 says a human
reviewer is least likely to notice.

**The one place this needed a reading rather than a transcription.** Ruling
0015's vocabulary gives `released` two clauses — *merged to the deployed branch,
**or** applied to the live database* — and item 18 is the second one: migrations
0063–0065 are on the database and not on `main`. A check that only knew the
first clause would fail item 18, which is correctly stated. So the released
check recognises both, and makes the second mechanical rather than trusted: a
cited migration that is not on `main` satisfies `released` **only while it passes
the 0020 additive check**, since that is the sole condition under which 0020
clause 3 lets a migration run ahead of its code. Both halves are tested
(`scripts/test-ledger-check.ts` — additive passes, the same migration with the
default removed fails). This ties 0015's second clause to 0020's rather than
leaving it on a phrase in a table cell. Flagging it because it is an
interpretation, not a quotation; if the decision space wants it narrower, say so.

### Ruling 0018 — a finding cites the artifact it read

`checkCitations()` at `scripts/ledger-check.ts:413`, over every backticked token
in the prose of every markdown file under `docs/`.

**Rejects:** a backticked repo path that resolves to nothing.

Resolution is deliberately generous, because this runs on a Stop hook every turn
and a check that cries wolf stops being read. A citation resolves against the
repo root, the citing document's own directory, `docs/`, any file or directory
with that basename anywhere in the repo, or a numeric-prefix reference such as
`docs/decisions/0002`. Not treated as paths at all: URL routes (`/login`), globs
and `NNNN` placeholders, dot-directories, and a bare extension. Each exclusion
has a test (`scripts/test-ledger-check.ts:328` onward).

**Fenced code blocks are skipped, and this report is why.** The first version
scanned every line, and then failed on its own transcript of the live
demonstration below: the block quotes a check output that names a file which
deliberately does not exist. A fence holds quoted output, a sample or a command
someone ran — it is a transcript, not the document asserting that a file is
there. Inline backticks in prose are the assertion, and those are what gets
checked. Both halves are tested: a bad path inside a fence is not a citation, and
prose after a fence is still checked.

**Failing example, run live** — a scratch file was added to `docs/reviews/`, the
check run, and the file deleted:

```
FAIL  docs/reviews/0013-citation-probe.md:1 cites `lib/obtainability-gate.ts`,
      which does not exist. Ruling 0018: a name is not evidence — cite the
      artifact you opened, or say "not checked".
```

That is acceptance check (5).

**This shipped as paths only.** Table names and symbols are **not checked**.
That is a deliberate stop, not an oversight, and the measurements behind it are
in item 27 and in *What I am not confident about* below.

### Ruling 0020 — only an additive migration may run ahead of its code

`checkMigrations()` at `scripts/ledger-check.ts:500`, over
`git diff --name-only main...HEAD -- supabase/migrations/`. The analysis is
`additiveViolations()` at `:478`, run on SQL with comments, string literals and
`$$` bodies stripped first (`stripSql()`, `:469`) — the ruling is explicit that a
comment claiming a migration is additive is not evidence that it is.

**Rejects:** `drop column`, `drop table`, `rename`, `alter column … type`, and
`not null` without `default` on a column added to an existing table. Columns
inside `create table` are exempt: a brand-new table has no existing rows for a
not-null to break, which is why `qualification_stages` in 0064 passes.

**Failing example** (`scripts/test-ledger-check.ts:414`) — note the comment,
which is what the ruling says not to trust:

```sql
-- Additive.
alter table prospects drop column source_url;
```

```
FAIL  supabase/migrations/0066_bad.sql is ahead of main and is not additive:
      drop column. Ruling 0020 clause 3 — a non-additive migration is not
      applied until its code is on the deployed branch.
```

Eleven SQL shapes are tested individually, plus three cases proving the stripper
works: a comment mentioning `drop column` is not a violation, a string literal
containing "rename" is not a violation, and a plpgsql body is not scanned as DDL.

**0063–0065 pass**, checked two ways: through the live path above (3 migrations
ahead of `main`, 0 violations) and directly against the three files in
`supabase/migrations/` at `scripts/test-ledger-check.ts`. This is the acceptance
condition the handoff named.

---

## What is red, and why

`npx tsx scripts/ledger-check.ts` exits 1 in this worktree with **6 violations**.
All six are the new 0018 check finding real, pre-existing stale citations. None
is in a file the build space owns.

Four are in `docs/decisions/`, and are the "deep dive" rename that `CLAUDE.md`
records as complete in the code but which these documents still assert in the
present tense:

- **docs/decisions/0001-multi-tenancy.md:212** — cites lib/deep-dive.ts in a
  list of files changed.
- **docs/decisions/0002-research-agent.md:18, :37, :461** — cites
  deep-dive-actions.ts, at :461 described as "the live combined action".

Two are in `STATE.md` itself:

- **docs/ledger/STATE.md:48 and :169** — cite
  docs/decisions/0004-commercial-model.md. That file is **not present in this
  worktree**: `ls docs/decisions/` returns only `0001-multi-tenancy.md` and
  `0002-research-agent.md`. Item 25 says it was written on 2026-09-17, and only
  `docs/ledger/` was synced into this worktree, so the likeliest explanation is
  a sync gap rather than a missing file. I did not check the other worktree —
  the brief forbids reading it — so this is *unverified*, not *absent*.

Those paths are written above without backticks on purpose. Backticking them
would make this report fail its own check, and there is currently no way for a
document to quote a name as *wrong*. That is the same defect as item 27's, one
category down, and it is worth the decision space knowing that it bites paths
too.

The 18 warnings are 5 + 13, and they are two different facts: **5** rulings are
reconstructed and unconfirmed (0002, 0003, 0005, 0006, 0007), and **13** are
settled but unsealed (0008–0020, none of them present in
`docs/ledger/rulings/.settled.json` in this worktree). `--seal` is
decision-space-only and build did not run it. Item 26(a).

---

## What I am not confident about

**Table names and symbols are not checked, and the measurement says why.**
Parsing `create table` and `alter table` out of `supabase/migrations/*.sql`
yields 29 table names. Scanning `docs/**/*.md` for a backticked identifier
adjacent to the word "table" yields exactly **one** citation with no table behind
it — and it is in `docs/ledger/rulings/0018-a-finding-cites-the-artifact-it-read.md:41`,
inside the table of wrong claims that ruling exists to record. The check would
be right and the document would be right, and the ruling is immutable, so there
is no remedy. Symbols measured the same way (a backticked identifier absent from
every `.ts`/`.tsx`/`.sql`/`.mjs` file in the repo) give **19** misses, of which
most are fields of unbuilt slices — `revisit_on` in
`docs/slices/slice-07-relationship-memory.md:26` is a real example: it does not
exist because ruling 0019 has not been built yet, which is not an error. Both
need a vocabulary the rulings do not define. Item 27; build stopped rather than
inventing one.

**Line numbers in citations are not verified.** A citation of the form
`lib/availability.ts:1` resolves as soon as the file exists; nothing checks that
the file has that many lines, or that the line says what the citing document
claims. The handoff asked for existence and that is what shipped. A stale line
number in an old review is currently invisible.

**The `released` check can only see what a row cites.** An item that claims
`released` and cites a file which exists on `main` passes, whether or not the
*change* is there — `git cat-file -e main:<path>` tests the path, not the
content. Commit shas are checked properly (`merge-base --is-ancestor`) but no
current row carries one. A row that cited the commit rather than the file would
be strictly stronger evidence.

**`verified` is accepted and never checked.** Ruling 0015 says it cannot be
mechanically checked and must never be set by either space on its own authority.
The check therefore accepts it as a valid state and tests nothing about it. That
is the ruling's instruction, but it means `verified` is the one state the tooling
does not defend.

**The deployed branch is a constant.** `DEPLOYED_BRANCH = "main"` at
`scripts/ledger-check.ts:55`. If Vercel's production branch ever changes, this
check will keep confidently measuring against the wrong one. Not checked against
`vercel.json` or the Vercel dashboard — I did not open either.

**The Stop hook wiring was not found and I cannot say it exists.** `CLAUDE.md`
states the check "runs automatically at the end of every turn", and
`docs/ledger/README.md` says it is "wired to a Stop hook". Searching for it:
`ls -a .claude/` in this worktree returns only `launch.json`, and
`grep -rn "ledger-check" .claude/` and the same grep against the user-level
settings file both return nothing. So either the hook lives somewhere those two
searches do not reach, or it is not configured for this worktree. A statement in
a neighbouring document is not evidence (ruling 0018 rule 2), so this is
**unverified**, not **absent** — but it is worth the decision space checking,
because a protocol enforced by a hook nobody has seen fire is a protocol enforced
by memory. The CLI's `--quiet` behaviour is unchanged from the previous version
either way.

**Not run:** `npm run build`. This job touches no file Next.js compiles —
`scripts/` is outside the app — and `npx tsc --noEmit` covers the two files that
changed. If the decision space wants the full build before merge, it has not
been done here.

---

## State of the branch

Uncommitted in the `ledger-tooling` worktree. Nothing committed, nothing merged,
nothing pushed. `main` is untouched, and so is `build-1-qualification`.
