# 0014 — The national charity load records a structural check failure, and goes on

status: decided by the owner, 2026-11-11 ("Record and go on")
date: 2026-11-11
owner: decision space
under: decision 0012 clause 1 (the run stops at once when a state's check reports a structural failure); this decision amends that clause and nothing else.

## Why

Every stop of the national run so far was a defect in the check or a database timeout, never a bad load:
California's contractor name, the database totals with a second state loaded, Arizona's contact box, two
Washington, D.C. check defects (a filer that moved; a timed-out read), New York's one oversized write, and
Missouri's re-check against New York's half-finished write. Each stop cost between one and five hours of idle
server time, because loading is independent and repeatable state by state and a restart needs a signed-in
terminal. Thirty-seven states have passed their checks, so the loader is proven; what a stop buys is
a faster look at the cause, not safety.

## The decision

1. A state whose check reports a **structural failure** (outcome counts, header audit, scope audit, filing
   totals) is recorded as **needs review** (a `needs-review` marker beside the `unverified` one, and the
   check's result file with the reasons) and the run goes on to the next state.
2. The run still **halts** when two states in a row fail structurally (that points at the loader, not at one
   state), when a check crashes or is misused, and as before after 3 unverified states in a row or 8 in all.
3. A **load that fails** is repeated, up to three attempts a state (every write is idempotent), before the run
   stops.
4. A state already recorded as not verified or needing review is skipped on a restart unless named; naming
   it tries it again. (Reloading it before its cause is fixed only repeats the result.)
5. **Not complete until clean (unchanged).** The national load is not complete, and nothing may rely on it,
   until every unverified or needs-review state is explained or fixed and re-checked. At its end the run
   lists them and exits 5 if any remain.

## Also done with it

The scope audit's "funder is stored as in scope but this return of its own was not stored" now counts only a
funder whose stored organization record is in the state being checked. A funder that moved is stored in the
state of its latest return; a return of its in another state that does not qualify alone is not a miss
(it is the same moved-filer matter as the planned reconcile pass).
