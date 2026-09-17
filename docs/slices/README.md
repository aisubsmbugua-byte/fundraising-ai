# Build slices

Each slice is a **vertical, end-to-end feature** that deploys live. Build in
order. Do not start a slice until the previous one is deployed and its Definition
of done is met.

Slices 1–3 are deliberately human-scaffolded — manual CRM, human-gated pipeline,
human-authored screening rules. Slices 4 onward progressively hand more of that
work to AI, proposing and researching rather than requiring a human to do it by
hand. See `CLAUDE.md`'s "The AI-driven end state" for the full vision and how it
stays inside the hard rules.

## These docs are plans first, descriptions second

**Audited 2026-09-17.** Every slice doc below was written before its slice was
built, and several describe tables and features that ended up different. Each now
carries an **"As built"** block stating what actually shipped and how it differs.

Where a slice doc and the code disagree, the code is right. For current state,
read `docs/architecture/OVERVIEW.md`, the migrations, and `docs/decisions/`.

## Status

Using the six states from ruling 0015. `released` means live for users;
`verified` is not claimed here, because no one has recorded observing these in
production since the audit.

| # | Slice | Status | Note |
|---|-------|--------|------|
| 0 | Live skeleton | released | |
| 1 | CRM spine | released | |
| 2 | Pipeline board | released | Six active stages; four legacy enum values remain unused |
| 3 | Screening & classification | released | Built as specified |
| 4 | Discovery intake | released | **Grew well past the doc** — live AI web search shipped, which the doc lists as out of scope |
| 5 | AI drafting | released | Narrower than planned: two draft kinds, and now gated on an approved strategy |
| 6 | Evidence library | released | Materially different: one table, not two; binary permissions, not four |
| 7 | Relationship memory | released | Partial: interactions exist, the outcomes model does not |
| 8 | Email send | **proposed** | **Not built.** No send route, action, or columns exist |

## Build 1 is a separate track, and it lands inside these slices

**Build 1** — the Research Agent qualification pipeline — is not a slice. It is a
parallel, additive AI capability being built in ten steps, tracked in
`docs/ledger/` rather than here.

Per ruling 0016 there is no cutover event: each Build 1 module is wired into the
live product as soon as a ruling establishes it is correct. Two have landed
already — `lib/discovery-handoff.ts` under ruling 0003, and `lib/availability.ts`
under ruling 0009. The rest are still dark.

So Build 1 **extends** these slices rather than replacing them. Slice 3's
human-authored rules engine is not going away; AI-assisted qualification layers
on top of it. See `docs/decisions/0003-two-tracks-and-build-1s-landing.md`.

## Every slice doc follows the same shape

- **Goal** — one sentence
- **Why now** — why it comes at this point in the sequence
- **Scope** — what's in
- **Out of scope** — what to explicitly not build yet
- **Data** — tables / columns this slice adds
- **UI** — screens/components
- **Guardrails** — the non-negotiables that apply here
- **Definition of done** — the checklist to call it complete
- **As built** — what actually shipped, and how it differs *(added 2026-09-17)*

| # | File | Slice |
|---|------|-------|
| 0 | `slice-00-live-skeleton.md` | Live skeleton |
| 1 | `slice-01-crm-spine.md` | CRM spine |
| 2 | `slice-02-pipeline-board.md` | Pipeline board |
| 3 | `slice-03-screening-classification.md` | Screening & classification |
| 4 | `slice-04-discovery-intake.md` | Discovery intake |
| 5 | `slice-05-ai-drafting.md` | AI drafting |
| 6 | `slice-06-evidence-library.md` | Evidence library |
| 7 | `slice-07-relationship-memory.md` | Relationship memory |
| 8 | `slice-08-email-send.md` | Email send (human-gated) |
