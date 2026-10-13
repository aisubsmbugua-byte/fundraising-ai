---
id: 0038
title: A command is a decision made in words; a decision gate is decided only on what the user was shown
status: settled
provenance: verbatim
supersedes: 0037
date: 2026-10-13
---

## The ruling

Ruling 0037 let the assistant read, and let it act only through a proposal
the user approved with a click on a rendered card. The owner has said that is
not what they need: they need to *command* the assistant — "approve this
strategy", "push back on it", "add this prospect", "make that email warmer" —
and have it act as them. A command typed by the owner, naming an action, is a
human decision made in words. The platform has to be able to honour it
without a second click, and without turning "the human decides" (hard rule 3)
into a sentence in a prompt. Five things hold, whatever the provider.

1. **It is the signed-in user, not a privileged process.** The assistant
   reads and writes through the session-scoped client every page uses, and a
   member sees and changes through it exactly what they could on the page.
   It never holds the service-role key (hard rule 5), and an organization's
   data stays isolated by the same mechanism as everywhere else (hard rule 6).
   *(Carried unchanged from ruling 0037, clause 1.)*

2. **A command executes only as the direct result of the user's own words
   in the current turn, and the words are on the record.** An ability that
   writes may run immediately only when the call carries a quotation of the
   user's latest message — a verbatim excerpt, checked by code against that
   message before anything runs, never accepted on the model's say-so.
   Text that reached the model through a tool result — a funder's claim, a
   note, a web page, an earlier assistant message — is not the user's
   command and cannot supply the quotation. A model acting on its own
   initiative is not a command: its suggestions remain proposals the user
   approves with a click, exactly as under ruling 0037. A command names one
   subject and one action; there is no "all of them", and a turn may execute
   only a small, fixed number of commands.

3. **A decision gate is decided only on what the user was shown.** Some
   abilities are the platform's own decision gates — approving a strategy,
   approving a draft. For those, the user's command is accepted only for a
   specific version the assistant displayed to the user in an *earlier* turn
   of the same conversation, identified by a fingerprint of its content,
   and the fingerprint is recomputed at the moment of execution; if the
   content changed since it was shown, nothing runs and the user is told.
   A person cannot decide on something they have not seen. The user may say
   "approve it" in their next message; they may not approve in the same
   breath as the assistant first reads it. Every other ability — adding a
   prospect, editing or revising content, logging, setting a follow-up —
   is not a gate and runs on the command alone.

4. **Some things are not on the assistant's list, however it is asked.**
   Sending anything to a funder (hard rule 1, rulings 0029 and 0032),
   moving a prospect between pipeline stages (hard rule 2), approving or
   correcting a research claim, deleting a record, and recording a gift are
   each gated elsewhere, by their own screens and rulings, and no command
   given to the assistant reaches them. Approving a draft is on the list
   because approval is not sending: the send is its own confirmed step on
   its own screen. The list is closed in the sense ruling 0029 closed the
   send path: a scan asserts the set and each ability's kind, so adding one
   is a visible, reviewed change, not something a prompt or a model can
   bring about.

5. **Every command leaves a record that can be read and, where a write
   replaced something, undone.** The record names who, the user's message,
   the quoted words, the ability, the exact payload, and the outcome; where
   a write replaced content, it holds what was replaced. Records are
   append-only. And the rest of what ruling 0037 required still holds: a
   fact shown comes from a tool result rendered by code, the model's prose is
   labelled AI-written (clause 3 of 0037); each turn is a ledgered run, born
   before the model is called, whose own record names the provider (clause 4
   of 0037); and what leaves the platform for a provider is an allowlist per
   ability (clause 5 of 0037) — widened here only as far as an ability must
   read the very content the user is asking it to change, and no further.

## Why

Ruling 0037 guarded the right thing and got the user's meaning wrong. It put
the decision in a click on a card, which made the assistant a suggestion box
for every write — and left out the gate actions entirely, because it read
"the human decides" as "the human clicks a button". The rule says the human
*decides*. A command given in words is a decision; what the platform must
guarantee is that it really was the user's, that it was about the thing they
were looking at, and that it can be reconstructed afterwards.

The two places this can go wrong are the ones the clauses close. The model
can act without being told to (clause 2: no command without the user's own
words, verified, and its own suggestions stay proposals); and the user can be
made to decide blind (clause 3: a gate is decided only on a version they were
shown, pinned by content). Neither depends on prompt wording, which on this
codebase has measured well short of what a guarantee needs.

## What this deliberately does not do

It does not check that the quoted words *mean* the action. Code can verify
that the user said those words; it cannot verify the model understood them.
That residual risk is bounded, not removed: a misread command is limited to
the ability list, to one subject, is recorded with the words that caused it,
and for content replaced carries what it replaced. A gate is never decided
blind.

## Test of compliance

If an ability's description needs "and then it sends", "and then it moves
the stage", or "unless the user objects", it is not an assistant ability. If
a gate ability could execute against content the user was not shown in an
earlier turn, it is not a gate ability, it is the model deciding. If the
only evidence that the user commanded an action is the model's statement
that they did, there was no command.

## Worked examples

- Not a ruling: "Let Muse approve the Maclellan strategy."
- A ruling: "A gate ability executes only for a version the user was shown
  in an earlier turn, pinned by fingerprint; the user's next message saying
  to approve it is the decision."
- "Add Harvest Foundation as a prospect, channel private foundation" in one
  message: executes in that turn (not a gate), recorded with the quoted
  words.
- "Approve the strategy for Maclellan" as the first message about it: the
  assistant shows the strategy and says it will approve on the user's next
  word. It does not approve in the same turn.
