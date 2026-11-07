---
id: 0045
title: Public-record funder data is shared reference data, loaded offline, and every value carries its filing and its definition
status: settled
provenance: verbatim
supersedes:
date: 2026-11-06
---

## The ruling

The owner has decided to build the platform's own database of US grant-making
organizations from public IRS filings, beginning with California and three tax
years. That data belongs to no organization, comes from documents with known
quirks, and will be read by every tenant. Seven things hold.

1. **Public-record funder data is shared reference data, not tenant data.** The
   tables that hold it carry no organization's content and no `organization_id`.
   Every signed-in member of any organization may read them; **no application
   role may write them** — not a member, not an admin, not the assistant, not the
   external agent. They are written only by the offline loader (clause 6), with the
   service key. Everything an organization adds about a funder — notes, status,
   a prospect — stays in its own org-scoped tables (hard rule 6) and refers to the
   reference row by EIN. Hard rule 6's pattern does not apply to these tables, and
   its absence here is deliberate, not an omission; what replaces it is that these
   tables hold nothing an organization wrote.

2. **Every value carries its source.** A stored value names the filing it came
   from (EIN and tax period end), where the document can be read, when it was
   loaded and which version of the loader read it. A value with no source filing is
   not stored.

3. **A figure is stored with what it measures, by tax period.** Figures are keyed by
   the tax period end date, never by the year a filing was submitted or published.
   Figures that sound alike but differ — contributions paid per books, qualifying
   distributions, charitable disbursements — are separate columns named for what
   the form calls them, and there is no single "giving" column. A derived figure
   (an average or median grant, a payout ratio, a share) names the set it was
   computed over and the figures it used (ruling 0021).

4. **A fact the filing does not carry is absent, not filled in.** The loader never
   guesses a website, an email address or a telephone number it was not given. A
   value found elsewhere later (a website, a priority on a funder's own page) is a
   separate claim with its captured source, stored apart from filing-derived values
   and never presented as one (the capture contract; ruling 0044 clause 4's rule on
   sources).

5. **A person named on a filing is stored as named.** The record holds the name,
   role, tax period and what the filing states about them. The loader does not
   merge people from different filings into one person, because a shared name is not
   an identity; a link between two filings' people, or between one of them and a
   person an organization recorded, is a proposal that lands in review and changes
   nothing (rulings 0044 clauses 6 to 8).

6. **The loader is offline, repeatable and honest about what it did.** It runs
   outside the web application, never from a request. It can be run again and
   resumed without duplicating a row. Each run records what it read, what it loaded
   and what it rejected, with each rejected filing named and the reason, and it
   states which tax periods it holds for which funders and which it does not
   (rulings 0023 and 0024). **A filing that cannot be read is recorded as unread,
   never silently dropped**, and "no data for that year" never reads as "it gave
   nothing that year".

7. **This data proposes; it does not decide or send.** A funder drawn from this
   data is a candidate that a human accepts like any other (hard rules 2 and 3). It
   is never contacted, and no prospect is created from it, without a human click.

## Why

A shared table of public documents is the right shape for facts that are the same
for everyone, but it breaks the platform's tenant-isolation habit on purpose, so the
exception has to be stated, bounded and testable rather than discovered later. The
other clauses are the lessons of the first worked example: sources disagree about
which year a figure belongs to, "how much it gives" has several honest meanings that
differ by hundreds of thousands of dollars, and the lists that matter most to us
(grants and officers) are not in the summary data that is easiest to fetch.

## Test of compliance

A signed-in member of any organization reads the reference rows; the same session
cannot insert, update or delete one, and neither can the assistant or the agent.
Every stored value traces to a filing and a tax period. Two different giving figures
for one foundation and year are two columns, and no column is named for "giving"
alone. A foundation whose filing has no website has none stored. Two filings with the
same officer name produce two person rows. Run the loader twice: no duplicate rows.
Feed it an unreadable filing: it is recorded as unread with a reason. Loading a year
that is not yet published records the year as missing, not as zero.

## Scope

Authorizes item 110: a worked example (Servant's Heart Foundation, EIN 58-2218044)
loaded end to end from the IRS filing and compared value by value with the filing,
then the California pilot, three tax periods, foundations above a size threshold the
owner sets; the shared tables for the foundation, its yearly figures, its people, its
grants and its stated way to apply; and the offline loader. Does not authorize any
use of this data in matching, discovery, scoring or the way-in feature, any screen,
any web or person enrichment, any state beyond California, or any write to these
tables from the application. Direction and field list: docs/decisions/0010-funder-reference-database.md.
