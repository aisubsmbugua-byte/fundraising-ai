---
id: 0032
title: Sending is off for an organization until the platform owner turns it on — the absence of a row is the off state
status: settled
provenance: verbatim
supersedes:
date: 2026-09-24
---

## The ruling

1. **Funder-facing sending is a per-organization capability that is OFF by
   default.** An organization may send only while an explicit enablement
   record for it exists and says enabled. **The absence of a record means
   disabled** — nothing stores "off", so nothing can get it wrong (the
   encoding migration 0066 established for `undecided`).

2. **Only the platform owner turns sending on.** The enablement record is
   written by a superadmin, never by the organization's own members — an
   organization must not be able to enable its own sending by editing a
   row it owns. Read access is org-scoped (a member may see whether their
   own organization is enabled); write access is superadmin-only.

3. **The database enforces it, and the interface explains it.** The
   send-attempt birth (ruling 0029's birth-before-provider record) is
   refused by the database unless the organization is enabled — so no
   client, handler or future code path can send for an org that has not
   been enabled. Separately, the readiness check that builds the
   confirmation refuses earlier with a plain sentence saying sending is
   not switched on for this organization and how it is switched on, so a
   person is told, not merely blocked.

4. **Nothing else about a disabled organization changes.** Drafting,
   composing, approving, un-approving, revising, and exporting proposals
   and decks all work exactly as before. Only the final funder-facing send
   click is unavailable. Hard rules 1 and 2 are untouched.

## Why

Every organization's mail transits the one platform sending address, and
that address now lives on the owner's own verified domain. An organization
that sends before it has its own verified sending identity would emit
funder mail as "Their Org Name" from the owner's domain — an identity
mismatch that spends the owner's sender reputation on someone else's
behalf. Decision 0007 / item 58 is the real fix (each organization
verifying its own domain); until it exists, the honest posture is that
sending is granted deliberately, per organization, by the person who
bears the reputational risk. Default-off is the safe direction under rule
1's spirit, reversible per organization in one action, and costs testers
only the last click of a workflow they can otherwise complete end to end.

## Test of compliance

For an organization with no enablement record: the confirmation refuses in
plain words before any attempt is born; a direct attempt insert is refused
by the database; approving, composing and exporting still work. Enable it
as a superadmin: the same draft sends. Try to write the enablement record
as an ordinary member of that organization: refused.

## Scope

Authorizes item 74: one additive migration (a small org-scoped
enablement table under hard rule 6 with superadmin-only write policies;
a `create or replace` of the send-attempt birth function that adds the
enablement check to its existing guards and removes none — 0070/0075's
additive-in-effect precedent); a readiness refusal with a plain message;
a superadmin toggle in the existing admin area; tests, including the
isolation suite's extension to the new table. Does not authorize any
change to what a draft is, to non-send capabilities, or to per-org
sending domains (item 58).
