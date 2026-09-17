# Correction: Where the Pages Are Actually Lost

**Status:** correction to 0010. For review before further fixes.
**Date:** 2026-09-02

---

## 1. The correction

0010 reported **discovery recall 47%** and attributed the loss to depth bias,
subdomains and vocabulary. That measurement conflated two different stages.

Splitting them:

    retrieval recall   29/43 (67%)   discovery actually fetched the URL
    manifest recall    20/43 (47%)   ...and it survived cleaning, grouping and the cap

**Nine of forty-three pages were retrieved and then discarded by our own
reduction.** They were never a discovery failure. The harness labelled them
"NOT DISCOVERED", which is the same conflation this project keeps having to
undo — and this time it was in the instrument, not the system.

---

## 2. Where the 23 losses actually are

| Cause | Count | Cases |
|---|---|---|
| Only one nested sitemap is followed | ~9 | EAA, Maclellan, NCF |
| Grants content on a subdomain | 5 | Presbyterian Mission Agency |
| Retrieved, then dropped by the cap | 9 | C&MA (5), Missio Nexus (4) |

### 2.1 One nested sitemap

A sitemap index lists several child sitemaps and we follow exactly one, chosen
by a `/page/` name heuristic:

    eaa.org         5 children   sitemapWeb · sitemapCalendars · sitemapVideo · sitemapPlaces · sitemapPeople
    cmalliance.org 10 children   posts-post · posts-page · posts-job · posts-video · taxonomies-*
    maclellan.net   2 children   post-sitemap1 · page-sitemap1

Everything in the unfollowed children is invisible. This is the largest single
cause and the cheapest fix: follow all children, bounded, deduplicating as we
go.

*Affects:* every funder on WordPress, Yoast or any CMS emitting a sitemap
index — the majority of the pipeline.

### 2.2 The cap discards known-good pages

C&MA's and Missio Nexus's pages were retrieved and reduced away. Both are
"mandatory" by intent and neither matches the keyword vocabulary:

    /our-work/church-ministries/pastoral-financial-health-initiative/
    /innovation/  ·  /innovation/2023-innovation-fund/

**This is the important finding, and it is not a vocabulary gap.** A funder may
call its grant programme anything: "Innovation Fund", "Pastoral Financial
Health Initiative", "Self-Development of People". Adding `innovation` and
`our-work` would fix these two cases and fail on the next three names nobody
predicted. Keyword matching cannot identify a grant programme by name, because
the names are arbitrary.

Adding `scholar`, `fellowship`, `award`, `bursary`, `prize` and `stipend` was
worth doing — EAA's entire programme is scholarships, and that is a *category*
of funder, not one name — but it moved the measured recall by zero, and no
further keyword will move it much either.

The cap is the mechanism to change, not the vocabulary.

---

## 3. What this means for the approved fixes

| Approved fix | Status after correction |
|---|---|
| C — verify the domain first | **Unchanged.** Still first; still a wrong-organization risk. Built. |
| A — evidenced related subdomains | **Unchanged.** Accounts for PMA's 5. Built, not yet wired to discovery. |
| B — depth ranks rather than excludes | **Built, and it moved nothing.** It governs ranking inside the manifest; these pages never reached the manifest. Keep it — it is correct — but it was not the constraint. |
| D — programme vs application status | **Unchanged.** Independent of retrieval. |
| Opportunity classification | **Unchanged.** Independent of retrieval. |

And one addition, now the highest-value item:

**Follow every child of a sitemap index**, bounded and deduplicated, rather
than guessing one by name. Class: funders whose CMS splits its sitemap.
Expected to recover most of the fourteen never-retrieved pages.

---

## 4. What I would not do

Raise the manifest cap to make C&MA and Missio Nexus pass. That is fitting the
cap to two organizations. The honest options are to let selection see a larger
manifest for *all* funders and measure the cost, or to accept that a programme
with an unguessable name and no keyword signal will sometimes be missed — and
report it as `not_checked` rather than implying the funder publishes nothing.

The second is not a failure to fix. It is the system telling the truth about
what it did not see, which is the metric that matters more than recall.
