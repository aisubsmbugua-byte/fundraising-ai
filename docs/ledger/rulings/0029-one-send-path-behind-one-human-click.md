---
id: 0029
title: One send path, born behind one human click — the no-auto-send guarantee moves into construction before send code exists
status: settled
provenance: verbatim
supersedes:
date: 2026-09-21
---

## The ruling

Hard rule 1 has been true by absence — no send code exists. Slice 8 ends the
absence, so the guarantee becomes construction, before the first line:

1. **Exactly one module may send funder-facing mail.** The call to the mail
   provider for anything funder-facing lives in one server-side module,
   imported by exactly one handler. A closed-set scan test (the ai-runs
   pattern) fails the suite the day a second importer or a second send call
   appears anywhere in app/ or lib/. The invite mail path stays separate and
   untouched — inviting a teammate is not funder-facing.

2. **The one handler sends only on a live human confirmation of exact
   content.** It takes an approved draft id; re-verifies server-side, at
   send time, that the draft exists, belongs to the caller's org, is
   `approved`, and has never been sent; and executes only as the direct
   result of a confirmation that displayed the exact recipient, subject and
   body that will be sent. No other precondition combination sends.

3. **One draft, one send, ever.** sent_at is written once; the columns are
   never cleared; re-sending requires a new draft. Enforced in the database
   (the terminal-once shape from ai_runs), not by the interface declining a
   button.

4. **What was sent is captured, not retyped.** The provider's message id
   comes from the provider's response; the interaction row is logged from
   the same payload that was sent. A send whose response never arrived is
   recorded as attempted-unconfirmed — a born-unfinalized state, never
   silently absent and never assumed delivered.

5. **No batch, no schedule, no trigger, no retry loop.** One click, one
   message, one recipient. A failed send is reported to the human, who may
   click again on a NEW confirmation; the system never re-sends on its own.

## Why

Item 21 recorded the moment this becomes urgent: "the moment Slice 8 starts,
that guarantee has to move into construction." Slice 8 starts now, under a
deadline — exactly when a guarantee left to prose would erode. Measured
prose compliance on this codebase is 52–80%; sending is the one capability
where a defect reaches a funder's inbox with the organization's name on it.
The mechanisms are all proven in this codebase already: the closed-set scan
(test-ai-runs), terminal-written-once (migration 0067), capture-don't-retype
(everywhere). This ruling only points them at the send path.

## Test of compliance

Grep for the provider call: one funder-facing module, one importer. Read the
handler: every clause-2 check present, server-side, at send time. Try the
database: a second write to sent_at fails. Find the confirmation: what it
displays is what was sent, from the same payload.

## Scope

Authorizes item 52 — Slice 8 per its spec (docs/slices/slice-08-email-send.md)
under these five clauses: one additive migration (sent_at, sent_by, provider
message id on drafts, nullable; DB enforcement of clause 3), the send module
+ handler, the confirmation UI on approved drafts, the automatic interaction
log, the closed-set scan test, and tests for each clause. Does not authorize
batch anything, scheduling, retries, templates, or touching the invite path.
