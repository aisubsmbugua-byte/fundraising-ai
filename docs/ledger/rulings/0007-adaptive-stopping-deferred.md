---
id: 0007
title: Adaptive search stopping is deferred until the pipeline is correct
status: settled
provenance: reconstructed
supersedes:
date: 2026-09-16
---

## The ruling

Adaptive search stopping — ending a search early when returns diminish — is not
built during Build 1. It is an optimization, and optimizing a pipeline whose
correctness is still being established would tune against a moving target and
make regressions unattributable.

Same disposition for the denomination registry: built incrementally and
evidence-linked, not inferred in bulk.

## Why

The user's stated priority is speed and accuracy, and the measured latency and
variance both traced to a single agentic call rather than to search volume. The
available win is in that call, not in stopping earlier.

## Revisit when

Steps 5–8 are complete and recall is measured against the frozen reference set,
so a stopping rule can be evaluated against a stable baseline.

**Provenance: reconstructed** from the session transcript.
