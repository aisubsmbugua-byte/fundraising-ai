# 0031 — Funder reference database, California pilot: build report

Item 110 · authorized by ruling 0045 · decision 0010 · build space, 2026-11-06
Status: **built and verified on a local Postgres. Migration 0084 was applied to production on 2026-11-07 at the owner's explicit instruction (section 13); no data is loaded there yet. Nothing committed or pushed.**

## 1. Read this first

1. **The worked example matches the filing.** For Servant's Heart Foundation Inc (EIN 58-2218044), all three tax periods (ending 2022-12-31, 2023-12-31, 2024-12-31) were loaded from the IRS's own files and compared with them by a separate verification script: **1,991 stored values compared, 0 mismatches**, run both against local copies and against fresh copies fetched from the IRS archive location the database recorded.
2. **The decision doc has one wrong label and two wrong estimates** (section 6). Its "qualifying distributions" row ($841,321 / $849,758) is the filing's *distributable amount*; the filing's real qualifying distributions are $1,104,388 / $1,067,256 / $1,855,039. Its "about 20 grants" for 2023 is 33. This is the "sources disagree" problem the ruling predicted, and the database now holds the right figures under the right names.
3. **California is loaded and verified, into a local database only.** Form 990-PF returns with a tax period ending 2022 to 2024: **6,165 California foundations in scope (17,292 returns, 402,152 listed grants, 81,141 people rows)**, loaded in about 90 seconds. **Every stored value for every one of those 6,165 funders was compared with its IRS return: 8,691,829 comparisons, 0 mismatches.** 5,901 returns that the IRS index lists are in no IRS archive and are recorded as unread, not guessed (section 7).
4. **The size threshold is not set by the owner.** I used the decision doc's suggestion as two clearly named parameters (`--min-assets 1000000`, `--min-giving 100000`) and said so on every run record. Section 8 has what other values would have changed.
5. **Things I could not do or verify** are listed in section 10. The two that matter most: nothing was run against the real Supabase project (the Supabase write path is untested live), and NTEE code and ruling year are not stored, because they are not on a Form 990-PF and ruling 0045 clause 2 says a value with no source filing is not stored (a question for the decision space, section 10).

## 2. What was built

All new, except one existing test assertion that was edited (section 9).

| Path | What it is |
|---|---|
| `supabase/migrations/0084_funder_reference.sql` | Eight shared tables, access rules, and the single write function. The SQL is inlined in section 12. |
| `lib/funder-reference/xml.ts` | A strict XML reader (refuses DOCTYPE, mismatched tags, unknown entities). No dependency added. |
| `lib/funder-reference/inflate.ts` | Deflate **and Deflate64** decoder. Needed: see section 3. |
| `lib/funder-reference/zip.ts` | ZIP reader: ZIP64, bytes before the archive, three compression methods, CRC-32 check on every member read, reads from disk or from the IRS over HTTP range requests. |
| `lib/funder-reference/parse-990pf.ts` | Form 990-PF return to plain data. Rejects what it cannot understand. |
| `lib/funder-reference/derive.ts` | The size threshold and the derived figures, each naming its set. |
| `lib/funder-reference/document.ts` | Turns a parsed return into rows; stamps each with filing, EIN, period end, load time, loader version. |
| `lib/funder-reference/sources.ts` | IRS index and archive names, index reader, archive provider. |
| `lib/funder-reference/pipeline.ts` | The loader's flow and its counting. |
| `lib/funder-reference/sink.ts` | Where it writes: local Postgres (PGlite) or Supabase with the service key. |
| `scripts/load-funder-reference.ts` | The offline loader (command line). |
| `scripts/fetch-funder-reference-sources.ts` | Resumable download of the IRS index files and archives. |
| `scripts/verify-funder-reference-example.ts` | The permanent verification script. |
| `scripts/test-funder-reference.ts` | 161 unit assertions, no database. |
| `scripts/test-funder-reference-migration.ts` | 115 assertions on a real Postgres. |
| `scripts/funder-reference-stats.ts` | Read-only measurements of what is in the tables (counts, sizes, unread reasons, coverage, grant-list quality, a privacy scan). |
| `scripts/funder-reference-support.ts`, `funder-reference-test-support.ts` | Test harness and a ZIP writer. |
| `scripts/fixtures/funder-reference/` | The three real Servant's Heart returns (public IRS files, ~160 KB) and the exact compressed bytes of one as the IRS stored it. |

Nothing under `app/`, `components/` or the rest of `lib/` mentions these tables or imports this code; a test scans for that.

**The invariant implemented, in one sentence:** every value in the shared reference tables traces to a named IRS return and tax period end, no application role can change one, and anything the return does not state, or the loader could not read, is recorded as absent or unread rather than filled in.

## 3. Where the data comes from, and what I found about it

Source: the IRS "Form 990 series (e-file) XML" bulk downloads, `https://apps.irs.gov/pub/epostcard/990/xml/<year>/`: one index CSV per year and monthly ZIP archives of the returns. ProPublica's site is not read by the loader.

Findings that shaped the build (all observed 2026-11-06):

- **The archives cannot be read by the usual tools.** `2025_TEOS_XML_11B.zip` (80,283 members) is ZIP64 and stores its members with **Deflate64** (ZIP method 9). Python's `zipfile` raises `NotImplementedError: That compression method is not supported` on it, and macOS `unzip` and `bsdtar` call it damaged. A loader that used those tools would have silently dropped whole months. The loader reads it with its own decoder, and every member is checked against the CRC-32 the archive records (all matched).
- **The 2022 and 2023 index files have no batch column** (the 2024 index onward do), and a return can sit in a different month's archive than its submission suggests (the example's 2022-period return, submitted 2023-11-14, is in `2023_TEOS_XML_11A`). Those are found by reading archive directories.
- **Member naming differs by archive** (folder-prefixed in most, top-level in `2025_TEOS_XML_11B`); lookup is by file name.
- **About 1.6% of the wanted index rows are in no archive.** Section 7.
- Index files carry the tax period as `yyyymm` only; the exact end date comes from the return.
- ProPublica's terms: the API page defers to ProPublica's Data Terms of Use, which restrict republishing the raw data in full, reselling and changing it. I made **one** API call (this EIN) to cross-check; nothing from ProPublica is stored in any table or committed.

## 4. How the tables meet ruling 0045

