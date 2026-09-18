# 0015 — Item 4, discovery half: retrieval and shortlist recall measured

**Date:** 2026-09-18
**Space:** build
**Authorization:** `STATE.md` `## Authorized now`, item 4 — the discovery half of
the reference-set recall measurement. Standing objective:
`docs/decisions/0005-measure-before-choosing-build-1s-direction.md`.
**Binding on this report:** ruling 0021 (a count names the set it ranged over and
how that set was determined) and ruling 0004 (a count names what it measured).

No code was changed. The working tree carries no modification to `lib/`,
`scripts/` or `supabase/` from this job. This was a measurement job and it stayed
one; everything below that looks like a diagnosis is filed as a finding for the
decision space, not as a fix.

---

## The command, and what it ranged over

```
npx tsx scripts/reference-recall.ts --discovery-only
```

Run twice, from the repo root, on branch `main`, at 2026-09-18T18:50:39Z and
again at 2026-09-18T18:54:29Z. Both exited 0. The two outputs are byte-for-byte
identical excluding the timestamps I wrapped around them:

```
diff <(grep -v '^\(START\|END\)' /tmp/refrecall.log) \
     <(grep -v '^\(START\|END\)' /tmp/refrecall2.log)   # no output
```

Fixture: `docs/reference-set/cases.json` — `schemaVersion: 1`, `frozen: true`,
12 cases × 5 fact keys = 60 judgements, all recorded, none `unreviewed`. Of the
60: 43 `stated`, 17 `not_stated`. Enumerate with

```
python3 -c "import json;d=json.load(open('docs/reference-set/cases.json'));
print(len(d['cases']), sum(1 for c in d['cases'] for f in c['groundTruth'].values() if f['status']=='stated'))"
```

which prints `12 43`.

---

## Raw output of the authorized run

```
Reference set: 12 cases · 60/60 judgements recorded · frozen: true

  maclellan      priorities               1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  maclellan      geographic_restriction   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  maclellan      recipient_restrictions   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  maclellan      program_currency         1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  maclellan      application_process      0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  stewardship    priorities               1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  stewardship    geographic_restriction   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  stewardship    recipient_restrictions   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  stewardship    program_currency         1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  stewardship    application_process      1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  eaa            priorities               0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  eaa            geographic_restriction   0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  eaa            recipient_restrictions   0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  eaa            program_currency         0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  eaa            application_process      0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  ncf            priorities               1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  ncf            recipient_restrictions   0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  ncf            program_currency         1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  cma            priorities               1/1 retr  0/1 manif  0/1 sel  0/1 read   RETRIEVED, DROPPED BY REDUCTION
  cma            geographic_restriction   1/1 retr  0/1 manif  0/1 sel  0/1 read   RETRIEVED, DROPPED BY REDUCTION
  cma            recipient_restrictions   1/1 retr  0/1 manif  0/1 sel  0/1 read   RETRIEVED, DROPPED BY REDUCTION
  cma            program_currency         1/1 retr  0/1 manif  0/1 sel  0/1 read   RETRIEVED, DROPPED BY REDUCTION
  cma            application_process      1/1 retr  0/1 manif  0/1 sel  0/1 read   RETRIEVED, DROPPED BY REDUCTION
  missio-nexus   priorities               1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  missio-nexus   recipient_restrictions   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  missio-nexus   program_currency         1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  missio-nexus   application_process      1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  antioch        priorities               1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  antioch        geographic_restriction   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  antioch        recipient_restrictions   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  antioch        program_currency         1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  antioch        application_process      1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  mariners       priorities               1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  mariners       program_currency         1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  mariners       application_process      1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  signatry       priorities               1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  signatry       recipient_restrictions   1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  signatry       program_currency         1/1 retr  1/1 manif  0/1 sel  0/1 read   in manifest, not selected
  pma            priorities               0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  pma            geographic_restriction   0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  pma            recipient_restrictions   0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  pma            program_currency         0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED
  pma            application_process      0/1 retr  0/1 manif  0/1 sel  0/1 read   NEVER RETRIEVED

============================================================
Reported separately. These are three different failures.
  retrieval recall   31/43 (72%)   discovery actually fetched the URL
  shortlist recall   26/43 (60%)   ...and it survived cleaning, grouping and the cap

  These are REFERENCE-PAGE SHORTLIST RECALL. Not research coverage, and
  not decision accuracy: a page reaching the shortlist is not evidence
  that the fact was read, understood, or correctly acted on.
  selection / fetch     not measured (--discovery-only)
============================================================
```

