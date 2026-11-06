---
id: 0044
title: A way in is found by researching both sides, and a person is identified by a human click before anything is researched about them
status: settled
provenance: verbatim
supersedes: 0040
date: 2026-11-05
---

## The ruling

Rulings 0033 and 0040 let the AI propose which of an organization's recorded
people might open a door to a funder, but only by matching those people's own
words against facts already approved about the funder. The owner has named the
way in to a funder as the hardest thing a fundraiser overcomes, and asked for
the platform to do the finding: learn who each person in the organization's
circle really is, learn who is on the funder's side, and show how the two meet
— without the user having to know the connection beforehand, and without a
human approving every fact one at a time. This ruling authorizes that, and
bounds it. Ten things hold. Clauses 1 and 6 to 10 carry forward the guarantees
of 0033 and 0040, each marked and extended where it grows; clauses 2 to 5 are
new.

1. **A recorded person carries the facts that identify them, and no contact
   detail.** The record holds: a name; an employer or organization; a title or
   role; a city and state; how the recorder knows them; a strength chosen from
   a closed list (close, warm, acquaintance) with no default and no inference;
   and free-text notes. The title and the city and state are new. **No email
   address, phone number, social handle or profile link is stored, ever.**
   Capture is by hand or by importing a file of the organization's own
   contacts; an import takes only the fields above, and a column not imported
   is named to the person importing, in plain words, before and after. *(0040
   clause 1, extended by the two fields.)*

2. **No research is run about a person until a human has said which real
   person they are.** For each recorded person the platform may look for
   candidates — real people who could be them — using only the public web and
   official public records (clause 4). A candidate is shown with what it was
   found on, which recorded facts it agrees with (employer, title, city and
   state, name) and which it disagrees with, and its source. The person
   deciding picks one candidate or "none of these". A strong match may be
   preselected so that a whole list can be confirmed on one screen, but the
   confirmation is a human click on a screen that shows every candidate and
   its evidence; **the system never confirms an identity itself.** "None of
   these" is recorded and the person is not researched further (ruling 0019: a
   no is recorded). A person whose identity is not confirmed contributes
   nothing to any path.

3. **Research on a confirmed person is confined to public, organizational
   facts, and the confinement is enforced in code.** The kinds of finding are
   a closed list: employer; title; board, trustee or officer seat; school
   attended; leadership or staff role in a church or other organization; a
   publicly listed affiliation held in an organization's name. A finding of any
   other kind — family, children, health, wealth or finances, politics, a
   private religious membership, a home address, anything about a person's
   private life — is discarded and logged, not stored. The model chooses a
   kind from the list; prompt wording is never the last line of defence
   (CLAUDE.md, "Capture, don't retype").

4. **Sources are public pages and official records, and nothing else.** The
   platform may read the public web through its search and official public
   records (IRS Form 990 filings, SEC filings, and like registers). **It never
   signs into, scrapes or crawls a social or professional network, never uses
   a credential belonging to anyone, and never uses data it learns was
   obtained that way.** A licensed people-data provider may be added only by a
   later ruling that names the provider and states how it sources its data.
   Each finding keeps the URL and the passage the source actually returned; a
   finding that cannot be attributed to a captured source is marked
   `source_missing`, hidden, and never used — the capture contract applied to
   people. Whether a finding is supported by its captured text is tested by
   token containment, not fuzzy similarity, and a failure is recorded, never
   deleted (attestation).

5. **Findings about a person are sourced and strikeable; they are not
   approved one at a time.** Once identity is confirmed, findings enter as
   visible and usable, each with its source link and labelled "not yet
   reviewed by a person". A human may strike any finding; a struck finding
   stays recorded, is never used again, and takes every path built on it out
   of play. This is deliberately lighter than the funder side, and the
   difference is reasoned: a person finding only ever feeds a *suggested*
   path, which a human accepts or dismisses (clause 8), while a funder-side
   claim feeds strategies and drafts and so keeps its per-claim approval
   exactly as before. **Findings about a recorded person never enter a
   strategy run, a draft or any funder-facing text.** Where a path rests on a
   finding no person has reviewed, the path says so on its face.

