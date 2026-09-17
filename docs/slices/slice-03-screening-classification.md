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

## Where this grows
Today's rules are human-authored. The planned next step (see `CLAUDE.md`'s "The AI-driven end state") is AI-suggested rules and channel-type matching, informed by the nonprofit's own knowledge base (Slice 6) — always landing as a suggestion a human approves, per guardrail 3. This slice's rules engine is the foundation that suggestion lands on top of, not something it replaces.

## As built — verified 2026-09-17

**Status: released.** Built essentially as specified — one of the few slices
where the plan and the code agree.

- `screening_rules` and `screening_results` exist as described (migration 0003).
  Results are **append-only**: each run inserts a new row, so screening history
  is preserved rather than overwritten.
- Thresholds: **Tier 1 ≥ 70%**, **Tier 2 ≥ 40%**, **Tier 3 below**. A prospect
  with no applicable rules defaults to Tier 2 — *not enough data to judge*,
  never Tier 3.
- Rules are editable at `/settings/screening`: label, description, channel,
  weight (1 / 3 / 5), and a field-operator-value criterion.
- `screenProspect` is called from seven places, including candidate creation,
  CSV import and AI discovery search, where it pre-computes `suggested_tier`.
- **Screening still never moves a prospect.** It classifies only.

### How Build 1 relates to this

Build 1's qualification pipeline (`lib/qualification.ts`) is a *second*,
evidence-backed assessment — pursue / dismiss / insufficient evidence /
intermediary-only — and it is still dark. Per ruling 0016 it **layers on top of
this engine rather than replacing it**; these human-authored rules are not going
away.

The two answer different questions: tiers say *how good a fit*, qualification
says *is there enough evidence to pursue at all*. Neither acts on its own —
both are advisory to a human under hard rule 3. What a user sees when both have
an opinion on the same prospect is deliberately undecided (`STATE.md` item 20).
