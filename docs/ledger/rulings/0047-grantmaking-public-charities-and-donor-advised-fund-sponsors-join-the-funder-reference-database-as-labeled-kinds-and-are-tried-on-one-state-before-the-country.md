---
id: 0047
title: Grantmaking public charities and donor-advised fund sponsors join the funder reference database as labeled kinds, loaded from the same IRS archives and tried on one state before the country
status: settled
provenance: verbatim
supersedes:
date: 2026-11-10
---

## The ruling

Rulings 0045 and 0046 built and bounded a shared database of US private foundations
from Form 990-PF. The owner has asked for the two large kinds of funder it does not
yet hold: public charities that make grants (community foundations are the clearest
case) and the sponsors that hold donor-advised funds. Eight things hold.

1. **Scope.** Two kinds are added, each a label on the funder, never inferred by a
   model:
   - **Grantmaking public charity** — an organization that files Form 990 (not
     990-PF) and reports grants to organizations on Schedule I.
   - **Donor-advised fund sponsor** — an organization that reports donor-advised
     funds on Schedule D, Part I. An organization can carry both labels.
   Tax periods are the same three as ruling 0045 (2022, 2023, 2024). Form 990-EZ
   filers and Form 990-N filers are out of scope and are stated as not covered
   wherever coverage is stated. Private foundations are unchanged.

2. **The kinds stay apart.** Every funder row names its kind and the form it came
   from. A figure from Schedule I, Schedule D or Form 990 is stored under the name
   that form gives it and is never placed in a column that means something different
   on Form 990-PF; a figure that sounds alike but is defined differently is a
   separate column (ruling 0045 clause 3). No screen, count or average may combine
   kinds without saying so.

3. **A donor-advised fund sponsor's money has no named donor, and the database says
   so.** The sponsor's own figures are stored as filed (number of funds, assets,
   contributions received, grants made), with their definitions. The recipients on
   the sponsor's Schedule I are **the sponsor's grants**. The loader never tries to
   identify the individuals behind any fund, and nothing built on this data may label
   a recipient as funded by any person through a fund. Wherever a sponsor's grants are
   shown, the page states that a gift made through a donor-advised fund carries no
   named donor in this data.

4. **Ruling 0045's seven clauses apply unchanged.** The new tables or columns are
   shared reference data with no `organization_id`, written only by the offline loader
   with the service key; every value carries its filing, its place on the form
   (schedule, part and line) and the loader version; a fact the filing does not carry
   is absent, not filled in; people are stored as named and not merged; an unread
   filing is recorded as unread; and nothing here decides or sends.

5. **Same archives, no new download.** The loader reads the IRS archives already on
   the owner's server. **The first act of the build is to confirm, on a sample, that
   those archives hold Form 990 returns with Schedule I and Schedule D**, and to
   report what it found before writing the reader. If they do not, the build stops and
   comes back to the owner. The IRS Exempt Organizations master file (category codes
   for recipients) is **not** authorized here: it is a new source and needs its own
   ruling.

6. **Tried on one state, measured, then the owner decides.** Stage one loads
   California only, checked by the same seeded sample and exception list as ruling
   0046 clause 3 (a state is complete only when the run finished, the outcome counts
   add up, the header audit is clean and the sample has no unexplained mismatch). The
   build report states the rows and storage it added and projects the national figure
   against the owner's 8 GB database limit. **The national run is a separate decision
   the owner makes on those numbers**; this ruling does not authorize it.

7. **Not while the national foundation load is running.** No stage begins on the
   owner's server or in the production database until the item-114 national load is
   complete and verified, so the two do not compete for the server or the database.
   Reader code, tests and the migration may be written and countertested before then;
   nothing is loaded.

8. **Who is in scope is a stated threshold, not a feeling.** A grantmaking public
   charity is in scope when any filing in the three periods reports grants to
   organizations of at least $100,000 in total (mirroring the giving test used for
   private foundations); a sponsor is in scope when it reports any donor-advised fund
   on Schedule D. The threshold is recorded on every run, and the number of funders
   just under it is reported so the owner can see what the line excludes. The
   $100,000 figure is the owner's to confirm or change before the build starts.

## Why

The private-foundation database misses two of the largest sources of grants a small
nonprofit can actually win: community foundations, which run open programs, and the
money that moves through donor-advised funds. Both file public returns, but they differ
in a way that matters. A public charity's grant list sits in a schedule, not in the
foundation return the loader already reads, and a donor-advised fund hides its donors
by design. Calling the first "the same as a foundation" would put figures with
different definitions side by side, and implying the second can be traced to a person
would be a claim the data cannot support. Stating the kinds, the definitions and the
limit in the ruling, and trying one state before the country, keeps this data as
trustworthy as the first load. Everything else is a repeat of rulings 0045 and 0046.

## Test of compliance

Load California: every new row names its kind, its form, and its schedule, part and
line, and carries no `organization_id`; the application role still cannot write the
new tables. Search the data for a column that holds both a private foundation's
"contributions paid per books" and a public charity's Schedule I total: there is none.
Open any donor-advised fund sponsor's grants: no person is attached to any recipient,
and the page carries the no-named-donor statement. Read the run record: it lists the
threshold, the count just under it, and the forms not covered (990-EZ, 990-N). Run the
loader while the item-114 load is still running: it refuses to start. Re-run a
complete state: zero rows written. Read the stage-one report: it states rows added,
storage added and a national projection, and the national run has not been started.

## Scope

Authorizes item 116 stage one only: the sample confirmation of clause 5, the reader
for Form 990 with Schedule I and Schedule D, the additive migration for the new kinds,
the California trial and its report. Does not authorize the national run, any screen
that reads the data (item 113), any use of it in matching, discovery or scoring, the
Exempt Organizations master file, any attempt to identify donors behind donor-advised
funds, Form 990-EZ or 990-N filers, or any change to rulings 0045 or 0046.

## Owner's confirmations, 2026-11-10

The owner approved this ruling as drafted. They confirmed the $100,000 grants
threshold of clause 8, and that Form 990-EZ and Form 990-N filers stay out of this
stage (clause 1). The national run waits for the stage-one numbers and a separate
decision by the owner, as clause 6 states.
