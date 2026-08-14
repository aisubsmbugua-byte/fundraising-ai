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

## When in doubt

Ask before adding anything that (a) sends something externally, (b) advances state automatically, or (c) puts a secret near the client. Those three are the whole ballgame.
