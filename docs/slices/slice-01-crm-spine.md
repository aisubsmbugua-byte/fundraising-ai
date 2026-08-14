# Slice 1 — CRM spine

## Goal
A custom prospect record: create, view, edit, list. This is the backbone every later slice hangs off.

## Why now
No external CRM. Everything — pipeline, screening, drafting, memory — attaches to a prospect record, so it must exist first.

## Scope
- `prospects` table.
- List view of all prospects.
- Detail view of one prospect.
- Create + edit forms.
- Basic search/filter by name and channel.

## Out of scope
- Pipeline stage logic (Slice 2).
- Screening/scoring (Slice 3).
- Interaction history (Slice 7).

## Data
`prospects`:
- `id` (uuid, pk)
- `name` (text, required)
- `channel` (enum: `foundation`, `regranting`, `christian_business`, `denomination`, `daf`, `major_donor`)
- `organization` (text, nullable)
- `contact_name` (text, nullable)
- `contact_email` (text, nullable)
- `website` (text, nullable)
- `notes` (text, nullable)
- `owner_id` (uuid → auth.users)
- `created_at`, `updated_at` (timestamptz)

Add RLS: a user can read/write rows they own (single-tenant for now is fine, but keep the policy).

## UI
- `/(dashboard)/prospects` — table with name, channel, organization, contact.
- `/(dashboard)/prospects/[id]` — detail + edit.
- `/(dashboard)/prospects/new` — create.

## Guardrails
- Channel is a fixed enum matching the six channels. Don't let it be free text.

## Definition of done
- [ ] Migration applied; `prospects` table exists with RLS.
- [ ] Can create, view, edit, and list prospects on the live app.
- [ ] Channel is constrained to the six values.
- [ ] Search by name and filter by channel work.
