# Build slices

Each slice is a **vertical, end-to-end feature** that deploys live. Build in order. Do not start a slice until the previous one is deployed and its Definition of done is met.

Slices 1–3 are deliberately human-scaffolded — manual CRM, human-gated pipeline, human-authored screening rules. Slices 4 onward progressively hand more of that work to AI, proposing and researching rather than requiring a human to do it by hand. See `CLAUDE.md`'s "The AI-driven end state" for the full vision and how it stays inside the hard rules; relevant slice docs below have a "Where this grows" note pointing at their planned AI extension.

Every slice doc follows the same shape:

- **Goal** — one sentence
- **Why now** — why it comes at this point in the sequence
- **Scope** — what's in
- **Out of scope** — what to explicitly not build yet
- **Data** — tables / columns this slice adds
- **UI** — screens/components
- **Guardrails** — the non-negotiables that apply here
- **Definition of done** — the checklist to call it complete

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