| Clause | How it is met | Where it is tested |
|---|---|---|
| 1. Shared, no write by any application role | No `organization_id` on any table. RLS on, one `select` policy per table (`my_organization_id() is not null`), **no insert/update/delete policy**. As a second lock, insert/update/delete/truncate are **revoked** from `anon` and `authenticated` (Supabase grants them by default). Writes go through `funder_reference_apply_filing(jsonb)`, executable by `service_role` only. | Migration test: catalog checks; a member's insert/update/delete/truncate refused on all eight tables; the function refused to members and anon; with the privilege deliberately restored, RLS alone still refuses (the second lock holds by itself). |
| 2. Every value carries its source | Every data row has `filing_object_id`, `ein`, `tax_period_end`, `loaded_at`, `loader_version`, tied to its filing by a **composite foreign key** (so they cannot disagree). The filing row records the IRS archive URL and the member inside it, plus the SHA-256 of the exact bytes read. | Test: every row traces to a filing; a mismatched row is refused by the database. Verifier: re-fetches the member, compares its SHA-256 with the stored one. |
| 3. Figures by tax period, separately named | Keyed by period end date. Contributions paid per books, the cash-basis disbursements column, charitable disbursements, qualifying distributions and distributable amount are five columns named for the form's lines; no "giving" column exists. Derived figures sit next to a sentence naming the set and the figures used. | Test on column names; verifier recomputes every derived figure independently. |
| 4. Absent stays absent | Every value column is nullable and null means "the return does not carry it". Website is stored exactly as the return wrote it (N/A) and never turned into a URL. The unticked "preselected only" box stays null, not false. No email or phone is invented (the only phone is the one stated on the return). Grant-list statistics are null, never 0, when no rows were listed. | Parser and migration tests with elements removed. |
| 5. People as named | One row per person per filing, plus the return's signer as a separate row. No person key exists across filings. | Test: "PAUL A NEFF" is eight rows across four filings; no person-key column. |
| 6. Offline, repeatable, honest | Command-line only. A second run writes nothing and changes no row. A killed run resumes to exactly the state of a clean run. Each run records rows read/loaded/rejected, names each unread filing with a reason, and records missing periods as `no_filing_in_index`, never as zero. | Migration tests (twice-run byte-identical; crash-and-resume equals clean; unread reasons; missing period has no figures row). |
| 7. Proposes, never decides | No screen, no use in matching/discovery/scoring, no prospect creation, no write path from the app. | Source scan: nothing outside `scripts/` and `lib/funder-reference/` mentions the tables. |

Also: the signing officer's SSN field (published masked by the IRS) is never read into anything; a test and the verifier both check it appears nowhere in stored data.

## 5. The worked example: how it was verified

**Load.** `scripts/load-funder-reference.ts --ein 582218044` found three Form 990-PF rows in the IRS index files, located each in its archive (two read straight from the IRS over HTTP range requests, one from a local copy of the Deflate64 archive), and stored them: 3 filings, 1 foundation, 3 figures rows, 15 people rows (4 officers + the signer, per year), 93 grants (30 + 33 + 30), 3 application-terms rows, 3 coverage rows (all `loaded`). A second run: 0 written, 3 unchanged.

**Verify.** `scripts/verify-funder-reference-example.ts` is deliberately independent of the loader: its own regular-expression XML scanner, its own column-to-element table typed out again, its own arithmetic for the derived figures. It also holds nine figures for the 2022 return that I transcribed by reading the XML. It compares, for every filing:

- the SHA-256 and length of the XML against what was stored (so what is compared is what was loaded);
- every column of the filings, foundation, figures and application tables, every people row and every grant row (name, address parts, relationship, status, purpose, amount), and the whole `financial_statement_values` document (110 element/value pairs per return);
- every derived figure, recomputed;
- row counts (no missing and no extra rows), provenance on every row, and that the SSN is nowhere in the stored text.

Result: **1,991 comparisons, 0 mismatches**, `RESULT: PASS`. The same with no local copy (each return re-fetched from the archive location the database recorded): identical.

**What the filing carries that is not stored** (the verifier prints it by section, using the return's own element names): across the three returns, 635 of 2,016 leaf elements. Mostly parts of the return that are not about who the funder is or how it gives: `UndistributedIncomeGrp` (75; only the current-year undistributed income is a column), `StatementsRegardingActy4720Grp` (71 yes/no questions), `AnalysisIncomeProducingActyGrp` (53), the rest of `StatementsRegardingActyGrp` (52), `ExciseTaxBasedOnInvstIncmGrp` (30), `TrnsfrTransRlnNonchrtblEOGrp` (30), `CapGainsLossTxInvstIncmDetail` (23), the attached expense and investment schedules, the preparer firm and preparer person (27), and **Schedule B (38 elements: the foundation's own donors, deliberately not stored)**. Everything in Part I (revenue and expenses) and Part II (balance sheet), plus the minimum-investment-return, distributable-amount and qualifying-distribution groups, is kept, as named columns where the form defines one and otherwise in `financial_statement_values`.

**The tamper test.** The migration test loads the example through the command line, runs the verifier (pass), then as the service key changes one figure by $1, deletes one grant row, renames an officer and corrupts a stored hash. The verifier exits non-zero and names each: `total_revenue_per_books_amt: stored "539141" but the filing gives "539140"`; the grant count; `officer 1 name_as_named: stored "PAUL B NEFF"`; the `xml_sha256`.

## 6. What disagreed (reported, not smoothed)

The decision doc's figures came from ProPublica's API and page (checked 2026-11-06). I made one call to the same API for this EIN and compared **ProPublica, the decision doc and the IRS return** field by field (the verifier prints the ProPublica comparison with `--propublica <saved response>`).

| Item | Decision doc | The IRS return | Verdict |
|---|---|---|---|
| Total assets, year end | 17,049,161 / 17,401,474 / 17,408,962 | Part II total assets, end of year: identical (book and fair market value both) | agrees |
| Revenue | 539,140 / 576,743 / 677,750 | Part I line 12, per books: identical | agrees |
| Total expenses | 2,054,296 / 1,333,213 / 2,108,008 | Part I line 26, per books: identical | agrees |
| Contributions paid, per books | 911,323 / 831,853 / "not yet in structured data" | 911,323 / 831,853 / **1,653,654** | agrees; 2024 now filled in from the IRS file |
| **"Qualifying distributions"** | **841,321 / 849,758** | **Qualifying distributions (Part XII line 4) are 1,104,388 / 1,067,256 / 1,855,039.** 841,321 and 849,758 are the **distributable amount** (Part XI line 7) | **DISAGREES: wrong label** |
| Charitable disbursements | 1,104,388 / 1,067,256 / 1,855,039 | Part I line 26 column (d): identical (and in these three returns equal to qualifying distributions) | agrees |
| Grants in 2023 | "about 20" | **33** listed in Part XV | **DISAGREES** (2022: 30, 2024: 30) |
| Average gift | "roughly $30,000 to $40,000" | 2022: $30,377; **2023: $25,208**; 2024: $55,122 (medians 13,750 / 12,000 / 22,500) | 2022 agrees; 2023 does not; 2024 differs |
| "$911,322 under 2023 vs $911,323" | the aggregator is off by $1 | The return carries **both**: Part XV's stated total of grants paid is 911,322 (and the 30 listed grants sum to exactly that); Part I per-books contributions paid is 911,323 | not an error: two lines of the same return |
| Officers | Paul A. Neff, Kathy A. Neff, Richard Haugen, Lindsey Haugen | Same four, titles as in the doc; compensation: Richard Haugen $31,790 (2022), $2,718 (2023), $16,306 (2024); others $0 | agrees |
| "Invitation-only, not accepting unsolicited requests" | an aggregator claim | The "only preselected charities" box is ticked (`X`) on **all three** returns | agrees (read from the return, as the doc asked) |
| Individual grants "about $100 to about $220,000" | aggregator | 2022: $100 to $220,148; 2023: $110 to $190,000; 2024: **$515 to $592,500** | agrees for 2022; the top end grew in 2024 |
| Most common states | CA, TX, NC | By number of grants over the three years: CA 43, TX 7, NC 6 (by amount: $1.83M, $368k, $318k) | agrees |
| Minimum payout "about $850,000 on $17.4M" | | Minimum investment return: $841,321 (2022), $850,901 (2023), $882,611 (2024); qualifying distributions are 1.31x, 1.25x and 2.10x that minimum | agrees |
| The 2024 return | exists, not yet in structured data | In the IRS file and now loaded | agrees |

