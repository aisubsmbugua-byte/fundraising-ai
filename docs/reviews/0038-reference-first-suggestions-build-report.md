# 0038 — Reference-first suggestions: build report (item 117, ruling 0049)

Date: 2026-11-12. Status: first build deployed; amended by ruling 0050 the same day (see the section below). Not yet clicked through by the owner.

## Amended 2026-11-12 by ruling 0050 (supersedes 0049): read this first

The owner reviewed the first build's results and directed three changes, which ruling 0050 makes and this section reports. The rest
of this report describes the first build and is kept for the record; where it disagrees with this section, this section is right.

- **One list, share-first.** Funders with at least five faith-named grants in the organization's size band come first, ordered by the
  share of their listed grants that are faith-named, then by the count in band, then by recency; funders with fewer follow, marked
  "Less to go on". The five is defined once in the database (`reference_suggestion_floor()`) and read back by the application.
  Real data, Village Worship's band: 25,461 funders match; 8,598 have enough to go on; the top of the list is funders whose filed
  giving is entirely faith-named (Word of Life, Steer, Mount Hope, Mercy Multiplied, Pillar Church Planting Network, Far Reaching
  Ministries in California, Salt and Light, Cecil B. Day and others). The 40-grant pass-through that led under the old rule now ranks
  by its 10% share.
- **Nobody is held apart.** Funders that say "pre-selected charities only" and donor-advised fund sponsors are in the same list,
  labelled, and can be added. Of the 8,598 with enough to go on, 4,312 are pre-selected and 808 are flagged sponsors; hiding them
  would have removed about half of the best matches. This reverses decisions 1 of the first build (sponsors listed apart); decisions
  2 and 3 (a funder with none in the band, or with no stated amount, is left out when a band is set) stand under ruling 0050 clause 5.
- **Ways in.** Every funder has a panel with what its own filing gives: the contact it names for requests, how to apply, deadlines,
  restrictions (as filed, with a note that a restriction is a question to ask), the officers and trustees it names (title, city and
  state only), website, phone, address and, for charities, the stated mission; then one fixed paragraph of general practice, labelled
  as not coming from the filing. Read through the member's own session by `lib/funder-reference/ways-in.ts`: no model, no service key,
  no outside request.
- **Migration 0098** (applied to the live database 2026-11-12) replaces the suggestions function: the group argument is gone, one
  column (`meets_floor`) is added. Earlier migrations are untouched.
- **Measured live, as a Village Worship member:** the suggestions query 0.69 s for a page of 25; the five keyed reads for a page of
  ways in 0.12 s.
- **Tests:** `scripts/test-reference-suggestions.ts` now 82 checks (migrations 0094 to 0098 on a real Postgres; one-list order with a
  pure funder, a pass-through and funders under the line; pre-selected and sponsor funders present and ordered by the same rule; the
  old group call refused; exclusion per organization; the ways-in reads run as a member with the exact columns the reader names;
  parsing of a real-shaped application record and officer list; no street address or pay carried for a person; source scans).
  Other suites unchanged: 122 (funder screen), 69 (charity screen), 135 (public charities), 161 and 38 (loader), and the
  loader-migration suite 125. `tsc` and `next build` clean.
- **Found and fixed while running the suites:** `scripts/test-funder-reference-migration.ts` had four checks that failed on the
  committed first build (the table count predated the derived table of 0094; the source scan predated the three item-117 readers).
  They are narrowed explicitly (the one derived table named; the three reader files named), not loosened. A person's name written
  in capitals gave "Paul a Neff" under the shared name rule (it treats "a" as an article); people now have their own casing rule,
  covered by a test.
- **Not verified:** the page has still not been seen rendered (sign-in is the owner's). Contact coverage is partial: only 27% of
  foundation filings state any application contact.
- The next layers (topic and place profile, how open a funder is, ways-in reasoning, an AI brief per added funder, peers) are
  proposed in `docs/reviews/0039-funder-intelligence-matching-and-ways-in.md`.

---

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
