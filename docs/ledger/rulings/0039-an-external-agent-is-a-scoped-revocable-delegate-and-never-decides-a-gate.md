---
id: 0039
title: An external agent is a scoped, revocable delegate of one user, and never decides a gate on its own call
status: settled
provenance: verbatim
supersedes:
date: 2026-10-16
---

## The ruling

The owner wants their own desktop assistant — an agent that runs outside this
platform, in another company's cloud, alongside their other projects — to
report on where fundraising stands and to carry out their decisions. That is
a different kind of actor from the in-platform assistant ruling 0038 governs,
and the difference is one fact: **the platform cannot see what the user said
to it.** Ruling 0038's central safeguard — the user's words, quoted and
checked in code against the message the platform itself stored — does not
exist here. The platform sees only the agent's calls. So five things hold,
and they replace "the user's words" with what the platform can actually
verify. Ruling 0038 is unchanged and keeps governing the in-platform
assistant; this ruling adds to it and takes nothing from it.

1. **An agent is a delegate of exactly one user, by a token that can be shown
   once, scoped, expired and revoked.** The agent presents a personal access
   token created by the user inside the platform. The platform stores only a
   hash of it — never the token — so a leak of the database does not leak the
   credential. A token stands for one user in one organization, carries a
   scope (read, or read and act), an expiry, a name, and a record of when it
   was last used; revoking it takes effect on the very next call. A token is
   checked by a database function that returns the owner only when the hash
   matches a live token, and a request without a live token is refused before
   anything else happens.

2. **The agent acts as that user through the same wall as every page.** Data
   is read and written through a session-scoped client bound to the token's
   user, so row-level security decides what the agent can see and change
   (hard rule 6). The platform's privileged credential may be used in exactly
   one place — a minting step that exchanges a verified token for a session
   of that same user — and never to read or write data. A scan asserts both:
   that the credential is named in that one module only, and that the module
   does nothing but mint. (The project signs sessions with keys the
   application cannot hold, so a session cannot be minted without the
   privileged credential; this confines it rather than pretending it is not
   needed.)

3. **The agent's abilities are a closed list of reads and everyday acts, and
   a decision gate is never decided on the agent's call.** A read looks
   something up and is rendered by code from platform data. An act changes
   something the user could have changed by hand — adding a prospect, logging
   an interaction, setting a follow-up or an ask amount, editing a draft,
   pushing back on a strategy, reopening an approved draft — and runs on the
   agent's call within the token's scope. Approving a strategy or an outreach
   draft is a gate, and no call from an agent executes one. The agent may
   *request* an approval; the platform answers with a single-use, short-lived
   link bound to the exact content fingerprint. The approval happens only when
   the user, signed in to the platform, opens that link, sees the full
   content, and clicks — a human act the platform itself observes. If the
   content changed since the link was made, nothing is approved. Sending,
   moving a stage, approving or correcting research claims, deleting, recording
   a gift and changing a contact's address are not on the list at all, as under
   ruling 0038 clause 4. A scan asserts the set.

4. **Every call is recorded for what it is, and writes are recorded before
   their effect.** The record names the token, the user, the ability and the
   arguments, and for a write what it replaced; it is append-only. It does
   **not** claim the user said anything: where the agent supplies the
   instruction it relied on, that is stored marked as the agent's own
   statement, unverified. Authority in this path is delegation bounded by
   scope, list, caps and revocation — never a verified instruction, and the
   record never pretends otherwise. A token has a cap on writes in a window,
   and text a write replaced can be restored by the user's click.

5. **What leaves the platform is an allowlist, and the user is told where it
   goes.** Each read returns a fixed set of fields, the same discipline as
   ruling 0037 clause 5 carried into 0038 — no contact email, phone, notes or
   interaction text, and a supporter's pledge only as a tier. An agent's
   provider holds what it receives under its own terms, which the platform
   does not read and cannot enforce; the page where a token is created says
   so, names what each scope can see, and is the only place a token can be
   made.

## Why

The in-platform assistant was safe to give a spoken-command interface because
the platform held the words. An external agent takes that away, and the
tempting repair — trust the agent's report that the user asked — makes the
agent the only witness to its own authority. That is the defect this ledger
keeps meeting: a guarantee held by the party it is meant to constrain.

So the platform is honest about what it can and cannot know. It cannot know
what was said; it can know which token called, what the token may do, what it
did, and — for the two calls that are real decisions — that a signed-in human
saw the content and clicked. Everyday acts rest on delegation, bounded and
revocable and recorded. Decisions rest on a click the platform can see.

## What this deliberately does not do

It does not stop a delegated agent from misreading the user and adding a
prospect they did not want, or logging a call they did not make. That risk is
the price of delegating everyday work, and it is bounded: a closed list, one
subject per call, write caps, a record of every call with what it replaced,
restore for replaced text, and revocation at once. It is not the price of
delegating a decision.

## Test of compliance

If an agent call can approve a strategy or a draft, or if an approval link
can be used by anyone other than the signed-in user it was made for, or twice,
or after the content changed, the gate was decided by the agent. If the
platform's record says the user instructed something on the strength of the
agent's report alone, it claims knowledge the platform does not have. If the
privileged credential is read anywhere but the minting step, the wall is
gone.

## Worked examples

- "Muse, log that I called the Maclellan Foundation" arrives as an act call
  with the user's token: it runs as that user, is recorded as the agent's
  call, and the prospect's activity shows it.
- "Muse, approve the Maclellan strategy" arrives as a request for approval:
  the agent gets a link, tells the user, and the user clicks Approve on the
  platform after seeing the strategy. The agent has not approved anything.
- A revoked token fails on its next call, whatever the agent is in the middle
  of.
