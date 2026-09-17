# Step 3 — Tier 2 Results, and What They Change

**Status:** for review. Nothing persisted; no migration required yet.
**Date:** 2026-09-02
**Measured on:** 30 distinct funders (32 prospect rows), live.

---

## 1. What was built

Tier 2 in four deterministic stages plus one bounded judgement:

1. **Discovery** — sitemap-first, homepage links as fallback. No search provider.
2. **Manifest reduction** — canonicalize, clean, collapse listings, cap. Pure code.
3. **Selection** — one model call, no tools, no loop. Returns *indices* into the manifest; it never writes a URL.
4. **Fetch** — code fetches. Availability recorded per purpose.
5. **Identity exchange** — deterministic. An EIN found on a funder's own site reopens a Tier 1 verdict. Tier 1 and Tier 2 run concurrently.

407 tests pass. Build and typecheck clean.

---

## 2. What works

**Reduction.** 8,176 raw URLs across the pipeline become 932 manifest entries — an 89% cut, median 36 entries per site. A model is never shown a sitemap.

**Fetching is solved.** 157 pages selected, **157 read, zero failures, zero empty responses.** Because code fetches rather than the model, the `url_not_in_prior_context` failure class — three of eight fetches in the last agentic run — cannot occur.

**Selection behaves.** Typically 5–8 pages, tagged with several purposes each rather than one fetch per question. EAA took 4 from 60 on a site that is mostly aviation news.

**Blocking is at the front door, not on pages.** Every 403 occurred during discovery. No selected page failed.

---

## 3. What does not

### 3.1 Identity is still unresolved for 17 of 30

```
BEFORE tier 2   established 12 · insufficient 13 · incomplete 3 · conflicting 2
AFTER  tier 2   established 13 · insufficient 13 · incomplete 2 · conflicting 2
reopened by tier 2: 3
```

Seven of the seventeen have no reachable website, and no amount of retrieval helps them. **The other ten had pages read successfully and still did not resolve.**

### 3.2 The identity exchange works, and yields little

Three funders were reopened by an EIN found on their own site; one improved. The argument for building this was that a funder's own site usually states its legal identity. Measured: Tier 2 read pages for 22 funders and supplied usable identity evidence for **3**. Most funder websites do not publish an EIN.

The mechanism is correct. Its ceiling is lower than the case made for it.

### 3.3 Latency misses an accepted criterion

```
p50 6,456ms   p95 21,007ms   max 31,500ms
```

The ~10-second rung holds at the median and fails at p95. The tail is slow funder sites, not our own processing.

### 3.4 Coverage is measured but unverified

```
priorities   found 22 · not_offered 1 · not_checked 7
eligibility  found 20 · not_offered 3 · not_checked 7
process      found 19 · found_thin 2 · not_offered 2 · not_checked 7
grants       found 20 · found_thin 2 · not_offered 1 · not_checked 7
```

**`found` means a substantive page tagged with that purpose loaded — not that the page states priorities.** This is the same distinction an earlier report collapsed when it claimed 78% coverage from keyword matching, and it is not being repeated. Turning these into coverage figures requires the reference set (task #11).

`found_thin` fired four times, so the state is catching real cases. It exists because maclellan.net/fund is 104KB of HTML yielding 528 characters — "what we fund" is delivered as an embedded video. Nothing failed; the page has no prose.

---

## 4. Root causes

**A. Registry queries carry opportunity names.** "NCF — Donor Advised Fund", "Hilton Foundation — Aviation Fund", "Missio Nexus — Ministry Innovation Fund". We ask a registry of *entities* about a *program*. The decision contract models operating organization, legal entity and opportunity as three separate layers; Tier 1's query does not yet use them. This is the largest single cause among the ten that were read but unresolved.

**B. Funder sites rarely publish an EIN.** Structural, not fixable by better parsing.

**C. Discovery picks one source, not both.** Antioch selected 0 pages from a 39-entry sitemap manifest. Re-running discovery now returns 11 entries via homepage links including `/how-to-apply`, `/what-we-do`, `/grant-highlights` and `/faq` — ideal pages the sitemap did not surface. Sitemap-first is right on average and wrong here.

---

## 5. Proposed solutions

**1. Merge discovery sources instead of choosing between them.** One extra HTTP request per funder, strictly more coverage, fixes Antioch directly. Low risk.

**2. Route Tier 1's registry query through the contract's operating-organization layer.** `searchableOrganizationName` already strips a qualifier, but nothing carries the three layers into the query. This is the biggest lever on the ten read-but-unresolved funders, and it uses a structure that already exists rather than adding one.

**3. Let site evidence NARROW a registry search without settling it.** Today only an EIN reopens Tier 1, because a legal name or address cannot identify an entity on its own. But a legal name plus a state, taken from the funder's own site, would cut an 80-candidate search to a handful — the same way `location` already does. It must narrow only; resolving on it would repeat the ambiguity with more confidence attached.

**4. Latency needs a decision, not a fix.** Tier 2 is non-blocking behind Tier 1's one-second rung, so a 21-second p95 may be acceptable. If it is not, the levers are fewer selected pages or higher fetch concurrency — both trade coverage or politeness for speed.

---

## 6. Decisions requested

1. **Is a 21-second p95 acceptable for Tier 2**, given it runs behind an already-published Tier 1 result — or should selection be capped lower?
2. **May site-derived legal name and address narrow a registry search** (never settle it), as `location` does today?
3. **Confirm the reference set is the gate** for claiming priority and eligibility coverage — the numbers in section 3.4 should not be quoted as coverage until it exists.

Nothing is persisted yet. The manifest schema deliberately has not been written, because solutions 1–3 change what a manifest contains and freezing it first would mean migrating it twice.
