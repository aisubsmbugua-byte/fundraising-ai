---
id: 0001
title: Every case-specific failure is translated into a general system invariant before code changes
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

A failure observed on one organization is a diagnostic case. It does not
authorize a change by itself. Before code is written, the failure must be stated
as an invariant that holds for every subject the system will ever see.

The individual organizations in `docs/reference-set/` are diagnostic cases, not
the product roadmap.

## Why

Case-driven patching produced a system that worked on the cases it had been
patched for and drifted everywhere else. It also produced the session's most
persistent defect shape: a concept wired into the call site where the case
appeared, and not into the other five.

## Test of compliance

If the justification for a change cannot be written without naming a specific
funder, the change is not ready.

## Worked examples

- Not a ruling: "Maclellan's /fund page is thin, handle it."
- A ruling: "A page under the substantive-text threshold leaves the fact
  `not_checked`, never `checked_not_stated` — a page that loaded and a page that
  said something are different facts."
