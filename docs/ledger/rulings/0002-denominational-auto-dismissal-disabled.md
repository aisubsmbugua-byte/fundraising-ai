---
id: 0002
title: Denominational auto-dismissal is disabled and stays disabled until the vocabulary is evidence-backed
status: settled
provenance: reconstructed
supersedes:
date: 2026-09-16
---

## The ruling

The system may not automatically dismiss a prospect on denominational grounds.
When a denominational restriction is found, the verdict is **review required**,
surfaced to the user as:

> A denominational restriction was found, but compatibility could not be
> determined automatically.

This holds until the denomination registry's entries are individually
evidence-backed and confirmed (tracked separately as the denomination registry
work).

## Why

Auto-dismissal on this axis is high-consequence and irreversible from the user's
point of view — a wrongly dismissed funder is never seen again, and the user has
no signal that it happened. The vocabulary needed to make the call correctly does
not yet exist in evidence-backed form, and inferring it from names would be
exactly the kind of model-written value this codebase treats as a claim rather
than a fact.

## How it is enforced

Structurally, not by prompt. `EMPTY_DENOMINATION_REGISTRY` in `lib/qualification.ts`
resolves nothing and reports nothing incompatible, so the auto-dismissal branch
is unreachable by construction rather than disabled by a flag someone could flip.

## Status note

Binding on Step 5 (deterministic disqualification rules) and every step after it.

**Provenance: reconstructed** from the session transcript. Confirm the exact
wording of the user-facing string in the decision space before relying on it.