The `0/1 sel` and `0/1 read` columns in every row above are **structurally
zero, not measured**. Under `--discovery-only`, `scripts/reference-recall.ts:100`
and `:105` substitute an empty selection and an empty fetch. Those two columns
carry no information and must not be read as a result.

---

## The numbers, each with its denominator

**Retrieval recall — 31/43 (72%).**
Unit: one `(fact key, ground-truth URL)` pair. Population: every judgement in
`docs/reference-set/cases.json` whose `status` is `stated`, one URL each — 43
pairs across 10 of the 12 cases. Determined by `scripts/reference-recall.ts:85`
(`f.status === "stated"`) and summed at `:114` as `discTotal`. Reproduce the
population with the `python3` one-liner above. It ranges over **21 distinct
URLs**, not 43 — several facts in one case cite the same page, so the count is
of judgements, not of pages.
Meaning: the URL a human recorded was among the URLs `discoverSitePages`
(`lib/tier2/discovery.ts:82`) actually returned, before any reduction.

**Shortlist recall — 26/43 (60%).**
Same unit, same 43-pair population, same line `:114`. Measured at `:111` against
`manifest.entries` from `buildManifest` (`lib/tier2/manifest.ts:216`).
Meaning: the URL survived canonicalisation, the content-rule exclusions,
group-collapsing and the 60-entry cap.

**These two are not the same number and are not to be averaged.** The 5-point
gap between them is entirely the `cma` case: 5 judgements that were retrieved and
then dropped by reduction. `31 − 26 = 5`.

**Neither is coverage and neither is decision accuracy.** A page on the shortlist
has not been read. The script prints that caveat itself and it is repeated here
because an earlier "78% coverage" on this project was a keyword-match rate.

---

## How many cases completed, and how many errored

**12 of 12 completed. 0 errored. 0 were blocked.**

Established by a second, read-only observation run at 2026-09-18T18:52:03Z that
calls the same `discoverSitePages` the measurement calls and prints the
`DiscoveryResult` fields the measurement discards. It is a separate run, so its
numbers are its own; the retrieved/in-manifest booleans it reports agree with the
authorized run on all 43 judgements. Every case returned `httpStatus: 200`,
`robots: "allows"`, `failure: null`, a `method` other than `unreachable`, and a
non-empty URL list:

| case | method | http | robots | failure | URLs retrieved | after cleaning | after grouping | manifest entries | capped | dropped by cap |
|---|---|---|---|---|---|---|---|---|---|---|
| maclellan | sitemap+links | 200 | allows | none | 40 | 14 | 14 | 14 | false | 0 |
| stewardship | sitemap+links | 200 | allows | none | 44 | 22 | 22 | 22 | false | 0 |
| eaa | sitemap+links | 200 | allows | none | 10,664 | 10,516 | 337 | 60 | true | 10,456 |
| ncf | sitemap+links | 200 | allows | none | 673 | 644 | 52 | 52 | false | 592 |
| cma | sitemap+links | 200 | allows | none | 2,303 | 1,415 | 458 | 60 | true | 1,355 |
| saddleback | links | 200 | allows | none | 49 | 36 | 32 | 32 | false | 4 |
| missio-nexus | sitemap+links | 200 | allows | none | 8,648 | 8,521 | 465 | 60 | true | 8,461 |
| antioch | sitemap+links | 200 | allows | none | 67 | 18 | 13 | 13 | false | 5 |
| ronald-blue | sitemap+links | 200 | allows | none | 751 | 674 | 55 | 57 | false | 617 |
| mariners | links | 200 | allows | none | 179 | 70 | 70 | 60 | true | 10 |
| signatry | sitemap+links | 200 | allows | none | 520 | 398 | 85 | 60 | true | 338 |
| pma | sitemap+links | 200 | allows | none | 24,269 | 17,723 | 2,870 | 60 | true | 17,663 |

**So the 12/12 completion rate and the 43-judgement recall denominator are two
different populations and must not be conflated.** All 12 sites answered; only
**10** of them contribute a single judgement to either recall, because
`saddleback` and `ronald-blue` record 0 `stated` facts (5 `not_stated` each) and
`scripts/reference-recall.ts:108` iterates only over `stated`. Those two cases
produced no row in the output above and moved neither numerator nor denominator.

---

## Per-case recall rows

Denominator per row = that case's count of `stated` judgements.

