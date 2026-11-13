---
id: 0050
title: Funders are ranked by how much of their giving goes to work like the organization's, none is shut out for how it takes requests or what kind it is, and each shows the ways in that its own filing gives
status: settled
provenance: verbatim
supersedes: 0049
date: 2026-11-12
---

## The ruling

Ruling 0049 made the national funder database the first source of funder suggestions. Run
on the real data it showed two faults, and the owner's direction of 2026-11-12 corrects
both: the ordering favored organizations that give very many small grants (pass-through
organizations), and holding back funders that say "pre-selected charities only" shut out
about half of the funders that fit best. This ruling restates 0049 with those corrected and
supersedes it. Rulings 0045 to 0048 stay in force. Nine things hold.

1. **Suggested first, proposed only.** The Donor Finder shows a section of funders drawn
   from the national database above every web-search result. Each is a proposal. Showing
   one creates nothing. A member of the organization adds one to that organization's queue
   with a click on that funder; nothing is added automatically, in bulk or on a schedule.

2. **Adding creates a candidate and nothing else.** The click creates one pending candidate
   for the member's own organization, carrying the funder's EIN, its name as filed, its
   place as filed, its kind as a label, and a record of the figures and filings the
   suggestion rested on at that moment. It creates no prospect, contact, draft or message
   and changes no pipeline stage (hard rules 1 to 3). Any funder in the list can be added,
   including one whose filing says it gives only to pre-selected charities. Accepting a
   candidate carries the EIN to the prospect. A funder already in the organization's
   candidates or prospects (by EIN) is not suggested again.

3. **Every figure is computed from filings and every fact is shown as filed.** The reason a
   funder is suggested is made only of numbers computed from the grant rows the database
   holds, each with its tax period, and a sample of those grants with a link to the filing.
   The ways in (clause 7) are shown as the filing states them, with the tax year and a link.
   No model writes, rewrites or summarizes a reason, a score, a funder's description or a
   way in. Any fixed explanatory sentence on the screen is written by people, is the same
   for every funder of its kind, and is labelled as general practice, not as something the
   funder's filing says. A figure the database does not hold is shown as not held, never as
   zero.

4. **"Faith-named" is a stated, versioned rule, shown as approximate.** The database does
   not say which recipients are Christian ministries. The suggestion counts grants whose
   recipient name or stated purpose contains a word from a fixed, named list (version
   recorded with the figures and shown on screen). It is labelled "by name", it will miss
   some ministries and include some that are not, and the screen says so. Changing the list
   is a new version, recomputed in full. This is the current measure of "funds work like
   the organization's", and a better measure replaces it only by a ruling.

5. **The ranking is a stated rule: how much of its giving goes to work like the
   organization's.** Funders are ordered, in turn, by: whether the funder has at least five
   grants to faith-named recipients in the organization's size band over the years held
   ("enough to go on", the number five being a stated constant); then the share of the
   funder's listed grants that are faith-named; then the number of such grants in the band;
   then the most recent tax year with one. A funder with fewer than five is still listed,
   after those that have enough, and says so. The size band comes from the organization's
   own profile (annual budget) and is shown; with no budget there is no band and the screen
   says so. A recipient in the organization's own state is shown as a further fact and does
   not change the order. The rule is printed on the screen. A funder with no grant in the
   band to a faith-named recipient is not listed, because nothing in its filed giving
   resembles the organization's work.

6. **Nothing is shut out for how a funder takes requests or what kind it is.** One list, in
   one order. A funder that says it gives only to pre-selected charities, a donor-advised
   fund sponsor and a charity that gives to other charities are listed with the rest, with
   their kind and their manner of taking requests as labels, never as a reason to hide or to
   rank them down. A funder is absent only because it is already in the organization's
   queue or because its filed giving does not resemble the organization's work (clause 5).
   A restriction a filing states (a place, a group of people, a purpose) is shown as filed
   beside the funder as a question to ask, and is not a reason to remove it. Kinds stay
   separate labels (ruling 0047 clause 2), and the no-named-donor statement of ruling 0047
   clause 3 appears wherever a donor-advised fund sponsor is shown.

