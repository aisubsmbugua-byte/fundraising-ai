# Build 1 Qualification Plan

**Status:** plan for review. **No implementation authorized.**
**Date:** 2026-09-02
**Responds to:** the external architecture recommendation, seven requests.

---

## 1. Assessment against the current implementation

### 1.1 Where the recommendation improves on our own design

Three points are better than what we proposed, not merely consistent with it.

**The decision contract fixes a defect our design could not.** Our design keyed
planning off *subject type*; the recommendation keys it off *the decision being
supported*, with opportunity, operating organization and legal entity as three
separate named fields, and says explicitly that organization type "informs this
contract but should not control it by itself."

That is the precise fix for the largest known defect in our design — that it
classified, retrieved and matched entirely at the entity layer, contradicting
the settled decision that the unit of pursuit is the opportunity. And it works
**without the deferred schema redesign**, because the contract is a runtime
object, not a table. One prospect row can still hold one opportunity while the
contract carries all three layers explicitly.

**Seven availability states beat our three.** We proposed *found /
structurally unavailable / not checked*. The recommendation adds **not
applicable** (an individual has no 990 — that is not the same as unavailable),
**stale** (filings lag one to two years, so freshness is a first-class
property), and **conflicting** (two sources disagreeing is a real state our
ledger would have silently collapsed).

**The immutable approval record catches something we missed.** We proposed
recording which evidence a recommendation cited. The recommendation adds the
**nonprofit profile version**. That matters more than it looks: the graded fit
assessment compares against `org_profile`, so editing the profile later would
silently invalidate every past decision without any record of why. We had no
answer for that.

### 1.2 Where it agrees with what is already built

Substantial parts of the recommendation already exist and must not be rebuilt:

| Recommendation | Already in the codebase |
|---|---|
| Model selects evidence, never generates quotations | Extraction selects `evidence_ids`; evidence ledger stores captured text with `content_hash` |
| Preserve entity safeguards | Two-layer identity, entity validation statuses, identity gates the run |
| Rules disqualify deterministically | `geographic_restriction` already split from `geographic_focus`, with the reasoning recorded |
| Model/prompt/code versioning in the audit record | `research_runs.prompt_version`, `.extraction_schema_version`, `.code_version` exist |
| Screening-specific materiality | Per-consumer grading exists; only the screening entry is missing |
| Progressive presentation | Polling already exists — see 1.4 |

### 1.3 Where it conflicts with the current implementation

**Retrieval location.** Today one agentic call plans, searches, fetches and
decides when to stop, executed inline in a server action. The recommendation
requires code-controlled retrieval. This is the central change and everything
else depends on it.

**Approval granularity.** `loadApprovedIntelligence` admits only individually
approved claims to downstream use, and `RESEARCH_APPROVAL_DECISIONS` is a
per-claim vocabulary. Recommendation-level approval needs a new record type
alongside it — not a replacement, since later stages still gate their own facts.

**No `org_profile` versioning exists.** The table has no version or `updated_at`
column. The audit record in the recommendation cannot be built without adding
one. This is a genuine gap requiring a migration.

**No fact key for denominational incompatibility.** The recommendation lists it
as a deterministic disqualifier. `funding.funder_type` mentions "denominational
fund" as a *type*, but no key captures a denominational *restriction*. Given
the sector this platform serves, this is a real omission.

### 1.4 A correction to our own design document

We claimed progressive rendering "requires infrastructure that does not exist."
That was wrong. `ResearchPanel` already polls `/api/research-runs/[prospectId]`
every **1.5 seconds** and the route already returns a status snapshot. The
machinery is built.

What actually blocks it is narrower and more interesting: **the run writes
nothing until the end by deliberate design.** Claims, evidence and coverage are
inserted while status is still `extracting`, and the flip to `ready` is the last
write, so no consumer ever sees a partial run. That is a correctness property,
not an oversight.

Progressive rendering appears to conflict with it, and the resolution matters:
**each tier's output is complete at its own tier, not a partial version of the
final answer.** Tier 1 produces a finished fact — this is the right legal
entity, it paid grants in its most recent filing. Publishing that is not
publishing partial data. The safety property is preserved by making each tier's
write atomic and complete-for-that-tier, rather than by deferring all writes to
the end.

---

## 2. Correctness risks created by narrowing Build 1 to qualification

