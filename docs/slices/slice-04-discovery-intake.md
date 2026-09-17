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
- ~~Live web scraping / crawling. Manual + CSV only for this slice.~~
  **No longer true — AI-driven live web search shipped.** See "As built" below.
  The boundary moved as the "Where this grows" note anticipated; the doc was
  simply never updated.
- Any automatic acceptance. Every candidate is human-accepted. **Still true.**

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

## Where this grows
This slice's manual/CSV intake is the human-gated foundation for the same review-queue pattern that a later, continuous multi-source AI discovery process will feed into (see `CLAUDE.md`'s "The AI-driven end state"). "No live scraping" is a Slice 4 boundary, not a permanent one — when automated discovery arrives, candidates still land in this same pending queue for human accept/dismiss.

**A specific search tactic to build in when that arrives:** if the nonprofit is a Christian organization and has individual churches (`church` channel) among its notable/current funders (`org_profile.notable_funders`), the AI discovery search should check whether those supporting churches belong to a broader denomination or network -- and if so, treat sibling churches in that same network as high-value candidates. An existing supporting relationship is a warm signal for the rest of that network, not just that one congregation.

## As built — verified 2026-09-17

**Status: released, and well past this plan.** The Data section above lists 13
columns; `candidates` has about 30.

### Live AI discovery search shipped

`/discovery/search` runs a real web search per channel and turns the results into
candidates (`(dashboard)/discovery/search/actions.ts`). The flow:

1. **Search** — Anthropic's web-search tool; capture every URL and title it
   actually visited.
2. **Extract** — a second call turns the prose into structured candidates, each
   required to cite a `source_index` pointing at one of those captured URLs.
3. **Attribute** — classify the source as the funder's own site or a third-party
   page; test the model-typed names against the captured title and URL.
4. **Dedupe** → **ProPublica 990 lookup** → **screen** (Slice 3's engine) →
   **insert**.

### The capture contract — the reason this is trustworthy

Added in migrations 0055 and 0056, and the important part of this slice now:

- `source_url` / `source_title` — the exact result the search returned. Never
  generated, never reconstructed.
- `source_domain`, `dedupe_key` — deduplication across candidates and prospects.
- `website_status` — `official_candidate` or `third_party_source`. **Provenance
  and officialness are never conflated:** a directory page *about* a funder is
  not the funder speaking about itself.
- `capture_status` — `captured` or `source_missing`. A candidate that cannot be
  traced to a real search result is kept for audit, hidden from the queue, and
  **can never become a prospect** (enforced in `acceptCandidate`).
- `asserted_fields` — which model-typed fields the captured source does *not*
  support. `null` means not evaluated; `[]` means evaluated and clean. The two
  are deliberately different values.

### Other drift

- **Four statuses, not three**: `pending`, `accepted`, `dismissed`, `saved`
  (0029). "Saved" is *not now, but don't lose it* — distinct from both pending
  and dismissed.
- Funder intelligence columns (0015): `location`, `funder_type`,
  `geographic_focus`, `typical_grant_size`, `focus_areas`.
- Follow-up columns (0031): `dismissed_reason`, `revisit_date`.
- Split naming (0055): `funder_name` (the legal organization) and
  `opportunity_name` (the programme) are separate from `name`.
- Routes: `/discovery` (queue, with To Review / Saved / Dismissed),
  `/discovery/search`, `/discovery/new`, `/discovery/import`.

### What held

**No auto-accept.** Every candidate still requires an explicit human click, and
accepting one creates a prospect at `discovery` plus a research run. Nothing
enters the pipeline on its own.
