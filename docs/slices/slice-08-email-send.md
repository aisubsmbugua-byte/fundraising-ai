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
