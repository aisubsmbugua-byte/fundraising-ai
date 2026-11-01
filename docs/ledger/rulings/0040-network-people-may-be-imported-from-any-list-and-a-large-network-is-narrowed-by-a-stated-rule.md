---
id: 0040
title: Network people may be captured by hand or imported from any list the organization already holds, and a network too large for one look is narrowed by a stated rule, never silently
status: settled
provenance: verbatim
supersedes: 0033
date: 2026-10-31
---

## The ruling

Ruling 0033 made network capture manual and refused any import, and made
path-finding refuse outright above a fixed number of recorded people. The
owner has run the feature and found it valuable, and asked that people be
addable from any list the organization already holds — a donor list, a
board list, an export from any service — not one source, and not only by
hand. Typing hundreds of people one at a time is the real bottleneck, and a
refusal above a fixed number makes a real list unusable the moment it is
loaded. Both limits go; the guarantees 0033 existed to protect do not.
Seven things hold, and clauses 2, 4, 5 and 6 are 0033's own, carried
forward.

1. **Capture is manual or by importing a file of the organization's own
   contacts, from any source.** Whichever way a person arrives, the record
   holds only: a name, an affiliation (where the person works or serves), how
   the recorder knows them, a strength chosen from a closed list (close, warm,
   acquaintance), and free-text notes. **No email address, phone number or
   social handle is stored, ever** — a file will often carry them, and an
   import takes only the fields above and drops the rest. A column that is
   not imported is **named to the person importing, in plain words, before
   and after**; it is never dropped silently. The strength is chosen by the
   person importing, once for the whole batch, from the closed list, with no
   default and no inference from the data. The import never contacts anyone
   and creates nothing but connections.

2. **A connection is the recorder's claim, and it is the organization's to
   edit and erase** — one at a time or in bulk. It is org-scoped under hard
   rule 6 and records who recorded it. A person removed takes every path
   suggestion derived from them with them. Erasure of a third party's data is
   a feature, not a gap, and an import that was a mistake must be undoable by
   the same hand that made it. *(0033 clause 2, extended to bulk.)*

3. **Disclosure is stated where people are entered and where they are
   imported.** The capture surface and the import surface say, in plain
   words, that when paths are looked for, the names, affiliations, how-known
   text and notes of the people being considered are shared with the AI
   provider, that notes are free text and should not hold sensitive details,
   that contact details in a file are not imported, and that nothing is ever
   sent to the people listed. *(0033 clause 3, extended to import.)*

4. **A path is a proposal grounded in two captured facts, referenced by
   id.** Unchanged from 0033: the model may propose a path only by citing a
   connection the organization recorded and a funder-side fact a human has
   approved; an id not in the pool it was handed is discarded and logged; the
   model may never invent a person, an affiliation or a relationship; a name
   coincidence is low confidence at best; the model's confidence is its own
   claim, labelled so. *(0033 clause 4, verbatim in effect.)*

5. **Paths land in a review state and change nothing.** Unchanged: only a
   human moves a suggestion to accepted or dismissed, and doing so contacts no
   one, drafts nothing, sends nothing and advances no stage. The system never
   messages a network person. *(0033 clause 5.)*

6. **Finding paths is a ledger operation,** born in the run ledger before the
   model is called. *(0033 clause 6.)*

7. **When more people are recorded than one look can consider, the code
   narrows them by a stated rule, and every result says so.** The model sees
   only a shortlist chosen by a fixed, named rule in code — a recorded
   person is shortlisted when a distinctive word in their name, affiliation,
   how-known text or notes also appears in an approved funder-side fact for
   this prospect, scored by how many such words they share. When the network
   is no larger than one look can consider, nothing is narrowed and every
   person is considered, exactly as before. Narrowing is **never silent and
   never presented as a judgement about the people left out**: every result
   states how many people were considered out of how many are recorded and
   by what rule, and "no path was found" always reads "none found among
   those considered", never "none exist". A person who shares no word with
   the funder's approved facts was not examined, and may be examined by
   narrowing the network or approving more of the funder's facts. This
   replaces 0033's refusal above a fixed number: choosing which people the
   model sees without saying how was the defect that refusal guarded
   against, and a stated rule, a stated count and a stated limit are what
   guard against it here.

## Why

0033's refusal was the right answer to an unspoken selection, and the wrong
answer to a real list. The honest repair is not to pick people quietly and not
to refuse, but to pick them by a rule anyone can read and to say, in every
result, what was and was not looked at. The same discipline applies to
import: the earlier defect in this codebase's supporter import was a column
silently ignored. An import that takes what it needs and names what it left
is the answer to both.

Allowing import costs one thing 0033 deliberately protected: the platform
will now hold more third-party names than anyone typed by hand. The
protections that remain are the ones that never depended on the volume — no
contact detail is ever stored, the people are the organization's to erase,
what leaves is disclosed where it is entered, and the system never contacts
anyone.

## Test of compliance

Import a file that has an email column: no email is stored anywhere, and the
screen named the column as not imported. Import without choosing a strength:
nothing is imported. Import a list larger than one look can consider, then
find paths: the result says how many were considered of how many recorded and
by what rule, and a person who shares no word with the funder's approved
facts is not sent to the model. Find paths on a small network: every person
is considered and nothing is narrowed. Delete a connection or a batch: its
paths are gone. Accept a path: nothing is sent and no stage moves.

## Scope

Authorizes item 103: a general file import with a column-mapping step and a
batch strength; large-list management on the Network page (search, paging,
bulk removal with a confirm step); and the narrowing rule and its stated
counts in path-finding. Does not authorize any contact-detail field, any
message to a recorded person, any change to what a path or a prospect's stage
does, or reading anyone's social network from a service.
