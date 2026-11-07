# 0010 — A funder reference database built from public IRS filings

status: proposed (direction; the invariants are in ruling 0045)
date: 2026-11-06
owner: decision space
pilot: California, three tax years (2022, 2023, 2024), one worked example first

## The direction

Build our own database of US grant-making organizations from public IRS filings, so
that matching and finding a way in no longer begin from a blank web search for every
funder. The hard work (loading and cleaning) is done once; after that the database is
topped up as new filings are published. The owner's reasoning: a hard front end,
then matching becomes easier.

It feeds three things already planned: funder identity (an EIN is a permanent,
checkable key), the way-in feature (a foundation's officers and trustees are named on
its return, the official-record source ruling 0044 clause 4 allows), and matching
(size, geography, who a funder has given to).

It does not replace the Research Agent. Filings run one to two years behind, so a
funder's current priorities and how to apply still come from its own website.

## What it covers, honestly

Well covered: private foundations and family trusts (Form 990-PF), and public
charities that make grants. Not covered: churches and most denominations (churches
are not required to file), individuals and major donors, businesses, and the people
behind donor-advised-fund gifts. Of the seven channels, it is a strong base for
Foundation & Family Trust and Regranting Ministry, partial for Denomination &
Network Fund, and nothing for the other four.

## Worked example, done first: Servant's Heart Foundation Inc, Newport Beach

EIN 58-2218044. Private (non-operating) foundation, ruling 1996, fiscal year ends in
December, files Form 990-PF, no employees. Checked 2026-11-06 against ProPublica
Nonprofit Explorer's API and page, which are built from the IRS filings.

What the filing data gave, by tax year:

| | 2022 | 2023 | 2024 |
|---|---|---|---|
| Total assets (year end) | $17,049,161 | $17,401,474 | $17,408,962 |
| Revenue | $539,140 | $576,743 | $677,750 |
| Total expenses | $2,054,296 | $1,333,213 | $2,108,008 |
| Contributions paid, per books | $911,323 | $831,853 | not yet in the structured data |
| Qualifying distributions | $841,321 | $849,758 | not yet in the structured data |
| Charitable disbursements (page figure) | $1,104,388 | $1,067,256 | $1,855,039 |

Officers shown on the filing page: Paul A. Neff (President, CEO, Chairman), Kathy A.
Neff (Director), Richard Haugen (Treasurer), Lindsey Haugen (Secretary).

Third-party sources describe it as invitation-only and not accepting unsolicited
requests, with 20 to 30 grants a year, mostly Christian ministries and churches,
California, Texas and North Carolina most common, individual grants from about $100
to about $220,000. That is a claim from aggregators; the filing itself carries a box
saying whether a foundation takes unsolicited requests, and the loader must read that
box rather than trust an aggregator.

What the example taught us:

1. **ProPublica's structured API does not carry the two things we most need.** It has
   the financial summary, but not the list of grants (recipient, city, purpose,
   amount) and not the officers. Those are in the full filing (the XML and PDF). So
   the loader reads the IRS bulk filings, and ProPublica stays useful for lookups.
2. **"How much does it give" is not one number.** Contributions paid per books,
   qualifying distributions and charitable disbursements are three different figures,
   and they differ by hundreds of thousands of dollars. The database stores each by
   its own name and never a single "giving" column.
3. **Sources label years differently.** One aggregator reports $911,322 under
   "2023"; that is the 2022 tax-year figure ($911,323), filed in 2023. Everything is
   keyed by the tax period end date, never by when it was filed or published.
4. **The latest year lags.** The 2024 return exists but its figures were not yet in
   the structured data. A pilot of "three years" means whatever is loaded; the
   loader records which years it has and which it does not.
5. **Average gift** can only be computed once grants are parsed. From the counts
   above it looks like roughly $30,000 to $40,000 (2022: $911,323 over 30 grants;
   2023: $831,853 over about 20), but treat that as indicative, not a stored fact.
6. **Minimum payout is a free signal.** A private non-operating foundation must pay
   out about 5% of its assets a year, and the return states the figure. Here that is
   about $850,000 on $17.4 million, so its giving is predictable, which is useful
   for matching.

## What to store

Every value carries its source (clause 2 of ruling 0045): the filing, the tax period
end, where the document is, when it was loaded and which loader version.

**The foundation (one row per EIN).** EIN, legal name, care-of name, street address,
city, state, zip, telephone as stated on the return, ruling year, foundation type
(operating or non-operating), NTEE code, fiscal year end, last tax period filed, and
whether it is still an active filer. Website is NOT on a 990-PF in general, so it is
absent, not guessed; a website found later is a separate web-found claim with its
captured source.

**Size, one row per EIN and tax period.** Total assets (fair market value, year
end); total revenue; contributions received (shows whether it is an endowment or is
still being fed by a donor); total expenses; contributions paid per books;
qualifying distributions; the minimum amount it was required to distribute; the
undistributed amount; and a payout ratio computed from those, naming the figures it
used. Net assets and liabilities. Number of grants.

**How it gives, computed from the grant list, naming the set it was computed over.**
Count of grants, average, median, smallest and largest grant, share going to the
foundation's home state, share going to repeat recipients, and number of first-time
recipients in the year (a sign of openness to new organizations).

**Whether it takes new requests.** The return's "preselected charities only, no
unsolicited requests" box; and where it does take them, the stated contact (name,
address, telephone or email) for applications, the form of application, deadlines and
restrictions as written. This is where real contact details come from, and it is the
single most useful filter in the database.

**Its people, one row per person per tax period.** Name, title, role (officer,
director, trustee), hours per week, compensation, and the address on the return. The
loader does not merge two filings' people into one person; a link between them is a
proposal (ruling 0045 clause 5).

**Its grants, one row per grant.** Tax period, recipient name, recipient city and
state, recipient's tax status as stated, purpose as written, amount. The recipient's
EIN is not on the return; matching a recipient to the IRS registry to get an EIN, and
therefore its NTEE code and size, is a second, later step and is stored as a proposed
match.

**Not stored in this pilot:** anything not on a filing (no email lookups, no social
profiles, no person enrichment), no scoring, no fit judgement. Those come later and
are separate, labelled claims.

## Pilot plan

1. Take one organization end to end, Servant's Heart, from the IRS bulk filing to the
   tables above, and compare every stored value with the filing itself. This fixes the
   schema before volume.
2. Then California, three tax years, foundations above a size threshold. Record how
   many filings, how long, how big the tables are, how many filings could not be
   parsed and why.
3. Only then decide the next state or national, and how often to refresh.

## Decided and still open

- **Decided 2026-11-06 by the owner:** the pilot's size threshold is at least $1
  million in assets or at least $100,000 in yearly giving.
- **Decided 2026-11-06 by the owner:** keep the full grant list only for
  foundations above the threshold, three tax periods.
