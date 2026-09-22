# 0023 — A deck renders exactly what a human approved

**Build report for STATE item 66** (pitch deck v1, decision 0007 phase 3's
second half). Built 2026-09-22 in the build space. Migration **not** applied
(owner applies); code fails closed until it is, verified live.

## The invariant

A deck is rendered only from the exact outline text a human approved: the
model proposes the outline as a reviewable draft grounded in captured
evidence ids, and rendering is a deterministic parse with zero model
involvement.

## What changed

| Artifact | Change |
| --- | --- |
| `supabase/migrations/0072_deck_draft_kind.sql` | New. One statement: `alter type draft_kind add value if not exists 'deck';` — header carries 0071's deploy-order and transactional caveats. |
| `lib/deck-outline.ts` | New. The ONE outline format definition: `parseDeckOutline` (pure), `ensureOutlineHeader` (idempotent), `DECK_OUTLINE_HEADER` (the self-documentation every stored outline begins with, prepended in code). |
| `app/(dashboard)/prospects/[id]/draft-actions.ts` | `generateDeckOutline` added beside `generateProposalDraft`, mirroring it: 0072 enum probe before `beginRun` (fail closed, no tokens), approved strategy required, org profile, the verified+approved evidence pool handed over with ids, `ai_runs` operation `deck_draft` born before the model call, errors returned not thrown. Cited ids are parsed back out of the outline with the shared parser and validated against the pool; unknown ids are logged and kept in the text. |
| `lib/ai-runs.ts` | `deck_draft` added to `AI_RUN_OPERATIONS` (decision 0006 prices per operation). |
| `lib/drafts.ts` | `DraftKind` gains `"deck"`; `draftKindLabel` maps it to "Deck Outline". |
| `app/prospects/[id]/deck/[draftId]/page.tsx` | New deck view route. Approved-only; deterministic parse; read-only evidence lookup for footnote attributions; print stylesheet (one slide per page, screen-only chrome hidden, `@page landscape`); on-screen print-to-PDF note. |
| `app/(dashboard)/prospects/[id]/draft-panel.tsx` | "Draft Deck Outline" button beside "Draft Grant Proposal" (same approved-strategy gate, own error surface); an approved deck card links to the deck view. |
| `scripts/test-deck-outline.ts` | New standalone suite: parser vocabulary + edge cases, header contract, deck-route construction scans. |
| `scripts/test-ai-runs.ts` / `scripts/test-send-draft.ts` | Extended (below). |

Nothing under `lib/send-draft.ts`, `send-actions.ts`, or migrations
0001–0071 was touched (`git status` shows only the files above). No new
table. No external library — `package.json` unchanged.

## Where the route lives, and why

The item suggested `app/(dashboard)/prospects/[id]/deck/[draftId]/page.tsx`
"or the codebase's natural shape". The route is at
`app/prospects/[id]/deck/[draftId]/page.tsx` — same URL, outside the
`(dashboard)` route group — because `app/(dashboard)/layout.tsx:95-102`
wraps every child in the sidebar shell, which would render chrome onto the
screen view and print onto every PDF page. Auth is unaffected:
`middleware.ts:38-50` gates every path starting `/prospects`, and the page
re-checks the session itself (`redirect("/login")`) like the dashboard
layout does. Verified in `npx next build`: `/prospects/[id]/deck/[draftId]`
is its own route beside `/prospects/[id]`, 29 routes total (was 28).

## The outline format

Plain text a human edits in the existing draft editor with no external
instructions: `#` lines open slides, plain lines are bullets,
`> evidence: <id>` cites, `//` lines are notes. The explanatory header is
**prepended in code** (`ensureOutlineHeader` at the insert site,
`content: ensureOutlineHeader(content)`), never trusted to the model —
measured prompt-only compliance on this codebase is 52–80%
(`CLAUDE.md`, "Capture, don't retype"). Nothing a human wrote is silently
dropped: pre-title lines land on a leading untitled slide, a
non-citation `>` line stays a bullet, an unknown evidence id stays in the
text and renders as explicitly unresolved.

One deliberate difference from the proposal's citation handling: the
proposal captures cited ids in a second model-typed field
(`evidence_cited`); the deck's citations live IN the outline text, so
validation parses them back out with the same parser the renderer uses —
one copy of the fact, no second list that could disagree.

## Measurements (commands and denominators)

All run from the repo root 2026-09-22.

| Command | Before | After |
| --- | --- | --- |
| `npx tsx scripts/test-ai-runs.ts` (offline) | 46 passed, 0 failed | **50 passed, 0 failed** |
| `npx tsx scripts/test-send-draft.ts` (offline) | 108 passed, 0 failed | **123 passed, 0 failed** |
| `npx tsx scripts/test-deck-outline.ts` | (did not exist) | **32 passed, 0 failed** |
| `npx tsc --noEmit` | — | exit 0 |
| `npx next build` | 28 routes | compiles, **29 routes** |
| `npx tsx scripts/ledger-check.ts` | — | `ok protocol intact` (2 pre-existing warns on rulings 0005/0007) |

