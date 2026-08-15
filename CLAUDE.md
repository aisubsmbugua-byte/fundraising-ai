# CLAUDE.md — build context for this repo

You are building **Fundraising AI**, an AI-assisted advancement platform for nonprofits. Read this file at the start of every session.

## What we're building

A web app that helps a small nonprofit team identify, qualify, and steward funding opportunities across six channels, with AI doing the automatable work and a human owning every funder-facing decision.

## Hard rules (never violate)

1. **No auto-send.** Nothing goes to a funder without an explicit human click. Email sending (Slice 8) is always a one-click human action on a pre-drafted message.
2. **No auto-advance.** A prospect never changes pipeline stage without human approval. Stage transitions always pass through an approval gate.
3. **AI drafts and suggests; humans decide.** All AI output lands in a review state, never a "done" or "sent" state.
4. **No external CRM.** The CRM is custom and lives in our own Supabase tables.
5. **Server-only secrets stay server-only.** Anthropic key, service role key, Resend key are never imported into client components.

## The AI-driven end state

The system is meant to work as an AI-assisted advancement officer, not just a system of record. Fed by two knowledge bases — one about this nonprofit (mission, programs, outcomes, who it serves) and one about the funding landscape — AI is expected to: propose which funder types are a plausible match, continuously search multiple sources to discover candidate organizations, screen and prioritize them into a hit list, do deeper research on strong candidates, and draft everything from first outreach through full proposals.

This is compatible with the hard rules above, not an exception to them. AI does the searching, matching, researching, and drafting continuously and proactively; a human reviews and improves the AI's output at each meaningful checkpoint (channel-match suggestions, the hit list, screening tiers, drafts) rather than doing that legwork by hand. "AI doing the automatable work" means AI acts first and often — the human still owns every decision that matters, per rule 3.

Slices build toward this incrementally. Slices 1–3 are deliberately human-scaffolded (manual CRM, human-gated pipeline, human-authored screening rules) — that scaffolding doesn't get replaced, AI-suggested capability layers on top of it. Later slices add the knowledge bases (evidence library, Slice 6) and AI capability (drafting, Slice 5; AI-assisted discovery and matching, planned expansions of Slices 3–4) that this vision needs. Each relevant slice doc has a "Where this grows" note pointing at its planned AI extension.

## How we build

- **Vertical slices.** Each slice in `docs/slices/` is a thin end-to-end feature. Build one at a time, in order (0 → 8).
- **Live from day one.** The app is deployed on Vercel. Keep `main` deployable at all times.
- **Definition of done.** Every slice doc has one. Don't mark a slice complete until it's met and the app still builds and deploys.
- **Migrations are additive.** Each slice adds a numbered migration in `supabase/migrations/`. Never rewrite an applied migration.

## Stack

Next.js (App Router) · Supabase (Postgres/auth/storage) · Vercel · Anthropic API · Resend.

## Domain glossary

- **Channel** — one of six funder types. Drives how much AI automation applies.
- **Stage** — one of seven pipeline stages, each gated by human approval.
- **Three-tier classification** — screening output: Tier 1 (strong fit) / Tier 2 (possible) / Tier 3 (unlikely).
- **Evidence library** — verifiable outcomes + case studies with permission tags. This is the core differentiator; treat it as first-class data.
- **Relationship memory** — the full interaction history, including "no → yes" tracking. A "no" is data, not a dead end.
- **Knowledge base** — the nonprofit's own profile (mission, programs, outcomes, who it serves) plus general funding-landscape data. AI uses both to propose funder-type matches and to ground drafts in real evidence. The evidence library (Slice 6) is where the nonprofit-side half of this lives.

## When in doubt

Ask before adding anything that (a) sends something externally, (b) advances state automatically, or (c) puts a secret near the client. Those three are the whole ballgame.