**ProPublica's own fields.** Its `totassetsend`, `totrevenue`, `totfuncexpns`, `contrpdpbks`, `distribamt` and `totexpnsexempt` agree with the return for 2022 and 2023. `distribamt` is the distributable amount, which is how the decision doc's "qualifying distributions" row came about. ProPublica's field `qlfydistriamt` is empty and `qlfydistribtot` is 0 for both years; the IRS field dictionary (`12eofinextractdoc.xls`) groups the `qlfydistrib*` fields with the Form 990-PF Part XIV block (the private-operating-foundation test), which a non-operating foundation leaves empty. That is consistent with the zeros but I did not confirm it line by line, so I list it as a disagreement I could explain rather than one I resolved. For 2024 ProPublica lists the filing without structured data, as the decision doc said.

**Not on the return, so not stored:** ruling year (ProPublica says 1996), NTEE code (T20Z) and foundation code. See section 10.

## 7. The California pilot

Run only after the worked example matched. (The loaded database is at `/private/tmp/claude-502/-Users-kanjii-Developer-Fundraising-Ai-Build-fundraising-ai--claude-worktrees-inspiring-goldwasser-2fec5d/ff21421c-3b1d-4f16-bb9f-627af383e12e/scratchpad/pilot/db`, a temporary session folder; section 11 rebuilds it.) **Loaded into a local PostgreSQL (PGlite) with all 84 project migrations applied, not into production** (no migration may be applied to production in this item, so there is no production table to write to yet).

**What "California, three tax years, above a size threshold" meant here** (four choices, all mine, all easy to change):

1. **Form 990-PF only.** Public charities that make grants file Form 990 with Schedule I, a different structure; they are not in this pilot. So the seven-channel coverage in the decision doc still holds: strong for foundations and family trusts, nothing for the rest.
2. **"Tax period" is the calendar year in which the period ends** (2022, 2023, 2024), so a June-year-end foundation contributes periods ending 2022-06, 2023-06 and 2024-06. This is how ProPublica labels them (`tax_prd_yr`).
3. **California = the state in the filer's own address on the return**, found by reading each return's header, then confirmed on the whole return before anything is stored. Section 7.2 audits the header check.
4. **Threshold, per funder:** a foundation is in scope if **any one of its filings in the three periods** shows total assets (fair market value, end of year) of at least **$1,000,000** *or* contributions paid per books of at least **$100,000**. The owner has not set these; they are the decision doc's suggestion, set as the named parameters `--min-assets` and `--min-giving`, and every run record stores them. **Full grant lists (and officers) are kept for every period of every in-scope funder; below-threshold funders keep a filing row (EIN, period, location, size figures in its note) and nothing else.** That is my reading of "keep the full grant list only above the threshold"; if the owner meant per filing rather than per funder, it is a one-line change.

### 7.1 Counts

Run `ad688c1f` (the rebuild with the corrected migration; the first build, run `53330e60`, produced identical counts), completed, **88 seconds** for the load (93 for the first build). (Downloading the 18.5 GB of IRS archives, once, took about 20 minutes in two sittings; the second resumed a stalled connection by itself.) Every index row ends in exactly one named outcome and the outcomes sum to the rows considered (`outcomes_sum_check: true`):

| Set | Rows |
|---|---|
| Form 990-PF rows in the IRS index with a period ending 2022-2024 (nationwide) | **374,947** |
| the filer is outside California (332,908 by the header, 2 more after a whole-return read): counted, not stored | 332,910 |
| in California, funder below the threshold: filing row only | 18,649 (7,478 funders) |
| in California, in scope, standing | **17,292 filings** (6,165 funders) |
| in California, in scope, superseded by a later (amended) return for the same EIN and period | 195 |
| **unread: the IRS index lists the return but no archive holds it** | **5,901** |
| unreadable for any other reason (bad CRC, malformed XML, EIN or period disagrees with the index) | **0** |

Of the 36,138 returns read in full because the header said California (or could not be read), none failed to parse or to match the index; 36,136 are California and 2 were not.

What is stored (counts from the tables; sizes from the database, which holds 42,037 filing rows in all):

| Table | Rows | Size |
|---|---|---|
| filings (all outcomes above except out-of-state) | 42,037 | 26 MB |
| foundations (one per funder) | 6,165 | 3.5 MB |
| figures (one per funder and tax period end) | 17,292 | 45 MB |
| people (officers, directors, trustees as named, plus the signer) | 81,141 | 30 MB |
| grants (378,244 paid during the year; 23,908 approved for future payment) | 402,152 | 156 MB |
| application terms | 17,292 | 5.6 MB |
| period coverage (6,165 funders x 3 periods) | 18,495 | 7.8 MB (after the second run rewrote it) |
| **Tables total** | | **about 275 MB** (the database directory on disk is about 660 MB) |

The IRS returns that were read held 875 MB of XML (52 KB on average). Peak memory of the load process was **4.9 GB** (`/usr/bin/time -l`), which matters on a smaller machine.

**Periods held per funder in scope (6,165 funders):** all three, 5,242; two, 616; one, 307. By period year: 2022 loaded for 5,615 (345 with no 990-PF in the index for a period ending in 2022; **205 unread** because the 2022 return is in no archive); 2023 loaded for 5,854 (311 with none in the index); 2024 loaded for 5,796 (369 with none in the index; returns for fiscal years ending late 2024 may simply not be filed yet). `no_filing_in_index` means only that the IRS index files read by the run list no such return; it is recorded as missing, never as zero.

### 7.2 Is the California filter right?

