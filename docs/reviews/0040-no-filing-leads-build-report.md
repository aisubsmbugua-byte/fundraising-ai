# 0040 — Funders that file no return: build report (stage one)

Date: 2026-11-16. Item 119. Rulings 0051 (superseded) and 0052. Migrations 0099, 0100, 0101, all applied to the live database.

## The problem, in a fundraiser's terms

The national funder database is built from filed tax returns, so a funder that files none cannot be in it. The Solomon Foundation of Parker, Colorado is one: a church extension fund whose Legacy Fund is a donor-advised fund, exempt from filing as a religious organization. A ministry like Village Worship should be looking at exactly this kind of funder, and the platform could not see it. The owner asked for a way to get organizations like these, and for The Solomon Foundation to be kept in the shared database, not only in Village Worship's queue.

## What was built

1. **A curated record that endures.** A shared table, `funder_reference_curated_funders`, holds funders recorded by hand with the sources a person read. It is never rebuilt by the refresh, no member or model can write it, and every member can read it. The first record is The Solomon Foundation: website, address, contact, what its own pages say it offers (the Legacy Fund and five designated funds), why it has no filing (per ProPublica), and three sources with the date read. Its EIN, 27-4214240, comes from a ProPublica listing matched by name and city and is labelled unverified. A curated record is shown first, without the faith-giving relevance test, because a person chose it.
2. **Leads found in other organizations' filings.** A recipient named in loaded grants that no loaded funder or charity matches (by stated EIN, or by normalized name and state) is a lead when its own name says it is a church extension fund, loan fund, gift fund or donor advised fund, or when its name is a foundation's and a giver's stated purpose says the gift went into a donor advised or gift fund (rule `no-filing-lead-v2`). Computed offline in two passes, then built; shown only when at least one funder that named it has five faith-named grants of its own.
3. **The Donor Finder** shows them in their own section, "Funders that file no return", below the ranked list: curated first, then leads by how many different funders named them. Every lead carries the mark "No return in the database, so no giving figures" (curated: "Recorded from its own website; no filing figures"), the counts as recomputable from the grant rows, the grants behind it with links to the filings, and, for a curated record, what its site says and its sources. Any lead can be added with one click, creating one pending candidate and nothing else.
4. **The Solomon Foundation was also added by hand to Village Worship's queue** on 2026-11-16 as a pending candidate, from its own website. Because Village Worship now holds it, the section does not offer it to Village Worship again; another organization sees it first in the list.

## What measurement changed

The first rule (v1: any grant whose stated purpose mentioned a donor advised fund, re-granting or grantmaking) was built, run on the live data and **rejected on the result**: it offered 5,068 leads and the most-named were the Metropolitan Museum of Art (865 funders), the Red Cross and the Salvation Army, because those words describe how a giver decided, not what the recipient is. v2 requires the recipient to be described as a fund (or named like one). Live result: 889 candidate keys, 721 leads, **177 offered**. The top of the list is now church extension funds and loan funds (Catholic Church Extension Society, Jewish Educational Loan Fund). The Solomon Foundation, found by v2 from its own grants, has five different funders naming it, all five with at least five faith-named grants of their own, across three tax years, last in 2024. Ruling 0052 clause 2 was amended before any code shipped to say this.

## Known limits

- **Aliases of filers.** A funder that files, written under a different name than its filing's, can appear as a lead: Fidelity Charitable and Vanguard donor-advised funds appear because grants name them differently than their filings do. Loading the IRS exempt-organizations list (stage two, ruling 0052 clause 6, needs the owner's go and a measured size) gives name-to-EIN matching. The section says so on the page.
- **Loan funds that are not faith funders.** A community loan fund (Chicago Community Loan Fund) is offered if a faith-giving funder named it. It is labelled "Possible loan fund"; a person decides.
- **Foundation grants carry no recipient EIN**, so foundation-side matching is by name and state; charity-side grants carry one for most rows.
- **Counts are over the grants and years the database holds** (mostly two to three years per funder), only paid grants on the foundation side.
- **A curated record is a person's reading of a web page at a date.** It states the sources and the date; it does not state anything about how the funder behaves beyond what the page says. A search result said the foundation ended ECFA membership in 2025 and carries a low donor-confidence score; that is recorded as a note and as unverified, not as fact.

## How it was checked

- `scripts/test-nofiling-leads.ts`: 63 checks on a real Postgres (PGlite) with every migration applied: name key and signal rule exact (including the v1 defect: a museum is not a lead); two passes repeatable; the Solomon case; a recipient matching a loaded charity by name and state or by stated EIN is never a lead; relevance; the read as member of two organizations, a stranger and anon; the curated record survives a full rebuild and is offered without the relevance test; no member can write or read staging; the pure logic; source scans (no model, no service key, no outside request; the add action touches only candidates).
- Existing suites unchanged and passing: reference suggestions 82, funder screen 122, charity screen 69, funder reference 161, ledger check. `test-funder-reference-migration` (125) had four checks that hard-code the table count and the list of files allowed to touch the tables; they were narrowed explicitly (named tables and named files), not loosened.
- Live: migrations applied; scan, build and read run against the real data; the member read as Village Worship returns 176 rows (the 177th, The Solomon Foundation, is excluded because it already holds it).

## Not verified

The page in a browser (sign-in is the owner's). The live run of the add click. Refreshing the leads after a new funder load is the owner's script (`scripts/refresh-nofiling-leads.ts`); until it is run again the leads reflect the filings loaded on 2026-11-16.

## What the owner decides next

- Stage two: load the IRS exempt-organizations list (a measured size first), which fixes the alias problem and finds non-filing religious funders directly.
- Seed the curated table with more named funders (for example the church extension funds and denominational DAF programs a development officer would already know), each with its sources.
