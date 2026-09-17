# 0003 — Two tracks, and where Build 1 lands

**Date:** 2026-09-16
**Status:** The relationship between the tracks is settled. **Build 1's landing is not decided** — see "What is not decided."

## Why this exists

The decision space asked how Build 1's ten steps (ruling 0005) relate to Slices
0–8, and found that nothing answers it. [0002](0002-research-agent.md) — 530
lines, the settled Research Agent design — does not contain the word "slice"
once. `docs/slices/README.md` does not mention Build 1. Two roadmaps have run in
parallel for three weeks without a written word about how they compose.

## What each track is

**Slices 0–8 are the live product.** All nine are built. Slice 3's screening
engine exists as specified — `screening_rules`, `lib/scoring/`,
`/(dashboard)/settings/screening` — and the live intake path calls it
(`screenProspect` in `discovery/actions.ts`). This is the human-scaffolded
system CLAUDE.md describes: manual CRM, human-gated pipeline, human-authored
rules.

**Build 1 is a parallel, additive AI capability that ships dark.** 0002 is
explicit: "no nav entry, no button any ordinary tenant user sees or can
trigger," reachable only through the superadmin `/admin/research` eval tool. It
does not change the live Strategy workflow. Its ten steps build a second,
evidence-first qualification pipeline — `lib/qualification.ts`,
`lib/availability.ts`, `lib/registry/`, `lib/tier2/` — none of which the live
product reads.

So there are currently **two screening systems**: one live and human-authored,
one dark and evidence-backed. That is deliberate, not an accident, and CLAUDE.md
already settles the question of what happens to the first: *"that scaffolding
doesn't get replaced, AI-suggested capability layers on top of it."* Layer, not
replace.

## The slice docs are stale, and must not be read as current state

Verified 2026-09-16:

- **Slice 4 lists live web search as out of scope** — "Live web scraping /
  crawling. Manual + CSV only for this slice." It shipped anyway.
  `app/(dashboard)/discovery/search/actions.ts` is a live dashboard route doing
  AI-driven discovery, with the capture contract and attestation behind it
  (migrations `0055_candidate_source_capture.sql`,
  `0056_candidate_attestation.sql`). The slice's own "Where this grows" note
  anticipated this — "a Slice 4 boundary, not a permanent one" — but the
  boundary moved and the doc was never updated.
- **Slice 4's `candidates` spec is short by most of its real columns**, and its
  `status` enum reads `pending | accepted | dismissed` while
  `lib/candidates.ts:1` carries a fourth, `saved`.
- **`architecture/OVERVIEW.md` stops at Slice 8's data model.** There are 65
  migrations. It also names Resend for email while CLAUDE.md names Postmark;
  `lib/invite.ts` uses Resend.

None of these are large on their own. Together they mean the roadmap describes a
system that has not existed for some time, which is the failure mode a roadmap
has: it is read as a plan and it is also read as a description, and it silently
stops being the second one.

## The risk worth naming

**Build 1 is 4 steps into 10 and has no defined landing.** 0002 says the live
workflow keeps its own research call "unchanged, indefinitely, until (if ever) a
later build migrates it." *If ever* is in the settled design document. No slice
covers wiring the qualification pipeline into anything a user touches, and no
ruling authorizes it.

This is ruling 0010 one level up. 0010 says a *step* is done when its invariant
holds in the running product — written because Step 4 shipped a module with no
callers. Build 1 is that shape at the scale of the whole build: ten steps of
work that by design no user reaches. The difference is that Build 1's darkness
is intentional and Step 4's was not, so 0010 does not condemn it. But the
question 0010 asks does apply, and right now it has no answer: *what has to be
true for this to become live, and which artifact says so?*

The cost of leaving it unanswered compounds. Every step adds capability that
cannot be validated against real user behaviour, and the eventual landing gets
larger and riskier the longer it waits — while the live screening path keeps
accruing its own behaviour that the landing will have to reconcile with.

## What is not decided

1. **When Build 1 lands.** After Step 8? Step 10? Incrementally, per step?
2. **Through which artifact.** A new slice (Slice 9), an extension of Slices 3
   and 4, or a ruling that defines the cutover.
3. **What "layer, not replace" means mechanically** where the two screening
   systems disagree — a Slice 3 rule says Tier 2 and the qualification pipeline
   says dismiss. Both are human-gated, so neither auto-wins, but a user seeing
   two contradictory verdicts with no stated precedence is a new interface
   problem, not a solved one.

These are the next strategy conversation, not something to settle by inference
here. Item 8 in `STATE.md` carries them.

## Immediate consequence

Until the slice docs are refreshed, `docs/slices/` is a statement of intent and
not a description of the system. Read the code, the migrations and
`docs/decisions/` for current state. Refreshing them is decision-space work now
(`ROLE-decision.md`), and it waits on the landing question, because rewriting
Slices 3 and 4 before knowing whether Build 1 extends or supersedes them would
be writing the same doc twice.
