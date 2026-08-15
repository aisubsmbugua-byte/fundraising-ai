# Slice 6 — Evidence library

## Goal
A library of verifiable outcomes and case studies, each with a permission tag, that drafting can cite. This is the organization's core differentiator — treat it as first-class data.

## Why now
Verifiable outcomes are what make a proposal credible. The draft surface (Slice 5) exists; now give it real, source-linked, permission-tagged evidence to pull from.

## Scope
- `evidence` records: a claim/outcome, its source link, a metric (optional), and a **permission tag**.
- Permission tags govern where an item may be used: `public`, `partners_only`, `internal`, `do_not_share`.
- Case studies: longer narrative items, also permission-tagged.
- Evidence picker inside the draft editor — a human selects which items to include; only items whose permission tag allows the draft's audience are selectable.
- Drafting (Slice 5) is updated to accept selected evidence and weave it in, with source links preserved.

## Out of scope
- Auto-selecting evidence. A human chooses what to include; AI may *suggest* but not decide.

## Data
`evidence`:
- `id`, `title`, `claim` (text), `metric` (text, nullable), `source_url` (text)
- `permission` (enum: `public`, `partners_only`, `internal`, `do_not_share`)
- `tags` (text[]), `created_by`, `created_at`

`case_studies`:
- `id`, `title`, `body` (text), `source_url` (nullable)
- `permission` (same enum), `tags` (text[]), `created_at`

## UI
- `/(dashboard)/evidence` — manage evidence + case studies, with permission tag on each.
- In the draft editor — evidence picker filtered by permission vs. draft audience.

## Guardrails
- **Permission tags are enforced.** A `do_not_share` or `internal` item can never be inserted into an external-audience draft. Enforce in code, not just UI.
- Every evidence item keeps its `source_url` — no unsourced claims in drafts.

## Definition of done
- [ ] Evidence and case studies are manageable, each permission-tagged and source-linked.
- [ ] The draft editor's evidence picker respects permission tags in code.
- [ ] Selected evidence appears in generated drafts with sources preserved.
- [ ] No unsourced or over-permissioned evidence can reach an external draft.

## Where this grows
This library doubles as the nonprofit-side knowledge base referenced in `CLAUDE.md`'s "The AI-driven end state" — the same mission/outcomes data that grounds a draft's claims is what AI will use to judge which funder types are a plausible match in the first place. Building it as first-class, source-linked, permission-tagged data now is what makes that matching trustworthy later.
