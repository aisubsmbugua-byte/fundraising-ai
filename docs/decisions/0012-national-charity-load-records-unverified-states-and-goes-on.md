# 0012 — The national charity load records a state whose check differs, and goes on

status: decided by the owner, 2026-11-11 ("Yes, make that change")
date: 2026-11-11
owner: decision space
under: decision 0011 condition 2 (the run stops at the first state whose check reports a difference nobody has explained); this decision amends that one condition and nothing else.

## Why

The first three stops of the national run (California's contractor name, the database totals once a second
state was loaded, Arizona's contact box) were each a defect in the check, not in the loaded data, and each
cost about an hour of idle server time. Loading is the slow, repeatable part and nothing reads these
tables yet. The owner asked whether to keep going and keep the differences for analysis; the build's
recommendation, accepted here, is to keep going on differences between a stored value and its return, and
to keep stopping on anything that signals a broken loader.

## The decision

1. **Stops at once** (as before) when a state's load fails, or its check reports a structural failure:
   the run's outcome counts do not add up, the header audit finds a return the loader put in the wrong
   state, the scope audit finds an in-scope return the loader did not store, or an input is missing.
2. **Goes on** when a state's check reports only differences between stored values and the IRS return that
   nobody has explained. That state is recorded as not verified, in the database on its run
   (counts.verification.verified is false) and in the run's unverified folder, and is not marked done.
3. **Halts** after 3 unverified states in a row or 8 in all, since that points at the check or the
   loader, not single returns.
4. **Not complete until clean.** The national load is not complete, and nothing may rely on it, until every
   unverified state's differences are explained or fixed and the state is re-checked (ruling 0046's bar,
   applied here). At its end the run lists the unverified states and exits non-zero if any remain.
5. No unexplained difference is waved through: the exception list for this kind stays empty unless a
   difference is explained and entered there.

## What it does not change

Everything else in decision 0011: threshold, no people stored, nothing sent, the screen unchanged,
resumable.
