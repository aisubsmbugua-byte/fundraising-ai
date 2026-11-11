# Item 116: California trial of grantmaking public charities and donor-advised fund sponsors. Numbers report

Date: 2026-11-11. Ruling 0047 clause 6 asks for the rows and storage the California trial added and a
national projection against the 8 GB database, so the owner can decide the national run. This report
gives them. It does not start the national run and nothing here authorizes it.

## In plain words

California has about 4,800 grantmaking public charities and donor-advised fund sponsors that give at least
$100,000 a year to other organizations (or run donor-advised funds). They are now in the shared funder
database, each labeled as what it is, each value tied to the IRS return it came from, and a sample of 150 of
them was re-checked against the returns with no difference. It added about 160 MB. Doing the whole country
would add about 1.5 GB and take most of a day on the server, leaving the database near 4.5 GB of 8 GB.

One real gap: the very largest donor-advised fund sponsors file returns so large the loader refused them.
That has to be fixed before a national run, or the biggest names are missing.

## What the trial did

Run on the Lightsail server, 2026-11-11 00:53 to 01:43 UTC (2,966 seconds, peak memory 1.6 GB), California
only, from the IRS archives already on the server (no new download). Migration 0089 had been applied on the
owner's go the day before.

| | California |
|---|---|
| Form 990 returns considered (all states, 2022 to 2024 periods) | 1,069,962 |
| Returns outside California (counted, not stored) | 956,477 |
| California returns not in scope (counted, not stored) | 99,527 |
| Filings stored | 13,958 (13,617 standing, 339 replaced by a later return, 2 unreadable) |
| Funders in scope | 4,843 identified, 4,842 stored |
| Public charities (grants to organizations of $100,000 or more) | 4,750 identified, 4,749 stored |
| Donor-advised fund sponsors | 239 identified, 238 stored |
| Both | 146 |
| Just under the line ($50,000 to $99,999), recorded but not in scope | 1,161 |
| Grant (recipient) rows stored | about 195,000 |
| Outcome counts add up | yes |

Returns that do not state Part IX line 1 at all: 48,722 of 113,485 California returns read. They are
treated as "not stated", never as zero, so a charity that gives a lot but does not fill that line is not in
scope on that return. 15,680 California funders state no such total on any return. This is the known limit
of the $100,000 test the owner confirmed, and a reason the "just under" count should not be read as the
whole of the near misses.

## Storage

Measured on the live database, all six new tables with their indexes: about 160 MB.

| Table | Size |
|---|---|
| Recipient rows (grants) | 97 MB |
| Yearly figures | 23 MB |
| Donor-advised fund figures | 14 MB |
| Filings | 8 MB |
| Funders | 8 MB |
| Coverage | 3 MB |

The database went from 2.84 GB to 2.99 GB.

## Checks

- **Sample check (ruling 0047 clause 6):** passed on 2026-11-11. 150 of 4,842 California funders (the ten with the most grant
  rows, then a seeded draw), 1,288,914 stored values compared with the returns, 0 differences; the run's
  outcome counts add up; header audit (300 returns the loader put outside California re-read, none were in
  California); scope audit (150 returns the loader dropped as not in scope re-read, none should have been
  stored); unread audit (the two unread returns are indeed unreadable by the verifier's own reader).
  Peak memory 1 GB, 142 seconds.
- The first run of this check on real data reported one difference and failed, correctly stopping. The
  stored string was a Schedule I recipient, "Donor Network West", and the return also names it in a
  contractor field that the verifier had counted as a person. The contractor element can hold a business
  name; the verifier now skips it and still checks officers, signers and preparers. The loader's data was not
  wrong, the check was. It was fixed with a test and the check re-run to a pass.
- The foundation side of the same server finished its full California verification during the trial
  (6,065 funders, 8,774,715 values, 17 differences, all explained). The two did not disturb each other.

## The gap: the largest sponsors were refused

One California funder, EIN 31-1640316 (the name on the return should be read before anyone relies on it),
is not stored. Its two most recent returns list 46,203 and 55,292 recipients, and the loader's write
document for each (40.6 MB and 48.5 MB) is over the loader's 16 MB limit for one database call. Both are
recorded as unread, with that reason; nothing was dropped silently. Donor-advised fund sponsors are exactly
the filers with enormous recipient lists, so across the country this would leave out several of the largest
ones. Writing such a return in pieces is a small change to the loader's write step. It is a change to
decide before a national run, not something the trial did.

## National projection (an estimate, not a promise)

California is 113,485 of the 1,069,962 returns (10.6%), so the country is about 9.4 times California.

- **Storage:** about 1.5 GB (a range of 1.2 to 2.0 GB, depending on whether other states have as many
  recipient rows per return). Database from about 3.0 GB to about 4.5 GB of 8 GB. This does not include the
  oversized returns above, which would add something (the two returns are about 100,000 rows between them).
- **Time:** California took 50 minutes of which about 30 minutes was writing; the writing rate was about 400
  filings a minute. About 131,000 filings nationally is about 5.5 hours of writing plus reading the archives
  once; plan on 8 to 12 hours, unattended, one state at a time, on the same server.
- **Memory:** peak 1.6 GB for the loader and 1 GB for the check. California's foundation run needed 3.3 GB,
  so the size of the biggest state, not the trial, sets the server's memory limit; the setup default is now
  4 GB.
- **Cost:** nothing new to buy at 4.5 GB. The 8 GB included allowance is the limit that matters.

## What remains for the owner

1. Whether to run the national load, on these numbers.
2. Whether to fix the oversized-return write first (recommended: yes, before a national run).
3. Any change to the $100,000 test (changing it means rewriting every stored funder, `--rewrite-all`).
4. Whether the funder database screen (item 113) should also show charities and sponsors. It does not now;
   nothing in the screen reads these tables.