The state is found from the first ~12 KB of each return, then confirmed on the whole return for every one the header called California: **0 of those turned out to be elsewhere** (2 returns whose header could not be read were read in full and were not California). The other direction (a California funder the header check ruled out) cannot be seen without reading everything, so the run reads a repeatable random sample of the ruled-out returns in full: **3,000 of the 332,908 sampled, 3,000 read, 0 in California after all.** A rate of 0 in 3,000 does not prove 0 in 332,908; it bounds it (roughly, fewer than 1 in 1,000 at ordinary confidence).

### 7.3 Is the stored data right? (every value, every funder)

`verify-funder-reference-example.ts --all` re-reads each funder's returns from the IRS archives (the same files the loader read, from disk) and compares every stored value with them, with the verifier's own XML reader and its own column table: **8,691,829 comparisons across all 6,165 funders in the database, 0 mismatches** (`RESULT: PASS`, about 9 minutes). A first full run found the amended-return chain defect described in section 9 (4 funders) and a false alarm in its own SSN scan; both were fixed, the database was rebuilt from scratch, and this is the result of the second full run.

It also covers a chosen sample of funders picked to hit each feature (largest grant list, foreign-address recipients, named-person recipients, application details, an amended return, a non-December year end, a private operating foundation, a funder whose grant rows do not sum to its stated total, a funder with money paid but no grant list, funders holding one or two periods, a funder with an unread period): 42 funders, 356,324 comparisons, 0 mismatches.

### 7.4 What the data looks like (findings you will want before relying on it)

- **Grant lists are present for 90.7% of standing filings** (15,691 of 17,292: a total stated above zero, rows listed, money paid per books above zero). The median filing lists 9 grants, the 90th percentile 46, the most 2,382.
- **1,563 standing filings (9.0%) list no grants.** 779 state a Part XV total of 0 and show 0 paid per books, and 745 state no total and show 0 paid: they paid nothing. **39 are real gaps**: 29 show money paid per books ($4.9 million in all) with no Part XV total and no rows; 10 state a total of 0 yet show money paid per books ($33.7 million in all). These are stored with `grants_listed_count` null (not 0) and a derivation sentence saying why; any downstream use must read null as "list not available", not "gave nothing".
- **Listed rows equal the stated total in every case but one.** The exception (EIN 954664672, year ending 2024-09-30) lists 19 rows totalling $129,200 against a stated $137,700 (also its per-books figure); I checked the raw XML: the return itself is short by $8,500, there is no hidden row. The loader stores the gap (`grants_listed_minus_stated_amt = -8500`) rather than hiding it. (The $1 difference in the worked example is a different kind: two different lines of one return, both correct.)
- **No element of any grant row was left unread** (`unmapped_fields` is empty on all 402,152 rows). 10,473 paid grants go to foreign-address recipients. 80,457 paid grants use the person-name field for the recipient; that is the element the filer used, not a finding that the recipient is a person (one filer typed "PEF ISRAEL ENDOWMENT FUND INC" there), so the column is `recipient_person_name` and no one should treat it as a person flag.
- **How funders say they take requests.** On 14,125 filings (5,092 funders) the "only preselected charities" box is ticked. On 3,167 filings (1,205 funders) there is **no mark**, and 3,064 of those carry application details (contact, form, deadline, restrictions as written); 1,129 funders have at least one such filing. The unmarked box is stored as null, not as "accepts requests": the unmarked-and-details filings are the real signal.
- **Websites:** 4,596 funders state "N/A" or similar, 1,249 state a value, 320 have no website element. Nothing was derived.
- **Officers:** 63,849 rows (6,165 funders), 9,073 of them paid compensation.
- **556 funders are private operating foundations** (a different kind of funder from the grant-making majority); 2 do not say.
- **Amended returns:** 195 filings are kept but superseded; the later return's figures stand and nothing is counted twice.

## 8. The size threshold: what other values would have changed

The owner has not set it. These are counts over the **13,643 California funders read in full** (each funder counted once, by its largest value over the three periods). The run record stores this table so it need not be re-derived.

| Assets (FMV, end of year) at least | Funders | | Contributions paid per books at least | Funders |
|---|---|---|---|---|
| $100,000 | 8,481 | | $10,000 | 8,433 |
| $250,000 | 7,367 | | $25,000 | 7,255 |
| $500,000 | 6,294 | | $50,000 | 6,118 |
| **$1,000,000** | **5,082** | | **$100,000** | **4,842** |
| $5,000,000 | 2,425 | | $250,000 | 3,243 |
| $10,000,000 | 1,617 | | $500,000 | 2,206 |
| $50,000,000 | 539 | | $1,000,000 | 1,503 |
| $100,000,000 | 299 | | $5,000,000 | 473 |

With the suggested pair: **either** test 6,165 funders (assets only 1,323; giving only 1,083; both 3,759); **neither** 7,478. "Either" admits 1,083 funders with under $1 million in assets that still give at least $100,000 a year, and 1,323 funders with at least $1 million that give less than $100,000. Requiring **both** would give 3,759. Because funders below the threshold store only a filing row, changing the threshold means re-running the loader (about 90 seconds here, with the IRS files already on disk), which re-evaluates every filing.

## 9. Verification, in one place

| Check | Result |
|---|---|
| Worked example, stored vs filing | 1,991 comparisons, 0 mismatches; also with every return re-fetched from the IRS |
| California pilot, **every funder** stored vs filing (`--all`) | **8,691,829 comparisons across all 6,165 funders, 0 mismatches** (about 9 minutes) |
| California pilot, 42 chosen-and-random funders | 356,324 comparisons, 0 mismatches (including one per feature: largest grant list, foreign recipients, application details, an amended return, a non-December year end, an operating foundation, a grant-total mismatch, money paid with no list, one or two periods held, an unread period) |
| Pilot header filter | every return the header called California was confirmed California on the whole return (0 elsewhere); 3,000 random returns it ruled out were read in full, 0 were California |
| Pilot idempotence at scale | A second run over the finished database took 36 s: 0 rows written, 42,037 unchanged, same outcomes; every row of every table (ignoring only the load-time and run columns) hashes identically before and after, and a second run record exists |
| Example, ProPublica cross-check | agrees except the `qlfydistrib*` question above; and the decision doc's label |
| `npx tsc --noEmit` | clean |
| `npx next build` | compiles |
| `scripts/test-funder-reference.ts` (no database) | 161 passed, 0 failed |
| `scripts/test-funder-reference-migration.ts` (real Postgres) | 115 passed, 0 failed |
| Existing suites | test-network 183, test-network-import 156 (see below), test-network-identity 303, test-network-identity-flow 114, test-network-identity-migration 96 (all 84 migrations apply), test-assistant 585, test-agent 344, test-supporters 182, test-send-draft 268, test-reply-address 138, test-ai-runs 70, test-health-status 19, test-ledger-check 111: all passing. `test-send-draft` and `test-ai-runs` print "NOT EVALUATED: DB assertions -- no env supplied" for their live-database assertions, as before this item. `test-tenant-isolation` needs a live Supabase project; it was not run and I did not extend it (the new tables are deliberately outside its tenant rule). |
| `npx tsx scripts/ledger-check.ts` | "protocol intact" |
| Mutation checks on the access rules | Add an insert policy and privilege for members: 7 assertions fail by name. Open the write function to members: 2 fail. Add `organization_id` to a table: 1 fails. Migration restored byte for byte afterwards. |
| Tamper test on stored data | The verifier exits non-zero and names the changed figure, the missing grant, the renamed officer and the changed hash |

