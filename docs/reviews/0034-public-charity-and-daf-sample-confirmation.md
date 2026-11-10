# Item 116: do the IRS archives we already hold carry grantmaking public charities and donor-advised fund sponsors? Sample confirmation

Date: 2026-11-10. Ruling 0047 clause 5 asks for this before any reader is written. Tool:
`scripts/sample-990-schedules.ts` (permanent; read-only; reads local index CSVs and ZIP archives;
no download, no database, no server).

## Answer

**Yes.** The archives already on disk hold Form 990 returns that carry Schedule I (grants to
organizations) and Schedule D with donor-advised-fund figures. No new download is needed.

## What was sampled

- All index rows read: 3,311,641. Form 990 returns whose tax period ends in 2022, 2023 or 2024:
  **1,069,962**.
- Of those, **372,494 name no archive** (the 2022 and 2023 indexes have no batch column; the
  loader finds those by reading archive directories, as it already does for foundations) and
  none name an archive that is missing from disk. This sample therefore covers the 697,468
  returns whose index names their archive (mostly 2024-period returns). It is not a sample of the
  2022 and 2023 periods.
- Systematic sample, every 871st of those 697,468: **800 returns**. 753 were read, 47 (5.9%) are named
  in the index for an archive that does not hold them (the same index-versus-archive drift the
  foundation loader handles by searching other archives; it needs the same handling here), and
  none were unreadable.
- Return versions seen: 2022v5.0 through 2024v5.2, plus a few 2023v4.0.

## What was found (753 returns read)

| | Returns | Share |
|---|---|---|
| Carry Schedule I (grants to organizations) | 158 | 21.0% |
| Carry Schedule D | 596 | 79.2% |
| Carry a donor-advised-fund figure under Schedule D | 4 to 5 | about 0.5% to 0.7% |
| **In scope: grants to organizations of $100,000 or more** (Part IX line 1, domestic plus foreign) | **67** | **8.9%** |
| **In scope: donor-advised fund sponsor** (Schedule D reports at least one fund) | **5** | **0.7%** |

Cross-check: the main form's own "donor-advised fund" box is ticked (`true` or `1`) on exactly
those 5 returns. The five sponsors in the sample include community foundations and a Jewish
federation, which is who this ruling expected.

## What the elements look like (this decides the reader)

- **Schedule I** (`IRS990ScheduleI`): one `RecipientTable` per recipient, holding
  `RecipientBusinessName`, `RecipientEIN`, `USAddress`, `IRCSectionDesc`, `CashGrantAmt`,
  `NonCashAssistanceAmt`, `NonCashAssistanceDesc`, `ValuationMethodUsedDesc` and
  `PurposeOfGrantTxt`. The schedule also has `Total501c3OrgCnt`, `TotalOtherOrgCnt`,
  `GrantRecordsMaintainedInd`, and a separate `GrantsOtherAsstToIndivInUSGrp` for grants to
  individuals, which is out of scope. Schedule I lists only recipients that received more than $5,000.
  Rows per in-scope charity return: mean 13.5, median 3, largest 196.
- **Schedule D Part I** (donor-advised funds): `DonorAdvisedFundsHeldCnt`,
  `DonorAdvisedFundsContriAmt`, `DonorAdvisedFundsGrantsAmt`, `DonorAdvisedFundsVlEOYAmt`. Nothing
  in them names a donor, which is what ruling 0047 clause 3 requires.
- **Yes/no values are written two ways** (`true`/`false` and `1`/`0`), so the reader must accept both.
- **Main form**: `GrantsToDomesticOrgsGrp/TotalAmt` and `GrantsToForeignOrgsGrp/TotalAmt` (Part IX
  line 1) carry the grants-to-organizations totals used for the $100,000 line.
  `CYGrantsAndSimilarPaidAmt` (Part I line 13) also covers grants to individuals, so it is not the test.
  Only 297 of the 753 returns state a Part IX line 1 total; the others state none, and those are
  treated as "not stated", not as zero.
- Average Form 990 XML: 40 KB (median 32 KB).

## What it would add (a projection, not a promise)

Scaling the sample's 8.9% and 13.5 rows to all 1,069,962 Form 990 returns of those periods:

- about **95,000 in-scope charity returns** and about **1.3 million** Schedule I recipient rows;
  donor-advised fund sponsors: about 7,500 returns, but from only 5 in the sample, so anywhere from
  a few thousand to well over ten thousand.
- Storage, scaled from the foundation load (62,000 funders, 4.1 million grant rows, **2.76 GB**
  database today, of which grants are 1.58 GB): roughly **0.8 to 1.2 GB**, taking the database from
  about 2.8 GB to about 4 GB of the 8 GB included. California alone would be about a tenth of that.
- Time: the foundation load ran at about 7 filings a second; 95,000 returns would be about 4 hours of
  loading plus the archive reading, about the length of the foundation run.

These are the sample's numbers with a wide margin (a sample of 753; the 2022 and 2023 periods not
sampled; the share with a stated Part IX total is small). The California trial in clause 6 is what
replaces the projection with a measurement.

## What this does not settle

- The 47 returns the index places in an archive that does not hold them need the same directory
  search the foundation loader uses; a reader that trusted the index would silently miss about 6%.
- The $100,000 test needs a rule for the 456 of 753 returns that state no Part IX line 1 total
  (proposed: not in scope on that return, counted and reported, never as zero grants).
- Clause 7 still holds: nothing runs on the server or in the production database until the national
  foundation load is complete and verified.
