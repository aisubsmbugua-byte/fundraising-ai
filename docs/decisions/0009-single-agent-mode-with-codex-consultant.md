# 0009 — Single-agent mode: one session holds both spaces; Codex is an on-demand second opinion

**Date:** 2026-09-29
**Status:** Decided by the owner. Extends `docs/ledger/README.md`'s protocol;
supersedes nothing in `CLAUDE.md`'s hard rules 1–6, which remain absolute
regardless of who is operating or how many sessions are running.

## Adopted by the owner

1. **Single-agent mode is the default.** One Claude session now holds both
   the decision space's responsibilities (direction, counterchecking,
   rulings) and the build space's (code, build reports), working directly
   under the owner's real-time guidance — replacing the asynchronous
   two-terminal handoff described in `docs/ledger/README.md` as the default
   way of working. The owner is the live counterparty that the old "switch
   terminals" step used to formalize; approval now happens in the same
   conversation, not by routing through a second blind session.

2. **The mechanical safety net is unchanged in substance.** `STATE.md`, the
   `docs/ledger/rulings/**` sealed-invariant record, and
   `scripts/ledger-check.ts`'s Stop-hook enforcement all stay in force. A
   code change in a governed area still needs a ruling naming the general
   invariant before it lands — the ruling can now be written in the same
   turn as the code it authorizes, since there is no second session to wait
   for, but it still has to be written. "Nothing binds until it is in a
   file" applies exactly as before.

3. **Codex is introduced as an on-demand, advisory-only second-opinion
   consultant.** Its role is defined in `AGENTS.md` at the repo root (the
   file Codex reads on startup, the way this session reads `CLAUDE.md`).
   Default posture: Codex reads and opines; it does not edit
   `docs/ledger/**`, does not write rulings, and has no write access to the
   repository unless the owner explicitly grants it for a specific task.
   Invoked when something isn't working and needs fresh eyes, or when a
   decision is worth stress-testing before committing to it.

## What this trades away, said plainly

The two-space split existed for a specific, stated reason:
`docs/ledger/ROLE-decision.md` — *"The moment this space starts doing the
work, it stops being able to check it."* Collapsing the two sessions into
one removes the structural guarantee that the agent writing code is never
the only check on it. That guarantee is real, and this decision does not
pretend otherwise.

What replaces it is weaker in one specific way: Codex is a genuine
independent second opinion when invoked, but invocation is now a choice
("throw things at it if they don't work") rather than an automatic step
every change passed through under the old handoff. The owner's own direct,
real-time involvement is the other half of the replacement — the review
that used to happen in a second session now happens with the owner present
in this one.

## What does not change

- Hard rules 1–6 in `CLAUDE.md` (no auto-send, no auto-advance, human
  decides, no external CRM, secrets server-only, tenant isolation) bind
  regardless of session structure.
- `docs/ledger/ROLE-build.md` and `ROLE-decision.md` still describe real,
  useful disciplines — cite what you read, name what you measured, how to
  countercheck a report, how to write a ruling. Both sets of disciplines
  now apply within the single session; neither is retired.
- Rulings already `settled` are exactly as immutable as before.

## Revisit

If a defect ships that a genuine second session would have caught — the
failure shape `ROLE-decision.md`'s countercheck section exists to name
(partial wiring, a claim inferred from a name, two facts collapsed into
one) — revisit whether some class of change should route through Codex by
default rather than only on request.