7. **Each funder shows the ways in that its own filing gives.** For every funder the screen
   offers, on request, what the filing says about getting to it, in two parts kept apart.
   *From the filing:* for a private foundation, the contact it names for requests, how to
   apply, the deadlines and the restrictions, exactly as filed, and whether the filing says
   it gives only to pre-selected charities; the officers, directors and trustees it names,
   each with title, city and state (no street address and no pay); for a public charity or a
   sponsor, its website, phone and address as filed and its stated mission. *General
   practice:* one fixed paragraph per kind. For a funder that gives only to pre-selected
   charities: that this describes how it decides today, and that the ways in are a personal
   introduction from someone who knows its trustees, a short letter or call to the contact
   its filing names asking how a charity is considered, and asking organizations it already
   supports how they came to be chosen. For a donor-advised fund sponsor: that its donors
   recommend the grants, so the way in is to meet its requirements for a recommended charity
   and be known to the people who give through it. None of this is sent, started or
   scheduled by the system; a person acts on it (hard rules 1 to 3).

8. **The reference tables stay read-only to the application.** The suggestions read the
   reference tables, the officer and application-term tables among them, and one derived
   table of per-funder counts. The derived table is a shared table like the others (ruling
   0045 clause 1): no application role writes it; it is filled only by an offline refresh
   run with the service key. The suggestion query runs for a signed-in member of an
   organization and for no one else, and excludes only that organization's own funders. The
   raw database screen (ruling 0048) is unchanged and stays superadmin-only.

9. **Built to the customer standard.** Shared tokens in `lib/ui.ts`, plain-language labels
   with no table, column or internal terms, clear empty, loading, error and not-computed
   states, border-boxed fields, a layout that works at a narrow width. The query is indexed
   for the national table size and the build report states the slowest measurement.

## Why

The owner's direction: the rules of this platform should work to make it think and look for
another way to reach an organization, not to shut organizations out, while keeping to the one
test that matters, that the funder funds work like the organization's. Measured on the
filings for a ministry of Village Worship's size, 8,598 funders have at least five grants in
band to faith-named recipients; 4,312 of them say pre-selected only and 808 are flagged as
donor-advised fund sponsors, including faith-specific ones that are among the best matches.
A person raising money knows that "pre-selected" describes a decision process, not a locked
door: board introductions and a letter to the named contact are how organizations get
chosen. Ranking by the share of giving that is like the organization's, once a funder has
enough grants to go on, puts funders that give almost only to such work ahead of
organizations that give many small grants to many things. Showing the filing's own contact,
terms and named people gives a person the material to find the way in, and keeping every
fact as filed keeps it checkable (the capture rule).

## Test of compliance

A member opens the Donor Finder and sees one list of funders above web results; a person who
is not a member sees none. Showing the list inserts no row anywhere. A funder whose filing
says pre-selected charities only appears in the same list and order as any other, labelled,
with its contact and named people available, and can be added. A donor-advised fund sponsor
appears in the same list, labelled, with the no-named-donor statement. Funders with at least
five grants in band come first, ordered by share; a funder with fewer comes after them and
says so. Change the organization's budget: the band and the order change, and the printed
rule still holds. Pick any funder: its numbers recompute from the grant rows by a query, its
contact, deadlines, restrictions and people match its filing's text, and the sample opens the
filing. Clicking add inserts exactly one pending candidate with its EIN and no prospect,
contact or draft. Search the code for a model call, a service-key use or an outside request
in the suggestions: there is none. Try to write to the derived table as a member: refused.

## Scope

Authorizes item 117 as amended: an additive migration replacing the suggestions function
(one list, the ordering of clause 5, and an indicator of "enough to go on"); the reads of the
application-term, officer, organization and website data for the funders on a page; the Donor
Finder section changed to one list with the ways in; the add action accepting any funder in
the list; tests and an updated build report. Does not authorize any model call, any change
to how "faith-named" is measured, a comparison of the organization's own people with a
funder's named people, peer-based matching (the grantee-to-funder index and the primed
pump), the IRS exempt-organizations master list, a funder-facing view, exports, any change
to the loader, or any automatic or bulk creation of candidates. Those, and the other ways of
learning what a funder funds, are proposed in review 0039 and each needs its own ruling.
