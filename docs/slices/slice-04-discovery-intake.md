# Slice 4 — Discovery intake

## Goal
Bring candidate funders into the system from public sources via manual entry and CSV import, landing them in a review queue — never straight into the pipeline.

## Why now
Discovery is the top of the funnel. It needs the CRM (to create records), screening (to auto-classify on intake), and the review-queue pattern that all later automation reuses.

## Scope
- CSV import: upload a file of candidate funders → parsed rows → staged as `candidates`.
- Manual "add candidate" form.
- A **review queue** UI: each candidate is screened automatically on intake (Slice 3 engine) and shown with its tier.
- Human action per candidate: **Accept** (creates a `prospect` at stage `discovery`) or **Dismiss** (kept as memory, not deleted).
- Optional: an Anthropic-assisted parser that normalizes messy CSV columns into the candidate schema (server-side, review-only).

## Out of scope
- Live web scraping / crawling. Manual + CSV only for this slice.
- Any automatic acceptance. Every candidate is human-accepted.

## Data
`candidates`:
- `id`, `name`, `channel`, `organization`, `website`, `source` (text), `raw` (jsonb — original imported row)
- `suggested_tier` (int, nullable — from auto-screen)
- `status` (enum: `pending`, `accepted`, `dismissed`)
- `reviewed_by` (uuid, nullable), `created_at`

## UI
- `/(dashboard)/discovery` — review queue: pending candidates with tier, Accept / Dismiss.
- Import screen for CSV upload + manual add.

## Guardrails
- **No auto-accept.** Candidates enter a queue; a human accepts or dismisses each one.
- Dismissed candidates are retained (relationship memory), not hard-deleted.
- If the AI parser is used, its output is editable before the candidate is saved.

## Definition of done
- [ ] CSV upload creates pending candidates; manual add works too.
- [ ] Candidates are auto-screened and show a suggested tier.
- [ ] Accept creates a prospect at `discovery`; Dismiss retains the record.
- [ ] Nothing enters the pipeline without a human accept.
