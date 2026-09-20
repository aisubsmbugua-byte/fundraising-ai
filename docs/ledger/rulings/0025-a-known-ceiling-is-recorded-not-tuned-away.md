---
id: 0025
title: Selection's known ceiling is recorded and priced, not tuned away — lifting it waits for a settled cost of a search
status: settled
provenance: verbatim
supersedes:
date: 2026-09-19
---

## The ruling

Four clauses. The direction they encode was chosen by the owner on
2026-09-19, presented as: accept and record the ceiling now; run the
capability experiment after the cost of a search is settled.

1. **The advertised/unadvertised axis is part of the measurement.** Every
   selection recall this project reports is split by whether the
   ground-truth page's manifest line advertises its purpose — advertised
   meaning mandatory-flagged by `isMandatoryPath` or opportunity-promoted,
   both deterministic, no model call. Each split population carries its own
   distribution (ruling 0022). The day an advertised page is missed, or an
   unadvertised one is found, the run itself announces it.

2. **The ceiling is recorded, not tuned away.** The current selector reads
   names; a page whose manifest line does not advertise its purpose is
   outside its established reach (review 0020: 8 of 8 advertised true URLs
   selected, 0 of 5 unadvertised, the split running through sites as well as
   between them). No change to selection mechanics — prompt, tool schema,
   model, ordering heuristics, funding vocabulary — is authorized to chase
   the unadvertised class. Per review 0009, a vocabulary that rescues one
   case is not a fix, and no vocabulary makes a church's care-recovery page
   say "priorities" without reading it.

3. **No consumer treats name-blind selection as site coverage.** A
   manifest's name-signal profile (how many entries carry any advertised
   signal at all) is derivable deterministically and accompanies selection
   wherever selection's completeness matters. A manifest like mariners' —
   zero advertised entries in sixty — tells every consumer in advance that
   selection is guessing among unlabeled doors there; presenting its output
   as coverage of such a site is the over-claim ruling 0024 forbids, now
   knowable before the model is even called.

4. **Lifting the ceiling is a priced experiment, not a fix.** A
   read-then-select pass, or any content-informed selection, may be built
   only after item 25 settles what a search may cost — it adds fetch volume
   and model calls to exactly the operation whose price is currently
   undefined. When run, the experiment is judged over the whole reference
   set with both populations reported separately, never by its effect on
   the unadvertised class alone. Item 45 (the opportunity name each script
   delivers to only one of the two places that can use it) rides with this
   clause: changing what the prompt is told re-prices the measurement, so
   it is decided with the experiment, not before it.

## Why

Review 0020 established the failing class deterministically: selection's
entire evidence per page is one manifest line, and on the recorded run the
partition by name-legibility separated selected from unselected true pages
perfectly. The three sites where every true page is name-silent are the
reference set's two DAF sponsors and its church — funder types whose
decision-critical facts live on pages named for something else. Accepting
the ceiling therefore concedes something real: for funders that do not look
like foundations, selection cannot be trusted to find the pages that
matter, and the system must say so rather than perform confidence.

The alternative — build content-informed selection now — was declined not
on merit but on order: it lands new per-search cost inside item 25's open
question ("a search" currently names two operations whose costs differ by
orders of magnitude, and a failed run maps to nothing recorded). Capability
whose price is unknown is how a commercial model ends up subsidizing its
most expensive customers. Honesty first; capability when its price is known.

This is the fourth population ruling in three days wearing a new face:
0021 named the set behind a count, 0022 the distribution behind a rate,
0023 the row behind a parse, 0024 the pages behind an absence — and 0025
names the reach behind a selection. In each case the defect was a value
detached from what produced it, and the remedy was to make the detachment
impossible to report silently.

## Test of compliance

For any selection recall this project reports, a reader can answer: *how
did each population fare — the pages whose names advertise them, and the
pages whose names do not?* For any consumer of selection output, a reader
can answer: *did it know, before trusting the selection, whether the
manifest offered names to read?* If either answer is missing, the report or
the consumer fails.

## Scope

Authorizes item 46, in `scripts/reference-recall.ts` only: per-fact rows
name each ground-truth URL's advertised status (derivable in discovery-only
runs, so it prints there too); selection recall, when measured, is reported
split by the axis with per-population distributions; the summary names each
manifest's name-signal profile where it bears on the numbers. Derived from
the same manifest entries the run already builds — never recomputed a
second way, never hard-coded.

Does not authorize: any change to `lib/tier2/select.ts`, any change to
manifest construction or `isMandatoryPath`, item 45's plumbing, or the
clause-4 experiment. Clause 3's pipeline-side surfacing binds `lib/tier2/`
consumers when they are next built or touched (there is no live caller of
selectPages today — verified: both callers are measurement and ops
scripts).
