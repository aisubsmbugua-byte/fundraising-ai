---
id: 0018
title: A finding cites the artifact it read, a name is never evidence, and absence is claimed only from a search that would have found it
status: settled
provenance: verbatim
supersedes:
date: 2026-09-17
---

## The ruling

Applies to both spaces, and to any subagent either one dispatches.

1. **Every factual claim cites the artifact it came from** — file and line, table
   and migration, or the command run and its output. An uncited claim is not a
   finding and may not enter a doc, a ruling, or a build report.

2. **A name is not evidence.** A filename, a table name, a symbol name, or a
   statement in a neighbouring document does not establish what a thing is or
   does. If the artifact was not opened, the answer is *not checked* — never an
   inference dressed as a fact.

3. **A claim of absence names the search that would have found it.** "X does not
   exist" is only reportable alongside the query run and its scope. Absence is
   the highest-risk claim shape, because verifying it requires exhaustive search
   and a negative is what nobody double-checks.

4. **Subagent assignments overlap on purpose.** Work handed to parallel
   investigators is scoped with deliberate redundancy at the seams, and any
   contradiction between them is escalated rather than reconciled by picking the
   more confident one.

## Why

Measured 2026-09-17, during the roadmap documentation audit. Three subagents
inventoried the codebase; four of their claims were wrong, and the failures
shared a shape:

| Claim | Actual origin |
|---|---|
| a `followup` table exists | inferred from `0031_followup.sql`; the table is `interactions` |
| `lib/availability.ts` is "date/time utilities" | inferred from the filename; it is the availability ledger |
| `drafts` carries `sent_at` / `sent_by` / `resend_id` | read from `CLAUDE.md`, not from the migrations; the columns do not exist |
| `prospects` is not org-scoped | a claim of absence; `0033_multi_tenant_rls.sql:18` adds `organization_id` |

Three of four were inferred from a **name or a neighbouring document** rather
than read from the artifact. The fourth was an **absence** claim. Both shapes are
specific enough to rule against.

Had the last one reached `docs/architecture/OVERVIEW.md`, it would have
contradicted hard rule 6 in the document engineers consult before adding a table
— the precise place a wrong fact does most damage.

## Rule 2 is the project's own principle, pointed inward

`CLAUDE.md`: *a field a model wrote is a claim, not a fact.* The product enforces
this on funder research — the capture contract keeps the URLs a search actually
returned, and attestation tests the model's words against the captured text,
because a model recalling a source is not a source.

The documentation and decision process had no equivalent. A subagent's summary
was treated as a fact, which is the same trust the product refuses to extend to
its own extraction step.

Rule 2 is also ruling 0006 applied to our own work. *We read it and it isn't
there* and *we never looked* are different facts, and a guess from a filename is
the second one wearing the first one's label.

## Rule 4 is the counterintuitive one

The contradiction between subagents is what exposed all four errors. Each was
confident and internally coherent; none was detectable from its own report.

Cleanly partitioned assignments would have produced four uncontradicted reports
and four errors in the documentation. Redundancy at the seams is therefore not
waste — it is the only free error signal in a fan-out, and partitioning for
efficiency removes it.

This bounds what the two-space protocol can claim. `docs/ledger/README.md`
separates decision from build to get an independent check; separation alone does
not produce independence when both sides share a model's priors. Overlap and
artifact-citation are what make the check real.

## Test of compliance

Take any factual claim in `docs/`, `docs/ledger/` or a build report and follow
its citation. If there is no citation, or the citation is a name rather than
content, the ruling is not met.

For any "does not exist" claim, the search that establishes it is stated and
reproducible.

## Scope

Binding on both spaces immediately; costs nothing to apply. The mechanical half —
a check that every file path and table name cited in `docs/` actually exists —
is authorized as a separate queued item, not started while Step 4 is in flight.