**One existing assertion was edited.** `scripts/test-network-import.ts` has an assertion that no migration is added in the working tree other than 0083. It now allows 0084 as well, exactly as item 108 did for 0083. Old: `!/…0083_network_identity\.sql$/`; new: `!/…(0083_network_identity|0084_funder_reference)\.sql$/`, with the comment and the assertion label updated to match. Nothing was deleted. (Once the migration is committed the assertion passes either way.)

**Defects found in my own work by the tests, the trial runs and the full verification, all fixed and each now pinned by an assertion:**

- The loader counted a filing as "loaded" at the moment it was applied and kept that answer after a later amended return demoted it (found by the run-it-twice test: coverage pointed at the demoted return on the first run and the right one on the second).
- Stale coverage rows would have survived a funder dropping out of scope when the threshold was raised.
- A return found in no archive was given an invented archive URL as its "document location"; it now records the index file that lists it and says the member was not found.
- A failed archive open leaked its file handle (Node crashed on it, first seen in a trial run while a download was still in progress); the same in the verifier's archive reader.
- Lower-case batch ids in the real 2024 index (`2024_TEOS_XML_05a`) did not match the archive names (about 245,000 index rows).
- **Found only by verifying every funder:** when one period has three returns (an original and two amendments), the oldest still named the middle one, not the one that stands. It affected 4 of the 6,165 funders (EINs 330885306, 384322070, 823472414, 954442308). The write function now repoints every earlier return to the current one; a test applies three returns in four different orders. The pilot database was rebuilt with the corrected migration and re-verified.
- The verifier's hand-read check for Servant's Heart 2022 was applied to every funder with a 2022 year end (288 false mismatches); it is now limited to that EIN. Its SSN scan also fired on a project code two filers typed into grant purposes (`...-#XXX-XX-XXXX`); it now fires only on a value that contains digits. A separate scan of the stored people, grant, foundation and application text finds **no SSN-shaped string** (`funder-reference-stats.ts`, "privacy scan").

## 10. What I could not verify, and what is not built

**Not verified**

1. **Nothing ran against the real Supabase project.** The migration was applied only to a local Postgres (PGlite) with Supabase's roles and default privileges imitated, not to the platform; `supabaseSink` was checked against a recording stub only (call shapes, chunking, errors), not live. After the owner applies 0084, run the post-apply check in section 11.
2. **The load timings are for an in-process database.** About 90 seconds for 42,037 filings includes no network. Against Supabase every stored filing is one remote function call (42,037 calls, 17,487 of them carrying a full document, the largest with 2,382 grant rows); that is unmeasured, and so is the size of the largest single call against PostgREST's request limits.
3. **The column definitions are checked against ProPublica for six figures on one funder, not against the IRS schema documentation.** Columns I could not cross-check with an independent source include net value of noncharitable-use assets, minimum investment return, and undistributed income. The Form 990-PF line numbers in the SQL comments are from my knowledge of the form's layout and were not checked against the form instructions; the loader reads by element name, not line number.
4. **The verifier proves the stored data equals the IRS files, not that the IRS files are right**, and it was written by the same author as the loader (though sharing no parsing code). A reading of what an element means that I got wrong in both places would pass.
5. **The IRS index's own completeness.** 5,901 index rows have no member in any archive (5,900 are in the 2022 index, 55% of that file's relevant rows, mostly non-calendar-year foundations whose period ended in early 2022; 1 in the 2023 index). I cannot tell whether those returns exist elsewhere on the IRS site. They are recorded as `unread` with the state unknown, which includes some non-California funders: 5,895 EINs nationwide.
6. **The state check on ruled-out returns is a 3,000-return audit, not a full read** (section 7.2).
7. **Memory:** the load needs about 5 GB on this machine.

**Not built (outside the authorization or deliberately left)**

- **Ruling year, NTEE code, foundation code, and whether a funder is still an active filer.** None is on a Form 990-PF. The decision doc lists them in the foundation field list, but ruling 0045 clause 2 says "a value with no source filing is not stored." They would come from the IRS exempt-organization master file, which is a second public source with no filing behind each value. **Question for the decision space:** does clause 2 need a companion clause for that source, or should these stay out?
- Public-charity grant-makers (Form 990, Schedule I).
- Recipient matching (EINs for the grant recipients), and so "repeat recipients" and "first-time recipients" (they need recipient identity); share of grants to the home state *is* computed.
- Any screen, scoring, use in matching or discovery, any state but California.
- A refresh schedule (re-running the loader is idempotent; when and how often is a decision for later).

## 11. Reproducing it, and checking it after the migration is applied

Commands (absolute paths; the project folder name contains spaces, so they are quoted):

```bash
cd "/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai"
npx tsx scripts/fetch-funder-reference-sources.ts --out /path/to/irs-data
npx tsx scripts/load-funder-reference.ts --work-dir /path/to/irs-work --index-dir /path/to/irs-data/index --archives-dir /path/to/irs-data/zips --state CA --years 2022,2023,2024 --audit-header-sample 3000 --target pglite:/path/to/irs-work/db
npx tsx scripts/verify-funder-reference-example.ts --db pglite:/path/to/irs-work/db --all --archives-dir /path/to/irs-data/zips
npx tsx scripts/funder-reference-stats.ts --db pglite:/path/to/irs-work/db
```

The load into the real project, after the decision space has countersigned and the owner has applied 0084, is the same command with `--target supabase --confirm-write-to-supabase` and the two server-side variables set in the shell (never in a file).

**Post-apply check for the owner** (run in the Supabase SQL editor; expected results in the comments):

