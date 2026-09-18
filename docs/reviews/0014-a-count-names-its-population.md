# 0014 — the ledger check's own counts now name their populations

Item 29, authorized by ruling 0021. Build space. 2026-09-18.

Written in an isolated worktree (`worktree-agent-a226abf9148f24f7c`, branched
from `main` at 647c8fd) because `scripts/ledger-check.ts` runs as a Stop hook in
the decision space's session every turn. Not merged. Every number below names
the set it ranged over, per the ruling that authorized the work.

## The invariant

**Every count this script prints appears beside the set it ranged over and the
command that enumerates that set, and the population is read from the same
function that produced the count.**

The second clause is the load-bearing one. Naming a denominator is not enough if
the denominator is derived a second time: two independent enumerations are two
measurements, and a disagreement between them is exactly the thing nobody would
notice. So `citationDocs()` both enumerates the files and is the population the
summary prints; `rulingFiles()` likewise; the migrations-ahead command is one
argument array used both to run git and to print the command.

## What changed

Two files. No Build 1 code, no new check, no change to what is governed or to
which files are scanned. `git diff --stat`: 298 insertions, 27 deletions across
the two.

### `scripts/ledger-check.ts` (931 → 1079 lines by `wc -l`)

| lines | what |
|---|---|
| 37–40 | header comment: ruling 0021 added to the list of rules this file carries, stated as *output*, not a check |
| 104–111 | `MIGRATIONS_AHEAD_ARGS` / `MIGRATIONS_AHEAD_CMD` — the git invocation as one value |
| 129 | `realGit().migrationsAheadOfDeployed` now runs that array instead of an inline copy |
| 205–222 | `rulingFiles()` extracted (205–217, comment included); `readRulings()` now built on it (219–222) |
| 405–425 | `citationDocs()` extracted — the `.md` walk under `docs/`, with its doc comment |
| 427–451 | `collectCitations()` now iterates `citationDocs()` instead of re-walking |
| 453–504 | `checkCitations()` returns `docs` alongside `checked` |
| 569–588 | `tableRowCells()` extracted (569–574); `openItemRows()` added (576–588) |
| 590–602 | `parseOpenItems()` now built on `tableRowCells()`; behaviour unchanged |
| 639–648 | `LedgerResult` gains `rulingFileCount`, `openItemRowCount`, `citationDocCount` |
| 666, 730, 761, 775, 803–808 | `runLedger()` populates them |
| 898–972 | the summary: comment (898–918), `CountedOver` (920–926), `summaryCounts()` (928–959), `summaryLines()` (961–972) |
| 1067 | `main()` prints `summaryLines(r)` |

### `scripts/test-ledger-check.ts` (455 → 578 lines by `wc -l`)

New section at 433–546 — "Ruling 0021 — a count names the set it ranged over" —
plus imports at 16 and 22–35. 15 assertions. No existing assertion was changed
or removed.

There is no failing example in this section, and that is deliberate rather than
an omission. Every other rule in this file has one because every other rule is a
check that rejects something. 0021's clause here rejects nothing; it constrains
the shape of output. The equivalent evidence is the reproduction test — running
the printed command and comparing against the printed number.

## The summary line, before and after

Exact text, both from `npx tsx scripts/ledger-check.ts` in this worktree on
2026-09-18, on an otherwise unmodified tree.

The population of those two runs, stated because this report is bound by the
same ruling: the worktree at 647c8fd with only `scripts/ledger-check.ts` and
`scripts/test-ledger-check.ts` modified, and **before this review file existed**
— 53 `.md` files under `docs/`, `find docs -name "*.md" -type f`. Every count
quoted below is over that 53-file tree unless it says otherwise.

Adding this review moves the population to 54 and raises the citation count by
the number of path citations in it, which is the behaviour under test rather
than a discrepancy. The citation total in that state is deliberately not quoted
here: it changes with every edit to this file, so a number written into it would
be stale by the time the file was saved. Run the printed command.

Before:

```
ledger: 20 ruling(s), 14 open item(s), 337 doc citation(s), 0 migration(s) ahead of main, authorized: 0013
```

After:

```
ledger: authorized 0013. Each count names the set it ranged over (ruling 0021):
  rulings                    20  parsed from 20 file(s): ls docs/ledger/rulings/*.md
  open items                 14  rows with a numeric id, of 16 table row(s) in '## Open items' of docs/ledger/STATE.md — the header and separator have none
  doc citations             337  backticked paths in prose, fenced blocks skipped, across 53 file(s): find docs -name "*.md" -type f
  migrations ahead of main    0  git diff --name-only main...HEAD -- supabase/migrations/
```

Two notes on the shape.

