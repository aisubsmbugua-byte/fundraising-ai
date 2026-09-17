# Build 1 — Approved Scope

**Status:** approved by external review, with sequencing changes. Awaiting
owner authorization to begin.
**Date:** 2026-09-02
**Supersedes the sequencing in:** `0005-build-1-qualification-plan.md` (which
remains the record of what was reviewed).

---

## 1. What Build 1 is

A **qualification decision system**, not a dossier generator. It answers one
question about one funding opportunity — *is this real, active, and a fit for
this nonprofit* — and returns **pursue**, **dismiss**, or **insufficient
evidence**, with about five decision-material facts and a next action.

Insufficient evidence is never silently converted to dismissal.

---

## 2. Corrections carried in from review

**2.1 Tier 1 does not "settle" identity deterministically.** Structured
retrieval is deterministic; the underlying identity may still be ambiguous.
Predicate 1 returns one of four values: **established**, **conflicting**,
**insufficient evidence**, **not applicable for this disclosure regime**.

This is not hypothetical. A registry name search for "stewardship foundation"
returns **80 organizations**, several sharing that exact name in different
states. Determinism of the *lookup* is not determinism of the *answer*.

**2.2 The Tier 2 measurement was over-claimed.** The defensible result is:

- 25 of 32 pipeline rows produced *potentially useful* own-site pages.
- Every reachable website produced at least one candidate page.
- Seven rows lack usable direct-site retrieval.
- **Page selection quality remains unproven.**

It is not evidence that Tier 2 can reliably establish stated priorities for 78%
of prospects. Coverage is not established until section 5.2 is measured.

**2.3 A 403 is `retrieval_failed`, not structurally unavailable.** It may be
intermittent, path-specific or provider-specific. The system does not evade a
deliberate block, but may try bounded alternatives: another official page, an
official document indexed elsewhere, filing evidence, a search provider's
captured excerpt, or authorized deeper research.

---

## 3. Rulings on the three open decisions

**3.1 DAF sponsors.** A donor-advised-fund sponsor is not ordinarily the
funding opportunity. It establishes that a giving *channel* exists; its
aggregate grants do not establish priorities for any particular donor-advisor.

Classify as **funding intermediary / relationship channel**, unless a named
advised fund, specific program, or identifiable donor opportunity exists. Absent
that, do not produce a normal priority-fit verdict. Return:

> *Legitimate giving intermediary; no specific funder opportunity identified.*

**3.2 Denominational incompatibility.** In Build 1. Applies only when all three
hold: the funder **states** a denominational restriction; the nonprofit profile
**supplies** the relevant affiliation; and the two are **deterministically**
incompatible. Affiliation alone is never a disqualifier.

**3.3 Recommendation-level approval supplements per-claim approval.** Approving
the recommendation approves its cited facts **for the pursue/dismiss decision
only**. Later consumers approve whatever additional facts they use. Store the
nonprofit-profile **snapshot or content hash** — not merely an update timestamp
— so the original comparison can be reconstructed.

---

## 4. Build order

1. **Decision contract + screening materiality.** Pure logic, no network.
2. **Tier 1 with progressive publication.** Four-valued predicate 1 (2.1).
3. **Tier 2: discovery → manifest reduction → selection → fetch.** See 5.1.
4. **Essential availability states:** `found`, `checked_not_stated`,
   `not_checked`, `retrieval_failed`, `not_applicable`.
5. **Deterministic disqualification.**
6. **Evidence-backed graded fit** — strong / plausible / weak, with basis
   (stated / revealed / both) and selected evidence IDs.
7. **Verification of recommendation-cited facts only** — before the
   recommendation is presented as ready for approval. Not all 43 claims; only
   those affecting legitimacy, disqualification, priority alignment and the
   resulting verdict.
8. **Recommendation + immutable approval record.**
9. **Remaining availability states** — `stale`, `conflicting`.
10. **Authorized gap-directed research.**

Search-provider comparison happens after step 3, when retrieval is separated and
the comparison is finally fair.

---

## 5. Tier 2, specified

### 5.1 Deterministic manifest reduction, before any model call

EAA Aviation produced 5,566 URLs with 992 keyword matches. Passing that to a
model recreates the token and selection problem in a new form. Code must first:

- Canonicalize and deduplicate URLs.
- Remove assets, tags, author pages, archives and pagination.
- Group repeated path patterns.
- Preserve page titles and sitemap metadata.
- Retain mandatory patterns — grants, eligibility, guidelines, funding,
  application, programs.
- **Cap the candidate set.**

The model selects from a **curated manifest**, never the raw sitemap. One
bounded call, no tools, no loop.

### 5.2 Page-selection reference test — required before coverage is claimed

A small, manually reviewed reference set. For each funder, a human records which
pages actually carry each of:

- Priority evidence
- Geographic restrictions
- Recipient restrictions
- Program currency
- Application or program pages, where they exist

Tier 2 is then measured on whether it **finds those specific pages** — not on
how many keyword matches it returns.

---

## 6. Acceptance criteria

| Criterion | Measure | Target |
|---|---|---|
| **Correct entity** | Wrong-entity recommendations on the fixed set | **Zero** |
| **Source-set determinism** | Same prospect twice against a **frozen discovery manifest** | 100% identical |
| **Verdict stability** | `pursue` / `dismiss` / `insufficient` on identical evidence **and profile**, 5 repeats | **100% identical** |
| **Explanatory wording** | Reasoning text across the same repeats | Lower stability permitted |
| **Selection quality** | Reference-set pages found (5.2) | Measure, then target |
| **Time to first result** | Identity + entity grantmaking on screen | p95 < 3s |
| **Time to fit assessment** | Graded verdict on screen | p95 < 15s |
| **Time to full recommendation** | Including verification of cited facts | p95 < 60s |
| **Return visit** | Second open of same prospect | < 1s, no retrieval |
| **User decisions per prospect** | Consequential decisions asked | ≤ 5 |
| **Insufficient evidence** | Conversion to dismissal | **Never** |

Determinism is tested against a **frozen manifest** because live websites
legitimately change; testing against the live web would measure the web, not
the system.

## 7. Fixed test set

Each row breaks something specific:

| Case | Prospect / condition |
|---|---|
| Rich sitemap; guidelines behind a login portal | Maclellan Foundation |
| **DAF intermediary** | National Christian Foundation (no sitemap; duplicated 3×) |
| Registry-rich, grant schedule unpublished | The Stewardship Foundation |
| **Exact named opportunity** | Missio Nexus — Ministry Innovation Fund |
| Denominational agency; **official website blocked** | Mission to the World |
| Long verification history | Servants Heart Foundation |
| **No website at all** | Phil Thompson (individual) |
| **Aggregator mistaken for official domain** | to be selected |
| **Merger or renamed entity** | to be selected |
| **Conflicting legal identities** | to be selected — the 80-result registry name collision |

Plus replay against the 40 stored runs for verdict stability, using the existing
`replay-extraction.ts` and `replay-resolution.ts` harnesses.

---

## 8. Open items flagged back

Four consequences of the rulings that the rulings do not themselves resolve.

**8.1 `org_profile` has no denominational affiliation field.** Rule 3.2 requires
the profile to supply affiliation. The table holds mission, programs,
who_we_serve, org_type, cause_areas, geographic_area and others — none capture
denomination. A profile column is a prerequisite for the rule, not a
consequence of it.

**8.2 `eligibility.` would be a new key namespace.** Existing keys use
`application.`, `funding.`, `identity.`, `people.`. An `eligibility` **section**
already exists and groups keys drawn from `application.*` and `funding.*` —
sections and namespaces are deliberately independent. `eligibility.denominational_restriction`
therefore either starts a new namespace on purpose, or should be
`application.denominational_restriction` to follow convention. Worth deciding
rather than drifting.

**8.3 The DAF outcome may be a fourth terminal state.** *"Legitimate giving
intermediary; no specific funder opportunity identified"* is not *insufficient
evidence* — that means we could not establish something. This means we
established that the thing is not an opportunity. Closer to a dismissal with a
specific reason, or a genuinely fourth state. It needs a name in the schema.

**8.4 Verification now sits inside the latency ladder.** Step 7 places
verification of cited facts before the recommendation is presented. That is
correct for trust, but it puts a model pass inside the path to the 60-second
rung. Verifying ~5 facts should be fast; it is nonetheless a new dependency on
the timing targets and should be measured early rather than assumed.

**8.5 The frozen manifest must be stored.** Determinism testing against a frozen
discovery manifest means the corpus persists the manifest itself, not only the
fetched pages. A small addition, easy to omit until the first determinism test
fails.