```sql
-- 1) the member role holds SELECT and nothing else on the eight tables; anon holds nothing
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_name like 'funder\_reference\_%' and grantee in ('anon', 'authenticated')
order by 1, 2, 3;                              -- expect 8 rows: authenticated / SELECT

-- 2) every table has row-level security and exactly one policy, a SELECT policy
select c.relname, c.relrowsecurity, (select count(*) from pg_policies p where p.tablename = c.relname) as policies,
       (select string_agg(cmd, ',') from pg_policies p where p.tablename = c.relname) as commands
from pg_class c where c.relname like 'funder\_reference\_%' and c.relkind = 'r' order by 1;
                                               -- expect true / 1 / SELECT for all 8

-- 3) only service_role may call the write function
select has_function_privilege('anon', 'funder_reference_apply_filing(jsonb)', 'execute') as anon,
       has_function_privilege('authenticated', 'funder_reference_apply_filing(jsonb)', 'execute') as authenticated,
       has_function_privilege('service_role', 'funder_reference_apply_filing(jsonb)', 'execute') as service_role;
                                               -- expect false / false / true
```

## 12. The migration SQL, exactly as in `supabase/migrations/0084_funder_reference.sql`

Not applied to production. This is the whole file, unchanged (it was embedded by script from the file, not retyped).

