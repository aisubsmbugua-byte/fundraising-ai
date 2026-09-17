# Reference Set — Findings and Proposed System Fixes

**Status:** for review. No retrieval logic changed since the set was frozen.
**Date:** 2026-09-02
**Set:** 12 cases · 60 human judgements · 43 stated · 17 not published · frozen.

---

## 1. The number

**Discovery recall: 20 of 43 (47%).**

Of the pages a human found stating a decision-critical fact, fewer than half
ever reached our manifest. Selection and fetch recall are not yet measured —
they are bounded by this, since a page never discovered cannot be chosen.

Every previous coverage estimate stood in for this number and overstated it.
The 78% figure counted keyword matches; the 53% "mandatory page" figure counted
pages that *might* carry a fact. This counts pages that *do*.

That gap is the reference set's entire justification. It cost twelve site
reviews and it invalidated two months of proxies.

---

## 2. What failed, as classes

Per the governing rule, each case-specific failure is stated as a general class
with the prospect categories it affects.

### Class A — Grants content lives on a subdomain

Presbyterian Mission Agency publishes grants at `centernet.pcusa.org`, not
`pcusa.org`. Our discovery accepts same-host URLs only, so those pages are
invisible **by construction** — not missed, unreachable.

*Affects:* denominations, agencies, universities and any funder whose
grantmaking sits on a separate ministry or programme site.
*Bar:* prevents a qualification decision being produced.

### Class B — Depth bias

Every page we discovered sits at path depth 1–2. Every page we missed sits at
3–5:

    FOUND    maclellan.net/faq · antiochfoundation.org/faq
    MISSED   eaa.org/eaa/learn-to-fly/scholarships/eaa-flight-training-scholarships
             cmalliance.org/our-work/church-ministries/pastoral-financial-health-initiative/

Two independent choices cause this: `MAX_MANDATORY_DEPTH = 4`, and a cap that
orders shallow pages first. Both were correct for the sites they were tested
against and wrong for the sites they were not.

*Affects:* any funder nesting a programme beneath a section — the normal shape
for large organisations.
*Bar:* prevents a qualification decision being produced.

### Class C — A prospect's stored website can be wrong

The Antioch row carries `theantiochfoundation.org`; the funder's current site is
`antiochfoundation.org`. Retrieval was measuring a different domain and
reporting the result as though it described the prospect.

Worse: the discovery-merge change made during Step 3 was justified partly on
Antioch's behaviour — **against a domain that was not theirs.** The change
survives on its own merits, having been measured across all 32 prospects, but
the anecdote that motivated it was invalid. This is precisely the failure the
governing rule exists to prevent, and it happened before the rule was written
down.

*Affects:* every prospect whose website came from Discovery rather than a human.
*Bar:* can cause a wrong qualification decision — the worst-ranked failure.

### Class D — Programme currency is not binary

Four of twelve funders are open-but-not-now:

| Funder | State |
|---|---|
| The Stewardship Foundation | Letters of inquiry suspended; check Q4 2026 |
| EAA Aviation Foundation | Cycle closed; reopens 1 October 2026 |
| Missio Nexus Innovation Fund | On hold since autumn 2025 |
| The Antioch Foundation | 2027 applications open 15 Sept – 15 Oct 2026 |

A closed cycle is a **timing fact**, not an absence. Read as "no programme" it
would dismiss a live funder; read as "available" it would send a user at a
closed door.

*Affects:* any funder running cycles — most competitive grantmakers.
*Bar:* can cause a wrong qualification decision.

---

## 3. The finding that is not about retrieval

Five of twelve cases are **not addressable grant opportunities at all**:

- **NCF** and **The Signatry** — donor-advised-fund sponsors. Fundholders
  recommend recipients; nonprofits submit no competitive application.
- **Ronald Blue Trust** — a wealth manager offering a client DAF service.
- **Mariners Church** — publishes individual and family benevolence, not
  external nonprofit grants.
- **Saddleback Church** — publishes nothing on any of the five facts.

And **C&MA**'s only published evidence concerns an internal Pastoral Financial
Health Initiative, not external grantmaking.

This is the `intermediary_only` outcome earning its place, and it points
upstream: **Discovery is admitting non-opportunities into the pipeline.**
Improving discovery recall on Ronald Blue would optimise retrieval for
something no nonprofit can apply to.

It also reframes the 47%. Some of that shortfall is retrieval failing to find
pages; some is retrieval hunting for grant guidance on organisations that make
no grants.

---

## 4. Proposed fixes

Each names its class, is measured across the whole set, and reports regressions
as well as improvements.

**1. Allow related subdomains of the prospect's registrable domain.** (Class A)
Accept `*.pcusa.org` where today only `pcusa.org` is accepted, capped and
recorded. Not arbitrary cross-domain crawling — the registrable domain is the
boundary.

**2. Make depth a ranking signal, not a filter.** (Class B) Raise the mandatory
depth limit and let the manifest cap handle volume, rather than excluding deep
pages before the cap sees them. A page named `apply` at depth 5 is more likely
to matter than a page named `news` at depth 1.

**3. Verify the stored website before trusting it.** (Class C) Confirm the site
belongs to the prospect — name tokens present, or the registry record's
identity corroborated — and mark it `unverified_domain` otherwise instead of
silently measuring a stranger.

**4. Give programme currency its own vocabulary.** (Class D)
`open` / `closed_reopens_on` / `suspended` / `unknown`, rather than
found-or-not. A closed cycle with a stated reopening date is a *pursue with
timing*, not a dismissal.

**5. Route DAF sponsors and non-grantmakers to `intermediary_only` earlier.**
Already a settled outcome; the finding is that it should be reachable from
Tier 2 evidence, not only from subject-type classification.

---

## 5. Recommendation

Fixes 1–3 clear the admission bar and are cheap. Fix 4 clears it and is small.
Fix 5 is a routing change to an outcome that already exists.

None should be taken as licence to reopen retrieval indefinitely. The measure
of success is not recall approaching 100% — several of these funders have
nothing to find — but a system that can say **which** of "we did not look",
"we looked and they do not publish it", and "they are not an opportunity"
applies, and can defend a pursue/dismiss/insufficient/intermediary verdict on
that basis.

The reference set is frozen and is now the regression gate. No retrieval or
identity change ships without a report of improvements *and* regressions across
all twelve.
