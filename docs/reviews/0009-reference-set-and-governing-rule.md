# The Reference Set, and the Governing Rule

**Status:** approved. Reference set to be frozen before further retrieval work.
**Date:** 2026-09-02

---

## 1. The governing rule

> **Every case-specific failure must be translated into a general system
> invariant before code is changed.**

Individual organizations in the reference set are **diagnostic cases, not a
roadmap**. Their purpose is to expose classes of failure. Retrieval and identity
logic must not be modified to improve one organization's result.

For every proposed fix:

1. Name the general failure class.
2. State which categories of prospect it affects.
3. Confirm no organization-specific behaviour is being introduced.
4. Test across the complete fixed reference set.
5. Report improvements **and regressions**, not only the triggering case.
6. Reject, or explicitly justify, any change that improves only one organization.

### Admission bar after the set is frozen

Further research or identity work enters Build 1 only if the issue can:

- cause a **wrong** qualification decision,
- **prevent** a qualification decision being produced,
- create **material unsupported information**, or
- force **unnecessary work back onto the user**.

Everything else is recorded for later and must not delay the user-facing
qualification product.

### Applying it retrospectively

The four changes made during Step 3 are checked against the rule:

| Change | Trigger | Failure class | Measured across set? |
|---|---|---|---|
| Merge sitemap + homepage discovery | Antioch selected 0 pages | One discovery source having pages the other lacks | Yes — 32 sites, +1,446 URLs |
| Query the operating organization | Ten funders read but unresolved | Registry indexes entities; we asked about programs | Yes — established 12 → 19 |
| `found_thin` coverage state | Maclellan `/fund` = 528 chars | A page that loads but says nothing is neither found nor failed | Yes — fired 4× |
| Monotonic reopen guard | One funder downgraded | Enlarging a candidate pool can destroy a unique match | Yes — 30 funders, 1 downgrade caught |

All four generalize and all four were measured across the full set. The rule is
recorded here because that discipline was implicit, and implicit discipline is
the thing this build keeps discovering it cannot rely on.

---

## 2. Systemic work, confirmed still valid

- Separate opportunity, operating organization and legal entity.
- Separate retrieval from reasoning.
- Prevent incomplete searches from becoming false conflicts.
- Use all available context before involving the user.
- Distinguish unavailable, unchecked and failed retrieval.
- Reuse captured evidence across stages.
- Produce a pursue / dismiss / insufficient / intermediary recommendation
  rather than a claim queue.
- Measure discovery, selection, fetching, evidence yield and decision
  sufficiency **separately**.

---

## 3. The reference set

Twelve cases, each chosen for a failure class rather than for its own sake.

| Case | Failure class it exercises |
|---|---|
| Maclellan Foundation | Clean baseline; priorities delivered as video (`found_thin`) |
| The Stewardship Foundation | Registry legal name carries trustee apparatus; 80-candidate search |
| EAA Aviation Foundation | Very large site (5,566 URLs); manifest cap reached |
| National Christian Foundation | DAF sponsor — `intermediary_only`; 75 same-token candidates |
| Christian and Missionary Alliance | Denominational program; a page fetch that fails |
| Saddleback Church | Church; nine same-token candidates in one state |
| Missio Nexus — Ministry Innovation Fund | Named opportunity distinct from its operating organization |
| The Antioch Foundation | Sitemap and homepage links disagree about what exists |
| Ronald Blue Trust | Site blocked or unreachable — `retrieval_failed`, not absent |
| Mariners Church | Display name is an opportunity phrase matching no legal name |
| The Signatry | DAF sponsor that DOES resolve — controls against over-fitting NCF |
| Presbyterian Mission Agency | Denominational agency, read successfully, still unresolved |

### What a human records

For each case, and for each of five decision-critical facts — **priorities,
geographic restriction, recipient restrictions, program currency, application
process** — the reviewer records one of:

- `stated`, with the specific URL(s) that state it
- `not_stated` — checked, and this funder does not publish it
- `unreviewed` — not yet examined

The middle value is the point. "This site does not publish eligibility rules"
is a finding about the funder; "we did not look" is a finding about us, and
collapsing them is the defect this whole build exists to remove.

### Why the template does not pre-fill

The reviewer browses the funder's site independently, without seeing what the
system discovered or selected. Showing the manifest first would let the reviewer
only record pages discovery already found — which would make discovery recall
100% by construction and measure nothing. Anchoring here would invalidate the
one number the set exists to produce.

### What it measures

Three recalls, reported separately and never combined:

- **Discovery recall** — of the URLs a human found, how many reached the manifest?
- **Selection recall** — how many did the model choose to read?
- **Fetch recall** — how many were actually read?

Plus **absence precision**: where a human recorded `not_stated`, did the system
correctly report `not_offered` rather than claiming a find?

A fact can be missed at three different stages, and a single blended "coverage"
figure would hide which. That distinction is what the earlier 78% claim lacked.

---

## 4. Freeze

Once populated, the fixture is frozen and versioned in the repository. It then
becomes the regression gate: no retrieval or identity change ships without a
report of improvements and regressions across all twelve.

The next milestone is not perfect research on every organization. It is a
dependable system that gives a busy nonprofit executive a defensible
recommendation while asking only consequential decisions of them.
