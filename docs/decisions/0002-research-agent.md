# 0002 — Research Agent (Build 1)

**Date:** 2026-08-27, revised 2026-08-28 (three times)
**Status:** Implemented through the evidence-first redesign (v10). Dark: no UI beyond the superadmin `/admin/research` eval tool, not wired into Strategy. Not yet accepted for the full evaluation set — see "Not yet done."

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

## Revision 3 — evaluation-readiness hardening (2026-08-28)

First real run (Maclellan Foundation) surfaced concrete gaps a review round
turned into ten numbered items. Changes made:

- **Atomic claims.** `application.process` and `funding.typical_grant_size`
  each bundled several unrelated facts under one key — split into ~9 atomic
  keys (see `RESEARCH_CLAIM_KEYS`). Rule going forward: one key = one
  independently confirmable/disputable fact.
- **`research_key_coverage` table** (`0036_research_key_coverage.sql`) — one
  row per `claim_key` per run, reporting `found`/`not_public`/`not_found`/
  `conflicting` (model-authored) or `not_attempted`/`extraction_failed`
  (always **server-derived**, never trusted to model self-reporting).
  **`found` is derived from whether a valid claim actually exists for that
  key, never from the model's own coverage entry** — a real bug caught live:
  the first version trusted the model's coverage array as authoritative, and
  a run with 16 real claims showed "20 not attempted" because the model's
  coverage entries didn't line up 1:1 with its own claims.
- **Confidence rubric** made explicit in the extraction prompt (source
  authority, directness, staleness, inference) instead of an unexplained
  model number — see Revision 4 below for `confidence_reason`, added next.
- **Error codes.** `research_runs.error_code` is now a small stable set
  (`search_failed`, `extraction_failed`, `claims_insert_failed`, etc.,
  thrown via a local `ResearchError` class in `research-actions.ts`); the
  full exception message stays in `error_message` (DB/logs only) instead of
  being the default UI text — closes a real leak (the first Maclellan run's
  error showed raw Anthropic SDK header-validation text in the interface).
- **`/admin/research`** — the first real UI: per-claim provenance, coverage
  summary, a claim-review control (verdict + notes + confirm/dispute →
  `research_eval_reviews`/`research_claims.verification_status`), and a
  working `retryResearch` button (`retry_of` chaining).
- **`scripts/test-tenant-isolation.ts`, `scripts/test-research-concurrency.ts`,
  `scripts/confidence-calibration-check.ts`** — real, repeatable verification
  scripts (not just manual clicking), following the `.ts` + `npx tsx
  --env-file=.env.local` convention (verified `tsx` resolves this project's
  `@/*` tsconfig path alias automatically, so these import from `lib/`
  directly like any other file). `test-tenant-isolation.ts` mints two real
  `authenticated`-role sessions via the same `generateLink`→`verifyOtp`
  mechanism `middleware.ts`'s `DISABLE_AUTH` bypass already uses, parameterized
  to two throwaway orgs/users — deliberately not the service-role client,
  which bypasses RLS and would prove nothing.

## Revision 4 — source provenance fix (2026-08-28)

The next review correctly rejected Revision 3's output on one point: almost
every claim showed "no source url." Root cause, confirmed via
`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`, not model
flakiness: `searchFunderWeb()` kept only `TextBlock.text` from the search
response and discarded two things the API already returns whenever the
`web_search` tool runs — `WebSearchToolResultBlock.content` (every page
actually retrieved, real `url`/`title`/`page_age`) and `TextBlock.citations`
(`CitationsWebSearchResultLocation`: which sentences are grounded in which
page, with the exact cited text). The extraction step then only ever saw
flattened prose (verified: the real Maclellan `findings` text contained zero
literal URLs) and had to type a `source_url` from memory of that prose —
exactly the "infer/fabricate a URL after the fact" failure the review named.

**Fix:** capture both citation sources at the search step
(`lib/ai/funder-search.ts` now returns `citedSources`/`searchedSources`),
pass a deduped, numbered list into extraction
(`lib/ai/research-extract.ts`), and require the model to cite by index only
— `claims[].source_indices: number[]`, never a free-text URL. Any index
outside the real list is dropped server-side, same defensive-filter idiom
as `claim_key` validation.

**New tables** (`0037_research_sources.sql`): `research_sources` (one row
per distinct URL retrieved, written for *every* page checked, cited or
not — this is what answers "what was searched" for `not_found` coverage
entries too) and `research_claim_sources` (links a claim to 1+ sources,
`supports_directly` distinguishing direct quotation from inference,
`content_hash` = `sha256(cited_text)` as a lightweight integrity signal —
**not** a durable page snapshot; a real snapshot would mean fetching and
archiving third-party pages ourselves, a separate, bigger feature with its
own storage/robots.txt/legal considerations, not attempted here).

