---
id: 0037
title: An assistant acts as the signed-in user, reads and prepares freely, and acts only on a human's approval of exactly what it will do
status: settled
provenance: verbatim
supersedes:
date: 2026-10-13
---

## The ruling

An in-platform assistant — a model the owner talks to, which looks things up
and starts deeper work on their behalf — is a new kind of actor. Whatever
model sits behind it, and however many providers the platform comes to use,
five things hold:

1. **It is the signed-in user, not a privileged process.** The assistant
   reads and writes through the same session-scoped client every page uses,
   so a member sees through it exactly what they see on the page and nothing
   else. It never holds or uses the service-role key (hard rule 5), and an
   organization's data is isolated from every other's by the same mechanism
   as everywhere else (hard rule 6) — the assistant adds no second path
   around it.

2. **Its abilities are a closed list written in code, and every entry is one
   of three kinds: read, prepare, or act on approval.** A read looks
   something up. A prepare starts a piece of work the platform already knows
   how to do (a research run, a strategy run), through that work's existing
   entry point, and the result lands in the review state it always lands in.
   An act-on-approval ability changes something the user could have changed
   by hand, and it does so only through a **proposal**: a stored record of
   exactly what will be done, shown to the user in full, which the model
   cannot execute. Only the user's own approval of that proposal — a click
   on the rendered proposal, handled by code the model has no way to call —
   executes it, once, with exactly the payload that was shown, through the
   same entry point a person using the page would use, as that user. A
   proposal that is dismissed, expires, or whose subject has changed since
   it was written is not executed. The model proposes; the user's approval is
   the decision; the execution is its direct result — the same shape as the
   rest of the platform's approval gates.

   **Two things are not on the list of what an approval can do, in this
   ruling, because each already has its own gate and its own ruling:** sending
   anything to a funder (hard rule 1; ruling 0029 and ruling 0032) and moving
   a prospect between stages (hard rule 2). The assistant may prepare a draft
   or point to the stage the prospect appears ready for; the send and the
   move are made in the screens that already carry those gates, not through a
   second path. Nor may any entry approve or correct a research claim or
   strategy (hard rule 3) or delete a record. The list is closed in the sense
   ruling 0029 closed the send path: a scan asserts the set, so adding an
   ability is a visible, reviewed change to a list, not something a prompt or
   a model can bring about.

3. **A fact shown to the user comes from a tool's result, not from the
   model's sentence.** A figure, a name, a date or a count is rendered by
   code from what a read returned. What the model writes around them —
   summary, interpretation, suggestion — is a claim and is labelled as
   AI-written wherever it appears. The assistant may be wrong in prose; it
   must not be able to make the platform's numbers wrong.

4. **Every assistant turn is a ledgered run, and names its provider.** A turn
   is born in the run ledger before the model is called (ruling 0026), so a
   turn that was killed is a row with no outcome, never an absence. The
   turn's own record — which the run row points to, and which is born in the
   same step, before the model is called — names which provider answered it
   and which model, so a killed turn still says who it was addressed to. The
   run is metered as an operation like every other; where credits are
   charged (decision 0006), an assistant turn is charged by the same
   schedule, and a provider's lower price is not a reason to leave a turn
   unmetered. This ruling does not set that price and does not build billing
   (ruling 0026 excludes both) — it only forbids a turn from existing outside
   the ledger the price will be read from.

5. **What leaves the platform for a provider is an allowlist per ability,
   not whatever the row happens to hold.** Each read states the fields it
   returns to the model; anything not named is not sent. Contact details (an
   email address, a phone number) and a supporter's personal particulars are
   excluded unless an ability is specifically written to include them. The
   default for a new ability is the narrowest set that answers its question.

## Why

The risk an assistant adds is not that it reasons badly — it is that it is
the first thing in the platform a person can *talk* to, so the pull is to let
it act on what it hears. Each hard rule so far guards a place where an
action could happen without a human. A conversational surface is a new place
that could, and the failure shape is the one this ledger already knows:
a guarantee left in the prompt ("be careful not to send anything") instead
of in the code, where measured prompt-only compliance is not good enough to
rely on.

The second risk is specific to a second provider: the platform's guarantees
about what happens to a funder's or a supporter's details were made with one
provider in mind. A new provider's retention and training terms are its own
and are not read by this code; so the platform's own discipline about what is
sent has to carry the load, not the provider's promise.

## Test of compliance

If a proposed assistant ability cannot be classified as read, prepare or
act-on-approval, or if its description needs the words "and then it sends",
"and then it advances" or "unless the user objects", it is not an assistant
ability; it is a new kind of action and needs its own ruling. If an
act-on-approval ability can be executed by anything other than the user's
approval of a stored proposal — a tool call, a retry, a second message from
the model — it is not act-on-approval; it is the model deciding.

If the justification for a field in a read's allowlist is "the model might
find it useful," the field is not in the allowlist.

## Worked examples

- Not a ruling: "Let the assistant draft and send a thank-you if I say so."
- A ruling: "The assistant's list contains reads, prepares and
  act-on-approval entries; sending is not an entry on it, however the
  request is phrased. The assistant may prepare the thank-you; the send is
  made in the screen that carries the send's own gate."
- An act-on-approval entry that logs a call against a prospect satisfies
  clause 2: the user sees "log this call, with this summary, on this
  prospect," clicks approve, and the platform logs it as that user. The
  model calling a tool named "log call" and the log being written without
  that click does not.
- A read that returns a prospect's name, stage, next action and due date to
  the model, and not its contact email, satisfies clause 5. A read that
  returns the whole row because it was convenient does not.
