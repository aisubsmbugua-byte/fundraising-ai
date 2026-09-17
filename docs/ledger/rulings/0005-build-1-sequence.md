---
id: 0005
title: Build 1 proceeds one step at a time, each stopping for review before the next
status: settled
provenance: reconstructed
supersedes:
date: 2026-09-16
---

## The ruling

Build 1 (the Research Agent qualification pipeline) is built in ten steps, in
order. Each step stops for review after its acceptance tests pass. No step starts
before the previous one is reviewed.

| Step | Subject | Status |
|------|---------|--------|
| 1 | Decision contract and screening materiality | done |
| 2 | Tier 1 registry retrieval, progressive publication | done |
| 3 | Tier 2 discovery, manifest reduction, selection, fetch | retrieval tuning stopped; persistence deferred to manifest schema freeze |
| 3b | Page-selection reference set and recall measurement | reference set frozen; selection/fetch recall not yet measured |
| 4 | Essential availability states | done |
| 5 | Deterministic disqualification rules | next |
| 6 | Evidence-backed graded fit assessment | pending |
| 7 | Verify recommendation-cited facts before display | pending |
| 8 | Recommendation and immutable approval record | pending |
| 9 | Remaining availability states: stale and conflicting | pending |
| 10 | Authorized gap-directed research | pending |

## Why one at a time

The recurring defect on this project is a concept wired into some call sites and
not others. That is invisible inside a large batch of changes and obvious at the
boundary of a small one.

## Constraints carried

- Migrations are additive and applied by the user, never by the assistant.
- Every model call is run by the user — the assistant sandbox has no API key.
- Database writes are handed to the user, not executed.
- Migration SQL is pasted inline in the closing message, not merely named.

**Provenance: reconstructed** from the session transcript. The step table
reflects state as of Step 4 completion.
