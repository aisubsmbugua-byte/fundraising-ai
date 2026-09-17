# Research Pipeline Design

**Status:** design only. No implementation authorized.
**Date:** 2026-09-02
**Companion to:** *Prospect Research Architecture* (problem) and *Reviewer
Questions Answered* (22 settled decisions)

---

## 1. What this is

The two prior documents established a problem and a direction. This one is the
concrete design that follows from them, plus an adversarial review of that
design against the 22 settled decisions.

It is written to be attacked. Section 6 lists where the design **fails** a
settled decision, and section 7 lists what remains unproven. Those two sections
are the point of the document.

---

## 2. The pipeline

Five stages. Code decides what to retrieve; models read and judge.

### Stage A — Classify the subject

Determines subject type and disclosure regime, from which the expected evidence
surface follows.

**Mostly not a model judgment**, which materially lowers the risk flagged
earlier. Where an EIN exists, the registry record returns `foundation_code`,
`subsection_code` and `pf_filing_requirement_code` — authoritative fields, not
inference. A model classifies only when no EIN and no registry match exist.

### Stage B — Tier 1 retrieval (structured, ~500ms)

Registry lookup by EIN, or name search resolving to one. Returns legal name,
address, foundation code, assets, income, and a filing series carrying grants
paid per year.

Decides **predicate 1, `legitimate`**: identified, and most recent filing shows
grants paid within two filing years. Deterministic; no model.

**→ Renders rung 1 (~1 second).**

### Stage C — Tier 2 retrieval (known addresses, parallel, ~2–5s)

Fetches the funder's own material over plain HTTP from our server. Page
discovery, in order:

1. `sitemap.xml`, following a sitemap index one hop.
2. Homepage link extraction, filtered by anchor text and href keywords.
3. Neither available → an availability fact, not a failure.

Then, from the retrieved corpus:

- **Eligibility rules extracted and applied deterministically.** These can only
  disqualify.
- **Graded priority match** against `org_profile` — *strong / plausible /
  weak*, with reasoning and cited evidence.

**→ Renders rung 2 (~10 seconds).**

**A structural gain worth naming:** because code fetches rather than the model,
the `web_fetch` prior-context rule disappears. Three of eight fetch failures in
the last measured run were `url_not_in_prior_context` — the model attempting a
URL it had not been shown. That failure class cannot occur here.

### Stage D — Tier 3 (bounded open search, non-blocking)

Only what has no address: news, personnel changes, current priorities,
relationship signals. A bounded budget, not an open loop. **Not required for
the gate.**

**→ Renders rung 3 (~45 seconds).**

### Stage E — Synthesis

A recommendation — *pursue*, *dismiss*, or *insufficient evidence* — with its
grade, its reasoning, and the specific evidence it cites. Plus the availability
ledger: for every target fact, **found**, **checked and structurally
unavailable**, or **not checked**.

---

## 3. What changes

**New:** a document corpus (org-scoped, keyed by url + content hash); an
availability ledger; a screening entry in the per-consumer fact grading; a
recommendation record linking to the evidence it cited, so approving the
recommendation can scope approval to exactly those facts.

**Changed:** retrieval moves out of the model and into code; extraction becomes
single-pass and toolless; the prospect page renders progressively instead of
waiting.

**Unchanged:** the evidence ledger, the two-layer identity model, the capture
contract, tenant isolation, and every hard rule.

---

## 4. Assumptions tested before writing this

**Registry data answers predicate 1 deterministically.** Verified: a single
JSON call returns legal identity, foundation code, assets, income and ten years
of filings including grants paid. Sub-second, zero variance.

**Tier 2 can find a funder's own material without search.** Tested on two live
prospects, with mixed results that changed the design:

| Method | maclellan.net | ncfgiving.com |
|---|---|---|
| Homepage link extraction | 2 candidates of 28 links — one a login portal | 2 candidates of 36 links, both donor-facing |
| `sitemap.xml` | Index → 13 pages, 9 relevant | **404** |

Sitemap-following is substantially better than link extraction and is now the
primary method. Maclellan's sitemap yields `/fund/`, `/grantees/`,
`/multi-year/`, `/fiscal-sponsorship/`, `/faq/` — three of which map directly
onto existing fact keys, and `/grantees/` supplying revealed priorities.

