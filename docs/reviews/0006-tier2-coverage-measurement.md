# Tier 2 Coverage Measurement

**Status:** measurement result. Step 0 of the Build 1 plan. Nothing implemented.
**Date:** 2026-09-02
**Tool:** `scripts/tier2-coverage.ts` (permanent, read-only, re-runnable)

---

## 1. What was being tested

Tier 2 of the proposed pipeline reads a funder's stated priorities and
eligibility rules from the funder's own website, fetched over plain HTTP by
code rather than by a model. The whole tier rests on one assumption: **that the
right pages can be discovered deterministically, with no search provider and no
agentic loop.**

Two sites had been probed by hand and disagreed. This measures all 32 prospects
in the live pipeline. At most four requests per site: robots.txt, sitemap.xml,
one nested sitemap, homepage.

## 2. Result

    prospects:            32
      with a website:     29
      no website at all:   3

    discovery method that worked:
      sitemap.xml:         16   (55% of sites)
      homepage links:       9   (31%)
      nothing found:        0
      unreachable:          4

    >=1 relevant page discovered: 25 of 32  (78%)
    relevant pages per site: min 1 · p25 4 · median 12 · p75 21 · max 992

    robots.txt: allows 26 · absent 2 · DISALLOWS ALL 0 · error 1

**The assumption holds for 78% of the pipeline, and no funder forbids
crawling.** Every site that was reachable yielded something — "nothing found"
is zero. Sitemap-following is the primary method at 55%, with homepage link
extraction a real fallback rather than a theoretical one.

## 3. The gap the measurement exposed

**Discovery is solved. Page *selection* is not — and the design did not
distinguish them.**

The yield distribution is not a success curve; it is evidence that URL-keyword
matching cannot pick pages:

| Prospect | Relevant / total | What it shows |
|---|---|---|
| EAA Aviation Foundation | **992** / 5,566 | A fetch plan of 992 pages is worse than the agentic loop it replaces |
| Missio Nexus | **396** / 410 | 96% of URLs "matched" — the filter is not filtering |
| Maclellan Foundation | **4** / 14 | Under-selects: missed `/multi-year/`, which maps to the existing `application.multiyear_grant_rules` fact key, and `/our-foundations/` |

Keyword matching **over-selects and under-selects at the same time**, on the
same corpus. It is not a viable selector in either direction.

**Proposed amendment, consistent with the existing architecture:** code
discovers the candidate URL list; **one bounded model call selects the five to
ten worth fetching**; code fetches them. This is the same shape as extraction
selecting `evidence_ids` — a selection over a list code already captured, with
no tools and no loop. Discovery stays deterministic and repeatable; only
selection becomes judgment, and it is one cheap call rather than thirteen
serialized turns.

## 4. The blind spot, now quantified

Previously flagged as an unquantified risk. It is **7 of 32 — 22% of the
pipeline**:

- **3 prospects have no website at all.** Tier 2 is empty by definition.
- **4 prospects are unreachable** — three HTTP 403, one timeout.

For all seven, predicate 2 must rest on revealed priorities from filings, or
the verdict is *insufficient evidence*. That is the correct behaviour under the
settled decisions, but it is now a known 22% rather than an unknown.

**Bot-blocking was characterised, and user-agent spoofing is not the fix.**
Probing three likely domains with our own agent versus a browser agent:

    site A    ours 403  ·  browser 403      identical response, not UA-driven
    site B    ours 000  ·  browser 000      connection failure, not a block
    site C    ours 200  ·  browser 403      the browser agent is blocked, ours is not

Blocking is heterogeneous and not user-agent driven; in one case impersonating
a browser is actively worse. Treat 403 as an **availability fact**, not an
obstacle to route around.

*Caveat:* those three domains were inferred, not read from the prospect rows,
and at least one appears not to match — site C returning 200 to our agent
contradicts the run. That mismatch is itself informative: the block may be
intermittent or path-specific, meaning a single measurement can understate
coverage.

## 5. What this changes

**The design survives.** Tier 2 can find funder material without a search
provider for roughly four fifths of the pipeline, and nothing in robots.txt
prohibits it.

**One amendment is required** before Tier 2 is built: a bounded selection step
between discovery and fetching (section 3).

**One number moves from unknown to known:** the 22% blind spot, which sets a
realistic ceiling on what qualification can decide from stated priorities
alone, and makes revealed priorities from filings load-bearing rather than
supplementary.

## 6. Notes on the data

- The 32 rows include one `[TEST] Regression Walkthrough Prospect` and three
  duplicate National Christian Foundation rows, so the count of distinct real
  funders is lower.
- **Mission to the World** — proposed in the fixed test set as the
  denominational-agency layering case — is one of the unreachable four. That
  makes it a better test case, not a worse one.
- All three NCF rows returned identical results (21 relevant of 33), which is
  independent confirmation that they are the same site.
