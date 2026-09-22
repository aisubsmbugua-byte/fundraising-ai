# Slice 8 — Email send (human-gated)

## Goal
Let a human send an approved draft to a funder via Resend — as an explicit, one-click, one-message action. This is the only slice that sends anything.

## Why now
Last, on purpose. Sending is the single highest-risk capability. It goes in only after every guardrail around drafting, evidence permissions, and memory is in place.

## Scope
- On an **approved** draft (Slice 5 status `approved`), a "Send" action appears.
- Send opens a final confirmation showing exact recipient, subject, and body.
- On confirm, the server route sends via Resend to the prospect's contact email.
- The send is logged as an `interaction` (`email_logged`) automatically after the fact.
- Sending is one message to one prospect. No batch send. No campaigns.

## Out of scope
- Bulk/campaign sending. Explicitly not built.
- Any scheduled or triggered send. Every send is a live human click.
- Auto-drafting + auto-sending chains.

## Data
Add to `drafts`:
- `sent_at` (timestamptz, nullable), `sent_by` (uuid, nullable), `resend_id` (text, nullable)

## UI
- Draft editor — "Send" only on `approved` drafts, behind a confirmation modal showing final recipient/subject/body.
- After send, the draft shows a sent badge and the timeline logs it.

## Guardrails
- **Human-gated, per-message, no batch.** One click sends exactly one message to one recipient, after a confirmation that shows the exact content.
- **No auto-send anywhere.** There is no scheduled, triggered, or bulk path. Grep the codebase to confirm the Resend call is reachable only from the confirmed-send handler.
- Resend key is server-only.
- A draft can only be sent once; re-send requires a new draft.

## Definition of done
- [ ] Only `approved` drafts can be sent.
- [ ] Send requires a final confirmation showing exact recipient/subject/body.
- [ ] Send delivers via Resend and logs an interaction.
- [ ] No batch, scheduled, or triggered send path exists anywhere in the code.

## Where this grows
See `CLAUDE.md`'s "The advancement workflow" — outreach and proposal content both eventually flow through this exact same gate (approve, then a confirmed send click), just triggered from more places in the sequence (post-strategy outreach, post-proposal-approval ask) rather than only from a single generic draft. The mechanism doesn't change: the system only ever sends as the direct, immediate result of a human's confirmed click.

## As built — verified 2026-09-21 (supersedes the 2026-09-17 note)

**Status: built under ruling 0029, migration 0069 pending owner application.**

Two namings drifted from this spec, both deliberate: the provider id column
is `resend_message_id` (per the item 52 authorization), and the logged
interaction kind is `email` — the `interaction_kind` enum from migration
0031 has no `email_logged` value and enums only grow by migration. The spec
also gained an attempt ledger (`draft_send_attempts`, born before the
provider call) the original data section did not foresee; it is how
"attempted but no response" is a recorded state instead of silence.
- `RESEND_API_KEY` sits in `.env.example` marked for this slice and is
  referenced nowhere in the code. The `resend` package is installed and dormant.
- Team invitations go through Supabase Auth's own `inviteUserByEmail`
  (`lib/invite.ts`), which is not a sending capability this app operates. A
  comment there mentions Postmark historically; it is not in use.

**Consequence for hard rule 1.** "No auto-send" is currently true by absence,
not by construction. When this slice is built, the guarantee has to move into
code — a send path reachable only from a handler taking an approved draft id and
a live human session — because absence stops protecting anything the moment the
first send call is written.
