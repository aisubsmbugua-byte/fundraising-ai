# Slice 3 — Screening & classification

## Goal
A rules engine that screens a prospect against configurable eligibility/fit criteria and produces a three-tier classification (Tier 1 / 2 / 3).

## Why now
Screening turns raw discovery into a prioritized list. It needs the CRM and pipeline in place; it feeds the discovery review queue (Slice 4) and gives drafting (Slice 5) a fit rationale to work from.

## Scope
- Editable screening rules (stored in the DB, not hardcoded).
- A scoring function that applies rules to a prospect and returns a tier + a per-rule breakdown.
- A "Screen" action on a prospect that computes and stores the result.
- Tier badge shown on prospect cards and detail.
- Screening runs on demand (button) — it does **not** move the prospect.

## Out of scope
- AI-generated rules. Rules are human-authored here; AI can assist authoring in a later iteration.
- Auto-advancing tier-1 prospects (never — that's a human decision).

## Data
`screening_rules`:
- `id`, `label`, `description`
- `channel` (nullable — applies to all channels if null)
- `weight` (int)
- `criterion` (jsonb — a simple, evaluable predicate spec)
- `active` (bool)

`screening_results`:
- `id`, `prospect_id` → prospects
- `tier` (int: 1/2/3)
- `score` (numeric)
- `breakdown` (jsonb — which rules passed/failed and their contribution)
- `screened_by` (uuid)
- `created_at`

## UI
- `/(dashboard)/settings/screening` — manage rules.
- Prospect detail — "Screen" button, tier badge, latest breakdown.

## Guardrails
- Screening classifies; it never changes pipeline stage.
- Rules are transparent: the breakdown always shows why a tier was assigned.

## Definition of done
- [ ] Rules are editable in the UI and persisted.
- [ ] Screening a prospect produces a tier + inspectable breakdown.
- [ ] Tier badges show on cards and detail.
- [ ] Screening never advances stage.