**2.1 Narrowing the decision must not narrow retrieval.** The single largest
risk. If the contract's "permitted retrieval depth" is read as *gather only what
the gate needs*, every later stage pays for a second retrieval pass, and the
shared corpus — the thing that makes return visits instant — delivers little.
The rule should be: **narrow what is graded and shown; keep retrieval broad
wherever it is cheap.** Tier 1 and Tier 2 cost about the same whether we grade
two facts or forty, so gather forty and grade two.

**2.2 A thin "pursue" defers ineligibility rather than removing it.** Qualifying
on two predicates means an application-stage disqualifier can surface after the
executive has committed time. This is acceptable only because the recommendation
already states the right rule — *absence of a rule may not be treated as proof
of eligibility* — so any disqualifier actually found still applies at the gate.
It should be recorded as a known, accepted deferral.

**2.3 Fewer facts shown means fewer chances for a human to catch a wrong
entity.** Wrong organization is the worst-ranked failure, and we are reducing
what the user sees from 42 items to about five. The mitigation is real but must
be stated: identity moves from model inference to a **registry lookup**, which
is stronger evidence than what a human was previously scanning. Net risk is
lower, but only if Tier 1 identity is genuinely deterministic.

**2.4 Graded fit concentrates trust in one model judgment.** Our measurements
show 44% of material claims arriving not fully supported. A single graded
verdict with five cited facts is a smaller surface for error to hide in, but a
larger consequence when it is wrong. Verification must continue to run.

**2.5 DAF sponsors remain unsolved — by both documents.** Neither our design nor
the recommendation answers what pursue/dismiss means for a donor-advised-fund
sponsor. Both predicates are ill-formed against one: it is unambiguously
legitimate and unambiguously grantmaking, and its priorities are the aggregate
of thousands of unrelated donors, so the real funder is the individual
donor-advisor. **NCF is in the pipeline three times** — the most duplicated
entity in the live data. This needs a decision before the classifier is built,
because it determines what the classifier emits.

---

## 3. Build 1 scope

The recommendation lists ten items. We agree with all ten as Build 1 scope. We
separate them by whether they are on the **critical path to a working
pursue/dismiss** or are improvements to it — a sequencing distinction, not a
scope disagreement.

### 3.1 Critical path — required for the decision product

1. **Decision contract** — opportunity, operating org, legal entity, sources,
   disclosure characteristics, profile version, required facts, retrieval
   depth, freshness.
2. **Screening materiality** — add the screening consumer to the existing
   per-consumer grading. Small, pure data.
3. **Tier 1 registry retrieval** — legal identity, foundation code, assets,
   filing series with grants paid. Settles predicate 1 deterministically.
4. **Tier 2 own-material retrieval + corpus** — sitemap-first, link-extraction
   fallback, plain HTTP from our server.
5. **Deterministic disqualification** — applied in code over captured rules.
6. **Evidence-backed graded fit** — strong / plausible / weak, reasoning,
   selected evidence IDs, basis (stated / revealed / both).
7. **Recommendation and its approval record** — immutable, with profile
   version, rules applied, model and prompt version, human decision.
8. **`org_profile` versioning** — a migration; prerequisite for item 7.

### 3.2 Build 1, but after the first working decision

9. **Availability and freshness states** — the full seven. Three suffice to
   ship a correct first decision; the remaining four are what stop reruns, so
   they follow immediately.
10. **Progressive presentation** — real user value, but the decision is correct
    without it. Cheaper than we previously claimed (1.4).
11. **Authorized gap-directed follow-up** — depends on item 9 being in place to
    identify which gaps are worth offering.

### 3.3 Deferred, per the recommendation

Cross-tenant reuse · social-network pathfinding · proposal generation ·
multi-opportunity schema redesign · automatic deep-research escalation ·
permanent search-provider migration. **Tier 3 open search is also not required
for the gate** and can follow the critical path.

---

## 4. Keeping the existing Research Agent operational

**No feature flag.** The codebase has no flag infrastructure (only a single
`process.env.DISABLE_AUTH` check), and an environment toggle would make the two
paths mutually exclusive — the opposite of what we need.

