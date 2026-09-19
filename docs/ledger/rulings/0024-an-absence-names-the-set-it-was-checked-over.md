---
id: 0024
title: An absence names the set it was checked over — a claim of not-stated covers the pages read, never silently the site
status: settled
provenance: verbatim
supersedes:
date: 2026-09-19
---

## The ruling

Three clauses, one discipline — ruling 0021's, applied to absences. A claim
of absence is a count of zero, and like any count it is evidence only with
its denominator.

1. **A purpose tag on a selected page is a prediction, not a finding.**
   Nothing derived from selection alone — a tag, a tagged page having loaded,
   a tagged page having loaded with substantive text — may be treated,
   named, or displayed as evidence that a fact exists, or that it does not.

2. **A not-stated claim names the set it ranged over.** "The pages read for
   X do not state it" and "this site does not state X" are two different
   facts and must not collapse. The first is establishable by reading; the
   second is establishable only when every candidate the system itself
   identified for X has been read, or an explicit recorded abstention states
   that no candidate existed. A reason string or state that asserts the
   second on evidence of the first is a violation.

3. **The three absences are three facts, end to end.** Declared-unavailable
   (the model abstained: a prediction about the site), read-and-silent
   (pages were read and did not state it: a fact about those pages), and
   never-covered (nothing was read: a fact about the run) stay distinct in
   every store, state, reason, display and measurement. Any scoring that
   collapses them — including `declared || !claimed` as one outcome — is the
   defect, not a simplification.

## Why

The first paid measurement (review 0019) put absence precision at 6/17 —
and 0 of 7 on mixed sites, with every respected absence on a site that
publishes nothing at all. The abstention channel exists, is a required field,
and is instructed plainly in the prompt (`lib/tier2/select.ts`); the funnel
rests on prose, and this codebase's measured prose compliance is 52–80%.

Tracing where the over-claim lands made this a ruling rather than a bug:

- `purposeCoverage` (`lib/tier2/fetch.ts`) scores a purpose **"found"** when
  a page tagged with it loaded with enough characters. No fact is checked.
  On every measured mixed-site over-claim, a human-verified-absent fact
  scores "found".
- `siteOutcome` (`lib/availability.ts`) then maps coverage "found" with no
  extracted fact to `checked_not_stated`, reason: "pages **covering** X were
  read and do not state it" — and its abstention arm claims "**no page on
  this site** could answer X". Both sentences assert site scope. What was
  established is prediction scope: the pages the model chose were read.

The danger inverts on the sites that matter most. Selection recall is 40%
with whole-site zeros (review 0019): on ncf, mariners and signatry the true
pages sat in the manifest unselected while other pages were tagged in their
place. Had those tagged pages loaded substantively, the user would be told
"read and does not state it" about facts the site does state, on the page
selection skipped. The same mechanism that over-claims an absence today
under-claims a presence tomorrow, and both wear the word "checked".

The module's own comments already hold this standard locally — found_thin
exists because "a downstream stage reading 'found' would assert we had read
their priorities when we had read their navigation", and not_offered is kept
apart from not_checked because "the first is about the site, the second
about the fetch". This ruling makes that local honesty binding across the
chain, before the pipeline's reading stages (Tier 2 steps 5–10) are built on
top of the current vocabulary. Invariant before code, per ruling 0001.

## Relationship to standing rulings

- **0008** governs when a fact is *unobtainable* — every source checked. This
  ruling governs a single source's internal honesty: "site checked" requires
  the site's own candidate set covered, not one predicted page.
- **0021/0022/0023** are the same discipline for counts, rates and rows.
  An absence is the count-zero case, and its denominator is the set of pages
  actually read.
- **0012** (provenance and confirmation are two facts) is clause 3's parent.

## Test of compliance

For any not-stated, not-offered or checked state the system stores or shows,
a reader can answer: **which pages were read to earn this, and were there
candidates the system itself knew of that were not read?** If the state or
its reason cannot answer, it fails. If the answer is "candidates existed
unread" while the claim says site-scope absence, it fails.

## Scope

Authorizes, in the dark pipeline (`lib/tier2/` is not in the live path,
item 16):

- `scripts/reference-recall.ts`: absence scoring separates the three
  outcomes of clause 3 in rows and summary, so the next run reports how
  often the abstention channel actually fires.
- `lib/availability.ts` `siteOutcome`: reasons claim prediction scope, not
  site scope; coverage "found" with no extracted fact maps to a state that
  ranks as page-scope evidence — conservatively `not_checked` with a reason
  naming what was read — never as a site-scope "checked", matching the
  existing found_thin downgrade and `combine`'s own doctrine that an unread
  source can still change the answer. The abstention arm keeps
  `checked_not_stated` but its reason names its basis as the model's
  declaration, not as a fact about the site.
- `lib/tier2/fetch.ts`: the coverage state currently named "found" is
  renamed to what it measures (a naming choice for build); tests follow.

Does not authorize: any change to the selection prompt, tool schema, model,
or tagging mechanics, any per-site fix, or any user-facing surface — the
selection failure itself is item 42 and is classified before it is touched.
