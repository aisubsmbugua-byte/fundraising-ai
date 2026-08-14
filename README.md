# Fundraising AI

An AI-assisted advancement platform for nonprofits. It identifies, qualifies, and helps steward funding opportunities across six channels while keeping a human at every funder-facing decision.

**Guiding principle:** automate the automatable, make the non-automatable easy, keep humans at the most critical touchpoints only.

## Non-negotiables

- **No auto-send.** The system never sends a message to a funder on its own.
- **No auto-advance.** A prospect never moves to the next pipeline stage without human approval.
- Humans own all funder-facing decisions and physical touchpoints.
- AI drafts, scores, summarizes, and remembers. Humans decide.

## The six funding channels

1. Foundations & family trusts *(data-rich → high automation)*
2. Regranting ministries *(data-rich → high automation)*
3. Christian businesses & marketplace giving *(mixed)*
4. Denominations & network funds *(mixed)*
5. Donor-advised funds (DAFs) *(relationship-led → support only)*
6. Major donors & individuals *(relationship-led → support only)*

AI automation is **tiered by channel**: heavy in data-rich channels (discovery, screening, drafting), support-only in relationship-led channels (memory, prep, reminders).

## The seven-stage pipeline

Every stage has a **human approval gate**.

1. **Discovery** — surface candidate funders from public sources
2. **Screening** — apply eligibility/fit rules, three-tier classification
3. **Qualification** — human confirms fit; enrich the record
4. **Cultivation** — relationship-building touchpoints
5. **Ask** — proposal / request submitted
6. **Decision** — yes / no / defer captured
7. **Stewardship** — reporting, thanks, renewal setup

A "no today" is captured as institutional memory — it can become a "yes next year" or a referral. The system is a **relationship memory**, not just a funnel.

## The seven functional modules

1. **Discovery** — public-source ingestion of candidate funders
2. **Screening & classification** — rules engine + three-tier scoring
3. **CRM** — custom prospect/relationship records (no external CRM)
4. **Pipeline** — seven-stage board with approval gates
5. **Drafting** — AI-generated proposals, emails, reports (never auto-sent)
6. **Evidence library** — verifiable outcomes / case studies with permission tagging
7. **Relationship memory** — history, interactions, "no → yes" tracking

## Tech stack

- **Next.js** (App Router) — web app + API routes
- **Supabase** — Postgres, auth, storage
- **Vercel** — hosting (deploy live from slice 0)
- **Anthropic API** — drafting, extraction, scoring assist
- **Resend** — transactional email (human-triggered only)

## Build slices

The build is organized as **vertical slices** — each one ships a thin end-to-end feature that deploys live to Vercel. See [`docs/slices/`](docs/slices/) for the full spec of each. Build them in order:

| # | Slice | Ships |
|---|-------|-------|
| 0 | Live skeleton | Deployed app + Supabase + auth on Vercel |
| 1 | CRM spine | Prospect records, manual create/edit |
| 2 | Pipeline board | Seven-stage board with approval-gated moves |
| 3 | Screening & classification | Rules engine + three-tier scoring |
| 4 | Discovery intake | Manual/CSV import → review queue |
| 5 | AI drafting | Proposal/email drafts (review-only, no send) |
| 6 | Evidence library | Outcomes + case studies with permission tags |
| 7 | Relationship memory | Interaction log + "no → yes" tracking |
| 8 | Email send (human-gated) | Resend integration, one-click human send |

## Getting started

See [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) for local setup and the Vercel + Supabase deploy path.