**A second trigger was needed, and only got caught by writing the isolation
test before applying the migration.** The first design had
`research_claim_sources` reuse `enforce_research_run_org_match()` (checks
the row's own `organization_id` against its `research_run_id`'s org) and
assumed that was sufficient. Writing the isolation test surfaced that this
says nothing about whether `claim_id`/`source_id` actually *belong* to that
`research_run_id` — a session could insert a row with its own valid
`research_run_id` (passing the first trigger) while `claim_id`/`source_id`
point at another organization's real rows. `enforce_claim_source_run_match()`
was added specifically to close this before the migration ever ran, checking
that both `claim_id` and `source_id` resolve to the same `research_run_id`
as the row being inserted. Lesson: **writing the test before applying the
migration is what caught this** — worth keeping as the default order for any
future junction-table addition, not just Build 1.

`research_claims.source_url`/`source_excerpt` are kept, now always populated
from a real captured source (never model-typed) for backward-compatible
simple display; the full multi-source list lives in the new tables. Also
added: `confidence_reason`/`reporting_period` on claims,
`retry_recommended` on coverage, verdict `"hallucinated"` renamed to
`"unsupported"` (zero existing rows — safe rename, not additive) to match
reviewer terminology.

**`RESEARCH_CLAIM_KEYS` expanded again** (v4) to match a specific target
presentation structure the user supplied (a curated "Prospect Intelligence"
reader document, 14 fixed sections, Maclellan Foundation worked example) —
new keys: `identity.legal_name`,
`funding.total_assets`/`total_revenue`/`total_expenses`/
`charitable_disbursements` (kept explicitly distinct from
`total_annual_giving`, which is a *sum of listed grants* — the two can
legitimately differ and must never be silently combined into one generic
figure, per the target spec's own explicit warning),
`application.invitation_mechanism`, `application.decision_timeframe`
(distinct from `application.deadline`), `application.foreign_org_eligibility`,
`application.fiscal_sponsorship_rules`, `application.prohibited_activities`.
Since `claim_key` is `text`, not a DB enum, none of this needed a migration
— purely a `lib/research.ts` + prompt-version-bump change. **The reader
presentation itself (the 14-section curated document) is deliberately not
built yet** — see "Not yet done."

## Research Department redesign, Stage 4 — Citation Consistency Validation (2026-08-28)

Testing surfaced a further gap Revision 4 didn't close: even with real,
retrieved source URLs, nothing checked whether the *extraction* step's
claimed `source_excerpt` actually matched what the *search* step had
originally cited. A broader "Research Department" redesign was proposed
(scoping → source discovery → extraction → deterministic provenance
validation → independent Claude verification → coverage audit → conflict
reconciliation → materiality classification → Prospect Intelligence
assembly), explicitly sequenced one stage at a time rather than built in
one pass. This entry covers only the first stage, built now; the rest are
deliberately not started.

**Naming discipline, explicit:** this is called **citation consistency**,
never "source verification." It proves the extraction step didn't drift
from what Claude's search pass actually cited — it does **not** prove the
live webpage still says that. `lib/research.ts`'s `assessCitationConsistency`
carries this same distinction in its own doc comment; the admin UI shows it
inline next to the badge, not just in code.

**Design, deliberately deterministic — no new model call.** `searchFunderWeb`
(`lib/ai/funder-search.ts`) used to dedupe citations by URL, keeping only
the first instance — closed first, since Stage 4 needs every citation
instance a URL received (a page cited for three different sentences yields
three excerpts to check against, not one).
`research_sources.search_time_excerpts` (`text[]`) stores all of them per
source; `research_claim_sources.citation_consistency` (`text`, one of
`consistent`/`drifted`/`unverifiable`/`no_excerpt`) records the per-
`(claim, source)` result of `assessCitationConsistency` — exact match or
substring containment after whitespace/case normalization, deliberately
**not** a fuzzy/word-overlap score (that would trade "exact and
deterministic" for a tunable heuristic). Both columns are plain
`text`/`text[]`, not a new Postgres enum — the broader redesign's
verification-state vocabulary is still being worked out, so new states here
follow the same shared-constant-plus-app-validation pattern already used
elsewhere, not a rigid DB type that would need a migration to extend later.
`citation_consistency` stays `null` on every pre-Stage-4 row (v1–v6) —
never backfilled, same non-destructive idiom as everything else in this
build. Verified with `scripts/test-citation-consistency.ts` (7/7, no
Anthropic call needed — pure string logic).

**Deferred, not built:** independent *webpage* verification (actually
fetching the live page — via Anthropic's own `web_fetch` tool, the more
natural fit over a custom scraper, or not at all) is a distinct, later,
separately-scoped stage. Open questions for whenever it's built: fetch per
claim or per distinct source (many claims share a handful of sources — the
latter is far cheaper); every run or only Enhanced-depth/flagged claims;
where fetched content is stored and for how long.

## Evidence-first redesign (v10, 2026-08-28)

Stage 4's real numbers (v9: 4/33 citation-consistent) plus a confirmed entity-
contamination finding (`marymcclellanfoundation.org` — a real, unrelated
organization — sat unflagged in a real source list) showed that patching the
extraction architecture case-by-case had hit diminishing returns. Root cause:
one unconstrained extraction call both decided what a source said *and* wrote
a quote of it, with nothing forcing the two to correspond — Stage 4 could only
check the symptom after the fact, and couldn't distinguish drift from partial
support from a genuinely wrong source. This redesign flips the order:
**evidence is captured and validated by code before extraction runs; extraction
selects from it, never writes its own quote.**

**Evidence ledger** (`research_evidence`, `0039_evidence_ledger.sql`): one row
per distinct captured text *fragment* — a citation instance (`kind:
"citation_fragment"`) or a source's title (`kind: "page_title"`) — not per
source. A source cited three times plus its title yields four independently
referenceable fragments, closing the exact v9 failure where one excerpt was
attached to every corroborating source regardless of which one it actually
came from. Deliberately named and scoped as *captured evidence*, never implied
to be a full webpage. `provider` (default `'anthropic_web_search'`) and
`content_hash` (`sha256(exact_text)`) are recorded per fragment, keeping the
door open for a second provider later without a schema change (Governing
Principle 6: Claude-only for now, contract kept separable).

**Entity validation gate** (`lib/research.ts`: `classifySourceEntity`,
`deriveEntityNameToken`, `determineConfirmedEin`) — a **trust classification**,
not a binary filter, because most legitimate sources never state an EIN and a
*different* EIN doesn't automatically mean "wrong entity" (the real Maclellan
findings themselves describe affiliated sibling foundations — Christian
Education Charitable Trust, the Robert L. and Kathrina H. Maclellan Foundation
— with different EINs but real, relevant context). Seven levels:
`ein_confirmed` · `official_domain_confirmed` · `legal_name_confirmed` ·
`affiliate_related_entity` · `identity_unresolved` · `entity_mismatch` ·
`unrelated_excluded`. Only the last two withhold a source's evidence from
extraction entirely; the other five stay usable, tagged with their trust level
in the prompt so the model weighs affiliate/unresolved evidence as context, not
as an equally authoritative statement about the entity itself. The core check —
a case-insensitive substring match on the funder's distinctive name token, not
fuzzy/edit-distance similarity — was chosen specifically because a fuzzy score
would likely have rated "McClellan" close enough to "Maclellan" to pass,
exactly the false-negative that let the real contamination through undetected.
Verified against both the real contamination case and the real affiliate case
before building (`scripts/test-entity-validation.ts`, 7/7).

**Extraction rewrite**: `claims[].source_indices` + `claims[].source_excerpt`
(model-typed) is replaced by `claims[].evidence_ids` (indices into the
evidence-fragment list, shown to the model with their actual text and trust
label). The model still writes `claim` — its own plain-language statement,
which may synthesize across several fragments — but never writes a quote; the
stored `cited_text` for a claim is always a direct copy of the referenced
fragment's `exact_text`. Fixed a real off-by-one-list bug caught during this
same build: `evidence_ids` must index into whatever array is actually passed
to `extractResearchClaims`, so filtering out excluded-entity fragments has to
happen in the caller *before* the call, not inside it.

**Explicit boundary with Stage 5**: this guarantees evidence is real,
attributable, and entity-checked — it does not guarantee a claim's wording
accurately and completely reflects that evidence (a claim can still cite a
perfectly real fragment and still overstate or omit something, e.g. "foreign
organizations are not directly eligible" stated without the equivalency
exception). *Evidence exists* / *entity matches* is settled here, structurally.
*Claim supported* / *partially supported* / *contradicted* remains Stage 5's
job, and only becomes meaningful once the evidence itself is trustworthy —
building this first is what makes Stage 5 possible to trust instead of having
it inherit the same fabrication risk it exists to catch.

**Migration compatibility**: fully additive. `research_sources.
entity_validation_status` and `research_claim_sources.evidence_id` are `null`
on all v1–v9 rows ("not evaluated by this stage," not "passed"). Old rows keep
their historical `cited_text`/`citation_consistency` values exactly as
written; `citation_consistency` is simply no longer computed for new rows
(there's nothing left to probabilistically check once the quote *is* the
evidence record).

**Research-only search prompt**: `searchFunderWeb` (`lib/ai/funder-search.ts`)
gained a `purpose: "combined" | "research_only"` parameter. `"research_only"`
(used only by `runResearch`) drops the "how do they prefer to be approached"
framing that the live combined deep-dive action's prompt legitimately needs
but that has no place in Research's own findings — Research must stay
upstream of Strategy. The live action's call is unaffected (defaults to
`"combined"`, byte-for-byte the original prompt).

