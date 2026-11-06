# Build report: slice A of item 107 (person identity), ruling 0044

Build space, 2026-11-05. Authorized by `docs/ledger/STATE.md` "Authorized now" (ruling 0044 clauses 1, 2, 9, 10 and the part of clause 4 that governs where candidates may come from). Slices B to E were not touched. Nothing under `docs/ledger/**` was edited, so no STATE item was appended (the brief forbade it): the decision space should open one from this report.

**The invariant implemented:** the platform may *propose* who a recorded person is, from the public web only, and everything it shows about a proposal is either text the web search actually returned or something code computed from it, never something a model typed; only a human click turns a proposal into an identity.

**Not applied to production.** Migration `0083_network_identity.sql` is a new file; it has not been run against any Supabase project. It was run, with migrations 0001 to 0082, on a real Postgres (PGlite), see section 4.

## 1. What I built, file by file

New files:

| File | What it is |
|---|---|
| `supabase/migrations/0083_network_identity.sql` | The migration (full SQL inlined at the end). 8 columns on `network_connections`; new table `network_identity_candidates`; 5 check constraints on the connection (status, decision, title, city, state), 5 checks and 2 unique constraints on the candidate (label, lengths, agreement object, rank 1 to 3, source URL; unique rank and unique source+label per person); RLS (select / insert / delete, deliberately no update); 4 org-match security-definer triggers; edit-reset and clear triggers; chosen-candidate-delete trigger. |
| `lib/network-identity.ts` | The pure core. Refused-host lists and `refusedSourceKind`; `refusalForLook`; `identityState`; `computeAgreement` (token containment, reusing `tokenize` / `isDistinctiveWord` from `lib/network-shortlist.ts`); `qualifiesForPreselection` / `preselectedCandidate`; `agreementFor` (recompute when facts were edited); `indexPersonSources` (the captured numbered list); `PERSON_CANDIDATES_TOOL` (closed schema); `validatePersonCandidates`; `scrubContactDetails`; `planBulkLook`, `bulkReportAddsUp`, `bulkReportMessage`. |
| `lib/ai/person-search.ts` | `findPersonCandidates(facts, usage)`: the web-search call (same tool version, `allowed_callers`, model and timeouts as `lib/ai/funder-search.ts` / `findNetworkPaths`), then a forced-tool selection from the captured numbered sources. No `fetch`, no fetch tool, no page is ever opened by the platform. |
| `lib/network-identity-store.ts` | Tolerant, paged, exact-count readers: `loadIdentityOverview`, `loadIdentityContext`, `countIdentityStates`. |
| `app/(dashboard)/network/identity-actions.ts` | `findIdentityCandidates`, `findIdentityCandidatesForUnidentified` (cap 10 per click, 250 s time budget), `confirmIdentity`, `confirmPreselectedIdentities`, `markNoneOfThese`, `resetIdentity`, `setDoNotResearch`. The one place a run is born is `lookAtPerson` (refusal line 101, `beginRun` line 110, model call line 116). |
| `app/(dashboard)/network/identity/page.tsx`, `identity-workspace.tsx` | The confirmation screen at `/network/identity`. |
| `scripts/test-network-identity.ts` | 299 assertions (pure rules, the real actions with fake Supabase and scripted Anthropic, import, assistant/agent exclusion, source scans, server-rendered screens). |
| `scripts/test-network-identity-migration.ts` | 96 assertions on a real Postgres (PGlite). |
| `scripts/mutation-check-network-identity.ts` | Breaks 18 guards in turn and checks a named assertion fails (section 3). |

Changed files:

| File | Change |
|---|---|
| `lib/network.ts` | `NetworkConnection` gains the optional new fields; `NETWORK_DISCLOSURE` and `NETWORK_IMPORT_DISCLOSURE` rewritten for ruling 0044 clause 10. |
| `lib/ai-runs.ts` | `"network_identity"` added to `AI_RUN_OPERATIONS`. No pricing registry exists in code (the ledger only records; decision 0006 leaves the credit price to the owner), so nothing else to add. |
| `lib/network-import.ts` | Title / City / State / combined "City, state" mapping targets; `splitCityState` (last comma); notice for unsplit values; caps; legacy duplicate key; request shape is now exactly 7 fields; `profile` / `profiles` added to the contact-heading words. |
| `lib/network-store.ts` | Import insert carries title / city / state only when a chunk has one. |
| `app/(dashboard)/network/actions.ts` | `ConnectionInput` gains optional title / city / state / do_not_research; `updateConnection` reads the current row and, when a confirmed person's facts change (or they are marked do-not-research), writes the reset and deletes their candidates (line 129 `voidsConfirmation`). |
| `app/(dashboard)/network/network-workspace.tsx`, `page.tsx` | Form fields, do-not-research checkbox, identity chip on each card, Find matches / Look again / Reset identity, bulk Do not research / Allow research, "Who is who" panel, `maxDuration = 450`. |
| `app/(dashboard)/network/import/import-workspace.tsx`, `page.tsx`, `import-actions.ts` | Mapping UI for the new targets, preview shows them, location notice, text updated. |
| `scripts/test-tenant-isolation.ts` | New "Network identity (migration 0083)" section (15 live assertions). **Written, not executed** (section 5). |
| `scripts/network-test-support.ts` | Fake client: `neq`, `limit`, and an opt-in `identityColumns` default set. Off by default, so older suites see the rows they always did. |
| `scripts/test-network.ts`, `test-network-import.ts`, `test-ai-runs.ts`, `test-agent.ts`, `test-assistant.ts` | Edits listed in section 6, item 14. |
| `package.json`, `package-lock.json` | the pglite package (@electric-sql/pglite) ^0.5.15 added as a **devDependency only**. |

