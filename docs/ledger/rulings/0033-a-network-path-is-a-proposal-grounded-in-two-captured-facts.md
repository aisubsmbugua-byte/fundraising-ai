---
id: 0033
title: A network path is a proposal grounded in two captured facts — a person a human recorded and a funder-side fact a human approved
status: settled
provenance: verbatim
supersedes:
date: 2026-09-25
---

## The ruling

1. **Network capture is manual and minimal.** An organization's people
   record the people they know, by hand. There is no import of any
   contact list, address book or social graph. A recorded connection
   holds only: a name, an affiliation (where the person works or
   serves), how the recorder knows them, a strength the recorder
   chooses from a closed list (close, warm, acquaintance — required, no
   default), and free-text notes. **No email address, phone number or
   social handle is stored** — the system never contacts these people,
   so it has no need of a way to.

2. **A connection is the recorder's claim, and it is the
   organization's to edit and erase.** It is org-scoped under hard rule
   6 (organization_id, tenant-isolated RLS) and records who recorded it.
   Unlike outcomes and send attempts, which are retained because they
   are records of acts toward a funder, a network connection is an
   organization's private note about a person — so it is editable and
   deletable, and **deleting a connection deletes every path suggestion
   derived from it**. Erasure of a third party's data is a feature, not
   a gap.

3. **Disclosure is stated where the data is entered.** Path-finding sends
   the recorded connections (names, affiliations, relationships, notes)
   to the AI provider. The capture surface says so in plain words, and
   says notes are shared with it, so a person recording an entry knows
   what leaves the system. Nothing is ever sent to the people recorded.

4. **A path is a proposal grounded in two captured facts, referenced by
   id.** The model may propose a path only by citing (a) a connection
   the organization recorded and (b) a funder-side fact a human has
   approved — an approved research claim in the prospect's approved
   intelligence (the same and only research payload a strategy is
   allowed to read, which is empty until the funder's identity is
   resolved). Every path names both ids, gives its reasoning in words,
   and carries a confidence the model states — labelled as the model's
   claim, never as a fact. A path citing an id not in the pool it was
   handed is discarded and logged, never stored. The model may propose
   no paths; it may never invent a person, an affiliation, or a
   relationship. A same-name coincidence is not a basis and must be
   said to be low confidence at best.

5. **Paths land in a review state and change nothing.** A stored
   suggestion is `suggested`; only a human moves it to `accepted` or
   `dismissed`, and that is a record of their judgement and nothing
   more. Accepting a path contacts no one, drafts nothing, sends
   nothing and advances no stage (hard rules 1-3). The system never
   messages a network person.

6. **Finding paths is a ledger operation.** The model call is born in
   the run ledger before it happens (ruling 0026) as its own operation,
   so it is metered and priced like every other AI operation.

## Why

The product's promise includes outreach that follows the path of least
resistance through the user's own relationships. Two risks come with
it and both are this codebase's governing defects in a new coat: a
model asked "who can introduce you" will happily invent a plausible
tie from a name and a vibe (a value the system never held), and a
feature that ingests people's relationships collects data about
third parties who never agreed to be in it. The remedy is the
architecture already proven elsewhere: reference by id instead of
retyping, ground every claim in something a human has already
approved, keep the human's decision as the only thing that changes
state, and collect the least data that makes the feature work. Manual
capture also means the platform never holds a scraped social graph —
a decision that is cheap to make now and impossible to walk back after
data exists.

## Test of compliance

For any stored path: the recorded connection and the approved claim it
cites both exist and belong to the organization. Delete the connection:
its paths are gone. Ask for paths on a prospect whose identity is
unresolved: none are produced. Read the capture form: it says what is
shared with the AI. Search the schema for an email, phone or handle
column on the connection table: there is none. Accept a path: nothing
is sent and no stage moves.

## Scope

Authorizes item 76 (network capture v1): additive migrations for the
connection table and the path-suggestion table with RLS and org-match
triggers on every cross-table reference; a Network page for capture,
edit and delete; the path-finding action grounded per clause 4; a
"paths in" panel on the prospect page; the new ledger operation; tests
including the isolation suite's extension. Does not authorize any
import, any contact detail field, any message to a recorded person, or
any change to what a prospect's stage does.