**It is a block, not a line.** The scope says "summary line". Four populations
and four commands do not fit on one readable line, and compressing them to fit
produces a string a reader cannot reproduce from — which fails the ruling's own
test of compliance while satisfying its letter. The block is the reading of the
scope I took; if the decision space wanted one physical line, that is a change
to make now rather than after it is relied on.

**Under `--quiet` nothing about this is louder.** `main()` still suppresses the
header when quiet and clean, so the Stop hook in the decision space's session
prints exactly what it printed before: the two standing warnings and
`ok    protocol intact`. Verified by running `npx tsx scripts/ledger-check.ts
--quiet`.

The worktree's authorized ruling reads 0013 because the worktree was branched
before the decision space's `STATE.md` edit; in the main tree the same line
reads 0021. That is a property of the tree, not of the change.

## The four acceptance checks

### (1) A reader holding only the summary can reproduce each population

Ran each printed command against this worktree and compared to the printed
population. All four agree:

| printed | command as printed | ran |
|---|---|---|
| 20 file(s) | `ls docs/ledger/rulings/*.md` | 20 |
| 16 table row(s) | rows of `## Open items` in `docs/ledger/STATE.md` | 16 |
| 53 file(s) | `find docs -name "*.md" -type f` | 53 |
| 0 (migrations) | `git diff --name-only main...HEAD -- supabase/migrations/` | 0 |

The open-items row count is the one population stated as a description rather
than a one-line command, because the naive grep is wrong: `docs/ledger/STATE.md`
has a second numeric-id table under `## Closed items`, and a whole-file
`grep -cE '^\| [0-9]+ \|'` returns 24 rather than 16. The description is
section-scoped and the section heading is quoted in it, which is reproducible; a
command that silently ate the closed items would be the same defect this ruling
exists for. Reproduced with
`awk '/^## Open items/{f=1;next} /^## /{f=0} f && /^\|/{n++} END{print n+0}'`,
which returns 16.

The migrations command is stronger than reproduced-by-hand: a test splits
`MIGRATIONS_AHEAD_CMD`, executes it, and compares the result to what the git
port returns. Both are empty on this worktree, so the test establishes the
command runs and agrees, not that it agrees on a non-empty set. **Not verified:
that the printed command and the port agree when migrations are actually ahead
of `main`.** They cannot diverge by construction — one argument array — but that
is an argument from reading the source, not a measurement.

### (2) The citation count names the `docs/**` `.md` walk specifically

The printed population is `backticked paths in prose, fenced blocks skipped,
across 53 file(s): find docs -name "*.md" -type f`. It names the walk, the file
extension, the root directory, and the unit counted, and excludes the two things
a reader would otherwise guess wrong about (fenced blocks are skipped; the unit
is a backticked path token, not a link or a filename mention).

The one gap between the printed command and the code: `walk()` skips directory
names in `WALK_SKIP` — node_modules, .git, .next, .vercel, out, dist (written
without backticks because they are names under discussion, not paths asserted to
exist; the convention item 28 identified). Under `docs/` there is no such
directory — `find docs -type d` returns 8, being `docs` plus `docs/architecture`,
`docs/decisions`, `docs/ledger`, `docs/ledger/rulings`, `docs/reference-set`,
`docs/reviews` and `docs/slices`, none of them a skip name — and no symlink
(`find docs -type l` returns 0). So the printed command is exactly equivalent
today. It would stop being equivalent if someone created a docs/dist directory.
Recorded in a comment at `citationDocs()` rather than papered over.

### (3) Reintroducing duplicates moves both the count and the population

Tested the way the original finding was established. Copied two existing docs to
`* 2.md` names under `docs/ledger/`, re-ran, then deleted them:

```
before   doc citations   337   across 53 file(s): find docs -name "*.md" -type f
after    doc citations   374   across 55 file(s): find docs -name "*.md" -type f
```

Both moved, and the population moved by exactly the two files added. Under the
old line this would have read `337 doc citation(s)` then `374 doc citation(s)`
with nothing to say why — which is how 407 got into an evidence row.

Covered in the test suite too, against a fixture rather than this tree, so it
does not depend on the state of `docs/`.

A second instance of the same shape, not asked for and worth recording: the
open-item count now carries a constant denominator, so STATE.md item 31's
silent skip is visible in the output. Renaming item 17 to `17a` in
`docs/ledger/STATE.md` and re-running moved the line from `14 … of 16 table
row(s)` to `13 … of 16 table row(s)`. The decision space found that defect by
watching the count fall from 15 to 14 while the check still said `protocol
intact`; the drop is now legible as an exclusion rather than as a removal.
**The parser is unchanged** — `parseOpenItems()` still skips the row silently
and still does not fail. Item 31 still needs its ruling; this only makes the
skip visible. STATE.md restored afterwards; `git status` clean.

### (4) `scripts/test-ledger-check.ts` still passes