6. **A path is a proposal grounded in captured facts, referenced by id.**
   Unchanged in kind from 0033 and 0040: a path may cite only a recorded
   person, a confirmed identity, and findings or approved funder-side claims
   that exist; an id not in the pool is discarded and logged; the model may
   never invent a person, an affiliation or a relationship; its confidence is
   its own claim, labelled so. *(0040 clause 4, extended to person findings.)*

7. **The link between two sides is made by code, not by the model.** A link
   between a person finding and a funder-side fact exists when both name the
   same organization, board, school or church, matched by a fixed, named,
   readable rule — token containment on the normalized name, the attestation
   precedent. A link the rule cannot decide may be proposed by the model, only
   by citing both ids, and is labelled as the model's claim. A name
   coincidence is low confidence at best. When more people are recorded than
   one look can consider, they are narrowed by a stated rule, and every result
   says how many were considered of how many are recorded, never "none exist".
   *(0040 clause 7, extended.)*

8. **A path lands in review and changes nothing.** Only a human moves a
   suggestion to accepted or dismissed; doing so contacts no one, drafts
   nothing, sends nothing and advances no stage. The system never messages a
   network person. *(0033 clause 5, 0040 clause 5.)*

9. **Researching is a ledger operation.** Each look at a person or a funder is
   born in the run ledger before the model or any provider is called, and its
   cost is attributed. Research on a confirmed person is done once and reused
   across funders; it is repeated only when a human asks, and the age of what
   is held is shown, never hidden. *(0040 clause 6, extended; ruling 0026.)*

10. **The people are the organization's to control, and disclosure is stated
    where they are entered.** A person, and with them their candidates,
    findings and paths, is the organization's to edit and erase, one at a time
    or in bulk, and each person can be marked "do not research", which is
    honoured by code. Wherever people are entered or imported, the screen says
    in plain words that they may be researched on the public web and in
    official public records, which of their details are shared with the AI and
    search providers (name, employer, title, city, state, and search text
    built from them), that notes should not hold sensitive details, and that
    nothing is ever sent to the people listed. Records are org-scoped under
    hard rule 6. *(0040 clauses 2 and 3, extended.)*

## Why

The way in is a question about two sets of people, and the existing feature
could see only one of them in any depth. Researching both is the missing half.
The risks of doing so are specific: researching private individuals who have
not agreed to it, researching the wrong person who shares a name, and a
platform that quietly becomes a profiling tool. Each clause answers one.
Identity before research (2) stops the wrong-person error from being
compounded across everything found afterward. A closed list of finding kinds
and a bar on non-public sources (3, 4) keep the profile to what a person's
public role already says. Strikeable findings (5) take the approval burden off
the owner where the stakes are a suggestion rather than an action, and keep it
where the output reaches a funder.

The honest limit is stated rather than tuned away: without a licensed provider,
what the public web and official records say about a private person is thin,
and a person with little public footprint will yield few findings. That is a
reason to add a provider later, by ruling, not a reason to loosen clause 4.

## Test of compliance

A person with two plausible matches: both are shown with their evidence, and
nothing is researched until one is picked; choosing "none of these" records it
and no finding about that person ever appears. A search result describing a
person's family or health: no finding of that kind is stored. A finding with
no captured source text: marked `source_missing`, hidden, unused. Strike a
finding: every path resting on it leaves the suggestions. A path resting on an
unreviewed finding says so. A recorded person's data and findings never appear
in a strategy run or draft. Import a file with an email, phone or social-link
column: none is stored and the screen named the column. Mark a person "do not
research": no run is born for them. Erase a person: their candidates,
findings and paths are gone. Accept a path: nothing is sent and no stage
moves.

## Scope

Authorizes, in this order and as separate items: person identity (the two new
fields, candidate finding, the confirmation screen, "none of these", "do not
research"); research on confirmed people from public pages and official
records, with the closed finding kinds, capture contract and strikeable
findings; funder-side people (board, trustees, officers, key staff) gathered
by the same means and following the funder side's existing per-claim approval;
the code-made link between the two sides and the paths it produces, to two
degrees only — a recorded person, a shared organization, a funder-side person
or fact. **A path through a third person nobody recorded is not authorized**
and needs its own ruling. Does not authorize any contact detail or profile
link field, any licensed people-data provider, any use of a social or
professional network, any automatic confirmation of identity, any change to
the funder side's per-claim approval, any use of person findings in a strategy
or draft, or any message to a recorded person.