No new environment variable. Nothing server-only moved toward the client (the Anthropic client is imported only by `lib/ai/person-search.ts`; the client components import only pure modules and server-action references; `next build` compiled).

## 2. Test counts, before and after (real runs of `npx tsx scripts/<name>.ts`)

| Suite | Before | After |
|---|---|---|
| test-network | 183 passed, 0 failed | 183 passed, 0 failed |
| test-network-import | 156 / 0 | 156 / 0 |
| test-assistant | 585 / 0 | 585 / 0 |
| test-agent | 344 / 0 | 344 / 0 |
| test-supporters | 182 / 0 | 182 / 0 |
| test-send-draft | 268 / 0 | 268 / 0 |
| test-reply-address | 138 / 0 | 138 / 0 |
| test-ai-runs | 68 / 0 | 70 / 0 (two assertions for the new operation file) |
| test-health-status | 19 / 0 | 19 / 0 |
| test-tenant-isolation | **cannot run here**: exits 1, "Missing NEXT_PUBLIC_SUPABASE_URL ..." | same. Not run. It needs a live Supabase project with real organizations, and 0083 is not applied there. |
| **test-network-identity** (new) | n/a | 299 / 0 |
| **test-network-identity-migration** (new) | n/a | 96 / 0 |
| `npx tsc --noEmit` | clean | clean |
| `npx next build` | not run before | compiled, types and lint passed, `/network/identity` is in the route list |
| `npx tsx scripts/ledger-check.ts` (check only) | | "ok protocol intact"; it changed no file. Its additivity check (`additiveViolations`) returns no violations for 0083. |

Several of the "after" numbers equal "before" only because assertions were *edited* to the new behaviour, not left alone; every edit is listed in section 6, item 14.

## 3. Mutation checks (`npx tsx scripts/mutation-check-network-identity.ts`, 18 of 18 caught)

The script confirms both test files pass unmutated, then for each row writes the mutated source, runs the test that should catch it, requires a FAIL whose label contains the named text, and restores the file byte for byte (checked; I also diffed the whole tree against a copy taken beforehand). Result lines are "passed / failed" of the test that was run.

| # | Guard broken | Where | Caught by (named assertion) | Result |
|---|---|---|---|---|
| M1 | do-not-research refusal (the rule) | `lib/network-identity.ts` `refusalForLook` | "a do-not-research person is refused (outranking every other reason)" and 15 more | 283 / 16 |
| M1b | do-not-research refusal (the action stops calling it) | `identity-actions.ts` `lookAtPerson` | "a do-not-research person is refused, and no run is born and no model is called" (plus the other four refusals; "ZERO ledger runs, ZERO model calls") | 289 / 10 |
| M2a | social-network refusal on a candidate | `validatePersonCandidates` | "a candidate whose source is a social network (or a people-data broker) is discarded and reported even if it reached the pool" | 298 / 1 |
| M2b | social-network refusal building the source list | `indexPersonSources` | "LinkedIn (cited and surfaced ...) ... are NOT offered to the model" and 6 more | 292 / 7 |
| M2c | social host list recognition | `refusedSourceKind` | "refusedSourceKind refuses every social host in all forms ... 138 URLs, 138 missed" and 9 more | 289 / 10 |
| M3 | model-typed URL let through | `validatePersonCandidates` | "a URL, a title or a passage the model TYPED is never read" and the end-to-end "a model answer that types a LinkedIn URL ... stores ONE candidate, from the captured source" | 297 / 2 |
| M4 | auto-confirm on preselect | `lookAtPerson` | "THE LOOK CONFIRMS NOTHING ...", "the finder never writes identity_status itself" and 2 more | 295 / 4 |
| M5 | reset-on-edit, server action | `actions.ts` | "changing the person_name / affiliation / title / city / state of a CONFIRMED person resets them" (all five) | 293 / 6 |
| M5b | reset-on-edit, **database trigger never created** | `0083` SQL | "changing person_name: back to unconfirmed, decision cleared, candidates deleted (3 left)" and 7 more | migration 88 / 8 |
| M6 | agent exclusion (agent tool registry imports an identity action) | `lib/agent/tools.ts` | "none of the 49 files of the assistant, the external agent and the HTTP routes ... names or imports any identity action" and "neither closed registry names the Network at all" | 297 / 2 |
| M6b | agent exclusion (the MCP route imports one) | `app/api/mcp/route.ts` | same first assertion | 298 / 1 |
| M7 | batch confirm trusts the client's pair | `confirmPreselectedIdentities` | "the batch confirms exactly the two pairs that are STILL the preselected match" and 2 more | 296 / 3 |
| M8 | per-click cap | `findIdentityCandidatesForUnidentified` | "the first click looks at 10 of the 14 eligible" and 3 more | 295 / 4 |
| M9 | preselect when two candidates qualify | `preselectedCandidate` | "TWO candidates that both qualify leave NOTHING preselected" and 3 more | 295 / 4 |
| M10 | metering: no ledger birth | `lookAtPerson` | "ONE ledger run is born for the whole look" and "the run was BORN BEFORE the first model call" | the run aborted with an exception after printing these two FAILs, so there is no summary line |
| M11 | DB refuses candidates for do-not-research people | `0083` SQL | "a do-not-research person cannot be given a candidate, by any path" | migration 95 / 1 |
| M12 | DB refuses social-network source URLs | `0083` SQL | "every one of the 37 hosts the code refuses is refused by the database too (no drift)" and 2 more | migration 93 / 3 |
| M13 | DB voids a confirmation when its chosen candidate is deleted | `0083` SQL | "deleting the chosen candidate is allowed (not RESTRICT) ..." and 3 more | migration 92 / 4 |

