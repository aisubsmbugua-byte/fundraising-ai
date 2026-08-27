# 0002 — Research Agent (Build 1)

**Date:** 2026-08-27
**Status:** Implemented, migration `0035_research_agent.sql` sent to the user to apply. Dark: no UI, superadmin-only, not yet evaluated.

## Why this exists

Copy of the reasoning that would otherwise only live in a Claude Code plan-mode
file (`.claude/plans/`) — not part of this repo, overwritten the next time any
session enters plan mode. Same rationale as [0001](0001-multi-tenancy.md). If
you're about to touch `research_runs`, `research_claims`,
`research_expected_facts`, `research_eval_reviews`, or anything in
`research-actions.ts`, read this first.

## The problem

The Agentic Advancement Department brief proposes splitting the app's combined
"research + strategy" AI call (`runDeepDive` in `deep-dive-actions.ts`) into
separate, reusable agents, built and evaluated one at a time — Research first.
The brief's own gate: inspect the existing architecture, propose the smallest
additive plan for Build 1 only, stop for review before implementing. This
plan went through two rounds of external review (relayed from ChatGPT) before
being approved; this doc is the settled design, not the first draft.

**What Build 1 actually is:** a new, parallel, additive Research capability —
schema plus a superadmin/evaluation-only server action — that does **not**
change the live Strategy workflow's behavior. It ships dark: no nav entry, no
button any ordinary tenant user sees or can trigger.

## Decisions made, and why

- **A parallel path, not a replacement.** `runDeepDive` still does its own
  research call, unchanged, indefinitely, until (if ever) a later build
  migrates it. The only file the live workflow shares with Build 1 is the
  web-search step itself, extracted into `lib/ai/funder-search.ts`
  (`searchFunderWeb`) — a pure, behavior-preserving refactor of what
  `deep-dive-actions.ts` already did inline (same prompt, same model, same
  tool config, same timeout). "Zero behavioral changes to the live workflow"
  was the actual promise here, not "zero modified files" — the two are
  different, and the first round of review conflated them.
