# 0041 — The IRS list of exempt organizations: build report (stage two)

Date: 2026-11-17. Item 119, stage two. Ruling 0053 (carries out ruling 0052 clause 6). Migrations 0102 and 0103, both applied to the live database.

## The problem, in a fundraiser's terms

Stage one found funders that file no return only when another funder's filing happened to name them, and could not say whether any of them was real, whether it filed under another name, or even confirm the number the Solomon Foundation was listed under. The IRS publishes one list of every exempt organization with its own statement of whether a return is required. The owner said go on loading it.

## What was loaded

The IRS Business Master File extract, four regional files, data posted 2026-11-10, downloaded 2026-11-17. **1,984,891 organizations, no EIN twice.** The IRS's filing-requirement code says 288,404 are churches and 9,326 are other religious organizations that are not required to file: **297,730**, almost all ordinary congregations. Loading all of them as "funders" would bury the few that fund, so the ruling keeps only what is needed. The loader read every row and sent 4,182; the database kept **1,493**:

| Kept | Count | Shown to members |
|---|---|---|
| Tier 1: its own name says church extension, loan fund, gift fund or donor-advised fund | 38 | yes |
| Tier 2: the IRS's category is philanthropy or grantmaking | 261 | yes |
| Tier 3: named a foundation or fund, and the IRS does not class it as a church itself | 1,167 | no, kept in case the owner wants it |
| Kept only so a lead found in filings can be matched | 27 | with the lead |

Not kept: the other 297,000 congregations, and the 2,192 whose only signal is a fund-like name and whom the IRS classes as a church itself. In twenty tier-3 names read by eye, about half were a single church's own fund, which is why they are held back; offering them is one value in the database and the owner's call.

## What a member sees now

Read as a Village Worship member: **465 funders in the section**, now titled "Funders with no return in the database": 176 found in other funders' filings, then 289 the IRS list adds (34 by their name, 255 by their IRS category). The new ones are what a development officer would hope to find: diocesan deposit-and-loan funds, denominational church extension funds, loan funds of the Methodist, Lutheran, Reformed and Pentecostal bodies. Each carries what the IRS says, in the IRS's own words: its listed name and address, the EIN (labelled as from the IRS list), the month it was ruled exempt, its category, and its filing requirement. Where a lead found in filings matches exactly one listed organization, it carries the same facts; 24 of the 176 do (4 say not required to file; 20 say they do file a return, and the line says so rather than hiding them). Adding one still creates one pending candidate and nothing else; the EIN carried to it is the IRS list's, never a model's.

**The Solomon Foundation's EIN, 27-4214240, is confirmed.** The list has one organization with that EIN: SOLOMON FOUNDATION, 16995 Pine Lane, Parker CO, ruled exempt March 2011, filing requirement 13 (not required to file, religious organization). Name, street and city agree with the record. The curated record no longer calls its EIN unverified and cites the IRS file as a fourth source.

## What it did not do, and what I said before the load

**It did not remove the donor-advised sponsors that file.** Before the load I said the list would fix the case of Fidelity, Vanguard and Schwab appearing as "funders that file no return". That was wrong, and the measurement shows why: filers write these sponsors in their own words ("Fidelity Charitable Donor Advised Fund", "Schwab Donor Advised Fund", "JPM Donor Advised Fund for Chris"), which are not the IRS's listed names, so a match by name and state finds nothing. Zero leads were removed as aliases. Matching on name alone, ignoring state, would remove only 2 of the 465. The page now says this plainly. A real fix needs either a short list of the large sponsors' wordings recorded by hand with sources (the curated approach) or matching on what the name contains, which the rulings so far deliberately avoid; this is the owner's choice.

## Defects found along the way

- The platform refuses an UPDATE or DELETE with no WHERE when it is reached through the API; PGlite does not. The new apply function failed on the first live run for that reason. Fixed in migration 0103 (the applied 0102 is not edited), and a test now scans the function bodies for it.
- The same refusal would have stopped `scripts/refresh-nofiling-leads.ts` at the lead build of 0100 (a whole-table delete), which had only ever been run through the SQL connector. 0103 replaces that function too. A live run of the refresh script proved the scans but not the build; see "Not verified".

## How it was checked

- `scripts/test-exempt-list.ts`, 83 checks, on a real Postgres with every migration applied: the tiers, drops, shared keys and loaded-funder flags against a 15-row scenario (including a church the IRS classes as a church, an organization that must file, a conditional exemption); the member read (order, the alias leaving, an ambiguous name left unmatched, a lead the IRS says files a return kept and labelled, tier 3 not shown, the tenant filter, the Solomon Foundation first); no member can read or write the table, run apply or touch the curated record; the list replaced whole leaves the curated record; offering tier 3 is one value.
- The loader's filter and name key against the database's own over **1,500 real listed names** (a fixture): the key is identical for every one, and every row the database would keep is one the loader would send. The loader's reading of four real lines of the IRS file, including the Solomon Foundation's.
- Source scans: the page-side files make no outside request, call no model, read no file and never name the table; the loader's only requests go to the owner's own database.
- Existing suites unchanged and passing: stage one 63, reference suggestions 82, funder screen 122, charity screen 69, funder reference 161. `test-funder-reference-migration` (125): one check that hard-codes the list of service-only tables now names the new table.
- Live: migrations applied; the loader's real run (1,984,891 read, 4,182 sent, 1,493 kept, tier counts 38 / 261 / 1,167 exactly as the ruling states them); the member read as Village Worship, including the figures above.

## Not verified

- The page in a browser (sign-in is the owner's) and the add click on the live site.
- The stage-one refresh script end to end through the API: run live after the 0103 fix, its scans passed (889 keys, 8,235 staged rows) but its last step, the lead build, exceeded the API's statement limit (HTTP 500; the failed call rolled back, leaving the 721 leads untouched). Run through the SQL connector the same build produced the same 721 leads. The script now says so and stops with the one line to run in the Supabase SQL editor (`select funder_reference_nofiling_build();`), after which `scripts/load-exempt-list.ts` is run again.
- 4 rows on the list share a name and state with another listed organization; any lead matching one of them is shown as ambiguous and not tied to either. None is among the 465 a member sees today.

## What the owner decides next

- **Sponsors that file under their own wording** (Fidelity, Vanguard, Schwab, JPM, Goldman, NPT, BNY): record the large sponsors' common wordings by hand with sources, or accept the note on the page.
- **Tier 3** (1,167 foundations and funds the IRS does not class as churches): offer them or keep them held.
- More curated funders by name, as before.
- Whenever funders are reloaded or the IRS posts a new list: `scripts/refresh-nofiling-leads.ts` (finish its build in the SQL editor), then `scripts/load-exempt-list.ts` with the directory holding the four files and the page's posting date.
