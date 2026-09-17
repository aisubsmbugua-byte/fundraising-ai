# Architecture overview

**Verified against the codebase 2026-09-17.** The previous version of this file
described the system as of roughly migration 0038 and had drifted badly — it
listed 9 tables where there are ~28, omitted every directory added for the
Research Agent, and named an email provider that is not wired up. Where this
document and the code disagree, the code is right; report the drift rather than
working around it.

## Shape

A single Next.js app (App Router) on Vercel, backed by Supabase (Postgres, auth,
storage). AI calls go through server actions and route handlers to the Anthropic
API. **No outbound email to funders exists yet** — see "Email" below.

```
Browser ──> Next.js (Vercel)
                │
                ├── Server Components / Server Actions / Route Handlers
                │        │
                │        ├── Supabase (Postgres, auth, storage)  [RLS enforced]
                │        ├── Anthropic API   (server-only key)   [search, research, strategy, drafting]
                │        └── ProPublica 990  (public API)        [registry lookups]
                │
                └── Client Components (no secrets, ever)
```

## Layering

- `app/(dashboard)/` — the protected product; middleware guards it.
- `app/admin/` — superadmin only: organization management, and the Research
  Agent evaluation tool.
- `app/api/` — route handlers: run-status polling for strategy, research and
  discovery searches; the auto-discovery cron; health.
- `components/` — shared UI.
- `supabase/migrations/` — additive, numbered SQL. Never rewritten.

### `lib/`

| Path | Purpose |
|---|---|
| `lib/supabase/` | `server` / `client` / `admin` Postgres clients |
| `lib/ai/` | Anthropic wrappers: `funder-search`, `research-extract`, `research-verify`, `model-select`, `anthropic` |
| `lib/scoring/` | The Slice 3 screening rules engine (pure functions) |
| `lib/registry/` | ProPublica 990 lookups |
| `lib/tier2/` | Build 1 retrieval: `discovery`, `manifest`, `select`, `fetch`, `domain`, `identity-evidence` |
| `lib/research.ts` | Claim vocabulary, per-consumer field policy, run lifecycle |
| `lib/qualification.ts`, `lib/qualification-stages.ts` | Build 1 pursue/dismiss contract |
| `lib/availability.ts` | Build 1 availability ledger — *why* a fact is missing (five states) |
| `lib/legitimacy.ts` | Entity legitimacy checks |
| `lib/prospect-intelligence.ts` | `loadApprovedIntelligence` — the only research a strategy may read |
| `lib/discovery-handoff.ts` | Carries opportunity name + source URL from candidate to prospect |
| `lib/candidates.ts`, `lib/candidate-intake.ts`, `lib/discovery-search.ts` | Discovery intake and dedupe |
| `lib/prospects.ts`, `lib/prospect-workflow.ts` | Stage model and transitions |
| `lib/screening.ts`, `lib/evidence.ts`, `lib/drafts.ts`, `lib/strategy.ts`, `lib/interactions.ts`, `lib/contacts.ts`, `lib/organization.ts` | Feature data access |
| `lib/ui.ts` | Shared design tokens — use these, not one-off inline styles |

## Data model, by era

65 migrations. Grouped by what they were for:

| Range | What it added |
|---|---|
| 0001–0010 | CRM spine (`prospects`), pipeline (`stage_changes`), screening (`screening_rules`, `screening_results`), the org's own profile and document uploads |
| 0011–0022 | Discovery (`candidates`), channel matching, the combined research+strategy run (`deep_dive_runs`), drafting (`drafts`), discovery search runs, the revised stage model |
| 0023–0031 | `contacts` directory, `evidence_items`, `interactions`, follow-up and revisit fields |
| 0032–0034 | **Multi-tenancy.** `organizations`, `profiles`, `my_organization_id()`, RLS across every org-scoped table, storage scoping |
| 0035–0051 | **Research Agent.** `research_runs`, `research_claims`, `research_sources`, verification and approval tables, evidence ledger, coverage and retrieval diagnostics |
| 0052 | `deep_dive_runs` → `strategy_runs`; research and strategy formally separate |
| 0053–0062 | Entity resolution: EIN, legal name, aliases, predecessor EINs, operating identity, ranking cache. Candidate source capture (0055) and attestation (0056) |
| 0063–0065 | Faith affiliation, the qualification pipeline tables, the discovery handoff contract |

### Stage enum — a live wrinkle worth knowing

The `stage` type carries **ten** values; the product uses **six**.

Active: `discovery`, `outreach`, `proposal`, `decision`, `awarding`,
`stewardship` (`lib/prospects.ts` `STAGES`).

Defined but unused: `screening`, `qualification`, `cultivation`, `ask` — left in
place by migration 0022 because Postgres cannot drop an enum value without
recreating the type, and migrations here are additive-only. 0022 verified that
zero prospects occupied them before leaving them behind. `contact` was renamed to
`outreach` in 0027.

## Multi-tenancy

One Supabase project serves multiple nonprofits, isolated by RLS. Every
org-scoped table carries
`organization_id uuid references organizations(id) default my_organization_id()`
plus a policy scoped by it — the pattern is in `0033_multi_tenant_rls.sql`, and
`docs/decisions/0001-multi-tenancy.md` has the full reasoning and the known gaps.
**Nothing currently catches a new table that skips this.**

## The three invariants — all verified enforced, 2026-09-17

1. **No auto-send.** Nothing in the codebase sends email to a funder. There is no
   send route, no send action, and `drafts` has no `sent_at` / `sent_by` column.
   `approveDraft` in `prospects/[id]/draft-actions.ts` sets a status and nothing
   else. This is currently enforced by absence; when sending is built, it must be
   enforced by construction.
2. **No auto-advance.** `prospects.stage` is written only by `moveProspectStage`
   in `(dashboard)/pipeline/actions.ts`, called from an explicit form submission,
   which always appends an attributed row to `stage_changes`. RLS on
   `stage_changes` requires `changed_by = auth.uid()`.
3. **Evidence permission is checked server-side.** `runStrategy` in
   `prospects/[id]/strategy-actions.ts` filters `evidence_items` on
   `permission = 'approved'` **and** `verified_at is not null` before anything
   reaches a prompt, then filters the model's cited ids against that same pool —
   a model cannot cite its way to an unapproved item.

## External services

| Service | Key | Status |
|---|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only) | In use — database, auth, storage |
| Anthropic | `ANTHROPIC_API_KEY` (server-only) | In use — discovery search, research, strategy, drafting, channel match |
| ProPublica | none (public) | In use — 990 registry lookups |

### Email

There is no outbound email to funders. `RESEND_API_KEY` sits in `.env.example`
marked for Slice 8 and is referenced nowhere in the code. Team invitations go
through Supabase Auth's own `inviteUserByEmail`, not through an email provider we
operate. A comment in `lib/invite.ts` mentions Postmark historically; it is not
in use, and `CLAUDE.md`'s reference to Postmark is a leftover from an earlier
plan.

## Automation tiering by channel

The screening engine and drafting tone read `prospects.channel` and adjust:

- **Data-rich** (`foundation`, `regranting`) — more automated discovery and
  screening, structured criteria-matching drafts.
- **Mixed** (`christian_business`, `denomination`, `church`) — screening assists;
  drafts balance structure and relationship.
- **Relationship-led** (`daf`, `major_donor`) — AI is support-only: memory, prep,
  reminders, warm draft assist. Humans lead.