- **`claim_key`, not `category`, is the real comparison key.** `category` is
  free-text grouping/display only. Joining expected facts to claims by
  `category` breaks the moment a category holds more than one fact.
  `claim_key` is a stable, structured identifier
  (`funding.typical_grant_size`, `application.deadline`, `identity.ein` —
  full list in `lib/research.ts`'s `RESEARCH_CLAIM_KEYS`) enforced at the
  strongest available layer: the extraction tool's own input schema declares
  it as a fixed enum, so the model structurally cannot emit a key outside the
  list — not just a shared-constant convention that could drift between the
  extraction prompt and wherever expected facts get hand-authored.
- **No `'recommendation'` claim type, at the type level.** `claim_type` is
  `'fact' | 'hypothesis'` only, in the Postgres enum and in
  `ResearchClaimType`. Recommendation-type content is categorically
  Strategy's job — this boundary can't be blurred by a future call site
  passing the wrong string, because the value doesn't exist to pass.
- **Version allocation: read-then-insert, retry-on-conflict, not a DB
  primitive.** `version` is computed as `select coalesce(max(version), 0) + 1`
  in the same round-trip as the insert; `unique(prospect_id, version)` is the
  actual backstop; the calling code (`createResearchRun` in
  `research-actions.ts`) catches Postgres `23505` (unique_violation) and
  retries, up to 5 attempts, rather than surfacing a spurious error to a
  request that did nothing wrong. No advisory lock, no sequence — matches
  this codebase's standing convention of coordinating in server-action code,
  not the database, with one deliberate exception below.
- **Cross-table org integrity: the first trigger in this codebase.**
  `organization_id default my_organization_id()` on each table independently
  doesn't stop a `research_claims` row's `organization_id` from silently
  diverging from its parent `research_runs.organization_id` — the same class
  of gap [0001](0001-multi-tenancy.md) flagged and accepted for
  already-live tables. Repeating that gap into brand-new tables, when it's
  cheap to close before any data exists, wasn't justified the way accepting
  it on old tables was. `enforce_research_run_org_match()` (a `plpgsql`
  function) runs as a `before insert` trigger on `research_claims` and
  `research_eval_reviews`, rejecting any insert whose `organization_id`
  doesn't match its parent run's. `research_expected_facts` doesn't need it —
  it isn't a child of `research_runs`, it stands alone per prospect. This is
  a deliberately scoped, justified exception to "no triggers" — not a new
  habit; the version-allocation logic above stays in app code specifically
  because a trigger wasn't needed there.
- **Atomicity without a transaction: write-ordering, not a Postgres
  function.** Claim rows are inserted first, while `status` is still
  `'extracting'`; the update to `'ready'` is the *last* write. Every consumer
  is required to gate on `status = 'ready'` before trusting any claims — so
  if the claims insert fails partway, the run never reaches `'ready'` (it
  lands in `'error'` from the outer catch instead), and a correctly-gating
  reader never observes a partial set. Chosen deliberately over introducing a
  second new database-level primitive alongside the trigger above. If
  stricter guarantees are ever needed, a `plpgsql` function wrapping both
  writes in one transaction is a clean, isolated upgrade — not needed here.
- **Claim absence on a `'ready'` run is the explicit "not found" signal.**
  The extraction tool doesn't require every `claim_key` to be present — it
  returns only what it actually found. This is unambiguous from an `'error'`
  run, which never completed and produced zero claims for an unrelated
  reason. Documented explicitly because it's easy to get backwards.
- **Reproducibility fields exist because the live web moves and claim rows
  don't.** `prompt_version`, `extraction_schema_version`, `code_version`
  (best-effort, `process.env.VERCEL_GIT_COMMIT_SHA`), `input_tokens`,
  `output_tokens`, `cost_usd`, `latency_ms` on `research_runs` — added so "did
  research quality improve between v1 and v3" is answerable later without
  needing to remember what the prompt or model even was at the time.
  `cost_usd` uses hardcoded approximate per-token pricing constants in
  `research-actions.ts` (`COST_PER_INPUT_TOKEN_USD` /
  `COST_PER_OUTPUT_TOKEN_USD`) — good enough to compare runs to each other,
  not read from a live pricing source. Re-check against current Anthropic
  pricing before trusting the dollar figure for anything else.
- **Dark by construction, not by omission.** `runResearch`/`startResearch`/
  `retryResearch` are gated by `requireSuperadmin()` (`lib/auth.ts`, extracted
  from `app/admin/organizations/actions.ts` so both call sites share one
  implementation). This is evaluation infrastructure, not a feature being
  soft-launched to real users — the authorization boundary says so
  structurally, not just by the absence of a nav entry.
- **Untrusted external content.** Web-search findings are text pulled from
  the open internet and fed into the extraction prompt — a compromised or
  adversarial page could contain text aimed at manipulating the extraction (a
  form of indirect prompt injection). The extraction prompt explicitly
  instructs the model to treat findings as untrusted content to extract facts
  *from*, never as instructions to follow. Every claim also defaults to
  `verification_status = 'unverified'` regardless of the model's own
  confidence — nothing from this table is ever trusted downstream without a
  human confirming it. This is a known, general risk for any web-search-
  backed agent, not unique to this build.
- **Rollback is non-destructive.** Once real research runs and eval reviews
  exist, dropping the new tables would destroy completed work. Rollback means
  disabling the dark action's entry point — the additive tables stay exactly
  as they are. Table removal, if ever wanted, is a separate, later,
  explicitly-authorized decision — never bundled with a code rollback.
- **`resolveModel` is deliberately thin, not a provider router.**
  `lib/ai/model-select.ts` exists only so a future build that actually needs
  to route by task (once a second provider exists, or a measured need to
  route by cost/latency/quality shows up) doesn't have to touch every call
  site again. No config, no abstraction beyond one function today.

## Evaluation protocol (not yet run)

Track 1 (AI-output quality) reports four separate figures, not one
hallucination rate: **correctness** (of claims matching an expected fact's
`claim_key`, how many are right — Mode A only), **completeness/recall** (of a
fixture's expected facts, how many got any claim at all for that key),
**provenance quality** (human-judged: does `source_url`/`source_excerpt` look
real and specific, or vague/fabricated-sounding), and **unsupported-claim
rate** (claims with no corresponding expected fact — not automatically bad,
reviewed and recorded). `research_eval_reviews.verdict` values: `match` /
`partial` / `miss` / `contradicted` (Mode A, per expected fact) or
`plausible` / `hallucinated` / `unclear` (Mode B, per claim, no ground
truth). Track 2 (software regression) is contract-based, not byte-for-byte —
AI output is nondeterministic, so tests check statuses reached, gating
behavior, and UI availability, never exact generated text.

**Real-tenant (Mode B) evaluation is consent-gated, not a technical
requirement.** Tenant isolation is fully testable with controlled fixtures
alone — it's a property of RLS and `organization_id` scoping. Running the
Research Agent against real prospects from Village Worship Initiative or
Tunde Aviation requires that organization's explicit agreement first.

## Not yet done

- The evaluation harness itself: 5 controlled fixture prospects in a
  dedicated Eval organization, hand-authored `research_expected_facts` rows,
  and an actual evaluation report. Nothing has been run against real or
  fixture data yet.
- The five contract-based regression tests described in the approved plan
  (existing combined action still reaches `ready_for_review`;
  `approveStrategy` still gates draft generation; `evidence/page.tsx`'s usage
  count still runs against the same query; `suggestNextStep` still succeeds;
  both `deep-dive-panel.tsx` and `strategy-review-workspace.tsx` still render
  every existing state) — not yet written or run. This codebase has no
  automated test suite today; these would be the first.
- Concurrency test (two simultaneous `runResearch` calls for the same
  prospect, confirming two distinct correctly-ordered versions via the
  retry-on-conflict path) — not yet run.
- Cross-org trigger-rejection test (a deliberately mismatched insert gets
  rejected) — not yet run.
- No UI consumes any of this yet — by design, for Build 1. A later build
  decides whether/how Strategy consumes Research's claims.

## Critical files

- `supabase/migrations/0035_research_agent.sql` — the full schema
- `app/(dashboard)/prospects/[id]/research-actions.ts` — `startResearch`,
  `retryResearch`, `runResearch`
- `lib/research.ts` — `RESEARCH_CLAIM_KEYS` (the shared claim-key vocabulary),
  status/type/verdict unions, row types
- `lib/ai/funder-search.ts` — `searchFunderWeb`, shared with the live
  `runDeepDive`
- `lib/ai/model-select.ts` — `resolveModel`
- `lib/auth.ts` — `requireSuperadmin`, shared with
  `app/admin/organizations/actions.ts`
- `app/(dashboard)/prospects/[id]/deep-dive-actions.ts` — the live combined
  action; only its web-search step was touched, extraction/strategy call is
  unchanged
- [0001-multi-tenancy.md](0001-multi-tenancy.md) — the RLS pattern this
  schema follows, and the accepted cross-table-FK gap this build closes for
  its own new tables via the trigger above
