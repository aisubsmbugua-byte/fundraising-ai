---
id: 0051
title: Funders that file no return are found from other organizations' filings and the exempt-organizations list, and shown in the same list marked as having no giving figures
status: superseded
provenance: verbatim
date: 2026-11-16
---

## The ruling

The national funder database is built from filed returns, so a funder that files none cannot
be in it. Religious organizations are not required to file, and church extension funds and
church-connected donor-advised fund sponsors are often the best matches for a ministry. The
owner's direction of 2026-11-16, after the Solomon Foundation of Parker, Colorado was found to
be missing, is to find a way to get organizations like these. Ruling 0050 stands, including
its rule that nothing is shut out for how it takes requests or what kind it is. Eight things
hold.

1. **Two sources of leads, no model.** A "funder that files no return" is found only from
   facts already public and held or loadable without a model: (a) other organizations' filings
   already in the database, which name it as a recipient; (b) the IRS list of exempt
   organizations, once loaded under clause 6. Neither source reads a web page, calls a model,
   uses a service key from the page, or makes an outside request when a member views the list.

2. **Stage one, from the filings already held.** A recipient named in loaded grants is a lead
   when (i) no loaded funder or charity has its EIN, or, where a grant states none, its
   normalized name and state; and (ii) at least one of its grants carries a stated purpose or
   a name that points to giving rather than doing: the words donor advised fund, gift fund,
   extension fund, loan fund, grantmaking, or re-granting. The rule is a fixed named version
   recorded with each lead (`no-filing-lead-v1`). Leads are computed offline into one derived,
   read-only table, never at page time.

3. **Every fact as filed.** A lead shows the name and place as stated in the grants, how many
   different funders named it and in how many tax years, and the grants behind it with the
   filer's name, amount, stated purpose and a link to the filing. Nothing is typed by a model.
   Where the filings state an EIN for it, that EIN is shown labelled as stated.

4. **Same list, marked, never ranked by figures it does not have.** A lead appears in the
   Donor Finder list, in its own labelled group directly after the ranked funders, marked "No
   IRS filing in the database, so no giving figures". It is ordered by the number of different
   funders that named it, then recency, then name, and it is never given a share or a count in
   band. It can be added like any other funder and is never excluded for having no filing.

5. **Adding creates a candidate and nothing else.** The click creates one pending candidate
   for the member's own organization carrying the name and place as stated, its lead record as
   the basis and the EIN only where stated. No prospect, contact, draft or message, no stage
   change, no automatic or bulk creation (hard rules 1 to 3).

6. **Stage two, the exempt-organizations list.** The IRS exempt-organizations master list may
   be loaded read-only into its own derived table, filtered to religious organizations whose
   filing requirement says no return is required, and shown as leads under clause 4 with the
   list's own name, address, category and ruling year. It is loaded by the owner's go after
   stage one is accepted, with the measured size stated first. This ruling authorizes
   stage one now and stage two to be built after that go.

7. **Provenance and the web.** A lead states where it came from (filings or the master list)
   and never states what a funder offers unless that came from a source a person can open. The
   web check on a single funder a person has added is the existing Research Agent and is not
   changed by this ruling. A fact found on a funder's own site is added to a candidate only by
   a person, with the source link, as the Solomon Foundation was on 2026-11-16.

8. **Tenant and access rules unchanged.** Reference tables stay read-only to members and are
   written only by the owner's loader or the refresh script; adding a candidate stays scoped
   to the member's organization (hard rule 6).

## Why

The Solomon Foundation (Parker, Colorado) is a church extension fund with a donor-advised
fund called the Legacy Fund. It files no return, so the database never held it. The database
does hold five grants naming it as a recipient, from five different funders, one stating a
contribution "to a donor advised fund for the purpose of supporting other charitable
organizations", and one of $15 million. Recipients that act as funders leave this kind of trace in
other organizations' returns, and the rule above finds them without a model. A development
officer would do the same: ask who gives to the giver.

## Test of compliance

A recipient that no funder or charity in the database matches by EIN, name and state, and
whose grants state a donor-advised-fund purpose, appears in the Donor Finder in its own marked
group after the ranked funders; the Solomon Foundation (Parker, CO) is among them. A recipient
that matches a loaded funder never appears as a lead. Each lead's count of funders and years
recomputes from the grant rows by a query, and each sample opens its filing. Clicking add
inserts exactly one pending candidate. Search the code for a model call, a service key or an
outside request in the leads: there is none. Try to write to the derived table as a member:
refused.

## Scope

Authorizes item 119 stage one: an additive migration creating the derived leads table with
tenant-safe read access and a function the page reads; a refresh script; the lead group in the
Donor Finder section and the add action accepting a lead; tests and a build report. Stage two
(the master list) is authorized in principle by clause 6 and begins only on the owner's go
with the measured size. Does not authorize any model call, any change to how "faith-named" is
measured, any change to the loader of filed returns, a funder-facing view, or any automatic
or bulk candidate creation.
