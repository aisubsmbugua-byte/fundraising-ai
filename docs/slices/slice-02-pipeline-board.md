# Slice 2 — Pipeline board

## Goal
A seven-stage board where prospects move through the pipeline — with a human approval gate on every stage change.

## Why now
The pipeline is the operating surface of the whole system. It needs to exist before AI starts suggesting moves, so that every suggestion has a gate to land in.

## Scope
- Add `stage` to prospects.
- Board view: seven columns, one per stage, prospects as cards.
- Moving a card **requests** a stage change; it does not apply until confirmed.
- A confirm dialog on every move ("Advance Acme Foundation from Screening → Qualification?").
- Stage-change history log.

## Out of scope
- AI-suggested moves (comes once drafting/screening exist).
- Automated transitions of any kind.

## Data
Add to `prospects`:
- `stage` (enum: `discovery`, `screening`, `qualification`, `cultivation`, `ask`, `decision`, `stewardship`), default `discovery`.

New table `stage_changes`:
- `id`, `prospect_id` → prospects
- `from_stage`, `to_stage`
- `changed_by` (uuid → auth.users)
- `note` (text, nullable)
- `created_at`

## UI
- `/(dashboard)/pipeline` — seven-column board, drag or button to request a move, confirm dialog, then persist + log.
- Prospect detail shows its stage-change history.

## Guardrails
- **No auto-advance.** Every transition is human-confirmed. There is no code path that changes `stage` without a confirmed user action.
- Log every change to `stage_changes` with `changed_by`.

## Definition of done
- [ ] Seven-column board renders live prospects by stage.
- [ ] Moving a card requires explicit confirmation before it persists.
- [ ] Every stage change is written to `stage_changes` with the acting user.
- [ ] No code path advances stage automatically.
