---
id: 0041
title: A count of days between two dates is a count of calendar dates, never a quotient of elapsed hours
status: settled
provenance: verbatim
supersedes:
date: 2026-10-31
---

## The ruling

1. **When the platform says "due in N days" or "N days since", and both ends
   are calendar dates, N is the difference of the dates themselves.** It is
   computed by turning each date into a whole-day index of the calendar and
   subtracting. It is never computed by subtracting two moments in time and
   dividing by the number of milliseconds in a day, because a day is not
   always that long: where clocks change, a calendar day lasts 23 or 25 hours,
   and the quotient is off by an hour and lands on the wrong side of a
   threshold.

2. **An elapsed duration is a different fact and may be measured in elapsed
   time,** where what is being shown is how long something has lasted ("in
   this stage for 4.2 days"), not which calendar day something falls on. The
   two are never interchanged: a due date is a calendar fact and is counted by
   date; a stage's age is a duration and is counted by time.

3. **Whichever clock supplies "today" is stated and passed in, not read
   inside the arithmetic,** so the same function gives the same answer for the
   same two dates in any timezone, on a server or in a browser, on any day of
   the year, and a test can fix "today" instead of depending on the day it is
   run.

## Why

A "due soon" label was derived by subtracting a local-midnight timestamp for
"today" from one for the due date. Across the autumn clock change a prospect
due in exactly three days measured three days and one hour and read "On
track" instead of "Due soon", in the two views that run in the owner's
browser, while the same prospect read correctly on a server page — and two of
this codebase's own test suites began to fail on the first date it mattered.
The defect shape is the one this ledger keeps meeting: a fact true on most
days (a day is 24 hours) assumed true on all of them. The other two places in
the codebase that count days between dates already do it by calendar index;
this makes that the rule rather than the habit.

## Test of compliance

For every day of a year, in a timezone that observes a clock change in each
direction and one that observes none, a due date k days away, for k from
before today to a week ahead, classifies identically: overdue below zero, due
soon from zero to the window, on track beyond it. Run the arithmetic in a
different timezone and the answer does not change.

## Scope

Authorizes item 104: the "due soon" classification computed by calendar-date
arithmetic with "today" passed in, a test that sweeps a full year in several
timezones, and nothing else. Does not authorize a change to what the window
is, to which timezone "today" is read in (server and browser may still differ
by a day in the evening; recorded separately), or to any elapsed-duration
display.
