---
id: 0023
title: A row that does not parse is a violation, not a skip — membership in a governed population is decided structurally
status: settled
provenance: verbatim
supersedes:
date: 2026-09-19
---

## The ruling

When the check enumerates a governed population, **membership is decided by
what an element is, not by whether it happens to parse.** An element that is
structurally a member but fails to parse is a reported violation naming the
element. Silent skips are lawful only for elements structurally identifiable
as non-members.

For the open-items table in `docs/ledger/STATE.md` specifically:

1. **Item ids are numeric.** `^\d+$`, no suffixes, no whitespace. This is now
   settled rather than habitual.
2. The table contains exactly three kinds of row, distinguished structurally:
   the **header** (its cells are the column names), the **separator** (its
   cells match only dashes, colons and whitespace), and **data rows** —
   everything else.
3. A data row whose id cell is not numeric is a **violation**, reported with
   the row's content. It is never dropped from the parse, because a dropped
   row is exempt from every check that governs items.

## Why

Found by experiment in the decision space, 2026-09-18: renaming item 4 to
`4a` moved the open-item count from 15 to 14 while the check still reported
`protocol intact`. The row was present, readable, and carried an owner, a
status and an evidence claim — and none of it was checked, because
`parseOpenItems` (`scripts/ledger-check.ts`) drops any row whose id fails
`^\d+$` under a comment reading "header and separator rows". The comment is
correct about the two rows it was written for and wrong about every other row
it matches.

The failure this permits is worse than a miscount: **a malformed row is exempt
from governance precisely by being malformed.** Every ruling-0015 obligation —
valid status, named owner, evidence past `implemented`, `released` checked
against the deployed branch — attaches only to rows that parse. The cheapest
way to free an item from the rules is a typo in its id, and nothing would say
so.

Item 29's work already made the population visible — the summary prints "N
rows with a numeric id, of M table row(s)" — but that leaves the reader to
subtract and to know that the lawful difference is exactly two. Visibility of
the population is ruling 0021's business; this ruling makes the excluded
member loud rather than countable.

## The family this belongs to

Third population ruling in three days, and the progression is one argument:

- **0021** — a count names the set it ranged over.
- **0022** — a rate aggregated over cases carries its per-case distribution.
- **0023** — an element of a governed set that fails to parse is a failure.

All three are the governing defect — a value detached from the thing it
describes — arriving at the level of populations instead of fields.

## Test of compliance

Adding this row to the open-items table makes the check fail, naming the row:

    | 4a | build | tested | anything | 2026-09-19 |

The header and separator continue to pass, identified as what they are. The
summary's arithmetic reconciles by construction: data rows = table rows − 2,
and every data row either parses or fails the run.

## Scope

Authorizes changes in `scripts/ledger-check.ts` — `parseOpenItems` and
whatever its structural row-classification needs — and one failing example
per new failure mode in `scripts/test-ledger-check.ts`, per that file's
existing pattern. The summary population line from ruling 0021 keeps printing
both counts.

Binds, but does not authorize rewrites of, every other enumeration the check
performs; each is brought to this standard when it is next touched for its
own reasons. Does not change what is governed, and no existing well-formed
row's parse may change.