| case | retrieval | shortlist | verdict class | contributes to recall? |
|---|---|---|---|---|
| maclellan | 4/5 | 4/5 | 4 in manifest; 1 never retrieved | yes |
| stewardship | 5/5 | 5/5 | all in manifest | yes |
| eaa | 0/5 | 0/5 | all never retrieved | yes |
| ncf | 2/3 | 2/3 | 2 in manifest; 1 never retrieved | yes |
| cma | 5/5 | 0/5 | all retrieved, all dropped by reduction | yes |
| saddleback | — | — | 0 `stated` judgements | no |
| missio-nexus | 4/4 | 4/4 | all in manifest | yes |
| antioch | 5/5 | 5/5 | all in manifest | yes |
| ronald-blue | — | — | 0 `stated` judgements | no |
| mariners | 3/3 | 3/3 | all in manifest | yes |
| signatry | 3/3 | 3/3 | all in manifest | yes |
| pma | 0/5 | 0/5 | all never retrieved | yes |
| **total** | **31/43** | **26/43** | | 10 of 12 cases |

Column sums: retrieval `4+5+0+2+5+4+5+3+3+0 = 31`; shortlist
`4+5+0+2+0+4+5+3+3+0 = 26`.

---

## What `--discovery-only` leaves unmeasured, and why

Three stages, and the reason is the same for all three: they need a model call
and therefore an Anthropic key this sandbox does not have.

1. **Selection recall.** `selectPages` (`lib/tier2/select.ts`) is skipped at
   `scripts/reference-recall.ts:100` when `--discovery-only` is set; `selection`
   is replaced by an empty literal. Every `sel` column is therefore 0 by
   construction.
2. **Fetch recall.** `fetchSelectedPages` (`lib/tier2/fetch.ts`) is skipped at
   `:105`. Every `read` column is 0 by construction.
3. **Absence precision.** Not printed — `:149` is guarded by `!DISCOVERY_ONLY`.
   This is the notable loss and `docs/decisions/0005-measure-before-choosing-build-1s-direction.md`
   names it: whether the system claims a find where a human recorded that the
   funder publishes nothing has no discovery-only equivalent. Over-claiming an
   absence is unmeasured here, and 17 of the 60 judgements in the fixture — every
   judgement in `saddleback` and `ronald-blue`, plus 7 scattered across `ncf`,
   `missio-nexus`, `mariners` and `signatry` — exist to test exactly that.

These are item 30's half. Nothing in this report bounds them from below; what it
does bound is their ceiling, since a URL never retrieved cannot be selected or
read. **72% retrieval is the hard ceiling on every later stage, and 60% shortlist
is the ceiling on selection**, because `selectPages` is only ever shown
`manifest.entries`.

---

## Findings raised for the decision space, not fixed here

`lib/tier2/` is outside this job's authorization and constraint 1 of the dispatch
forbids changing pipeline code to move a number. Each of these is a diagnosis
with its evidence, and none of them was acted on.

**F1 — two ground-truth URLs in the frozen fixture are now 404, and both are
counted as retrieval misses.** Checked with `curl -s -o /dev/null -w "%{http_code}"
-L`, user agent matching `lib/tier2/discovery.ts:16`:

```
404  https://maclellan.net/support/how-may-i-apply-for-a-grant   (maclellan / application_process)
404  https://www.ncfgiving.com/forms/grantrecommendationform      (ncf / recipient_restrictions)
```

Both scored `NEVER RETRIEVED`. Discovery cannot retrieve a page that does not
exist, so 2 of the 12 retrieval misses are properties of the fixture rather than
of the pipeline. **Secondary number, labelled as such and not a substitute for
the primary:** over the 41 `stated` judgements whose ground-truth URL returned
HTTP 200 on 2026-09-18 — that is, the 43 minus these 2 — retrieval recall is
31/41 (76%) and shortlist recall is 26/41 (63%). I am reporting 31/43 and 26/43
as *the* result because the fixture is `frozen: true` and its contents are the
decision space's to change, not mine.

**F2 — the reference set no longer contains a blocked-site case.** The
`ronald-blue` case records `failureClass: "Site blocked or unreachable -
retrieval_failed, not absent"`. Today `https://ronblue.com/` returns 200 after
redirecting to `https://www.bluetrust.com/`, `robots.txt` allows, and discovery
retrieved 751 URLs by `sitemap+links`. The case that was in the set specifically
to prove a retrieval failure is not producing one. Whatever that case was
guarding is currently unguarded.