M2a is the thinnest (one assertion), which is expected for a defence-in-depth layer sitting behind M2b and M2c.

## 4. Real-Postgres verification of migration 0083

`scripts/test-network-identity-migration.ts` uses the pglite package (@electric-sql/pglite) 0.5.15, whose `select version()` reports PostgreSQL 18.6 (PGlite), in process. What it does and the evidence from the run:

* It builds a small Supabase shim (roles `anon` / `authenticated` / `service_role`, the `auth` schema with `users`, `uid()` reading `request.jwt.claim.sub`, `jwt()`, a `storage` stub, an `extensions` schema, and the default grants Supabase gives `authenticated`), then applies **every migration file in `supabase/migrations`, unchanged and in order: 83 files, 0001 to 0083, with no error**. (I first proved the shim sufficient: all 82 existing files applied, then 0083.)
* It then runs 96 assertions, as the superuser for fixtures and as the `authenticated` role (with a JWT subject set) for anything about row-level security. Groups: column shapes and defaults; no contact-detail column on either table; the decision check (nine cases mirroring `network_path_suggestions_decision_check`); fact checks; rank 1..3 and unique-per-person; closed lengths; the source-URL check against all 37 host names the code refuses, in subdomain / port / user-info / upper-case forms, plus lookalikes that must be accepted; the host list read back from the catalog equals the code's two lists exactly; org-match triggers for every reference (candidate to person, candidate to run, person to candidate, person to decider), each with a cross-organization attempt that is refused; decider pinned to the signed-in user; candidates refused for do-not-research, confirmed and none-of-these people; RLS (A sees only A; B cannot select, update or delete A's rows; nobody can update a candidate; own insert and delete work); reset-on-edit for each of the five facts, for a clearing edit, and under an authenticated edit; non-fact edits and unchanged saves do not reset; an unconfirmed person keeps candidates across an edit; none-of-these is kept across an edit; human reset starts clean; do-not-research deletes candidates and voids a confirmation; deleting the chosen candidate voids the confirmation and leaves the other candidates; deleting all candidates of a confirmed person in one statement; erasing a confirmed person, seven people in one statement, and as a signed-in user under RLS (cascade succeeds); a replace flow (delete then insert) with no unique-rank clash; additivity of the file.
* A first run of the harness had 3 failures, all mistakes in my test (a regex that named the wrong constraint; a candidate that a reset had correctly deleted before I reused its id; three inserts at the same rank). After fixing the test, 96 pass. The migration needed no change.
* Design point found while building it, recorded in the SQL comments: a BEFORE trigger that updates the same row the statement is updating, or deletes a row the statement is deleting, would raise in Postgres ("tuple ... already modified by an operation triggered by the current command"). So the reset is a BEFORE trigger that only rewrites NEW, the candidate deletion is a separate AFTER trigger, and that AFTER trigger does nothing when it is itself running inside another trigger (`pg_trigger_depth() > 1`, the case where deleting the chosen candidate voids the decision). Mutations M5b and M13 show these triggers are what the tests exercise.

What this does not prove: it is PGlite's Postgres, not the Supabase platform; it does not run PostgREST; the shim's `auth.uid()` is mine. The live isolation suite remains the check against the deployed database.

## 5. What I did not or could not verify

* **`scripts/test-tenant-isolation.ts` was not run** (needs live Supabase credentials and real organizations; 0083 is not applied there). I added a "Network identity (migration 0083)" section in its existing style; it is typechecked and **unexecuted**, and reports itself NOT EVALUATED if the table does not exist. The same behaviours are proven on PGlite instead.
* **No live Anthropic call was made** (the brief forbids it). Therefore unverified: that the real `web_search_20260318` tool accepts `blocked_domains` (it is a documented parameter in the installed SDK types, `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`, and nothing in the code depends on it: the refusal is in code); what real people-searches return; how often the search yields citations with text; the cost and latency of a look; and how strict token containment is against real pages (for example, a recorded "Senior Pastor" will not match a page that says only "Pastor"). **Preselection rates on real data are unmeasured.** I would measure on a sample of 20 to 30 of the owner's real people before trusting the "Confirm all preselected" button for volume.
* **The screens were never opened in a browser.** `/network` and `/network/identity` were rendered to static HTML with fixture data inside the test (react-dom/server) and asserted on text, structure and attributes; I tried to look at the fixture HTML in the preview pane and the pane would not screenshot a local file. Layout, spacing and the radio / button states are therefore not visually checked. The design tokens (`lib/ui.ts`) and `boxSizing: "border-box"` are used and scanned for.
* The time budget (250 s) and the per-click cap (10) are reasoned, not measured: a look is two model calls bounded by 120 s + 60 s; a typical one is expected to be well under that. That a server action invoked from a page inherits that page's `maxDuration` on Vercel (450 s here, as the prospect page) is my understanding of Next, not something I tested.
* Concurrency (two people clicking at once) was not tested beyond the database's own unique constraints.
* Path-finding was not re-run end to end; its existing suite passes (test-network), and a scan asserts it neither reads nor gates on identity.

