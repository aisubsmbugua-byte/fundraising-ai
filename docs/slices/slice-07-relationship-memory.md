# Slice 7 — Relationship memory

## Goal
A full interaction history per prospect, including outcome tracking that turns a "no today" into a future "yes" or referral. The system becomes institutional memory, not just a funnel.

## Why now
By now prospects move through stages, get drafted to, and cite evidence. Memory ties it together — capturing every touch and every outcome so nothing is lost when a team is small and turnover happens.

## Scope
- `interactions` log: a timestamped record of every touchpoint (call, email logged, meeting, note).
- Outcome capture at the Decision stage: `yes` / `no` / `defer`, with a reason and an optional **revisit date**.
- A "no → revisit" surfacing: prospects with a past `no` and a due revisit date appear in a **Revisit** list.
- Referral capture: a `no` can record a referral to another funder, optionally spawning a new candidate (Slice 4 queue).
- Prospect detail timeline stitches together stage changes, drafts, interactions, and outcomes.

## Out of scope
- Automated follow-up sending (any send is Slice 8 and human-gated).

## Data
`interactions`:
- `id`, `prospect_id`, `kind` (enum: `note`, `email_logged`, `call`, `meeting`, `other`)
- `summary` (text), `occurred_at`, `logged_by`, `created_at`

`outcomes`:
- `id`, `prospect_id`, `result` (enum: `yes`, `no`, `defer`)
- `reason` (text), `revisit_on` (date, nullable)
- `referral_to` (text, nullable), `created_by`, `created_at`

## UI
- Prospect detail — unified timeline + "log interaction" + "record outcome".
- `/(dashboard)/revisit` — prospects whose revisit date is due.

## Guardrails
- A `no` is never a hard delete. It is retained with its reason and revisit date.
- Referrals create candidates in the Slice 4 review queue (human-accepted), never direct prospects.

## Definition of done
- [ ] Every touchpoint is logged and shown on a prospect timeline.
- [ ] Outcomes capture yes/no/defer with reason and optional revisit date.
- [ ] The Revisit list surfaces due "no → revisit" prospects.
- [ ] Referrals flow into the candidate review queue.