```sql
-- STATE item 110, authorized by ruling 0045: the platform's own reference
-- database of US grant-making organizations, built from public IRS Form 990-PF
-- filings (California pilot).
--
-- THIS IS DELIBERATELY NOT TENANT DATA. Hard rule 6 (organization_id + an RLS
-- policy scoped by it) does NOT apply to these tables, and ruling 0045 clause 1
-- says so on purpose: they hold public documents that are the same for every
-- organization and nothing any organization wrote. What replaces the rule:
--
--   * READ: every signed-in member of any organization (my_organization_id() is
--     not null), no one else. anon reads nothing.
--   * WRITE: no application role. Row-level security has NO insert/update/delete
--     policy for any role, AND the table privileges for insert/update/delete/
--     truncate are revoked from anon and authenticated (Supabase grants them by
--     default; relying on RLS alone would leave one missing policy away from an
--     open table). Only service_role writes, and only the offline loader
--     (scripts/load-funder-reference.ts) holds that key. Nothing in app/ or lib/
--     (outside lib/funder-reference/) touches these tables; a source scan in
--     scripts/test-funder-reference-migration.ts holds that line.
--   * Everything an organization adds about a funder (notes, status, a prospect)
--     stays in its own org-scoped tables and refers to a funder here by EIN.
--
-- WHAT EVERY VALUE CARRIES (clause 2). Each data row names its filing by
-- (filing_object_id, ein, tax_period_end) through a COMPOSITE foreign key to
-- funder_reference_filings, so the denormalized EIN and period cannot disagree
-- with the filing. The filing row carries where the document can be read (the
-- IRS archive URL and the member inside it), when it was loaded and by which
-- loader version, and the SHA-256 of the exact XML that was read.
--
-- WHAT A FIGURE IS (clause 3). Keyed by tax period END DATE. Figures that sound
-- alike are separate columns named for the form's own line. There is no column
-- called "giving". Derived figures sit beside a column that names the set they
-- were computed over and the figures they used.
--
-- WHAT IS ABSENT STAYS ABSENT (clause 4). Every value column is nullable; null
-- means "the filing does not carry it", never zero or empty text. A tax period
-- the IRS index does not list is a funder_reference_period_coverage row with
-- status 'no_filing_in_index', not a row of zeros.
--
-- PEOPLE (clause 5). One row per person per filing, as named. No person table,
-- no key shared across filings.
--
-- THE LOADER (clause 6). It writes a filing and everything under it through ONE
-- function, funder_reference_apply_filing(jsonb), so a filing is replaced
-- atomically and a crash never leaves half of one. The function is executable
-- by service_role only.

-- ---------------------------------------------------------------------------
-- runs: recorded before they run (ruling 0026), finished at the end
-- ---------------------------------------------------------------------------
create table funder_reference_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  loader_version text not null,
  status text not null check (status in ('running', 'completed', 'failed', 'interrupted')),
  parameters jsonb not null,            -- every knob the run used, incl. the size threshold
  sources jsonb not null default '[]',  -- index files / archives read, with sizes and hashes
  counts jsonb not null default '{}',   -- rows read / loaded / rejected, by name
  rejected_filings jsonb not null default '[]', -- each unread filing: object_id, ein, reason
  notes text
);

-- ---------------------------------------------------------------------------
-- filings: one row per IRS return the loader considered in scope
-- ---------------------------------------------------------------------------
create table funder_reference_filings (
  object_id text primary key check (object_id ~ '^[0-9]{18}$'),   -- the IRS OBJECT_ID
  ein text not null check (ein ~ '^[0-9]{9}$'),
  return_type text not null,                                      -- '990PF'
  index_tax_period text not null check (index_tax_period ~ '^[0-9]{6}$'), -- yyyymm as the IRS index gives it
  tax_period_end date,                                            -- from the return itself; null only when unread
  tax_period_begin date,
  tax_year text,
  return_version text,
  return_ts timestamptz,
  status text not null check (status in ('loaded', 'superseded', 'unread', 'skipped_below_threshold')),
  status_note text,                                               -- the reason, for every status but 'loaded'
  superseded_by_object_id text references funder_reference_filings (object_id),
  -- where the document can be read
  index_file text not null,                                       -- e.g. index_2025.csv
  index_return_id text,
  index_sub_year integer,
  document_archive_url text not null,                             -- the IRS zip
  document_member text not null,                                  -- the file inside it
  xml_sha256 text,                                                -- of the exact bytes parsed
  xml_bytes integer,
  -- when and by what
  run_id uuid references funder_reference_runs (id),
  loaded_at timestamptz not null,
  loader_version text not null,
  unique (object_id, ein, tax_period_end),
  check (status = 'unread' or tax_period_end is not null),
  check ((status = 'loaded') = (status_note is null)),
  check ((status = 'superseded') = (superseded_by_object_id is not null))
);
create index funder_reference_filings_ein_idx on funder_reference_filings (ein, tax_period_end);

-- ---------------------------------------------------------------------------
-- foundations: one row per EIN, as it identified itself on its latest filing
-- ---------------------------------------------------------------------------
create table funder_reference_foundations (
  ein text primary key check (ein ~ '^[0-9]{9}$'),
  source_object_id text not null,
  source_tax_period_end date not null,           -- the filing every column below was read from
  legal_name_line1 text,
  legal_name_line2 text,
  care_of_name text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  country text,                                  -- null for a US address
  phone_as_stated text,
  fiscal_year_end_month integer check (fiscal_year_end_month between 1 and 12),
  private_operating_foundation_ind boolean,      -- null = the return does not say
  website_as_stated text,                        -- exactly what the return wrote, e.g. 'N/A'; never a derived URL
  books_contact_name text,
  books_contact_phone text,
  loaded_at timestamptz not null,
  loader_version text not null,
  foreign key (source_object_id, ein, source_tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end)
);

-- ---------------------------------------------------------------------------
-- figures: one row per EIN and tax period end
-- ---------------------------------------------------------------------------
create table funder_reference_figures (
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  filing_object_id text not null,
  -- Each column below is ONE element of the return, named for what the form calls it.
  fmv_assets_eoy_amt bigint,                           -- FMVAssetsEOYAmt: fair market value of all assets, end of year
  total_assets_boy_amt bigint,                         -- Part II total assets, beginning of year (book)
  total_assets_eoy_book_amt bigint,                    -- Part II total assets, end of year, book value
  total_assets_eoy_fmv_amt bigint,                     -- Part II total assets, end of year, fair market value
  total_liabilities_eoy_amt bigint,
  net_assets_eoy_amt bigint,                           -- total net assets or fund balances, end of year
  contributions_received_per_books_amt bigint,         -- Part I line 1, column (a)
  total_revenue_per_books_amt bigint,                  -- Part I line 12, column (a): revenue and expenses per books
  total_expenses_per_books_amt bigint,                 -- Part I line 26, column (a)
  contributions_paid_per_books_amt bigint,             -- Part I line 25, column (a): contributions, gifts, grants paid, per books
  contributions_paid_disbursements_amt bigint,         -- Part I line 25, column (d): the cash-basis disbursements column
  total_expenses_charitable_disbursements_amt bigint,  -- Part I line 26, column (d): total expenses and disbursements for charitable purposes
  net_value_noncharitable_assets_amt bigint,           -- Part X line 5
  minimum_investment_return_amt bigint,                -- Part X line 6: 5% of the line above
  distributable_amount_amt bigint,                     -- Part XI line 7: distributable amount as adjusted
  qualifying_distributions_amt bigint,                 -- Part XII line 4: qualifying distributions (NOT the distributable amount)
  undistributed_income_current_year_amt bigint,
  grants_paid_stated_total_amt bigint,                 -- Part XV line 3a: the total the return states for grants paid in the year
  grants_approved_future_stated_total_amt bigint,      -- Part XV line 3b
  -- every leaf of the financial-statement groups as filed: 'Group/ElementName' -> text
  financial_statement_values jsonb not null,
  -- DERIVED by the loader (ruling 0045 clause 3 / 0021): each says the set it ranged over
  grants_listed_count integer,
  grants_listed_sum_amt bigint,
  grants_listed_avg_amt numeric(20, 2),
  grants_listed_median_amt numeric(20, 2),
  grants_listed_min_amt bigint,
  grants_listed_max_amt bigint,
  grants_listed_in_filer_state_count integer,
  grants_listed_in_filer_state_sum_amt bigint,
  grants_listed_minus_stated_amt bigint,               -- grants_listed_sum_amt - grants_paid_stated_total_amt
  grants_listed_derivation text,                       -- names the set and the figures used, or why it is empty
  qualifying_to_minimum_investment_return_ratio numeric(14, 4),
  payout_ratio_derivation text,
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (ein, tax_period_end),
  unique (filing_object_id),
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end),
  -- a derived value never appears without the sentence that names its set
  check (grants_listed_derivation is not null),
  check (qualifying_to_minimum_investment_return_ratio is null or payout_ratio_derivation is not null)
);

-- ---------------------------------------------------------------------------
-- people: one row per person per filing, as named (clause 5)
-- ---------------------------------------------------------------------------
create table funder_reference_people (
  filing_object_id text not null,
  listed_in text not null check (listed_in in ('part_viii_officers_directors_trustees', 'signer_on_return_header')),
  ordinal integer not null check (ordinal >= 1),
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  name_as_named text,
  title_as_stated text,
  hours_per_week_as_stated text,          -- the text the return gave; not interpreted
  compensation_amt bigint,
  employee_benefit_amt bigint,
  expense_account_amt bigint,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  country text,
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (filing_object_id, listed_in, ordinal),
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end) on delete cascade
);
create index funder_reference_people_ein_idx on funder_reference_people (ein);

-- ---------------------------------------------------------------------------
-- grants: one row per listed grant (Part XV)
-- ---------------------------------------------------------------------------
create table funder_reference_grants (
  filing_object_id text not null,
  kind text not null check (kind in ('paid_during_year', 'approved_for_future_payment')),
  ordinal integer not null check (ordinal >= 1),
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  listed_in_element text not null,        -- the return element that held the row
  recipient_name_line1 text,
  recipient_name_line2 text,
  recipient_person_name text,
  recipient_address_line1 text,
  recipient_address_line2 text,
  recipient_city text,
  recipient_state text,
  recipient_zip text,
  recipient_country text,                 -- null for a US address
  relationship_as_stated text,
  recipient_status_as_stated text,
  purpose_as_stated text,
  amount_amt bigint,
  unmapped_fields jsonb not null default '{}', -- any element of the row no column reads; kept, not dropped
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (filing_object_id, kind, ordinal),
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end) on delete cascade
);
create index funder_reference_grants_ein_idx on funder_reference_grants (ein, tax_period_end);

-- ---------------------------------------------------------------------------
-- application terms: whether it takes new requests, and how, as the return says
-- ---------------------------------------------------------------------------
create table funder_reference_application_terms (
  filing_object_id text primary key,
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  -- The "only preselected charities, no unsolicited requests" box exactly as the
  -- return carries it ('X' when ticked). null = the return carries no mark. The
  -- boolean is true only for a ticked box; null stays null (an unmarked box is
  -- not turned into a statement that the foundation accepts requests).
  only_preselected_charities_raw text,
  only_preselected_charities_box_checked boolean,
  -- Every ApplicationSubmissionInfoGrp the return carries, each as
  -- {"ordinal": n, "fields": {"<element path>": "<text>"}}; [] when it carries none.
  application_groups jsonb not null default '[]',
  loaded_at timestamptz not null,
  loader_version text not null,
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end) on delete cascade
);

-- ---------------------------------------------------------------------------
-- coverage: which tax periods are held, and which are not, for each funder
-- ---------------------------------------------------------------------------
create table funder_reference_period_coverage (
  ein text not null check (ein ~ '^[0-9]{9}$'),
  period_year integer not null,           -- calendar year of the tax period END date
  status text not null check (status in ('loaded', 'unread', 'no_filing_in_index')),
  filing_object_id text references funder_reference_filings (object_id),
  note text not null,
  run_id uuid references funder_reference_runs (id),
  checked_at timestamptz not null,
  primary key (ein, period_year),
  check ((status = 'no_filing_in_index') = (filing_object_id is null))
);

-- ---------------------------------------------------------------------------
-- access: read for signed-in members, write for nobody but service_role
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'funder_reference_runs', 'funder_reference_filings', 'funder_reference_foundations',
    'funder_reference_figures', 'funder_reference_people', 'funder_reference_grants',
    'funder_reference_application_terms', 'funder_reference_period_coverage'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('grant select on table %I to authenticated', t);
    execute format(
      'create policy %I on %I for select to authenticated using (my_organization_id() is not null)',
      t || '_members_read', t);
    -- No insert, update or delete policy exists for any role. That absence is the
    -- point (ruling 0045 clause 1); the revoke above is the second lock on the same door.
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- the one write path
-- ---------------------------------------------------------------------------
-- doc = { filing: {...every funder_reference_filings column...},
--         foundation: {...}|null, figures: {...}|null,
--         people: [...], grants: [...], application: {...}|null }
-- Replaces everything stored for this filing in one transaction (a function call
-- is one). Returns 'loaded', 'superseded' (a later return for the same EIN and
-- period exists), 'unread' or 'skipped_below_threshold'.
create function funder_reference_apply_filing(doc jsonb)
returns text
language plpgsql
as $$
declare
  f funder_reference_filings%rowtype;
  winner text;
  st text;
begin
  f := jsonb_populate_record(null::funder_reference_filings, doc -> 'filing');
  if f.object_id is null or f.ein is null then
    raise exception 'funder_reference_apply_filing: filing.object_id and filing.ein are required';
  end if;

  -- A filing is replaced whole: clear what hangs off it, then write it again.
  delete from funder_reference_people where filing_object_id = f.object_id;
  delete from funder_reference_grants where filing_object_id = f.object_id;
  delete from funder_reference_application_terms where filing_object_id = f.object_id;
  delete from funder_reference_figures where filing_object_id = f.object_id;
  delete from funder_reference_foundations where source_object_id = f.object_id;

  insert into funder_reference_filings
  select f.*
  on conflict (object_id) do update set
    ein = excluded.ein, return_type = excluded.return_type, index_tax_period = excluded.index_tax_period,
    tax_period_end = excluded.tax_period_end, tax_period_begin = excluded.tax_period_begin,
    tax_year = excluded.tax_year, return_version = excluded.return_version, return_ts = excluded.return_ts,
    status = excluded.status, status_note = excluded.status_note,
    superseded_by_object_id = excluded.superseded_by_object_id,
    index_file = excluded.index_file, index_return_id = excluded.index_return_id,
    index_sub_year = excluded.index_sub_year, document_archive_url = excluded.document_archive_url,
    document_member = excluded.document_member, xml_sha256 = excluded.xml_sha256, xml_bytes = excluded.xml_bytes,
    run_id = excluded.run_id, loaded_at = excluded.loaded_at, loader_version = excluded.loader_version;

  if f.status <> 'loaded' then
    return f.status;
  end if;

  -- Among the returns for this EIN and period, the latest submitted one stands;
  -- the others are kept as filings but hold no figures, people or grants.
  select object_id into winner
  from funder_reference_filings
  where ein = f.ein and tax_period_end = f.tax_period_end and status in ('loaded', 'superseded')
  order by return_ts desc nulls last, object_id desc
  limit 1;

  if winner <> f.object_id then
    update funder_reference_filings
       set status = 'superseded', superseded_by_object_id = winner,
           status_note = 'a later return for the same EIN and tax period end exists'
     where object_id = f.object_id;
    return 'superseded';
  end if;

  -- This filing stands: demote any earlier return for the same EIN and period.
  for st in
    select object_id from funder_reference_filings
    where ein = f.ein and tax_period_end = f.tax_period_end and object_id <> f.object_id and status = 'loaded'
  loop
    delete from funder_reference_people where filing_object_id = st;
    delete from funder_reference_grants where filing_object_id = st;
    delete from funder_reference_application_terms where filing_object_id = st;
    delete from funder_reference_figures where filing_object_id = st;
    delete from funder_reference_foundations where source_object_id = st;
    update funder_reference_filings
       set status = 'superseded', superseded_by_object_id = f.object_id,
           status_note = 'a later return for the same EIN and tax period end exists'
     where object_id = st;
  end loop;

  -- However many amendments there have been for this period, every earlier return names the
  -- one that stands now (not the one that stood when it was demoted).
  update funder_reference_filings
     set superseded_by_object_id = f.object_id
   where ein = f.ein and tax_period_end = f.tax_period_end and status = 'superseded'
     and object_id <> f.object_id and superseded_by_object_id is distinct from f.object_id;

  insert into funder_reference_figures
  select * from jsonb_populate_record(null::funder_reference_figures, doc -> 'figures');

  insert into funder_reference_people
  select * from jsonb_populate_recordset(null::funder_reference_people, coalesce(doc -> 'people', '[]'::jsonb));

  insert into funder_reference_grants
  select * from jsonb_populate_recordset(null::funder_reference_grants, coalesce(doc -> 'grants', '[]'::jsonb));

  if doc -> 'application' is not null and doc -> 'application' <> 'null'::jsonb then
    insert into funder_reference_application_terms
    select * from jsonb_populate_record(null::funder_reference_application_terms, doc -> 'application');
  end if;

  -- The foundation row describes the funder as of its latest period held.
  if not exists (
    select 1 from funder_reference_foundations
    where ein = f.ein and source_tax_period_end > f.tax_period_end
  ) then
    delete from funder_reference_foundations where ein = f.ein;
    insert into funder_reference_foundations
    select * from jsonb_populate_record(null::funder_reference_foundations, doc -> 'foundation');
  end if;

  return 'loaded';
end;
$$;

revoke all on function funder_reference_apply_filing(jsonb) from public, anon, authenticated;
grant execute on function funder_reference_apply_filing(jsonb) to service_role;
```

