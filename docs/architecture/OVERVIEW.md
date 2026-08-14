# Architecture overview

## Shape

A single Next.js app (App Router) deployed on Vercel, backed by Supabase (Postgres + auth + storage). AI calls go through server routes to the Anthropic API. Email goes through Resend, human-triggered only.

```
Browser ──> Next.js (Vercel)
                │
                ├── Server Components / Route Handlers
                │        │
                │        ├── Supabase (Postgres, auth, storage)  [RLS enforced]
                │        ├── Anthropic API   (server-only key)   [drafting, parse assist]
                │        └── Resend          (server-only key)   [Slice 8, human-gated]
                │
                └── Client Components (no secrets, ever)
```

## Layering

- `app/` — routes. `(dashboard)` is the protected group; middleware guards it.
- `app/api/` — route handlers. All AI and email calls live here, never in client code.
- `lib/supabase/` — server and browser Supabase clients.
- `lib/ai/` — Anthropic wrappers (drafting, parse assist).
- `lib/scoring/` — screening rules engine (pure functions, testable).
- `components/` — UI.
- `supabase/migrations/` — additive, numbered SQL migrations, one set per slice.

## Data model (accumulates by slice)

- Slice 1: `prospects`
- Slice 2: `+ prospects.stage`, `stage_changes`
- Slice 3: `screening_rules`, `screening_results`
- Slice 4: `candidates`
- Slice 5: `drafts`
- Slice 6: `evidence`, `case_studies`
- Slice 7: `interactions`, `outcomes`
- Slice 8: `+ drafts.sent_at / sent_by / resend_id`

## The three invariants (enforced in code, not just UI)

1. **No auto-send.** The Resend call is reachable only from a confirmed-send handler that takes an approved draft id and a human session.
2. **No auto-advance.** `prospects.stage` is only written by a handler tied to a confirmed user action; every write also appends to `stage_changes`.
3. **Permission enforcement.** Evidence permission tags are checked server-side before any item is placed into an external-audience draft.

## Automation tiering by channel

The screening engine and drafting tone read `prospects.channel` and adjust:

- **Data-rich** (`foundation`, `regranting`): more automated discovery/screening, structured criteria-matching drafts.
- **Mixed** (`christian_business`, `denomination`): screening assists; drafts balance structure and relationship.
- **Relationship-led** (`daf`, `major_donor`): AI is support-only — memory, prep, reminders, warm draft assist. Humans lead.