**But coverage is not universal**, and the failure modes are systematic rather
than random: guidelines behind authentication (Maclellan's grant portal is a
Salesforce login), no sitemap at all (NCF), and sites whose audience is not
grantseekers.

---

## 5. Where the design holds

Against the settled decisions, these are satisfied by construction:

- **Speed (Q10).** Rungs map to tiers; each renders as it lands.
- **Legitimate (Q14).** Entity-level from Tier 1; program currency a Tier 2
  flag.
- **Geographic restriction (Q15).** Tier 2, deterministic, disqualifying only.
- **Rules vs judgment (Q20).** Rules subtract in code; graded judgment adds.
- **Stated vs revealed (Q21).** Both captured, labeled by basis, vintage
  stamped.
- **Approval (Q16).** The recommendation record names its cited evidence, so
  approval scopes to it.
- **Absence never dismisses (Q18).** The ledger distinguishes unavailable from
  unchecked; only positive disconfirming evidence dismisses.
- **Tenant containment (Q19).** Corpus is org-scoped, with url and hash present
  for a later cross-tenant collapse.
- **Classifier risk.** Lower than feared — registry fields, not inference,
  wherever an EIN exists.

---

## 6. Where the design fails a settled decision

**6.1 It does not model opportunity-level priorities — contradicting Q13.**

The settled unit of pursuit is the *opportunity*, with priorities resolving at
that layer. This design classifies, retrieves and matches at the **entity**
layer throughout. For a single-program foundation the two coincide and nothing
breaks. For a denomination with a disaster-relief fund and a church-planting
fund, the design produces one entity-level match where the settled decision
requires two.

This is the largest known defect in the design. It is not fixed by the Build 1
schema deferral: that deferral said one prospect row holds one opportunity, not
that priorities are an entity-level property.

**6.2 Donor-advised-fund sponsors break the pursue/dismiss frame entirely.**

Surfaced by the probe, not anticipated. NCF's website targets *donors*, not
grantseekers, because a DAF sponsor does not run an open grant program — the
funder a grantseeker actually deals with is the individual donor-advisor. Both
predicates are ill-formed against the sponsor: it is unambiguously legitimate
and unambiguously grantmaking, and its "priorities" are the aggregate of
thousands of unrelated donors.

NCF is currently in the pipeline **three times**. This is not a hypothetical
subject type; it is the most duplicated entity in the live data.

**6.3 The ladder requires progressive rendering that does not exist.**

Rungs are presented as a property of the retrieval design, but a tiered backend
delivers nothing to the user without an interface that renders partial results.
The current page polls for a finished run. This is real work and the design
above understates it as a consequence.

---

## 7. Unproven assumptions

- **Tier 2 coverage across the pipeline is unmeasured.** Two sites were tested.
  The right next step is to run discovery-only against all 32 prospects and
  report sitemap availability, page yield, and fetch failures — a cheap,
  read-only measurement that would either justify this design or kill it.
- **The dead zone is unquantified.** A funder publishing no stated priorities,
  whose grant schedule is also unobtainable, can never satisfy predicate 2 and
  will return *insufficient evidence* permanently. Both conditions have been
  observed separately. How often they co-occur is unknown.
- **Extraction quality under a code-assembled corpus is untested.** The corpus
  will be larger and less curated than what an agentic loop selects. Extraction
  may degrade.
- **Timing estimates are arithmetic, not measurement.** No end-to-end run of
  this design exists.

---

## 8. If authorized, the order

1. **Measure Tier 2 coverage across all 32 prospects.** Read-only, no
   architecture committed. This decides whether the design survives.
2. **Corpus and availability ledger.** Independently useful, and the
   precondition for measuring anything else.
3. **Tier 1 and predicate 1.** Smallest, most deterministic, highest
   confidence.
4. **Tier 2, eligibility rules, graded match.**
5. **Progressive rendering.**
6. **Tier 3 and synthesis.**

Run behind a flag alongside the existing path, on the same prospects, and
compare. The corpus is what makes that comparison possible — and separating
retrieval from reasoning is what finally makes any of it measurable.

**Resolve 6.1 and 6.2 before step 3.** They change what the classifier
produces, and the classifier is step one.
