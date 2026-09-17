---
id: 0019
title: A declined prospect keeps its reason, and "never revisit" is a choice a human makes rather than a blank field
status: settled
provenance: verbatim
supersedes:
date: 2026-09-17
---

## The ruling

When a funder declines, the prospect keeps a record carrying the reason and a
**revisit disposition** with exactly three values:

```
revisit_on <date>   a human set a date to return
never               a human deliberately closed this permanently
undecided           it is a no; nobody has decided whether to return
```

`never` is set only by an explicit human action. **An absent, blank, or skipped
field is `undecided` and never `never`.** A declined prospect with no disposition
recorded is `undecided` by construction, not by default-to-closed.

`never` carries its own reason and is reversible. It is not deletion: the record,
its reason and its history are retained, consistent with the existing rule that a
dismissed candidate is kept rather than hard-deleted.

## Why the third state exists

Raised by the user when approving this work, and it is the correct catch.

Two states would force a false fact on every decline. If blank reads as `never`,
funders are permanently closed that nobody chose to close, and the loss is
invisible — nothing signals that a decision was made, because none was. If blank
reads as a pending revisit, the revisit list fills with entries nobody scheduled,
and the list stops being trustworthy, which is the same outcome by a slower
route.

This is the project's governing defect shape — two different facts collapsed into
one value — arriving in a new place. It is the same distinction as ruling 0006's
`not_checked` versus `checked_not_stated`, and ruling 0012's `unconfirmed` versus
`refuted`: *nobody decided* and *someone decided no* are different, and the one
that flatters the interface is the one that hides work.

`undecided` is therefore a visible state, not a silent one. A no with no
disposition is an open question for a human, and must be surfaced as such
somewhere — it must not simply sit.

## Why this work at all

Measured against the code 2026-09-17. A dismissed **candidate** — a funder never
contacted — carries `dismissed_reason` and `revisit_date` on `candidates`
(migration 0031). A **prospect** carries neither, and there is no `outcomes`
table, no `declined`, `lost`, `closed` or `archived` concept anywhere, and no
terminal stage among the six: `discovery`, `outreach`, `proposal`, `decision`,
`awarding`, `stewardship`.

So a funder cultivated for months and then declining has nowhere to be recorded.
The relationship the organisation invested most in is the one it remembers least
about, while a stranger it never contacted is remembered in full.

`CLAUDE.md` names relationship memory as a core differentiator — *"a 'no' is
data, not a dead end"* — and that is currently true for candidates and false for
prospects.

## Consequences

- A prospect outcome does not move a prospect through a stage on its own. Hard
  rule 2 is unchanged: any stage transition remains a separate, confirmed human
  action.
- Referral capture — "not us, try them" — is **not** authorized here. It was
  considered and left out to keep this bounded. When it arrives, a referral
  creates a candidate in the review queue for human acceptance, never a prospect
  directly.

## Test of compliance

Record a decline without touching the revisit field. The stored disposition is
`undecided`. There must be no code path by which absence produces `never`.

Set `never`, then reverse it. The original reason and the reversal are both still
readable.

## Scope

Authorizes the outcome record, its three-valued disposition, the migration that
adds it, and the interface to set and reverse it. Queued behind Step 4 —
`## Authorized now` must name this ruling before work begins. Does not authorize
referral capture, a terminal pipeline stage, or any change to stage transitions.
