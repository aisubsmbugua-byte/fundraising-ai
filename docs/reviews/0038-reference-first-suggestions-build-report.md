# 0038 — Reference-first suggestions: build report (item 117, ruling 0049)

Date: 2026-11-12. Status: built, tested, deployed. Not yet clicked through by the owner.

## What exists now

- **Donor Finder, top section: "Suggested from the national funder database"** (`/discovery`). Funders found in IRS
  filings that gave to faith-named recipients, ranked by the rule printed on the page, each with its reason (counts only)
  and the grants behind it with links to the filings. Three separate groups, each ordered the same way: funders you can
  approach (main), donor-advised fund sponsors, and funders whose filing says pre-selected charities only (shown, never
  offered as open).
- **One click per funder**: "Add to my candidates" creates one pending candidate with the funder's EIN and a snapshot of
  the figures it rested on. It creates no prospect, contact, draft or message. Accepting it carries the EIN to the prospect.
- **The data under it**: a shared derived table of per-funder faith-named grant counts, computed from the paid grants held
  (4.3M foundation rows, 2.7M Schedule I rows), rule version `faith-name-v1`, filled by `scripts/refresh-faith-giving.ts`.
  Covers 60,652 foundations and 40,650 charities; 23,215 foundations and 7,498 charities have at least one faith-named grant.
- Migrations 0094 to 0097 are applied to the live database. 0095 and 0096 are performance iterations that 0097 supersedes
  (kept, because applied migrations are not rewritten).

## Measured

On the full table, as a member of Village Worship Initiative: about 0.55 s per group; the page asks for three groups in
parallel. The first call after a migration read 6 to 7 s on a cold cache; every call after that was 0.55 s. The slowest
single measurement of a warm call: 0.58 s. The derived table is filled in about 25 minutes (four ranges in parallel).

Tests: `scripts/test-reference-suggestions.ts` 64 checks (migration on a real Postgres as member, stranger and anon; ranking;
band count equals counting one by one over 300 random arrays; exclusion per organization; source scans: no model call, no
service key, no outside request; the add action touches only candidates). Existing suites unchanged: 122, 135, 69, 77, 12.
`tsc` clean; `next build` clean.

## Decisions I made inside the ruling, for the owner to confirm

1. **Donor-advised fund sponsors are listed apart.** Ordered by the ruling's rule, the first fifteen funders for a small
   ministry were Fidelity, Vanguard, Morgan Stanley and similar: they give to everything, so their counts are largest, and
   a ministry cannot approach a sponsor the way it approaches a foundation. Clause 6 and ruling 0047 already keep kinds
   separate; this is that applied. The ordering rule itself is unchanged.
2. **Where a size band is set, a funder with no faith-named grant in it is left out.** The ruling is silent on this; the
   alternative is a long tail of funders with zero in band.
3. **A funder whose faith-named grant states no amount cannot be in a band**, so it is left out when a band is set.

## Quality finding: the ordering rule works but is a weak ranking (needs the owner's call)

Run on real data, the main list's first twelve for Village Worship were: Thrivent Financial for Lutherans, Ohio Child Care
Resource and Referral Association, Thrivent (group), Indianapolis Center for Congregations, Carson-Myre Charitable
Foundation, Lilly Endowment, National Association for the Exchange of Industrial Resources, Oldham Little Church Foundation,
Kansas Association of Child Care Resource and Referral Agencies, Folds of Honor, Calvin University, Koch Foundation.
Several are real and relevant; several are pass-through organizations that give to many church-run programs (child care,
in-kind goods) and are not funders of a ministry like this one. Cause: the rule counts grants by recipient WORDS, and the
ranking puts the raw number of such grants first, which favors organizations that give very many small grants.

A better first key, for a ruling 0050 if the owner agrees: the **share** of a funder's grants that are faith-named, among
funders with at least a handful (say five) in band. That would put Servant Foundation (58%), Thrivent (56%), Carson-Myre
(87%), Oldham Little Church (86%) and Calvin (99%) ahead of the pass-throughs. It is a one-function change plus a ruling.
Not done, because clause 5 is sealed and the choice is the owner's.

## Not done / limits

- **Not clicked through.** Signing in needs the owner's password, so the page was verified by the live query run as
  Village Worship's user, by the tests, and by a clean production build, not by seeing it render. The first thing to check
  by eye is `/discovery`.
- The faith rule is words in a recipient's name or purpose. It misses ministries without those words and includes some that
  are not (a university with "Christian" in its name). The page says so.
- Peer-based matching (the primed pump), the exempt-organizations master list and the funder-facing view are later steps.
- After any later load of the funder tables, re-run `npx tsx scripts/refresh-faith-giving.ts`, and refresh the directory
  snapshots first, because suggestions read them.
- Names are shown as filed (readable case). Two funders in the data can share a name (two "Stewardship Foundation"s): the
  EIN is shown beside every name for that reason.
