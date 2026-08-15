# Slice 5 — AI drafting

## Goal
Generate proposal, email, and report drafts for a prospect using the Anthropic API — always landing in a review state, never sent.

## Why now
Drafting is where AI creates the most leverage. It needs a prospect (CRM), a fit rationale (screening), and it will pull from the evidence library once that exists (Slice 6) — build the draft surface now, wire evidence in at Slice 6.

## Scope
- A "Draft" action on a prospect with a type selector: intro email · proposal · thank-you · report.
- Server route calls the Anthropic API with prospect context (name, channel, tier, breakdown, notes).
- Draft is saved in a `drafts` table with status `draft`.
- Draft editor: view, edit, regenerate, save. Explicit **no send button in this slice** — sending is Slice 8.
- Channel-aware tone: relationship-led channels (DAF, major donor) get warmer, support-only framing; data-rich channels get structured, criteria-matching framing.

## Out of scope
- Sending anything (Slice 8).
- Auto-drafting on stage change (a human always initiates a draft).

## Data
`drafts`:
- `id`, `prospect_id` → prospects
- `kind` (enum: `intro_email`, `proposal`, `thank_you`, `report`)
- `content` (text)
- `model` (text), `status` (enum: `draft`, `approved`) default `draft`
- `created_by` (uuid), `created_at`, `updated_at`

## UI
- Prospect detail — "Draft" menu; opens editor.
- `/(dashboard)/prospects/[id]/drafts/[draftId]` — editor with regenerate + save.

## Guardrails
- **No send.** There is no send path in this slice. Drafts are internal artifacts only.
- All AI calls are server-side; the Anthropic key never touches the client.
- Draft status can be `draft` or `approved` — approval is a human action and still does not send.

## Definition of done
- [ ] Can generate a draft of each kind for a prospect via the Anthropic API.
- [ ] Drafts are editable, regenerable, and saved.
- [ ] Tone adapts to the prospect's channel.
- [ ] No send capability exists yet; the Anthropic key is server-only.

## Where this grows
Today's drafting is prompted by a human per-prospect. The end-state vision (see `CLAUDE.md`) has AI drafting proactively as part of a continuous discovery-to-outreach flow — drafts still land in this same review state either way; only what triggers drafting changes, never whether a human approves before anything sends.