**F3 — the fixture is frozen but the sites are not, so this number is not
reproducible over time.** The `eaa` case's `failureClass` records "5,566 URLs";
discovery returned **10,664** today. `missio-nexus` and `pma` both hit sitemap
truncation (`sitemapTruncated: true`, 12/13 and 12/20 children followed against
`MAX_SITEMAP_CHILDREN = 12`), and `pma` drew 24,000 URLs from its sitemap against
`MAX_SITEMAP_URLS = 25_000`. A rerun next month measures different sites. This is
a property of the measurement design, not a defect introduced by anyone; it
matters because ruling 0021 asks a reader to be able to reproduce the population,
and here the population is a live network.

**F4 — `pma`'s entire ground truth lives on a subdomain discovery never
enumerates.** All 5 judgements cite `centernet.pcusa.org`; all three distinct
URLs return 200. Of the 24,269 URLs discovery retrieved for host `pcusa.org`,
the hostname histogram is a single entry: `pcusa.org` × 24,269. Zero on any
subdomain. The sitemap at the apex host lists apex-host URLs, and the homepage
carries no anchor to `centernet`. `discoverFromHomepage`
(`lib/tier2/discovery.ts:206`) would have kept such an anchor — its filter is
`endsWith(host)` — so this is an absence of links, not a filter rejecting them.
This is a 5-judgement, one-case hole worth 12% of the retrieval denominator, and
per review 0009 it is a diagnostic case rather than a roadmap item.

**F5 — `eaa`'s two ground-truth pages are live but absent from the site's own
sitemap and homepage.** Both return 200. All 5 sitemap children were followed
(5 of 5, `sitemapTruncated: false`), yielding 10,412 URLs, plus 252 homepage
links. 112 of the 10,664 contain `scholarship` or `learn-to-fly`; none is either
ground-truth URL. So `eaa` is a genuine **retrieval** miss, distinct from
reduction — the manifest cap never got the chance to drop these pages.

**F6 — `cma` is the whole retrieval-to-shortlist gap, and it is a cap loss.**
One live URL, `https://cmalliance.org/our-work/church-ministries/pastoral-financial-health-initiative/`,
carries all 5 judgements. It was retrieved (2,303 URLs) and is absent from the
60 manifest entries (458 after grouping, `capped: true`, 1,355 dropped). Reading
`isMandatoryPath` (`lib/tier2/manifest.ts:164`), the rule requires a MANDATORY
keyword to *begin* a path segment; this URL's three segments are `our-work`,
`church-ministries` and `pastoral-financial-health-initiative`, none of which
starts with one — `who-we` and `what-we` are in the vocabulary, `our-work` is
not. The page is therefore non-mandatory, competes in the round-robin at depth 3
under section `our-work`, and loses to the cap. **Stated as a diagnosis only.** I
did not change the vocabulary, and I want to flag why not beyond authorization:
adding `our-work` because `cma` needs it is precisely the per-case fix review
0009 rules out, and the same edit would have to be justified as a general class.

**F7 — absence precision is computed even under `--discovery-only`, and would be
vacuously perfect if it were ever printed.** At `scripts/reference-recall.ts:126`
the absent-fact loop runs unconditionally. With selection stubbed empty,
`claimed` is always false, so `absenceCorrect` increments on all 17 `not_stated`
judgements and the value is 17/17. `:149` correctly suppresses the line, so
nothing wrong was emitted today. Recording it because the guard and the
computation are in different places, and a future edit that prints that line
would publish a 100% that means nothing.

---

## What I am not confident about

- The completion table comes from a **second run**, three minutes after the
  authorized one. Its retrieved/in-manifest booleans agree with the authorized
  run on all 43 judgements, which is the strongest cross-check available without
  changing the script to print more. The URL counts in that table have not been
  re-observed a third time and are single-observation figures against live sites.
- `saddleback` and `ronald-blue` completing successfully says nothing about
  whether the system would have behaved correctly on them, because the only
  thing their judgements test — absence precision — is the stage this run cannot
  reach.
- I did not verify that the 21 distinct ground-truth pages actually state the
  facts attributed to them. That is the human judgement recorded in the fixture
  and I took it as given; retrieval recall measures whether we fetched the page,
  not whether the page says what the fixture claims.
- Nothing here bounds decision quality. Ruling 0004 applies: this is
  reference-page retrieval and shortlist recall, and it is not coverage.