## 13. Applied to production (2026-11-07)

At the owner's explicit instruction ("apply it yourself"), migration 0084 was applied to the production database (project mbsxeyoxojcqetrmwgba) through the Supabase tool, as 0083 was. Every statement is identical to the file in section 12; the comments were omitted. The recorded migration name is `funder_reference_0084`.

**Before:** the project's applied migrations ended at network_identity_0083; no funder_reference table existed; the tenancy helper the read policy calls was present; 3 profiles and 3 organizations existed (the new tables touch none of them).

**After, checked by query on the live project (the post-apply check in section 11):**

- `authenticated` holds SELECT and nothing else on all eight tables (8 rows); `anon` holds nothing.
- All eight tables have row-level security on and exactly one policy each, a SELECT policy.
- The write function is executable by `service_role` only (anon false, authenticated false, service_role true).
- No table has an `organization_id` column (0), as ruling 0045 clause 1 requires.

So the local imitation of Supabase's default privileges matched the platform on every point checked.

**The security advisor** reports one new finding from this migration: the write function has a mutable search_path (WARN, the same class as 11 existing functions). The function runs with the caller's rights and only `service_role` can call it, so it is not reachable by members or the public; adding a fixed search_path would be a small follow-up migration. It was not changed here.

**Not done:** no data is loaded into production, and the Supabase write path of the loader has still not run against the live project. Nothing was committed or pushed; the STATE item for 110 has not been written.
