---
id: 0049
title: Funders from the national database are suggested first, each with reasons computed from filed grants, and enter an organization's queue only by a human click
status: settled
provenance: verbatim
supersedes:
date: 2026-11-12
---

## The ruling

Rulings 0045 to 0048 built the national funder database (private foundations, grantmaking
public charities and donor-advised fund sponsors) and kept it away from matching,
discovery and scoring. The owner has decided it is now the highest-priority source for an
organization's funder suggestions, ahead of web search, because every figure in it comes
from a filing and every funder in it has an EIN. Eight things hold.

1. **Suggested first, proposed only.** The Donor Finder shows a section of funders drawn
   from the national database above every web-search result. Each is a proposal. Showing
   one creates nothing. An organization's member adds one to that organization's queue with
   a click on that funder; nothing is added automatically, in bulk or on a schedule.

2. **Adding creates a candidate and nothing else.** The click creates one pending candidate
   for the member's own organization, carrying the funder's EIN, its name as filed, its
   place as filed, its kind as a label, and a record of the figures and filings the
   suggestion rested on at that moment. It creates no prospect, contact, draft or message
   and changes no pipeline stage (hard rules 1 to 3). The candidate is accepted, dismissed
   or saved exactly as any other, by a human, and accepting it carries the EIN to the
   prospect, so the funder's identity is established from a filing and not guessed from the
   web. A funder already in the organization's candidates or prospects (by EIN) is not
   suggested again.

3. **Every reason is computed from filed grants and is checkable.** The reason a funder is
   suggested is made only of numbers computed from the grant rows the database holds, each
   with its tax period, and a sample of those grants shown with a link to the filing. No
   model writes, rewrites or summarizes a reason, a score or a funder's description (the
   capture rule). A figure the database does not hold is shown as not held, never as zero;
   the tax periods held for a funder are stated beside its numbers.

4. **"Faith-named" is a stated, versioned rule, shown as approximate.** The database does
   not say which recipients are Christian ministries. The suggestion counts grants whose
   recipient name or stated purpose contains a word from a fixed, named list (version
   recorded with the figures and shown on screen). It is labelled "by name", it will miss
   some ministries and include some that are not, and the screen says so. Opening the
   sample of grants behind a count is always possible. Changing the list is a new version,
   recomputed in full; the version in use is never ambiguous.

5. **The ranking is a stated rule, not a judgement.** Funders are ordered by, in turn: the
   number of faith-named grants that fall in the organization's size band over the periods
   held; the share of the funder's listed grants that are faith-named; the most recent tax
   period with a faith-named grant. The size band comes from the organization's own
   profile (annual budget) and is shown; with no budget on the profile there is no band
   and the screen says so. A recipient in the organization's own state is shown as a
   further fact beside the funder, and does not change the order. The ordering rule is
   printed on the screen.

6. **A funder that takes no unsolicited requests is not offered by default.** Where a
   filing states that the funder gives only to pre-selected charities, the funder is held
   out of the default list, available under a separate, labelled heading, and is never
   described as open to requests. Kinds stay separate labels (ruling 0047 clause 2): a
   donor-advised fund sponsor's grants are donor-directed and the no-named-donor statement
   of ruling 0047 clause 3 appears wherever they are shown.

7. **The reference tables stay read-only to the application.** The suggestions read the
   reference tables and one derived table of per-funder counts. The derived table is a
   shared table like the others (ruling 0045 clause 1): no application role writes it; it
   is filled only by an offline refresh run with the service key, and records the rule
   version and the date it was computed. The suggestion query runs for a signed-in member
   of an organization and for no one else, and excludes only that organization's own
   funders. The opening of the raw database screen (ruling 0048) is unchanged and stays
   superadmin-only; this ruling opens the suggestions, not that screen, to ordinary
   members.

8. **Built to the customer standard.** Shared tokens in `lib/ui.ts`, plain-language labels
   with no table, column or internal terms, clear empty, loading, error and not-computed
   states, border-boxed fields, a layout that works at a narrow width. The query is
   indexed for the national table size and the build report states the slowest
   measurement.

## Why

Web discovery proposes funders that are hard to verify, carry no EIN and have produced
wrong figures, as the check of 2026-11-12 found against the filings. The filed data is the
one source where a funder's size, grants and recipients can be read and checked, so it
should lead. Keeping the human click, the candidate state and the stated rules means the
engine does the searching and counting while a person decides, as the hard rules require,
and "computed, not written" keeps it from becoming one more confident paragraph that
nobody can check.

## Test of compliance

A member of an organization opens the Donor Finder and sees suggested funders above web
results; a person who is not a member sees none. Showing the list inserts no row anywhere.
Clicking add on one funder inserts exactly one pending candidate with its EIN and no
prospect, contact or draft. Accepting it gives a prospect carrying the same EIN. That funder
no longer appears in the suggestions. Pick any reason: its numbers recompute from the grant
rows by a query, and its sample opens a filing. Change the organization's budget: the band
and the order change, and the ordering rule printed on the screen still holds. A funder
whose filing says pre-selected charities only is not in the default list. A funder with no
grants held is shown as such, not as a funder that gave nothing. Search the code for a model
call, a service-key use or an outside request in the suggestions: there is none. Try to
write to the derived table as a member: refused.

## Scope

Authorizes item 117: the derived per-funder table and its offline refresh; the suggestions
query; the Donor Finder section and the add-to-candidates action; an EIN and a record of the
basis on the candidate, and carrying the EIN to the prospect on acceptance; the additive
migration, tests and a build report. Amends the exclusions of rulings 0045 clause 7, 0046
and 0048 clause 5 and its scope for this use only. Does not authorize any automatic or
bulk creation of candidates, any change to existing web search or screening, peer-based
matching (the grantee-to-funder index and the primed pump), the IRS exempt-organizations
master list, a funder-facing view, exports, any model call, any change to the loader, or
access to the raw database screen for ordinary members.
