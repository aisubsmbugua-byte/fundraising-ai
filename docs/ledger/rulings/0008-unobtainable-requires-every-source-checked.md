---
id: 0008
title: A fact is unobtainable only when every source that could carry it has been checked
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

A fact that can come from more than one source takes the state of the *fact*,
not the state of whichever source happened to be consulted first.

Concretely, for a fact whose `source` is `either`:

- It is `checked_not_stated` only if **every** source that could carry it was
  read and none stated it.
- If any source that could carry it was never consulted, the fact is
  `not_checked` and therefore **obtainable**, regardless of what the other
  source said.
- `retrieval_failed` on any one source, with the others unread, leaves the fact
  obtainable.

The per-source outcomes are what get recorded. The fact's single state is
derived from all of them, never adopted from one.

## Why

Verified by direct probe of `deriveAvailability` at Step 4 as built. Given a
prospect whose registry record was never retrieved (`registry: null`) and whose
website was read for grants and said nothing:

```
funding.total_annual_giving   registry   not_checked          obtainable=true
funding.recent_grants         either     checked_not_stated   obtainable=false
funding.geographic_focus      either     not_checked          obtainable=true
```

The same ledger, from the same run, says both that no registry record was
retrieved and that `funding.recent_grants` cannot be obtained. The 990 grant
schedule — the single most valuable unread document for a grantmaker, and the
thing the existing UI already names as a rerun target — is declared a closed
question because a *different* source was silent.

The cause is structural, not a typo: `deriveAvailability` branches on
`source === "registry"` for the registry path and falls through to the site path
for everything else, so `either` never reaches the registry logic at all. The
guard `if (source === "registry" || source === "either")` opens a block whose
only inner test re-checks `source === "registry"` — the `either` case was
admitted and then not written.

This is failure shape 2 in its exact form: two facts collapsed into one value.
Ruling 0006 was written against the harm of offering a gap that cannot close.
This is the same root cause pointed the other way — suppressing a gap that can.
Both are the ledger lying about what we did.

`funding.geographic_focus` and `funding.recent_grants` are the only two `either`
keys in screening's required set, and both are wrong under this defect. Neither
is covered by any of the 29 Step 4 tests.

## Test of compliance

For every fact in the ledger, the reason string must be answerable for each
source the fact could have come from. If the reason names one source while
another was never consulted, the state is wrong.

A test that fixes `registry` to `retrieved: true` cannot detect this. The
end-to-end case must include a source that was never consulted alongside one
that was read and silent.

## Scope

This authorizes correcting the derivation and extending `scripts/test-availability.ts`
to cover `either`-sourced facts. It does not authorize changing which facts
screening requires, or the `FactSource` map itself.