## 6. Judgment calls and things the decision space must look at

1. **The old "Role or title" import target is replaced by Title.** Before: a role column was joined into `affiliation` as "Role, Affiliation". The brief said the mapping "gains" Title; leaving both would put two title targets on one screen, and the new fields exist so the title is separate. So: the Title column goes to `title`; `affiliation` is just the employer. Consequence handled: people imported earlier carry "Role, Affiliation" in `affiliation`, so `classifyImportRows` also treats a row as already-here when `name + "Title, Employer"` matches an existing key (tested), so re-importing a file adds no second copy. The existing import tests that asserted the joined form (`test-network-import.ts` lines for the LinkedIn and board fixtures) were rewritten to the separate form. Please confirm this reading.
2. **Disclosure wording.** `NETWORK_DISCLOSURE` no longer equals the item-76 sentence; the old test that asserted it verbatim now asserts the three promises that survive (notes shared for introductions, no sensitive details in notes, nothing ever sent to the people listed). The new text is truthful about two different flows: the identity search sends name, employer, title, city, state and search text built from them, and does **not** send notes or how-you-know-them; finding an introduction sends what it always did (name, affiliation, how known, strength, notes). Please read it as the owner will.
3. **Path-finding is unchanged, as instructed.** Title, city and state are **not** added to what the model sees in a path search (`connectionLine` picks named fields; a test passes an object with `SECRET-TITLE` and shows it is absent from the prompt) and the shortlist rule does not read them (tested). `findNetworkPaths` does not mention identity (asserted by scan).
4. **A sixth state, "No candidates found".** Brief lists five states. "Looked at and the search found no one" must not collapse into "Not looked at" (CLAUDE.md: not evaluated vs evaluated and clean), and re-spending in a batch on someone already searched for nothing is wasteful. It is derived from the run ledger (the person's latest finished `network_identity` run has outcome `empty`), so no extra column.
5. **A name alone is refused** (`too_few_facts`): at least one of employer, title, city, state is required before a look. Every "John Smith" on the web would otherwise be a candidate. In the batch this appears as a counted reason.
6. **Preselection is stricter than the brief in one respect:** a recorded name of one word is never preselected. Everything else is the brief's rule exactly: name found AND (employer or title found) AND (city or state found, when the recorder gave either), and only when exactly **one** candidate qualifies (two that qualify leave nothing highlighted). A state matches by full name or by the written form ", TX"; a bare "TX" does not count.
7. **People-data brokers are refused like social networks** (ZoomInfo, RocketReach, Spokeo, Whitepages and others, 14 hosts). Beyond the brief; reason: clause 4 says a licensed provider needs its own ruling, and these are unlicensed sources of the same kind of data, home addresses included. Easy to remove from `PEOPLE_DATA_BROKER_HOSTS` (and the migration's list).
8. **What an edit does.** Per the brief a confirmed person's edit of name / employer / title / city / state resets and deletes candidates (action and trigger). I decided: "none of these" is **not** reset by an edit (it is a recorded no; only a human resets it); marking a person do-not-research deletes their candidates and voids a confirmation; a human reset deletes the candidates too. The database also refuses to give candidates to a do-not-research, confirmed or none-of-these person, whatever the application does.
9. **Stale agreement.** Editing an *unconfirmed* person leaves their candidates (not asked to reset), so the comparison stored at look time can go stale. `agreement` therefore records the exact facts it was computed for (`computed_for`); the screen and the batch action recompute from the stored captured text when they differ (`agreementFor`), and say so on the card.
10. **A look that finds no one keeps earlier candidates; one that finds someone replaces them** (delete then insert, in that order; if the insert then fails the person is left with none and the error is returned and the run marked failed).
11. **Bulk action limits:** 10 people per click, one at a time, plus a 250 s time budget (stops before starting another person and says that is why). Each look is one run. The report always says "looked at X of Y eligible" and counts every other person by reason; the counts are asserted to add up (`bulkReportAddsUp`).
12. **Two model calls per look, one ledger run.** The search, then a forced-tool selection from the numbered captured sources. The selection prompt is given only the captured sources and the recorded facts, not the search call's prose, so the model cannot hand forward text that has no captured source. Tokens of both calls are added into the one run.
13. **Contact details and addresses are scrubbed from what is stored:** emails, phone numbers, links, handles and street addresses are removed from the captured passage and title; a model line (headline, location) that carries one is dropped whole and logged. This is a floor, not a guarantee: the code cannot recognise family, health or finances in free text. Those are never requested (the tool has no field for them) and the model is told not to report them.
14. **Edits to existing test suites** (each is a direct consequence of the new behaviour, none weakens a guard): `test-network-import.ts` (role to title, row shapes, the store-key scan now allows the conditional title/city/state spread, the MappedRow type, the disclosure phrase, ten selects instead of seven, and the "no migration added" check now allows exactly `0083_network_identity.sql`); `test-network.ts` (the verbatim item-76 disclosure assertion, see item 2); `test-ai-runs.ts` (`lib/ai/person-search.ts` added to the helper files, `identity-actions.ts` to the operation files, `await findPersonCandidates(` to the model-call tokens: this is the extension point that suite documents, and it still asserts that the set of model-calling files is exact and that every operation is declared); `test-agent.ts` ("0082 is the highest migration" was a position-relative claim that fails the moment any later migration lands, as the comment in `test-network.ts` already records for 0077; now "0082 exists, directly after 0081"; and the forbidden-reference list gains the identity actions); `test-assistant.ts` (forbidden-import list gains `identity-actions`, `person-search`, `network-identity`).
15. **Assistant and agent.** Neither closed registry names the Network at all (asserted), none of the 49 files under `lib/assistant`, `lib/agent` and `app/api` (including `app/api/mcp/route.ts`) mentions any identity action, table or column, and none can create or edit a network person, so the reset-on-edit rule has no second path through them. Added to their suites' forbidden lists as well.
16. **Code ahead of the migration is tolerated**, and the SQL header states the deploy order both ways: adding or importing a person with no title / city / state still works before 0083 (the columns are left out of the write); a person with one of them needs the migration and is told so by the database's own message; the Network page hides the identity controls and says why; `findIdentityCandidates*` refuse before any run is born when the identity columns cannot be read.
17. **`maxDuration = 450`** added to `/network` and `/network/identity` pages because a look runs inside the request of the page that invoked it.
18. **`blocked_domains`** is sent to the search tool as a *request*; see section 5.
19. **The label and headline a model wrote are claims.** Stored with `agreement.model_text` (label / headline / location supported by the captured text, true / false / null). Unsupported ones are shown with a warning, never deleted and not used to preselect (preselection uses only the recorded facts against the captured text).
20. `scripts/test-network-identity.ts` renders the screens with fixtures; `React` is set on `globalThis` there because the project's tsconfig uses `jsx: preserve`.

## 7. Plain list of what the owner will see once the migration is applied

Network page: a "Who is who" panel with counts and a button to the review screen; each person shows an identity chip (Not looked at / No candidates found / Candidates to review / Confirmed / None of these / Do not research), their title and place, and Find matches / Look again / Review matches / Reset identity; the add/edit form has Title, City, State and a Do not research checkbox; bulk Do not research / Allow research on the selection. Review screen (`/network/identity`): per person, the recorded facts, each candidate with headline, place, source link and the evidence line, a radio choice with "None of these", Confirm; a collapsed "Confirm all preselected (N)" that, when opened, lists every one of those people with the candidate they would be confirmed as and its evidence, above a single explicit button; and "Find matches for everyone not yet identified (N)" stating its cap of 10 per click. Import: Title, City, State and "City and state together" targets; a combined value is split at the last comma, and values that cannot be split are put whole in City and counted in plain words.

## 8. Migration 0083, exact SQL

```sql
-- STATE item 107, slice A, authorized by ruling 0044 (clauses 1, 2, 9, 10 and
-- the part of clause 4 that governs where candidates may come from): a
-- recorded person carries the facts that identify them, the platform may
-- PROPOSE up to three candidate matches from the public web, and a HUMAN says
-- which one is the real person, or "none of these". Nothing is researched
-- about a person beyond finding those candidates.
--
-- Two changes.
--
-- (i) network_connections gains the identifying facts and the identity
--     decision. title, city and state are optional text (the employer is the
--     existing `affiliation`). do_not_research is a flag a human sets and code
--     honours. identity_status is unconfirmed / confirmed / none_of_these, NOT
--     NULL DEFAULT 'unconfirmed': nobody is identified until a human says so.
--       * network_connections_identity_decision_check ties the decision
--         columns to the status in the manner of 0077's
--         network_path_suggestions_decision_check: unconfirmed carries no
--         candidate, decider or time; confirmed carries all three; none_of_these
--         carries a decider and a time and NO candidate. A row cannot be
--         "confirmed" without a candidate and a person who decided, nor
--         carry a decider while still unconfirmed.
--       * NO contact-detail column is added (ruling 0044 clause 1: no email,
--         phone, social handle or profile link is stored, ever).
--
-- (ii) network_identity_candidates: one row per candidate the platform
--     proposes for a person. It is the AI's PROPOSAL and nothing more -- it is
--     never "chosen" on its own row; the choice lives on the connection
--     (identity_candidate_id). There is no human edit of a candidate's content
--     (no update policy). A candidate keeps the URL, title and passage the web
--     search actually RETURNED (the capture contract); the model only selected
--     which captured source it came from. `agreement` is computed by CODE, not
--     by the model: for each recorded fact, whether its distinctive tokens all
--     appear in the captured text. rank is 1..3 and unique per person, so the
--     database itself holds at most three candidates per person.
--
-- WHAT THE DATABASE ENFORCES, beyond shape (each is exercised against a real
-- Postgres by scripts/test-network-identity-migration.ts):
--   * Org match on EVERY cross-table reference (hard rule 6; 0077's reasoning:
--     a foreign-key check runs as the table owner and does not respect RLS).
--     Security-definer triggers, in 0066/0077's exact pattern (set search_path =
--     public), fire on insert OR update of the referencing columns:
--       candidate.network_connection_id -> the connection's organization
--       candidate.ai_run_id             -> the run's organization
--       connection.identity_candidate_id-> the candidate's organization, and
--                                          the candidate must be THIS person's
--                                          own
--       connection.identity_decided_by  -> the decider belongs to the same
--                                          organization, and when a database
--                                          session is acting the decider IS
--                                          that session's user
--   * A candidate can be born only for a person who is not marked
--     do_not_research and whose identity is still unconfirmed: a person who is
--     confirmed, "none of these", or do-not-research cannot be given candidates
--     by any path, whatever the application does.
--   * A candidate's source_url must be http(s) and must not be on a social or
--     professional network or a people-data broker (ruling 0044 clause 4). The
--     list here and the list in lib/network-identity.ts are the same list; the
--     migration test fails if they drift.
--   * Editing the identifying facts of a CONFIRMED person (person_name,
--     affiliation, title, city, state) resets identity_status to unconfirmed,
--     clears the decision columns and deletes that person's candidates,
--     because the confirmation was of the facts as recorded. The server action
--     does the same; this trigger is what makes it true for every path.
--     "None of these" is NOT reset by an edit: it is a recorded no, and only a
--     human resets it.
--   * Marking a person do_not_research deletes their candidates (and a
--     confirmation that rested on one is voided with it): nothing is kept that
--     was found about someone who has been marked off limits.
--   * Deleting a candidate that is the chosen one voids the confirmation
--     (unconfirmed, decision cleared) instead of leaving it dangling. The
--     foreign key is ON DELETE SET NULL, NOT RESTRICT: erasing a person must
--     always work, and deleting a connection cascades to its candidates.
--
-- Tenant isolation (hard rule 6, 0033_multi_tenant_rls.sql): the candidates
-- table carries organization_id references organizations(id) default
-- my_organization_id() with RLS scoped by it. Insert, select and delete
-- policies exist for authenticated; there is deliberately NO update policy.
--
-- Additive under ruling 0020: eight new columns on one existing table, one new
-- table, their constraints, indexes, policies, functions and triggers. No
-- existing column, policy or function is dropped or redefined, and every
-- existing row takes the defaults (unconfirmed, not do-not-research, no facts).
-- Migrations 0001-0082 are untouched.
--
-- DEPLOY ORDER, both ways:
--   * MIGRATION AHEAD OF THE CODE: the new columns default safely and nothing
--     reads them; the existing Network page, capture, import and path-finding
--     behave exactly as before. Safe.
--   * CODE AHEAD OF THE MIGRATION: adding or importing a person that has NO
--     title, city or state still works (the code leaves those columns out of
--     the write when they are empty); a person WITH one of them cannot be
--     saved and the user is told why. The identity screen and "Find matches"
--     read tables and columns that do not exist yet; every read is tolerant
--     and says so in plain words, and no run is born and no model is called
--     (the candidate-finding action reads the person's identity columns
--     before the ledger birth and refuses when they cannot be read). Nothing
--     is sent to anyone in either order.
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so this applies together or not at all. Re-running after
-- success fails on the existing column, table, policy and trigger names (no
-- IF NOT EXISTS) -- a refusal that rolls the whole script back, not damage.

-- (i) the identifying facts and the identity decision
alter table network_connections
  add column title text,
  add column city text,
  add column state text,
  add column do_not_research boolean not null default false,
  add column identity_status text not null default 'unconfirmed',
  add column identity_decided_by uuid references auth.users (id),
  add column identity_decided_at timestamptz,
  -- The chosen candidate. The foreign key is added below, after the
  -- candidates table exists.
  add column identity_candidate_id uuid;

alter table network_connections
  add constraint network_connections_identity_status_check
  check (identity_status in ('unconfirmed', 'confirmed', 'none_of_these'));

-- The decision columns and the status say one thing, never two.
alter table network_connections
  add constraint network_connections_identity_decision_check
  check (
    (identity_status = 'unconfirmed'
      and identity_candidate_id is null and identity_decided_by is null and identity_decided_at is null)
    or (identity_status = 'confirmed'
      and identity_candidate_id is not null and identity_decided_by is not null and identity_decided_at is not null)
    or (identity_status = 'none_of_these'
      and identity_candidate_id is null and identity_decided_by is not null and identity_decided_at is not null)
  );

-- A fact is absent (null) or real: never an empty string, never unbounded.
alter table network_connections
  add constraint network_connections_title_check
  check (title is null or (length(btrim(title)) > 0 and length(title) <= 300));
alter table network_connections
  add constraint network_connections_city_check
  check (city is null or (length(btrim(city)) > 0 and length(city) <= 200));
alter table network_connections
  add constraint network_connections_state_check
  check (state is null or (length(btrim(state)) > 0 and length(state) <= 100));

comment on column network_connections.title is
  'Ruling 0044 clause 1: the person''s title or role, as the recorder knows it. Optional. Part of the facts a confirmed identity rests on: editing it resets a confirmation.';
comment on column network_connections.city is
  'Ruling 0044 clause 1: city, as recorded. Optional.';
comment on column network_connections.state is
  'Ruling 0044 clause 1: state or region, as recorded. Optional.';
comment on column network_connections.do_not_research is
  'Ruling 0044 clause 10: a human has marked this person off limits for research. Honoured in code BEFORE any run is born, and by the candidates insert trigger.';
comment on column network_connections.identity_status is
  'unconfirmed | confirmed | none_of_these. Only a human moves it off unconfirmed (ruling 0044 clause 2). The system never confirms an identity itself.';
comment on column network_connections.identity_candidate_id is
  'The candidate a human confirmed as this person. Set only with identity_status = confirmed, by the decision check.';

-- (ii)
create table network_identity_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  network_connection_id uuid not null references network_connections (id) on delete cascade,
  -- The ledger row of the look that produced this candidate. ai_runs rows are
  -- retained, never deleted; SET NULL only keeps this table erasable.
  ai_run_id uuid references ai_runs (id) on delete set null,
  -- The name as found on the source.
  label text not null,
  -- What the source says they do (employer / title as found). The model's
  -- wording of it, selected from the captured source: a claim, not a fact.
  headline text,
  location_text text,
  -- The three below are what the web search actually RETURNED. The model chose
  -- an index into the captured list; it never typed any of these.
  source_url text not null,
  source_title text,
  source_passage text,
  -- Computed by code from the recorded facts and the captured text; see
  -- lib/network-identity.ts (computeAgreement).
  agreement jsonb not null,
  rank integer not null,
  created_at timestamptz not null default now()
);

alter table network_identity_candidates
  add constraint network_identity_candidates_label_check
  check (length(btrim(label)) > 0 and length(label) <= 300);
alter table network_identity_candidates
  add constraint network_identity_candidates_text_length_check
  check (
    (headline is null or length(headline) <= 600)
    and (location_text is null or length(location_text) <= 300)
    and (source_title is null or length(source_title) <= 600)
    and (source_passage is null or length(source_passage) <= 4000)
  );
alter table network_identity_candidates
  add constraint network_identity_candidates_agreement_check
  check (jsonb_typeof(agreement) = 'object');
-- At most three per person, enforced by the database.
alter table network_identity_candidates
  add constraint network_identity_candidates_rank_check
  check (rank between 1 and 3);
alter table network_identity_candidates
  add constraint network_identity_candidates_unique_rank
  unique (network_connection_id, rank);
alter table network_identity_candidates
  add constraint network_identity_candidates_unique_candidate
  unique (network_connection_id, source_url, label);

-- A source is an http(s) page, and never a social or professional network or a
-- people-data broker (ruling 0044 clause 4). The host is read the same way the
-- code reads it: scheme://[userinfo@]host[:port][/...]. KEEP THIS LIST IN STEP
-- WITH lib/network-identity.ts (SOCIAL_NETWORK_HOSTS, PEOPLE_DATA_BROKER_HOSTS);
-- scripts/test-network-identity-migration.ts fails if they drift.
alter table network_identity_candidates
  add constraint network_identity_candidates_source_url_check
  check (
    source_url ~* '^https?://[^/?#[:space:]]+'
    and lower(substring(source_url from '^[hH][tT][tT][pP][sS]?://(?:[^/?#@]*@)?([^/?#:]+)'))
      !~ '(^|\.)(linkedin\.com|lnkd\.in|facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com|twitter\.com|x\.com|t\.co|threads\.net|tiktok\.com|snapchat\.com|pinterest\.com|reddit\.com|tumblr\.com|vk\.com|weibo\.com|xing\.com|whatsapp\.com|t\.me|bsky\.app|mastodon\.social|zoominfo\.com|rocketreach\.co|apollo\.io|lusha\.com|signalhire\.com|spokeo\.com|whitepages\.com|radaris\.com|beenverified\.com|truepeoplesearch\.com|fastpeoplesearch\.com|peoplefinders\.com|intelius\.com|pipl\.com)$'
  );

-- The chosen candidate. SET NULL, not RESTRICT: erasing a person must always
-- work (the cascade from the connection deletes its candidates), and deleting
-- the chosen candidate on its own voids the confirmation first (trigger below),
-- so SET NULL never meets a row it would leave in a half-state.
alter table network_connections
  add constraint network_connections_identity_candidate_fk
  foreign key (identity_candidate_id) references network_identity_candidates (id) on delete set null;

create index network_identity_candidates_organization_id_idx on network_identity_candidates (organization_id);
create index network_identity_candidates_ai_run_id_idx on network_identity_candidates (ai_run_id) where ai_run_id is not null;
create index network_connections_identity_candidate_id_idx on network_connections (identity_candidate_id) where identity_candidate_id is not null;
create index network_connections_identity_status_idx on network_connections (organization_id, identity_status);

comment on table network_identity_candidates is
  'Ruling 0044 clause 2: the AI''s PROPOSAL that a real person found on the public web could be a recorded person. Never chosen on its own row -- the human''s choice is network_connections.identity_candidate_id. No human edit of its content; deleted with its person.';
comment on column network_identity_candidates.agreement is
  'Computed by CODE: per recorded fact (name, employer, title, city, state), found / not_found / not_recorded by token containment in the captured source text. "not_found" is not a proven disagreement -- code cannot prove one.';

-- Tenant isolation.
alter table network_identity_candidates enable row level security;

create policy "team members can read network identity candidates"
  on network_identity_candidates for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can record network identity candidates"
  on network_identity_candidates for insert
  to authenticated
  with check (organization_id = my_organization_id());

-- A fresh look replaces an unconfirmed person's candidates, and a human can
-- reset a person; both delete candidates. No UPDATE policy: a candidate's
-- content is never edited.
create policy "team members can clear network identity candidates"
  on network_identity_candidates for delete
  to authenticated
  using (organization_id = my_organization_id());

-- Cross-table org integrity on EVERY reference, 0066/0077's pattern.
create function enforce_network_candidate_connection_org_match() returns trigger as $$
declare
  c record;
begin
  select organization_id, do_not_research, identity_status into c
    from network_connections where id = new.network_connection_id;
  if new.organization_id is distinct from c.organization_id then
    raise exception 'organization_id must match the referenced network connection''s organization_id';
  end if;
  if tg_op = 'INSERT' then
    if c.do_not_research then
      raise exception 'candidates cannot be recorded for a person marked do not research';
    end if;
    if c.identity_status <> 'unconfirmed' then
      raise exception 'candidates can be recorded only for a person whose identity is unconfirmed';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_identity_candidates_connection_org_match
  before insert or update of organization_id, network_connection_id on network_identity_candidates
  for each row execute function enforce_network_candidate_connection_org_match();

create function enforce_network_candidate_run_org_match() returns trigger as $$
begin
  if new.ai_run_id is not null
     and new.organization_id is distinct from (select organization_id from ai_runs where id = new.ai_run_id) then
    raise exception 'organization_id must match the referenced ai run''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_identity_candidates_run_org_match
  before insert or update of organization_id, ai_run_id on network_identity_candidates
  for each row execute function enforce_network_candidate_run_org_match();

create function enforce_network_connection_candidate_match() returns trigger as $$
declare
  c record;
begin
  if new.identity_candidate_id is null then
    return new;
  end if;
  select organization_id, network_connection_id into c
    from network_identity_candidates where id = new.identity_candidate_id;
  if new.organization_id is distinct from c.organization_id then
    raise exception 'organization_id must match the referenced identity candidate''s organization_id';
  end if;
  if new.id is distinct from c.network_connection_id then
    raise exception 'the confirmed candidate must be one of this person''s own candidates';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_identity_candidate_match
  before insert or update of organization_id, identity_candidate_id on network_connections
  for each row execute function enforce_network_connection_candidate_match();

create function enforce_network_connection_decider() returns trigger as $$
begin
  if new.identity_decided_by is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.identity_decided_by is not distinct from old.identity_decided_by then
    return new;
  end if;
  if new.organization_id is distinct from (select organization_id from profiles where id = new.identity_decided_by) then
    raise exception 'the person who decided an identity must belong to the same organization';
  end if;
  -- A decision made through a signed-in session is recorded as that session's
  -- user. (A session-less context, such as a maintenance script, is not
  -- pinned.)
  if auth.uid() is not null and new.identity_decided_by <> auth.uid() then
    raise exception 'an identity decision is recorded as the person who made it';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_identity_decider
  before insert or update of organization_id, identity_decided_by on network_connections
  for each row execute function enforce_network_connection_decider();

-- A confirmation is of the facts as recorded. Editing them (or marking the
-- person do-not-research) voids a confirmation. BEFORE: rewrites NEW. The
-- candidates are deleted by the AFTER trigger below, not here, because a
-- candidate delete may itself touch this row.
create function reset_network_identity_on_edit() returns trigger as $$
begin
  if old.identity_status = 'confirmed' and (
       new.person_name is distinct from old.person_name
    or new.affiliation is distinct from old.affiliation
    or new.title is distinct from old.title
    or new.city is distinct from old.city
    or new.state is distinct from old.state
    or (new.do_not_research and not old.do_not_research)
  ) then
    new.identity_status := 'unconfirmed';
    new.identity_decided_by := null;
    new.identity_decided_at := null;
    new.identity_candidate_id := null;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger network_connections_identity_reset
  before update on network_connections
  for each row execute function reset_network_identity_on_edit();

-- AFTER: a person who goes back to unconfirmed (an edit, or a human reset)
-- starts clean, and a person marked do-not-research keeps nothing that was
-- found. pg_trigger_depth() > 1 means this update came from inside another
-- trigger (the candidate-delete trigger below voiding a decision), where the
-- OTHER candidates must survive and a nested delete of the row being deleted
-- would raise.
create function clear_network_candidates_after_identity_reset() returns trigger as $$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if (old.identity_status <> 'unconfirmed' and new.identity_status = 'unconfirmed')
     or (new.do_not_research and not old.do_not_research) then
    delete from network_identity_candidates where network_connection_id = new.id;
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_identity_clear_candidates
  after update on network_connections
  for each row execute function clear_network_candidates_after_identity_reset();

-- Deleting the chosen candidate on its own voids the confirmation rather than
-- leaving it dangling. When the delete is the cascade from erasing the person,
-- the person is already gone and this updates no row.
create function void_network_identity_when_candidate_deleted() returns trigger as $$
begin
  update network_connections
     set identity_status = 'unconfirmed',
         identity_decided_by = null,
         identity_decided_at = null,
         identity_candidate_id = null
   where identity_candidate_id = old.id;
  return old;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_identity_candidates_void_decision
  before delete on network_identity_candidates
  for each row execute function void_network_identity_when_candidate_deleted();
```
