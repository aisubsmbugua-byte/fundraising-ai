---
id: 0053
title: The IRS exempt-organizations list is loaded to confirm who files no return, to name the aliases of filers, and to add the church extension and grantmaking funders it lists
status: settled
provenance: verbatim
date: 2026-11-17
---

## The ruling

Ruling 0052 clause 6 reserved stage two, the IRS list of exempt organizations, for the owner's go
with the measured size stated first. The owner gave the go on 2026-11-17 ("yes load the IRS exempt
organizations list"). This ruling states the measured size, what is kept and what is not, and
how the list is used. It does not change 0052; it carries out its clause 6. Ruling 0050 stands:
nothing is shut out for how it takes requests or what kind it is. Nine things hold.

1. **Source, and the measured size.** The IRS Exempt Organizations Business Master File extract,
   four regional files (`eo1.csv` to `eo4.csv`) from https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf,
   data posted 2026-11-10, downloaded 2026-11-17: **1,984,891 organizations, no EIN twice**
   (344 MB). The IRS's own filing-requirement code says whether a return is required: 06 "not
   required to file (church)" for 288,404 organizations and 13 "not required to file (religious
   organization)" for 9,326, **297,730 in all, 297,396 of them with unconditional exemption.**
   The IRS information sheet defines those codes; the code is used as the IRS gives it.

2. **Only what is needed is kept.** The 1,984,891 rows are read offline and not stored. Kept in
   one shared table: (a) a religious organization the IRS says is not required to file, with
   unconditional exemption, that falls in one of three tiers by the IRS's own fields: tier 1, its
   name says church extension, extension fund, loan fund, charitable gift, gift fund or donor
   advised (38 measured); tier 2, not tier 1, its IRS category (NTEE) is philanthropy or
   grantmaking, codes T20 to T59 (261 measured); tier 3, neither of those, its name has
   foundation, fund, trust or endowment as a whole word and the IRS does not classify it as a
   church itself, foundation code 10 (1,167 measured); (b) any listed organization, whatever it
   must file, whose normalized name and state equal those of a lead found in other funders'
   filings (ruling 0052 clause 2), so that the lead can be matched. Not kept at all: the 2,192
   whose only signal is a fund-like name and whom the IRS classes as a church itself. Tier 3 is
   kept but not offered: of twenty read by eye about half were a single church's own fund or
   endowment, so offering all 1,167 would bury the funders in noise (clause 5).

3. **Matching a lead.** A lead found in filings is matched to a listed organization only by
   normalized name and state, and only when exactly one listed organization has that key; a key
   shared by two is left unmatched and says so. A matched lead shows the IRS's facts as listed:
   name, address, ruling year, category, foundation code and the filing requirement in the IRS's
   words, and the EIN labelled "from the IRS list, matched by name and state". Nothing is typed
   by a model.

4. **Aliases of filers leave the list; nothing else is hidden.** A lead whose matched listed
   organization has the EIN of a loaded funder or charity is the same organization written under
   another name; it is already in the ranked list and is not shown again here (this is the
   Fidelity and Vanguard case named in the build report of stage one). A lead whose listed
   organization says it does file a return is not hidden: the section states what the IRS says,
   "files a return, none in the database", instead of the mark "not required to file". The section
   is titled for what is true of every row, that the database holds no return for it.

5. **Listed funders as leads.** A tier 1 or tier 2 organization from clause 2(a) is shown in the
   same section, after the curated records and the leads found in filings, ordered by tier and
   then name, never given a share or a count in band, marked with what the IRS says about it and
   with its tier named ("church extension or gift fund by its name", "philanthropy category by the
   IRS"). It is not shown when a loaded funder or charity has its EIN or its name and state, when a
   curated record is the same organization, when it is already a lead found in filings (the lead
   carries the IRS facts), or when it is already in the member's own queue or pipeline. Tier 3 is
   kept in the table, not offered; offering it is a change of one value with its own measurement
   and the owner's word. A religious organization is identified by the IRS's code, not by a model.

6. **Verifying an EIN already held.** The EIN of the curated record of the Solomon Foundation,
   27-4214240, listed by ProPublica and labelled unverified, is checked against the list: the list
   has one organization with that EIN, SOLOMON FOUNDATION, 16995 Pine Lane, Parker CO, ruling
   2011-03, filing requirement 13 (religious organization, not required to file), NTEE X19. The
   curated record is updated by migration to say it was checked against the IRS list, with the
   file and date; the same curated rule (ruling 0052 clause 9) holds for any later record.

7. **Adding creates a candidate and nothing else.** As for any lead: one pending candidate,
   carrying the EIN only where a source gives it, which for a listed organization is the IRS list
   matched uniquely, recorded in its basis. No prospect, contact, draft or message, no stage
   change, nothing automatic or in bulk (hard rules 1 to 3).

8. **No model, no outside request at page time, same access.** Loading is the owner's offline
   script with the service key, from files in a directory the owner names; a member's page makes
   no outside request and calls no model. The table is shared, read-only to members (readable only
   through the function the page calls), written only by that script (hard rule 6 is met by the
   same tenant filter as stage one: a member never sees an organization already in their own queue
   or pipeline). The list version, its posting date and the date it was loaded are recorded on
   every row.

9. **Refresh.** The script is run again when the IRS posts a new list and after any load of the
   funder reference tables, because aliases are judged against the loaded funders. It is safe to
   run again: the table is replaced whole.

## Why

The first stage could not tell a funder that files no return from one that files under another
name, and could find only the funders other filings happen to name. The IRS's own list says,
for each organization, whether a return is required, and lists the church extension funds and
the grantmaking religious organizations that no filing names. It also settles the question the
Solomon Foundation record left open: the EIN is real.

## Test of compliance

The table holds only the rows of clause 2 and its count by tier is stated in the build report.
The Solomon Foundation record carries the IRS list as a source and its EIN is no longer called
unverified. A lead whose matched listed organization is a loaded funder is not shown; one whose
key two listed organizations share is not matched; one the IRS says files a return says so. A
tier 1 listed organization (Lutheran Church Extension Fund-Missouri Synod) appears in the
section, marked, and a tier 3 organization does not. A member cannot read or write the table
directly. Search the code for a model call or an outside request in what the page runs: there is
none. Adding one inserts exactly one pending candidate.

## Scope

Authorizes item 119 stage two: an additive migration (the table, the apply function, the updated
read function, the Solomon source and EIN note), a loader script reading the owner's downloaded
files, the page's rendering of the IRS facts and marks, tests and a build report. Does not
authorize offering tier 3, any model call, any change to how "faith-named" is measured, any
change to the loader of filed returns, a funder-facing view, or any automatic or bulk candidate
creation.
