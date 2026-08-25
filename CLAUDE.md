# CLAUDE.md — build context for this repo

You are building **Fundraising AI**, an AI-assisted advancement platform for nonprofits. Read this file at the start of every session.

## What we're building

A web app that helps a small nonprofit team identify, qualify, and steward funding opportunities across seven channels, with AI doing the automatable work and a human owning every funder-facing decision.

## Hard rules (never violate)

1. **No auto-send.** Nothing goes to a funder without an explicit human click. Email sending (Slice 8) is always a one-click human action on a pre-drafted message.
2. **No auto-advance.** A prospect never changes pipeline stage without human approval. Stage transitions always pass through an approval gate.
3. **AI drafts and suggests; humans decide.** All AI output lands in a review state, never a "done" or "sent" state.
4. **No external CRM.** The CRM is custom and lives in our own Supabase tables.
5. **Server-only secrets stay server-only.** Anthropic key, service role key, Postmark key are never imported into client components.
6. **Every org-scoped table is tenant-isolated.** A new table holding any org's data needs `organization_id uuid references organizations(id) default my_organization_id()` and an RLS policy scoped by it, following the pattern in `supabase/migrations/0033_multi_tenant_rls.sql` — see `docs/decisions/0001-multi-tenancy.md` before touching anything in this area. Nothing currently catches a table that skips this.

## The AI-driven end state

The system is meant to work as an AI-assisted advancement officer, not just a system of record. Fed by two knowledge bases — one about this nonprofit (mission, programs, outcomes, who it serves) and one about the funding landscape — AI is expected to: propose which funder types are a plausible match, continuously search multiple sources to discover candidate organizations, screen and prioritize them into a hit list, do deeper research on strong candidates, and draft everything from first outreach through full proposals.

This is compatible with the hard rules above, not an exception to them. AI does the searching, matching, researching, and drafting continuously and proactively; a human reviews and improves the AI's output at each meaningful checkpoint (channel-match suggestions, the hit list, screening tiers, drafts) rather than doing that legwork by hand. "AI doing the automatable work" means AI acts first and often — the human still owns every decision that matters, per rule 3.

Slices build toward this incrementally. Slices 1–3 are deliberately human-scaffolded (manual CRM, human-gated pipeline, human-authored screening rules) — that scaffolding doesn't get replaced, AI-suggested capability layers on top of it. Later slices add the knowledge bases (evidence library, Slice 6) and AI capability (drafting, Slice 5; AI-assisted discovery and matching, planned expansions of Slices 3–4) that this vision needs. Each relevant slice doc has a "Where this grows" note pointing at its planned AI extension.

## The advancement workflow (per prospect, once accepted)

Once a candidate is accepted into the pipeline, the intended flow is a sequence of AI-prepares / human-approves handoffs, not a single draft-then-send step:

1. Accepting a candidate automatically triggers a deep-dive: AI researches the specific funder and proposes a **strategy** (outreach approach, proposal/ask positioning, rationale). This research runs without a separate human trigger — accepting a candidate is a commitment to do the work of pursuing it — but its output is a proposal, not a decision.
2. A human approves (or edits) the strategy. Nothing downstream happens without this.
3. AI drafts outreach content (intro email, or call-prep notes) based on the approved strategy.
4. A human approves the content. If it's an email, the system executes the send as the direct, immediate result of that approval click — there is no separate autonomous send step, ever. If it's a call, the human makes the call using the AI-prepped notes.
5. AI drafts the proposal/grant/deck/ask.
6. A human approves. If email is the right vehicle, the system sends on approval, same as step 4; otherwise AI preps materials for a human-led meeting.
7. Stewardship/CRM follow-through (reporting, renewal, relationship memory) is a later slice, not yet designed in detail.

"Strategy" is a new artifact type this workflow introduces — distinct from a draft (Slice 5's `drafts` table). It's the AI's proposed plan for a prospect: reviewed and approved before any content gets drafted from it, not skipped past.

Since the deep-dive involves real web search and takes several seconds, the UI shows genuine progressive status (what step is running right now), not a static spinner — sourced from the actual run's state, not a simulated animation.

## How we build

- **Vertical slices.** Each slice in `docs/slices/` is a thin end-to-end feature. Build one at a time, in order (0 → 8).
- **Live from day one.** The app is deployed on Vercel. Keep `main` deployable at all times.
- **Definition of done.** Every slice doc has one. Don't mark a slice complete until it's met and the app still builds and deploys.
- **Migrations are additive.** Each slice adds a numbered migration in `supabase/migrations/`. Never rewrite an applied migration.
- **The app is multi-tenant.** One shared Supabase project serves multiple nonprofit organizations, isolated by RLS — see hard rule 6 and `docs/decisions/0001-multi-tenancy.md` for the full pattern and its known gaps before touching `organizations`, `profiles`, or adding any new org-scoped table.
- **Basic design principles apply even before a dedicated design pass.** We're not doing visual design work yet, but every page should still be internally consistent: same spacing scale, same colors, inputs actually aligned to their container (this means `box-sizing: border-box` on every field — without it, padding pushes elements past `width: 100%` and breaks the grid). Use the shared tokens in `lib/ui.ts` (`fieldStyle`, `labelStyle`, `buttonPrimary`, `buttonSecondary`, `buttonDanger`, `sectionStyle`, `cardStyle`, `spacing`, `colors`) instead of one-off inline styles, so pages don't visually drift from each other as functionality gets added.

## Stack

Next.js (App Router) · Supabase (Postgres/auth/storage) · Vercel · Anthropic API · Postmark.

## Domain glossary

- **Channel** — one of seven funder types (added Individual Church, distinct from Denomination & Network Fund, since many churches are standalone or not meaningfully denomination-affiliated). Drives how much AI automation applies.
- **Stage** — one of six pipeline stages (Discovery, Outreach, Proposal, Decision, Awarding, Stewardship), each gated by human approval. Stewardship covers everything after Awarding: reporting, renewal, relationship memory.
- **Three-tier classification** — screening output: Tier 1 (strong fit) / Tier 2 (possible) / Tier 3 (unlikely).
- **Evidence library** — verifiable outcomes + case studies with permission tags. This is the core differentiator; treat it as first-class data.
- **Relationship memory** — the full interaction history, including "no → yes" tracking. A "no" is data, not a dead end.
- **Knowledge base** — the nonprofit's own profile (mission, programs, outcomes, who it serves) plus general funding-landscape data. AI uses both to propose funder-type matches and to ground drafts in real evidence. The evidence library (Slice 6) is where the nonprofit-side half of this lives.
- **Strategy** — the AI's proposed plan for pursuing a specific accepted prospect (outreach approach, ask positioning, rationale), produced by an automatic deep-dive on acceptance. Reviewed and approved by a human before any content is drafted from it — see "The advancement workflow."

## When in doubt

Ask before adding anything that (a) sends something externally, (b) advances state automatically, or (c) puts a secret near the client. Those three are the whole ballgame.