`npx tsx scripts/test-ledger-check.ts`: **76 of 76 checks passing**, from 61 of
61 before. Population: every `check(...)` call reached in one run of that file —
it is a straight-line script, so the population is the file. The 15 added are
all in the new ruling-0021 section and each names what it covers in its own
title string:

- every printed count names a non-empty population
- every printed count names its unit
- the four counts on the summary are rulings, open items, citations and migrations
- the summary no longer prints the bare `N doc citation(s)` shape
- the citation population is the `.md` files `citationDocs` walks
- the citation population is every `.md` under `docs/`, subdirectories included
- a duplicate doc moves the citation count
- a duplicate doc also moves the stated population
- the stated population is reproducible from the summary text
- the open-item population counts header and separator rows too
- a malformed item id lowers the count while the population holds
- the ruling population is the `.md` files in the rulings directory
- an unparseable ruling shows as count below population
- the migrations-ahead command in the summary runs as printed
- running the printed command reproduces the printed count

`npx tsc --noEmit`: clean, exit 0.

## The live check

`npx tsx scripts/ledger-check.ts` in this worktree exits 0, `ok    protocol
intact`, with the two standing `reconstructed and unconfirmed` warnings for
rulings 0005 and 0007 that predate this work.

That required a caveat to establish. Run with no `node_modules` present, the
check reports one violation: `docs/decisions/0002-research-agent.md:194` cites a
path under `node_modules/`. This is a property of the worktree, not a
regression — a fresh worktree has no `node_modules`, `walk()` skips it anyway,
and so the citation cannot resolve. Established by experiment rather than
inferred: symlinking the main tree's `node_modules` into the worktree and
re-running turns the violation into `ok    protocol intact`, and the citation
population stays 53 either way. The symlink was removed afterwards. The main
tree's own run is clean on the unmodified script.

## Evidence that this is output-only

`runLedger()` takes its root as a parameter, so the modified script can be
driven against the main tree read-only. Did that, and compared against the
unmodified script's run on the same tree earlier in the session.

Unmodified script, main tree:

```
ledger: 21 ruling(s), 19 open item(s), 373 doc citation(s), 0 migration(s) ahead of main, authorized: 0021
  warn  ruling 0005 is reconstructed and unconfirmed …
  warn  ruling 0007 is reconstructed and unconfirmed …

  ok    protocol intact
```

Modified script, same tree, same moment:

```
ledger: authorized 0021. Each count names the set it ranged over (ruling 0021):
  rulings                    21  parsed from 21 file(s): ls docs/ledger/rulings/*.md
  open items                 19  rows with a numeric id, of 21 table row(s) in '## Open items' of docs/ledger/STATE.md — the header and separator have none
  doc citations             373  backticked paths in prose, fenced blocks skipped, across 56 file(s): find docs -name "*.md" -type f
  migrations ahead of main    0  git diff --name-only main...HEAD -- supabase/migrations/
violations: 0, warnings: 2
```

Every count identical — 21, 19, 373, 0 — and the same two warnings and zero
violations. The populations reproduce in that tree too: 21 ruling files, 56
`.md` files under `docs/`, 21 open-item table rows. So the summary is the only
thing that changed, measured rather than asserted.

This also confirms the block format holds at the main tree's wider numbers: the
column padding is derived from the longest label and widest count, not fixed.

## What I did not do, and what I am not confident about

- **Did not run `--seal`.** It was never needed; the check passes. Noting it
  because the protocol asks the build space to say so.
- **Did not edit `docs/ledger/STATE.md`** — the decision space is editing it
  live this session and records item 29 from this review. Nothing in this work
  depends on that edit.
- **Did not change the parser, the scanned file set, or what is governed.**
  Verified by `git diff`: the only behavioural change outside the summary is
  that `collectCitations()` iterates a sorted file list rather than walking
  in directory order. That changes the order citations are reported in, not the
  set. `checkCitations()` reports the same violations because it reports one per
  unresolved citation regardless of order.
- **`summaryCounts()` decides which counts get a population, and it hard-codes
  four.** A count added to `LedgerResult` later will not automatically appear on
  the summary, and nothing fails if it is printed elsewhere without a
  population. Ruling 0021 is not mechanically enforceable in English and
  `STATE.md` says not to try; this is the code equivalent of that limit, and it
  is worth knowing that the rule holds here by one function being the only
  place the summary is built, not by a check.
- **The "header and separator have none" clause is a statement about the
  filter, not a measured offset.** An earlier draft printed "(2 are its header
  and separator)", which is the interface asserting something the code had not
  measured — it would have kept reading reassuringly on the day a third row
  stopped parsing. Changed before it shipped, recorded because the draft was
  wrong for the reason `CLAUDE.md` names.
- **Not checked: whether the block format is acceptable under `--quiet` in the
  decision space's actual hook configuration.** I verified the flag's behaviour
  in this worktree; I did not read the hook definition in that session.
