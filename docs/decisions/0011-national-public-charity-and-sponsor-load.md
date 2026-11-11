# 0011 — The national load of grantmaking public charities and donor-advised fund sponsors

status: decided by the owner, 2026-11-11 ("Yes, run the national load")
date: 2026-11-11
owner: decision space
under: ruling 0047 clause 6 (the national run is the owner's separate decision, on the California numbers)

## The decision

Run the public charity and donor-advised fund sponsor load for every state, one state at a time, on the
owner's Lightsail server, from the IRS archives already on its disk. The numbers the owner decided on are
in docs/reviews/0036-public-charity-and-daf-california-trial-report.md: about 1.5 GB added, the database
near 4.5 GB of the 8 GB included, 8 to 12 hours (likely less, since the archive reading is cached after
the first state).

## Conditions the owner's go carries (from ruling 0047 and the report)

1. **Fix first.** The oversized-return write (migration 0090, pieces of at most 1,000 recipient rows) is
   proven on the real project's two refused California returns before the national run starts.
2. **Each state is checked before the next starts.** The same seeded sample check as California
   (scripts/verify-public-charities.ts, 150 funders, header audit, scope audit, unread audit). The run stops
   at the first state whose load fails or whose check reports a difference nobody has explained, and says which.
   No unexplained difference is ever waved through; the exception list for this kind starts empty.
3. **Nothing else changes.** The threshold stays at $100,000 and the just-under floor at $50,000; no
   person is stored; nothing is sent to anyone; the screen (item 113) does not show these tables.
4. **Jurisdictions.** The 56 other than California that the foundation load covered (50 states, DC, and the
   territories and military codes its headers named). Any filer whose address names none of them is counted
   by the end-of-run coverage check and reported, not silently left out.
5. **Resumable.** Finished states are skipped if the run is started again after a stop.

## What it does not decide

Opening these tables on the screen, any change to the threshold (which means rewriting every stored funder),
and a monthly refresh of the charity tables are each separate decisions.
