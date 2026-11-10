---
id: 0048
title: An internal, read-only screen shows the funder reference database, every value linked to its filing, and nothing on it creates a prospect or sends anything
status: settled
provenance: verbatim
supersedes:
date: 2026-11-10
---

## The ruling

Ruling 0045 built the shared funder reference database and authorized no screen to read
it; today it can be seen only in the Supabase table editor. The owner has asked for an
internal way to find, read and count what it holds. Seven things hold.

1. **Internal, read-only, signed in.** The screen is an internal research tool for the
   platform's own staff, not a customer feature. It is reachable only by a signed-in
   profile marked superadmin, and it is not linked from any customer's navigation. It
   reads the shared reference tables and writes nothing: no insert, update or delete,
   no note, no tag, no saved list. It reads with the signed-in user's own session, so
   the read-only policies of ruling 0045 are what enforce this, not the screen's good
   behavior. Opening it to ordinary members of an organization is a separate decision
   and needs its own ruling.

2. **Stage one: find a funder, then read it.**
   - **Search.** By funder name, EIN or city, with filters for state, size (assets and
     yearly giving, each by the tax period it is measured on), and whether the filing
     says the funder accepts unsolicited requests. Results page on the server and sort
     by named columns. Every list says how many funders it is counting and which states
     are loaded, so a state not yet loaded is never mistaken for a state with no funders.
   - **Funder page.** Size by tax period; how it gives (grant sizes, places and
     purposes as filed); its people as named on each filing; its grants; and its stated
     way to apply. Each figure is shown with its name from the form, its tax period and
     a link to the filing it came from (ruling 0045 clause 2). A figure the filing does
     not carry is shown as absent, never as zero or blank-as-zero. A year the database
     does not hold is shown as not held, never as "gave nothing that year".

3. **Stage two: landscape statistics.** Counts and distributions across the loaded
   funders: by state, by size band, by how they give, and the change across the three
   tax periods. Each statistic names the set it was computed over and the figure it
   used (ruling 0045 clause 3), and states which states and tax periods are in it.
   Statistics come from database views or precomputed tables built by an additive
   migration, so the page is fast and every number can be reproduced by a query. Stage
   two begins after stage one is accepted.

4. **Provenance and claims are visible.** A value a filing carries is shown as a filed
   value. A value a model or a web search supplied is shown as a claim with its captured
   source and is never placed in the same column or style as a filed value (the capture
   contract). People are shown as named and are never merged (ruling 0045 clause 5).
   Public charities and donor-advised fund sponsors (item 116), once loaded, appear
   only as separately labeled kinds, never combined with private foundations in a count
   or average without saying so (ruling 0047 clause 2), and the no-named-donor
   statement of ruling 0047 clause 3 appears wherever a sponsor's grants are shown.

5. **It decides nothing and sends nothing.** Nothing on the screen creates a prospect,
   candidate, draft or contact, changes a pipeline stage, or feeds matching, discovery
   or scoring (ruling 0045 clause 7). A way to start a prospect from a funder on this
   screen is a later, separate decision and needs its own ruling and a human click.
   Exports and saved lists are likewise not authorized.

6. **Built as if it will be customer-facing, because it may become so.** The screen is
   internal today, but it is built to the same UI, UX and design standards as every
   customer page, not as a throwaway admin view: the shared tokens in `lib/ui.ts`, the
   same layout and navigation patterns as other dashboard pages, consistent spacing,
   every field border-boxed, plain-language labels (no table or column names, no
   internal vocabulary), clear empty, loading, error and not-loaded states, keyboard
   and screen-reader basics, and a layout that works at a narrow width. Who may open
   it is decided in one place (the access check of clause 1), so opening it to
   customers later changes that one rule and the navigation entry, and nothing else
   has to be redone; the opening itself still needs its own ruling. It makes
   no call to any outside service and uses no secret in the browser: reads go through
   the server with the user's session, and the service key is never used by this screen
   (hard rule 5). Queries are indexed for the national table size; the build report
   states the slowest search and funder-page query it measured.

7. **May be built against what is already loaded.** Stage one can be built and
   tested against the states already in the database while item 114's national load
   continues, provided it adds no load that competes with the loader: reads only, and
   any new index or view is created by an additive migration applied only when the
   owner says the load can take it (an index build on the live tables is a heavy write
   and is not done during the run without the owner's go). A funder the loader has
   not finished verifying is shown with its state's status, and a state that has not
   passed its sample check is labeled "not yet verified".

## Why

The data is only useful if someone can look at it, and the first look is the best test
of whether the load is right: a person reading a funder page against its filing will
find problems a count never will. Doing it inside the app keeps the provenance links
and the sign-in the rest of the platform already has; a separate analytics tool would
need its own access control and would drop the filing links. Keeping it read-only,
internal and unconnected to the pipeline means it cannot send anything or advance
anything, and it can be built now without touching the hard rules. Statistics wait one
stage because they are the part most likely to mix definitions, and they are easier to
get right once the funder page has shown what each figure means.

## Test of compliance

A superadmin signs in and finds a funder by name, by EIN and by city; a non-superadmin
member opens the same address and is turned away. The same session cannot insert,
update or delete a reference row, and no screen action attempts to. Pick any figure on
a funder page: it names its form field, its tax period and links to the filing. Pick a
funder whose filing has no website or no stated way to apply: the page shows that as
absent. Pick a tax period the database does not hold: the page says not held. Search
with a state not yet loaded: the page says the state is not loaded, not "no results".
Search the screen's code for a call that creates a prospect, a candidate or a draft, a
use of the service key, or an outside request: there is none. Open a state that has not
passed its sample check: it is labeled not yet verified. The build report names the
slowest query measured.

## Scope

Authorizes item 113 stage one (search and funder page) and, after stage one is
accepted, stage two (statistics), as an internal, superadmin-only, read-only screen;
the additive migration for any index or view it needs, applied only as clause 7 says.
Does not authorize any write to the reference tables, any prospect creation or other
bridge into the pipeline, exports or saved lists, any use of the data in matching,
discovery or scoring, access for ordinary organization members, any web or person
enrichment, any change to the loader, or the loading of public charities and
donor-advised funds (item 116).

## Owner's confirmations, 2026-11-10

The owner approved this ruling as drafted. They confirmed that the screen is
superadmin-only for now (clause 1), that statistics wait until stage one is accepted
(clause 3), that no new index or view is applied to the live tables until the owner
says the national load can take it (clause 7), and that it is built to customer-facing
design standards from day one, with the access rule as the single switch for opening it
later (clause 6). Opening it to ordinary members of an organization remains a separate
decision and needs its own ruling.