## Evaluation protocol (not yet run)

Track 1 (AI-output quality) reports four separate figures, not one
hallucination rate: **correctness** (of claims matching an expected fact's
`claim_key`, how many are right — Mode A only), **completeness/recall** (of a
fixture's expected facts, how many got any claim at all for that key),
**provenance quality** (human-judged: does `source_url`/`source_excerpt` look
real and specific, or vague/fabricated-sounding), and **unsupported-claim
rate** (claims with no corresponding expected fact — not automatically bad,
reviewed and recorded). `research_eval_reviews.verdict` values: `match` /
`partial` / `miss` / `contradicted` / `outdated` (Mode A, per expected fact)
or `plausible` / `unsupported` / `unclear` (Mode B, per claim, no ground
truth). Track 2 (software regression) is contract-based, not byte-for-byte —
AI output is nondeterministic, so tests check statuses reached, gating
behavior, and UI availability, never exact generated text.

**Real-tenant (Mode B) evaluation is consent-gated, not a technical
requirement.** Tenant isolation is fully testable with controlled fixtures
alone — it's a property of RLS and `organization_id` scoping. Running the
Research Agent against real prospects from Village Worship Initiative or
Tunde Aviation requires that organization's explicit agreement first.

## Not yet done

- **The "Prospect Intelligence" reader presentation** — a curated document
  assembled from the atomic claims/sources/coverage, organized into a fixed
  14-section order (at a glance → mission/priorities → geographic reach →
  eligibility → application access → required materials → restrictions →
  funding capacity → key people → recent grants → conflicts → unknown/
  unresolved → research conclusion → human-review actions). The target spec
  and a full Maclellan-Foundation worked example were supplied by the user
  (2026-08-28); `RESEARCH_CLAIM_KEYS` was expanded specifically so the
  underlying data can support it (see Revision 4 above), but the reader page
  itself is deliberately deferred — explicitly out of scope for Build 1's
  current review, which is about validating the raw data layer first. When
  this gets built: the "conflicts" section maps directly to multiple claims
  sharing one `claim_key` each with low confidence and reason "conflicting
  sources" (already representable, no schema change needed); "unknown or
  unresolved" maps directly to non-`found` `research_key_coverage` rows;
  "human review: compare with earlier/later versions" is a query across
  `research_runs.version` for the same `claim_key`, not a new column.
- The evaluation harness itself: 5 controlled fixture prospects in a
  dedicated Eval organization, hand-authored `research_expected_facts` rows,
  and an actual evaluation report. Nothing has been run against real or
  fixture data yet.
- The five contract-based regression tests described in the approved plan —
  still not written as an automated suite (this codebase has none yet);
  non-regression has instead been demonstrated by hand each round (a full
  live browser walkthrough once; grep-confirmation that later rounds' diffs
  don't touch the live-workflow files, since they don't).
- Confidence-calibration script (`scripts/confidence-calibration-check.ts`)
  needs `ANTHROPIC_API_KEY` in local `.env.local` to actually run — blocked
  on that, not yet re-solved as of Revision 4.
- No UI outside `/admin/research` consumes any of this yet — by design. A
  later, separately-authorized build decides whether/how Strategy consumes
  Research's claims.

## Critical files

- `supabase/migrations/0035_research_agent.sql`, `0036_research_key_coverage.sql`,
  `0037_research_sources.sql` — the full schema across all three revisions
- `app/(dashboard)/prospects/[id]/research-actions.ts` — `startResearch`,
  `retryResearch`, `runResearch` (version allocation, write ordering,
  source resolution, error classification)
- `lib/research.ts` — `RESEARCH_CLAIM_KEYS` (the shared claim-key
  vocabulary — read the comment above it before adding/removing a key),
  `allocateResearchRunVersion`, status/type/verdict unions, row types
- `lib/ai/funder-search.ts` — `searchFunderWeb`, shared with the live
  `runDeepDive`; now also returns `citedSources`/`searchedSources`
- `lib/ai/research-extract.ts` — `extractResearchClaims`, `buildIndexedSources`;
  independently callable (no DB, no auth) by
  `scripts/confidence-calibration-check.ts`
- `lib/ai/model-select.ts` — `resolveModel`
- `lib/auth.ts` — `requireSuperadmin`, shared with
  `app/admin/organizations/actions.ts`
- `app/admin/research/` — `page.tsx` (provenance/coverage display),
  `claim-review.tsx`, `actions.ts` (`triggerResearch`, `submitClaimReview`,
  `setClaimVerificationStatus`)
- `scripts/test-tenant-isolation.ts`, `scripts/test-research-concurrency.ts`,
  `scripts/confidence-calibration-check.ts` — repeatable verification,
  `npx tsx --env-file=.env.local scripts/<name>.ts`
- `app/(dashboard)/prospects/[id]/deep-dive-actions.ts` — the live combined
  action; only its web-search step was touched, extraction/strategy call is
  unchanged
- [0001-multi-tenancy.md](0001-multi-tenancy.md) — the RLS pattern this
  schema follows, and the accepted cross-table-FK gap this build closes for
  its own new tables via the triggers above

## Stage 1 entity resolution (2026-08-28)

Identity is now a determined property of a run rather than something that
emerges from counting search results. Three real defects motivated this:

1. **Same organization, different verdicts.** In Maclellan v21 one affiliated
   foundation appeared at three URLs and received two different
   classifications, because two of its pages carried its full name in the
   title while its own summary page returned a bare-domain title and a
   snippet that never repeated the name. Classification was per-URL, so the
   thin page had nothing to match on.
2. **Majority vote elevated the wrong entity.** In Servants Heart v1 the EIN
   was chosen by counting mentions, and a different real organization
   (Carlisle PA) won because it happened to state its EIN in more titles.
   A dominance ratio patched the symptom but kept the mechanism.
3. **Nowhere to record identity**, so every run re-derived it from scratch.

**Resolution by priority, not popularity.** `resolveRunEntity` tries, in
order: a human-confirmed EIN on the prospect; an EIN from a name-matching
`irs_filing` source; an EIN on the prospect's own domain. Two competing
authoritative filings resolve to `ambiguous_filings` and deliberately yield
no EIN -- contested identity is never settled by picking the more frequent
answer. Returning null withholds trust without excluding anything.

**Classification per entity, not per URL.** `classifyRunSources` groups
sources by the EIN they describe, pools their captured text, and reaches one
verdict per entity. A page with a bare-domain title inherits the identity its
siblings establish. Grouping also knows the entity's EIN from URLs that state
it without a dash, which is what separates a genuine affiliate (different
EIN, name still matches) from an unrelated near-miss -- text-only detection
could not tell those apart.

**Location downgrades, never excludes.** State-level only, and only when both
sides state a location: a conflict turns `legal_name_confirmed` into
`identity_unresolved`. City-level matching was rejected on evidence -- the
real prospect record read "Irvine, CA" while the organization's filings say
"Newport Beach, CA", so a city gate would have rejected the correct
organization. This is the same false-negative class as the earlier
McClellan/ProPublica defects, and the rule is the same: a weak signal may
lower confidence but must never exclude.

**Identity is proposed, not written.** A run records `confirmed_ein` and
`entity_resolution_method` on itself; promoting that onto the prospect is an
explicit human click (`confirmProspectEin`, superadmin-only). Writing an
AI-derived identity straight into the CRM would be AI output landing in a
non-review state, which hard rule 3 forbids. Once saved, resolution
short-circuits to `stored_ein` and repeat runs become deterministic.

**Testing.** `scripts/test-entity-validation.ts` (16 cases, all built from
real captured run data) covers the v21 three-URL defect, the near-miss
exclusions (Mclain/Maclean/Mccall), competing filings, and the
Irvine/Newport Beach regression guard. `scripts/check-entity-admission.ts`
asserts structurally -- every entity has one verdict, no excluded evidence
supports a claim -- because the obvious outcome test ("zero wrong-entity
claims") already passed before the fix and so could not detect it. That
script also measures how much evidence withholding `identity_unresolved`
would cost, which is the input to the Stage 2 decision rather than an
assumption.

**Deferred to Stage 2:** partitioned evidence-pool records, a human
disambiguation picker, and excluding `identity_unresolved` from extraction.
All three depend on Stage 1's measurements; the EIN field already provides a
human resolution path.