`research_runs` is already **versioned per prospect** (`allocateResearchRunVersion`),
which is how one funder accumulated twenty-nine runs. The natural mechanism is
to add a **`pipeline` discriminator** (`agentic` | `qualification`) to that
table. Both paths write the same tables, the existing agent remains the default
and is untouched, and the new path is opt-in from `/admin/research` first and
the prospect page later.

The benefit over a flag: **both pipelines can run against the same prospect and
be compared directly**, which is the comparison the acceptance criteria need
anyway.

---

## 5. Acceptance criteria

Measured against a fixed set, reported as a table, no criterion judged by fact
count.

| Criterion | Measure | Target |
|---|---|---|
| **Correct entity** | Wrong-entity recommendations on the fixed set | **Zero** |
| **Retrieval determinism** | Same prospect run twice → identical source URL set | **100%** (it is code) |
| **Reasoning stability** | Same stored evidence → same verdict, 5 repeats | ≥ 90% identical |
| **Time to first result** | Identity + grantmaking status on screen | p95 < 3s |
| **Time to fit assessment** | Graded verdict on screen | p95 < 15s |
| **Time to full recommendation** | Non-blocking completion | p95 < 60s |
| **Return visit** | Second open of same prospect | < 1s, no retrieval |
| **User decisions per prospect** | Consequential decisions asked | ≤ 5 (from 42) |
| **Tier 2 coverage** | Prospects where own material was retrieved | Measure first, then target |
| **Verdict distribution** | Pursue / dismiss / insufficient evidence | No silent conversion of insufficient → dismiss |
| **Reruns** | Runs per prospect reaching a decision | Trending to 1 |

Two criteria are deliberately **not** thresholds yet. Tier 2 coverage has to be
measured before a target is honest — we have tested two sites. And verdict
accuracy needs human adjudication on the fixed set to establish ground truth.

## 6. Fixed test set

Not a random sample. Every prospect below is included because it breaks
something specific:

| Prospect | What it tests |
|---|---|
| **Maclellan Foundation** | Rich sitemap (13 pages, 9 relevant); guidelines behind a Salesforce login portal |
| **National Christian Foundation** | DAF sponsor — predicates ill-formed; no sitemap (404); donor-facing site; duplicated 3× |
| **The Stewardship Foundation** | Registry-rich, grant schedule genuinely unpublished; five prior runs as a baseline |
| **Servants Heart** | Long verification history; 43 claims, 24 material |
| **Mission to the World** | Denominational agency — the operating/legal/opportunity layering case |
| **A no-website prospect** | Tier 2 empty; must return insufficient evidence, not dismissal |
| **A non-US or individual prospect** | Tier 1 empty; the disclosure-regime edge |

Plus **replay against the 40 stored runs** for reasoning stability, using the
existing `replay-extraction.ts` and `replay-resolution.ts` harnesses. This is
what makes stability measurable at all, and it is free.

---

## 7. Sequence

**Step 0 — measure, commit nothing.** Run Tier 2 discovery across all 32
prospects: sitemap availability, page yield, fetch failures, HTTP status
distribution. Read-only. **This decides whether the design survives**, and two
sites is not a sample.

**Step 1** — decision contract + screening materiality. Pure logic, testable
without any network call.

**Step 2** — Tier 1 + predicate 1, written behind the `pipeline` discriminator.
First real user-visible output.

**Step 3** — corpus + Tier 2 + deterministic disqualification.

**Step 4** — graded fit + recommendation + approval record (with the
`org_profile` version migration).

**Step 5** — full availability states, then progressive presentation, then
gap-directed follow-up.

Search-provider comparison happens **after** step 3, when retrieval is separated
and the comparison is finally fair — exactly as the recommendation states.

---

## 8. Stopping here for review

Two decisions are needed before step 1, because both change what the decision
contract emits:

1. **What does pursue/dismiss mean for a DAF sponsor?** Section 2.5. Unsolved by
   both documents, and live in the data three times over.
2. **Is denominational incompatibility a Build 1 disqualifier?** If so it needs
   a new fact key, and it is the one rule in the recommendation with no home in
   the current model.

One decision is needed before step 4:

3. **Does recommendation-level approval replace or supplement per-claim
   approval for downstream consumers?** Our reading is *supplement* — the cited
   subset becomes approved for the pursue decision only, and later stages gate
   their own facts. Worth confirming, since it determines whether
   `loadApprovedIntelligence` changes or merely gains a second source.

No code will be written until these are settled.