Every other offline suite re-run after the change, all passing:
test-availability 84, test-candidate-attestation 19, test-candidate-intake
16, test-citation-consistency 7, test-cron-gate 30, test-decision-contract
69, test-discovery-handoff 31, test-entity-scoring 71,
test-entity-validation 140, test-identity-predicate 28, test-ledger-check
111, test-legitimacy 78, test-prospect-outcomes 176, test-prospect-workflow
23, test-tier2-manifest 70, test-tier2-selection 43 — each `N passed, 0
failed` from its own output. test-research-concurrency and
test-tenant-isolation skip without env (DB-dependent; owner runs them).

New assertions:

- `test-ai-runs.ts` (+4): `deck_draft` is a distinct operation in
  `AI_RUN_OPERATIONS`; `generateDeckOutline`'s own birth row precedes its
  own model call; it finalizes on every path; the 0072 enum probe precedes
  `beginRun` and names the migration. The pre-existing closed-set scans
  also now cover the new code for free: the model-caller set is unchanged,
  and the written-operations-equal-declared-vocabulary check ranges over
  `deck_draft`.
- `test-send-draft.ts` (+15): the **kind-restriction assertion** —
  `evaluateSendReadiness({kind:"deck", status:"approved", ...})` refuses
  `not_email` before any other precondition (`lib/draft-send.ts:100` is the
  existing enforcement; asserted, not added) — plus a 3d section pinning
  `generateDeckOutline`'s construction (gates, probe order, permission
  gate, header-in-code, insert shape, no send-path token anywhere in its
  body) and the panel (deck button behind the approved-strategy gate; the
  deck-view link renders inside the isApproved branch only). The existing
  closed-set scan walks all of `app/`, so the new route is inside the
  "exactly one resend importer / one provider caller" proof.
- `test-deck-outline.ts` (32): parser vocabulary, nothing-dropped edge
  cases, determinism, header contract (begins/explains/invisible to
  parser/idempotent), and route scans: zero model calls and zero ledger
  writes at render, no external deck/PDF import, shared parser on both
  sides, approved gate before any slide markup, unapproved branch points
  back to review, kind checked in code (no enum filter that would error
  pre-migration), draft fetched by draft id AND prospect id, print rules
  with screen-only note, read-only evidence lookup, unresolved-id text.

## Live verification (pre-migration, against the running app)

- The prospect page renders "Draft Deck Outline" beside "Draft Grant
  Proposal" for a prospect with an approved strategy.
- Clicking it **fails closed without spending tokens**: the UI shows "Deck
  drafting is not available on this database yet (is migration 0072
  applied?): invalid input value…", and
  `select count(*) from ai_runs where operation = 'deck_draft'` returned
  **0** afterwards — the probe refused before birth, so no run row and no
  model call (item 63's probe pattern, observed working).
- The deck URL with an approved **intro_email** draft's real id returns
  404 — a non-deck draft cannot render as a deck.

## Not checked

- **The rendered slide page and its print output were not seen live.** A
  deck draft cannot exist until 0072 is applied (that is the fail-closed
  design), so the slide markup, the one-slide-per-page print behavior, and
  the footnote attributions are verified by `tsc`, `next build`, and the
  32 parser/route assertions — not by eyes on a real deck. Worth a smoke
  test after the owner applies 0072: generate, approve, open the deck
  view, print to PDF.
- DB-dependent sections of test-ai-runs/test-send-draft (owner-run, per
  items 48/49's precedent). Nothing in this item changes DB behavior
  beyond the enum value.
- Model output quality of the outline (slide count, citation habits)
  — unmeasurable until the migration lands.

## Escalations (noticed, not changed)

1. **Deck citations are validated and logged, not stored in a column** —
   same shape item 63 escalated for the proposal (`drafts` has no
   `evidence_item_ids`; adding one was not authorized). Materially weaker
   here: the deck's ids live in the approved content itself and the view
   resolves them at render, so the approved artifact does carry its
   citations. But nothing machine-queryable records which evidence a deck
   used.
2. **An approved outline is editable-by-approval-reset only in the UI, not
   in the schema**: `updateDraft` (`draft-actions.ts`) has no status guard
   — the UI disables editing an approved draft, but the action would
   accept an update to one. Pre-existing for every draft kind, now
   load-bearing for "what was approved is what appears", since the deck
   renders `draft.content` at view time. Pre-existing behavior, out of
   item 66's scope; flagging because the deck raises its stakes.
3. **`deleteDraft` deletes approved decks** — the deck URL then 404s.
   Pre-existing for all kinds, unchanged.
4. A second `app/prospects` tree now exists beside
   `app/(dashboard)/prospects` (same URL namespace, no layout). Deliberate
   (print), documented in the route header — but a future route added to
   the wrong tree would silently lack the sidebar. Nothing enforces the
   split.

## For the owner: the migration to apply

Apply **before** deploying this code (safe in that order; in the other
order the app fails closed as verified above). Do not append a statement
that writes `kind = 'deck'` to the same SQL-editor run.

```sql
alter type draft_kind add value if not exists 'deck';
```
