# Build report: item 112, slice B of the way in (research each confirmed person), ruling 0044 clauses 3, 4, 5, 9, 10 and clause 2's gate

Build space, 2026-11-06. Authorized by `docs/ledger/STATE.md` "Authorized now" (item 112 only; slices C to E not touched). Nothing under `docs/ledger/**`, `CLAUDE.md` or any existing migration was edited by me (`docs/ledger/STATE.md` already showed as modified in `git status` before I started; I did not touch it). Nothing committed or pushed. **Migration 0085 is not applied to any database** (it was run, with every other migration, on a real Postgres, section 5). Item 110 (migration 0084) was not touched; 0084 is absent from this tree. No live service was called and no real AI call was made. No STATE item was appended (the brief forbade editing `docs/ledger/**`): the decision space should open one from this report.

**The invariant implemented:** once a human has confirmed which real person a recorded person is, the platform researches that one person on the public web and stores only findings of a closed list of kinds whose url, title and passage are the ones the web search actually returned (never typed by a model), tested for support by code and strikeable by a human; and nothing is researched about anyone who is not confirmed, is marked do-not-research, or was already researched, and no list, import or batch confirmation ever starts a research.

## 1. What changed, file by file

New files:

| File | What it is |
|---|---|
| `supabase/migrations/0085_network_person_findings.sql` | The migration (full SQL inlined at the end). One table `network_person_findings`; closed-kind CHECK, shape / text / status / decision / source-URL checks; a case-insensitive unique index; RLS (select, insert, update; deliberately no delete); five security-definer or guard functions and five triggers (org match on person and run, strike/restore pinned to the signed-in human, an update guard that lets only a strike or a restore through, and the clear-on-identity-change trigger on `network_connections`). |
| `lib/network-research.ts` | The pure core (no database, no model, no Next). The closed kinds and labels; `refusalForResearch` (the refusals, in order: do not research, none of these, not confirmed, no name, no readable confirmed match, already researched unless an explicit again); `researchedAtFrom` and `researchAgeText` (calendar days, ruling 0041); `planResearchQueue`; the two prompts and `PERSON_FINDINGS_TOOL` (closed schema: source number, kind enum, organization, role); `validatePersonFindings` (every guard in code, below); `attestFinding`; `capturedTextNamesPerson` (the wrong-person guard); `findingKey`; the review shapes (`buildReviewFinding`, `groupFindings`, `isUsableFinding`); the click statements and summary text (`researchCostStatement`, `researchSummary`, `toLoopResult`, `RESEARCH_SHARED_STATEMENT`). |
| `lib/ai/person-research.ts` | The research operation (server-only). Web SEARCH only, then a forced-tool selection from the numbered captured sources. Imports the identity look's tool settings, blocked domains, model, timeouts, reading of the response (`capturedSources`) and source indexing (`indexPersonSources`) rather than copying them. No `fetch(`, no fetch tool, no ProPublica or IRS call. |
| `lib/network-research-store.ts` | Read-only, session-client readers: `findingsTableReadable`, `loadResearchedAt`, `loadResearchOverview` (confirmed people and their finished research runs, paged past the 1000-row limit against an exact count), `loadFindingsFor`. Tolerant of a database without 0085. |
| `app/(dashboard)/network/research-actions.ts` | The server actions: `researchPerson(personId, again?)`, `loadResearchQueue()`, `loadPersonFindings(personId)`, `strikeFinding(id)`, `unstrikeFinding(id)`. `researchPerson`: refusals at lines 233 to 241 (table probe, then `refusalForResearch`), `beginRun` at line 139 of `researchOne`, the model call at line 145. |
| `app/(dashboard)/network/research/use-person-research.ts` | The client hook for one person's research (`run(again)`, `strike`, `restore`). No effect, no timer. |
| `app/(dashboard)/network/research/findings-view.tsx` | `FindingsView` (presentational, every phase) and `FindingsSection` (driven by the hook): "Researching…", "What we found" grouped by kind with source link (new tab, `rel="noopener noreferrer nofollow"`), the page's own words, the label "Not yet reviewed by a person" and Strike; "Could not be checked against the source (N)" collapsed; "Struck (N)" collapsed with Restore; the age; "Research again"; a failed research says so and offers "Try again". |
| `app/(dashboard)/network/research/person-research-block.tsx` | The block on a confirmed person's card in the Network list. |
| `app/(dashboard)/network/research/research-runner.tsx` | "Research your network (N)": `ResearchRunnerView` and `ResearchRunner`. Reuses `runLookupLoop` / `buildLookupQueue` from `lib/network-identity-flow.ts` unchanged. |
| `scripts/test-network-research.ts` | 218 assertions (section 3). |
| `scripts/test-network-research-migration.ts` | 141 assertions on a real Postgres (section 5). |
| `scripts/mutation-check-network-research.ts` | 68 mutations (section 4). |

Changed files:

| File | Change |
|---|---|
| `lib/ai-runs.ts` | `"network_research"` added to `AI_RUN_OPERATIONS`, with its own comment. There is no pricing registry in code (the ledger records; decision 0006 leaves the credit price to the owner, as for `network_identity`), so this entry is where its price attaches. |
| `lib/ai/person-search.ts` | One word: `capturedSources` is now `export`ed so research reads the search response the same way. Nothing else in the file changed. |
| `lib/network.ts` | `NETWORK_DISCLOSURE` gains one sentence (section 7). Every earlier phrase is kept word for word; `NETWORK_IMPORT_DISCLOSURE` still starts with the capture disclosure unweakened. |
| `app/(dashboard)/network/identity/person-card.tsx` | In `single` mode only, after `confirmIdentity` has succeeded (the error returns first), the same click's continuation calls `research.run(false)` (line 143, after line 134). The finished card shows the findings section. Review mode starts no research. No effect added. |
| `app/(dashboard)/network/network-workspace.tsx` | `ResearchPageData`; a keyed `PersonResearchBlock` on each confirmed (not do-not-research) person's card; the `ResearchRunner` section when research is available; a plain note when it is not (migration 0085); the "Confirm your network" paragraph no longer says nothing is researched beyond identity (it now says what is researched after a confirmation). |
| `app/(dashboard)/network/page.tsx` | Reads (read-only) the research overview and the findings of the confirmed people on the page. Comment on `maxDuration = 450` updated; the value is unchanged. |
| `app/(dashboard)/network/identity/page.tsx`, `identity-workspace.tsx` | Reads the research count; renders the separate `ResearchRunner` when the count is a number. The batch confirm handler is untouched and names nothing about research. Paragraph updated. |
| `scripts/network-test-support.ts` | The fake client gains a default row for `network_person_findings`. |
| `scripts/test-ai-runs.ts`, `test-network-import.ts`, `test-assistant.ts`, `test-agent.ts` | Section 6. |

Not changed: `lib/network-identity.ts`, `lib/network-identity-flow.ts`, `identity-actions.ts`, `actions.ts` (the edit and delete actions), the import files, `add-person-result.tsx`, the assistant, agent and API code, path-finding, `app/(dashboard)/network/import/page.tsx` (its `maxDuration = 450` is already there). No new environment variable. The Anthropic client is imported only by `lib/ai/person-research.ts` (scan asserts it; `next build` compiled).

## 2. Counts, before and after (real runs of `npx tsx scripts/<name>.ts`)

"Before" was taken on the tree as I received it, before any edit.

| Suite | Before | After |
|---|---|---|
| test-network | 183 / 0 | 183 / 0 |
| test-network-import | 156 / 0 | 156 / 0 (one assertion's wording and allowance changed: section 6) |
| test-network-identity | 303 / 0 | 303 / 0 |
| test-network-identity-flow | 114 / 0 | 114 / 0 |
| test-network-identity-migration | 96 / 0 | 96 / 0 (now applies 84 files, 0085 included) |
| test-assistant | 585 / 0 | 585 / 0 |
| test-agent | 344 / 0 | 344 / 0 |
| test-supporters | 182 / 0 | 182 / 0 |
| test-send-draft | 268 / 0 | 268 / 0 |
| test-reply-address | 138 / 0 | 138 / 0 |
| test-ai-runs | 70 / 0 | 72 / 0 (two assertions for the new operation file) |
| test-health-status | 19 / 0 | 19 / 0 |
| **test-network-research** (new) | n/a | 218 / 0 |
| **test-network-research-migration** (new) | n/a | 141 / 0 |
| `npx tsc --noEmit` | clean | clean |
| `npx next build` | not run before (item 109 report: compiled) | "Compiled successfully", linting and types passed, 39 static pages; `/network`, `/network/identity`, `/network/import` in the route list |
| `npx tsx scripts/ledger-check.ts` | | "protocol intact" |
| earlier `mutation-check-network-identity.ts` | 18 of 18 | 18 of 18 still caught |
| earlier `mutation-check-network-identity-flow.ts` | 23 of 23 | 23 of 23 still caught |

`test-tenant-isolation` was not run (needs live credentials; unchanged from items 108 and 109) and I did not add a section to it for 0085: the same behaviours are proven on a real Postgres instead (section 5).

## 3. What the new test (218 assertions) proves

Section numbers are the script's.

1. The six kinds exactly as the ruling lists them; `isFindingKind` refuses family, children, health, wealth, politics, religion, address and case variants; the cap of 12 per run; the click cap of 50 is the identity look's own constant.
2. Refusals and the age of what is held: unconfirmed, none of these, do not research (outranks everything, even with "again"), no name, no readable confirmed match, already researched (the age, "Researched 3 days ago", comes back with the refusal), a run from before the current confirmation does not count, calendar-day arithmetic, and a queue that accounts for everyone.
3. The prompts carry only the recorded name, employer, title, city and state plus the confirmed match's headline, place and page; both name the six kinds, say plainly what is not to be reported and do not ask for it; the answer schema has four fields and no field for a URL, title, passage or anything private.
4. The guards in code: a typed URL, title or passage is never read; a source number outside the captured list, a non-whole number, a non-object and a non-list store nothing and are logged; 18 attempts at kinds outside the list (family, children, spouse, health, wealth, net worth, income, politics, religious membership, home address, private life, case variants) store nothing and are logged; the wrong-person guard; unsupported claims are stored with the missing words recorded; contact details in an organization or role drop the finding whole, and the captured passage is scrubbed before storage; social and broker sources are refused when building the list and again at validation, for every host of both lists; duplicates; the kind-specific shape; the cap keeps supported findings first; a page about a spouse, children, cancer, a $2 million gift, a party and a home address yields nothing when labelled with any kind outside the list.
5. The real `researchPerson` action with a scripted model: two model calls, same tool version, `allowed_callers`, blocked domains (exactly the two lists), model and timeouts as the identity look, no fetch tool; the prompts carry no notes or how-known text; ONE ledger run, operation `network_research`, born before the first model call and before any finding is written, finalized with both calls' tokens; the stored findings carry only captured URL, title and passage; the insert names exactly the finding columns and never `organization_id`, a status or a striker; nothing but the ledger and the findings table is written; a second plain call is refused with the age; an all-social search makes no selection call and the run is `empty`, and "found nothing" counts as researched; a failed second call stores nothing, finalizes `failed` with the first call's tokens, and leaves the person confirmed; a failed ledger birth means no model call; a person reset, re-confirmed or marked off limits while the model works gets nothing saved.
6. Refusals before any run or model call, for five kinds of person, with hostile extra arguments ("again", `force`, `ledger: false`) and malformed ids; source order (refusal, then birth, then model); research refused, before a run is born, when the findings table is missing.
7. Research again: additive; the finding already held is not written twice; a struck one is not resurrected; a person reset and confirmed again is researchable with a plain call.
8. The queue read: 60 confirmed people, 2 researched, plus do-not-research, unconfirmed and none-of-these people: 58 waiting, ids capped at 50; the real client loop researches 50 one at a time with one run each, resumes, refuses a hostile queue for all four kinds, and Stop works.
9. Reading, striking and restoring: the strike records the verified session user and the time, an extra argument cannot name a different striker, the update names only the strike columns, a struck finding is never deleted, only a strike changes what is usable.
10. The ledger operation, in `AI_RUN_OPERATIONS`, finalized on every outcome, `beginRun` once.
11. Who may start a research (source scans plus the real code): `researchPerson(` is called from exactly three places; nothing starts one on load; the person card's single call is after a successful confirmation and only in single mode; the batch confirm handler names nothing about research; no import file names it; the pages that load data call no action; the assistant, the external agent and the HTTP routes name nothing; the existing forbidden-import scans were extended, not loosened.
12. Findings enter nothing: of 246 files under `lib/` and `app/`, the findings table and research module are named only in the network research files, the person card, and the Network pages (exact list); path-finding, strategy and draft files name none.
13. No fetch, no ProPublica or IRS, session client only, secrets stay on the server, the read actions make no write.
14. Screens rendered to static HTML for every phase and the batch button, the Network page (with research, without, with the table missing, unconfirmed and do-not-research people) and the review screen.
15. The disclosure covers findings, and what it says is shared is what the real prompts carry (with sentinel notes and how-known text that must not appear).

## 4. Mutation table (`npx tsx scripts/mutation-check-network-research.ts`: 68 of 68 caught)

For each mutation the script confirms the text to change appears exactly once, writes the mutated source, runs the test, requires a FAIL whose label contains the named text, and restores the file byte for byte (checked; `git status` afterwards shows only my intended changes). R* run the application test; D* mutate the migration and run the real-Postgres test. "Result" is passed / failed of the test that was run. The failing assertion shown is the first one listed; each mutation also required its own named label to match.

One mutation was NOT caught on the first run: **D6** (the do-not-research clause of the clear trigger). It was unreachable by any test because 0083's reset trigger already voids a confirmed person's identity when they are marked do-not-research, so the findings were cleared by the first clause. I added a test that switches off 0083's reset and candidate-clearing triggers for one statement and shows the flag alone clears the findings; D6 is caught by it (140 passed, 1 failed). The first full run was 67 of 68; the table below shows D6 as re-run.

| # | Guard broken | File | First failing assertion | Result |
|---|---|---|---|---|
| R1 | an unconfirmed person may be researched (the refusal rule forgets the confirmation) | `network-research.ts` | NO RESEARCH WITHOUT A CONFIRMATION (unconfirmed): refused, with the reason in plain words | 215 / 3 |
| R1b | the server action stops asking the rule (no refusal in code before a run is born) | `research-actions.ts` | ALREADY RESEARCHED (end to end): a second plain call is refused, says how long ago, and makes no run and no model call | 203 / 15 |
| R2 | a do-not-research person may be researched (the rule forgets the flag) | `network-research.ts` | DO NOT RESEARCH outranks everything, even a confirmed person asked for again | 212 / 6 |
| R3 | a person already researched is researched again by a plain call (the rule forgets the ledger) | `network-research.ts` | ALREADY RESEARCHED: refused unless asked again, and the AGE of what is held comes back with the refusal (3 calendar days) | 211 / 7 |
| R3b | a missing 'again' is read as an explicit again (a plain call re-researches) | `research-actions.ts` | ALREADY RESEARCHED (end to end): a second plain call is refused, says how long ago, and makes no run and no model call | 212 / 6 |
| R3c | a research run from before the current confirmation counts as 'researched' | `network-research.ts` | ... and a run from BEFORE the current confirmation does not count (the person was reset and confirmed again, so the research was of another decision) | 216 / 2 |
| R4 | the ledger run is not born (no beginRun) before the model is called | `research-actions.ts` | ONE ledger run is born for the whole research, as operation network_research pointing at the person | run aborted (exception) after the named FAIL |
| R5 | the model can type the URL (a typed source_url is used instead of the captured one) | `network-research.ts` | THE MODEL CANNOT TYPE A URL, TITLE OR PASSAGE (in code): a typed URL, title or passage is never read; the stored ones are the CAPTURED ones | 216 / 2 |
| R5b | the model can type the passage (a typed passage is stored instead of the captured one) | `network-research.ts` | THE MODEL CANNOT TYPE A URL, TITLE OR PASSAGE (in code): a typed URL, title or passage is never read; the stored ones are the CAPTURED ones | 217 / 1 |
| R5c | the model's answer schema gains a free url field | `network-research.ts` | THE MODEL CANNOT TYPE A URL, TITLE OR PASSAGE: the answer's schema has exactly four fields (source number, kind, organization, role) and allows no ... | 216 / 2 |
| R6 | a kind outside the closed list is stored (the code-level kind check is gone) | `network-research.ts` | CLOSED KINDS IN CODE: a finding of any kind outside the list -- family, children, spouse, health, wealth, net worth, income, politics, religious me... | 212 / 6 |
| R6b | isFindingKind accepts any text | `network-research.ts` | isFindingKind accepts the six and nothing else (not family, children, health, wealth, politics, religion, address; not a case variant) | 212 / 6 |
| R7 | the wrong-person guard is removed (a page that never names the person yields findings) | `network-research.ts` | WRONG-PERSON GUARD: a source whose captured title and passage do not contain the person's name (a page about the church; a page about 'Jane Smith')... | 206 / 12 |
| R7b | the wrong-person guard needs only SOME name token, not every one | `network-research.ts` | WRONG-PERSON GUARD: a source whose captured title and passage do not contain the person's name (a page about the church; a page about 'Jane Smith')... | 216 / 2 |
| R8 | a finding the captured text does not support is DELETED instead of stored with supported = false | `network-research.ts` | UNSUPPORTED IS STORED, NOT DELETED: a claim whose words the captured text does not contain is kept with supported = false (an invented organization... | 207 / 11 |
| R8b | every finding is called supported (the attestation is not computed) | `network-research.ts` | UNSUPPORTED IS STORED, NOT DELETED: a claim whose words the captured text does not contain is kept with supported = false (an invented organization... | 209 / 9 |
| R8c | an unsupported finding counts as usable (nothing excludes it from use) | `network-research.ts` | unsupported findings are not USABLE (supported && included); supported ones are; a struck supported one is not | 215 / 3 |
| R9 | a source on a social network or broker is accepted at validation (defence in depth removed) | `network-research.ts` | NO SOCIAL OR BROKER SOURCE (defence in depth): even if one reached the list, a finding on LinkedIn, ZoomInfo, Facebook or a non-web address is disc... | 216 / 2 |
| R9b | social and broker pages are offered to the model (the captured list is no longer filtered) | `network-identity.ts` | NO SOCIAL OR BROKER SOURCE (building the list): LinkedIn and ZoomInfo pages that the search returned are left out of the sources the model is offer... | 213 / 5 |
| R10 | contact details are no longer scrubbed from the captured passage before it is stored | `network-identity.ts` | SCRUBBED: emails, phones, links, handles and street addresses are removed from the captured title and passage BEFORE anything is stored | 216 / 2 |
| R10b | a finding whose organization or role carries a contact detail is kept | `network-research.ts` | a finding whose organization or role carries an email, phone, link, handle or street address is dropped WHOLE (a half-redacted claim is worse than ... | 217 / 1 |
| R11 | the cap of 12 findings per run is gone | `network-research.ts` | THE CAP: at most 12 findings per person per run; supported ones are kept FIRST, so the cap never drops a finding the text supports in favour of one... | 217 / 1 |
| R11b | the cap no longer prefers supported findings | `network-research.ts` | THE CAP: at most 12 findings per person per run; supported ones are kept FIRST, so the cap never drops a finding the text supports in favour of one... | 217 / 1 |
| R12 | the person's notes reach the search (the facts handed to the model include a field they must not) | `research-actions.ts` | a confirmed person is researched: the action succeeds and says how many things the sources support | run aborted (exception) after the named FAIL |
| R13 | findings are written for a person who was reset or marked off limits while the model worked | `research-actions.ts` | a person who is reset, confirmed as someone else, or marked off limits WHILE the model works gets nothing saved: the findings rested on an identity... | 216 / 2 |
| R14 | a strike is not recorded as the signed-in human | `research-actions.ts` | A STRIKE IS HUMAN-ONLY AND RECORDED: striking records status 'struck', WHO (the verified session user, not a value from the request) and WHEN, and ... | 216 / 2 |
| R14b | a restore is not recorded as the signed-in human | `research-actions.ts` | restoring records who and when and clears the strike; the finding itself is unchanged | 217 / 1 |
| R15 | THE BATCH CONFIRM STARTS RESEARCH (the 'Confirm your network (N)' handler researches the people it confirms) | `identity-workspace.tsx` | researchPerson( is called from exactly three places in the app: the research hook (a click, or the confirm continuation), the batch button, and the... | 215 / 3 |
| R15b | the person card researches after ANY confirmation, not only in the single-person panel | `person-card.tsx` | CONFIRM NEVER TRIGGERS RESEARCH EXCEPT THE SINGLE CARD: in the person card, research.run( appears exactly once; it is inside confirmChosen, after c... | 217 / 1 |
| R15c | the person card researches even when the confirmation FAILED | `person-card.tsx` | CONFIRM NEVER TRIGGERS RESEARCH EXCEPT THE SINGLE CARD: in the person card, research.run( appears exactly once; it is inside confirmChosen, after c... | 217 / 1 |
| R15d | the person card researches by itself on load (an effect, no click) | `person-card.tsx` | NOTHING STARTS A RESEARCH ON LOAD: the hook, the findings view, the people-list block and the person card have no effect, timer or page-load hook | run aborted (exception) after the named FAIL |
| R15e | the import page can start a research | `import-workspace.tsx` | AN IMPORT NEVER TRIGGERS RESEARCH: no import-flow file names a research action, the runner, the hook or the research module | 215 / 3 |
| R15f | the Network page researches while loading | `page.tsx` | the pages that load data (network/page.tsx, identity/page.tsx) call no research or confirm ACTION: they only read through the store | 217 / 1 |
| R16 | path-finding reads the findings table | `network-shortlist.ts` | FINDINGS ENTER NOTHING: of 246 files under lib/ and app/, the findings table and the research module are named ONLY in the network research files, ... | 215 / 3 |
| R16b | a draft or strategy file reads a person's findings | `strategy-actions.ts` | FINDINGS ENTER NOTHING: of 246 files under lib/ and app/, the findings table and the research module are named ONLY in the network research files, ... | 215 / 3 |
| R17 | the external agent's tool registry reaches the research actions | `tools.ts` | THE ASSISTANT AND THE AGENT CANNOT RESEARCH OR STRIKE: none of the 49 files of the assistant, the external agent and the HTTP routes names any rese... | 215 / 3 |
| R17b | the MCP route reaches the research actions | `route.ts` | THE ASSISTANT AND THE AGENT CANNOT RESEARCH OR STRIKE: none of the 49 files of the assistant, the external agent and the HTTP routes names any rese... | 215 / 3 |
| R18 | a page-fetch tool is offered to the model | `person-research.ts` | ... and offers NO fetch tool: the platform never opens a page itself | 216 / 2 |
| R19 | the search is no longer asked to leave social and people-data sites out | `person-research.ts` | ... asks the provider to leave social networks and people-data sites out (blocked_domains = exactly the two lists), as a request | 217 / 1 |
| R20 | a person with only unsupported findings counts as 'with findings' in the batch loop | `network-research.ts` | toLoopResult counts a person as 'with findings' only when something USABLE was found (unsupported ones do not count) | 217 / 1 |
| R21 | the per-click cap of 50 is raised | `network-research.ts` | THE CAP OF 50 PER CLICK is the identity look's own cap, not a second copy: 50, and the loop's ceiling is the same constant | 215 / 3 |
| R22 | the batch loop passes 'again' (it could research the same people twice) | `research-runner.tsx` | ... it calls the SINGLE-person action in the loop, passing the id alone (never 'again') | 217 / 1 |
| R23 | the batch button starts by itself when the page loads (an effect calls start) | `research-runner.tsx` | ... the batch button's one effect only STOPS the loop on leaving the page (a cleanup that sets the stop flag and starts nothing) | 216 / 2 |
| R24 | the disclosure no longer says that confirmed people are researched and findings kept | `network.ts` | capture disclosure: once a person is confirmed the platform may research what the public web says about them | 211 / 7 |
| R25 | the cost note is dropped from the click that spends | `network-research.ts` | THE BATCH BUTTON: 'Research your network (212)' with the count, that each person costs one AI run, heavier than a match look because it reads more,... | 216 / 2 |
| R26 | research is attempted (and a run born) with the findings table missing | `research-actions.ts` | CODE AHEAD OF THE MIGRATION: with the findings table missing, research is refused BEFORE a run is born -- no AI run is spent for findings that coul... | 217 / 1 |
| R27 | a re-run writes findings that are already held (and brings back a struck one) | `research-actions.ts` | ... it ADDS only what is new: the finding already held is not written twice, and the one a human STRUCK is not written again (it stays struck, it i... | 216 / 2 |
| R28 | the 'Could not be checked against the source' findings are shown as ordinary findings | `network-research.ts` | the usable findings are NOT inside a collapsed section; the ones the text did not support are, under 'Could not be checked against the source (1)' | 217 / 1 |
| R29 | the 'Not yet reviewed by a person' label is dropped from a finding | `findings-view.tsx` | ... the label 'Not yet reviewed by a person' on every finding shown as usable (3 of them), and a Strike button on each | 215 / 3 |
| R30 | the source link opens in the same tab without rel noopener | `findings-view.tsx` | ... each shows the SOURCE link, opening in a new tab with rel noopener, pointing at the captured address | 217 / 1 |
| D1 | the database accepts a kind outside the closed list | `0085_network_person_findings.sql` | a finding of ANY other kind -- family, children, health, wealth, politics, religious membership, home address, private life -- is refused, as is a ... | 138 / 2 |
| D2 | the database lets a finding be born for an unconfirmed person | `0085_network_person_findings.sql` | an unconfirmed person cannot be given a finding, by any path | 136 / 4 |
| D3 | the database lets a finding be born for a do-not-research person | `0085_network_person_findings.sql` | a do-not-research person cannot be given a finding | 139 / 1 |
| D4 | the database accepts a social-network or broker source (the host list is emptied) | `0085_network_person_findings.sql` | every one of the 37 hosts the code refuses is refused by the database too (no drift) | 136 / 4 |
| D5 | editing a confirmed person's facts no longer deletes their findings (the trigger is never created) | `0085_network_person_findings.sql` | changing person_name: the person is back to unconfirmed and all 3 findings are gone; another person's finding is untouched | 121 / 19 |
| D6 | marking a person do-not-research no longer deletes their findings | `0085_network_person_findings.sql` | the do-not-research clause works by itself: even if the person were left 'confirmed' (0083's reset and candidate-clearing switched off for the stat... | 140 / 1 |
| D7 | confirming a different candidate keeps the findings that rested on the first | `0085_network_person_findings.sql` | confirming a DIFFERENT candidate of the same person (re-pointing the confirmation) deletes the findings that rested on the first | 139 / 1 |
| D8 | the unique index reads a missing organization as distinct nulls and is case-sensitive | `0085_network_person_findings.sql` | ... case does not make it new | 137 / 3 |
| D9 | a finding's content becomes editable (the guard trigger is never created) | `0085_network_person_findings.sql` | kind cannot be edited | 126 / 14 |
| D10 | a signed-in user can record a strike as someone else | `0085_network_person_findings.sql` | a signed-in user cannot record a strike as a different teammate | 138 / 2 |
| D11 | a finding can be written for another organization's person | `0085_network_person_findings.sql` | a finding for Org B's person cannot be written as Org A's row | 138 / 2 |
| D12 | a DELETE policy is added (a struck finding could be made to disappear) | `0085_network_person_findings.sql` | NOBODY can delete a finding directly: not Org A's user on their own finding, not Org B on Org A's | 137 / 3 |
| D13 | any organization can read any other's findings | `0085_network_person_findings.sql` | Org A's user sees Org A's findings and none of Org B's | 138 / 2 |
| D14 | a struck finding need not say who struck it or when | `0085_network_person_findings.sql` | 'struck' with no striker and no time is refused | 135 / 5 |
| D15 | a bare title need not name a role, and other kinds need not name an organization | `0085_network_person_findings.sql` | a title with no role is refused | 133 / 7 |
| D16 | erasing a person no longer erases their findings (no cascade) | `0085_network_person_findings.sql` | erasing a CONFIRMED person with findings (one struck) succeeds | run aborted (exception) after the named FAIL |
| D17 | a finding can cite another organization's ledger run | `0085_network_person_findings.sql` | a finding citing another organization's run is refused | 139 / 1 |
| D18 | a person who stops being confirmed (reset, 'none of these') keeps their findings | `0085_network_person_findings.sql` | changing person_name: the person is back to unconfirmed and all 3 findings are gone; another person's finding is untouched | 126 / 14 |

Where the evidence is a source scan rather than behaviour (R15 to R17b, R23), the guard is a regular-expression scan of the component source, not a click in a browser; R29 and R30 are checked on the server-rendered HTML. It catches the shapes I thought of; a differently written auto-research in a client component would need a human reviewer or a browser test to be noticed.

## 5. Real-Postgres verification of migration 0085

`scripts/test-network-research-migration.ts` uses the pglite package (`select version()`: PostgreSQL 18.6 (PGlite 0.5.15)), in process, with the same minimal Supabase shim as the 0083 test (roles `anon`, `authenticated`, `service_role`; an `auth` schema with `uid()` reading `request.jwt.claim.sub`; a `storage` stub; Supabase's default grants). It applies **every migration file in `supabase/migrations`, unchanged and in order: 84 files (0001 to 0083 and 0085; 0084 is absent from this tree), with no error**. It then runs 141 assertions, as the superuser for fixtures and as the `authenticated` role (JWT subject set) for anything about row-level security.

What is asserted, with the number of the group in the script's order: the exact column list, defaults and `NOT NULL`s, and no contact-detail column; the kind CHECK (all six accepted; 23 other values, including a case variant, refused; the database's list read back from the catalog equals `FINDING_KINDS`); the shape check (bare title needs a role, every other kind needs an organization); text bounds; the decision check (a dozen cases, including the last human action being the one recorded); the source-URL check against all 37 host names the code refuses, in subdomain, port, user-info, upper-case and fragment forms, plus lookalikes that must be accepted, and the host list read back from the catalog equal to both the code's lists and 0083's constraint; the unique index (a repeat refused, case does not make it new, a bare title is unique, a struck finding cannot be resurrected by writing it again); the gate (unconfirmed, with candidates waiting, none-of-these and do-not-research people cannot be given a finding, also as a signed-in user); org-match on the person and on the ledger run; strike and restore pinned to the signed-in human and the organization; nothing editable except a strike (every content column, the person and the organization; an edit that changes nothing is accepted; deleting a ledger row the finding cites works and clears the reference); RLS (A sees only A, B cannot strike A's finding, nobody can delete a finding directly, the policies are exactly select, insert, update); the clears (each of the five facts, a clearing edit, notes/how-known/strength edits and no-op saves keep the findings, a signed-in edit, reset, none-of-these, do-not-research on its own, confirming a different candidate, deleting the chosen candidate, deleting a non-chosen one keeps them, deleting all candidates in one statement, one statement editing two people clears each person's own and nobody else's); the cascade (erasing a confirmed person with a struck finding, as a signed-in user although findings have no delete policy, and a bulk erase of five); a human flow under RLS (confirm, three findings one unsupported, strike, strike again matches no row, restore, edit voids all, confirm again starts clean and the same finding can be written again); additivity (no drop, rename or create-or-replace; the only table altered is the new one; five functions, four security definer with the search path pinned; five triggers).

Design points found while building it, recorded in the SQL comments: the clear trigger is an AFTER trigger on `network_connections` and is deliberately **not** guarded by `pg_trigger_depth()` (0083's candidate-clearing trigger is, to keep other candidates; here the opposite is wanted: when deleting the chosen candidate voids a decision, the findings must go with it); and the update guard must permit the foreign key's own `ai_run_id -> null`, which the test exercises by deleting a ledger row.

What this does not prove: it is PGlite's Postgres, not the Supabase platform; it does not run PostgREST; the shim's `auth.uid()` is mine. The live isolation suite remains the check against the deployed database (and I did not extend it).

## 6. Edits to existing files that carry assertions (every one)

None weakens a guard; no assertion was deleted.

| File | Edit |
|---|---|
| `scripts/test-ai-runs.ts` | Additive, at the extension points the file documents: `lib/ai/person-research.ts` added to `HELPER_FILES`; `app/(dashboard)/network/research-actions.ts` added to `OPERATION_FILES`; `"await findPersonFindings("` added to `MODEL_CALL_TOKENS`. The set of model-calling files is still asserted to be exact, and the new file is checked for a `beginRun` before its first model call and a `finalizeRun`. 70 to 72. |
| `scripts/test-network-import.ts` | The "no migration added or changed" assertion allowed exactly `0083_network_identity.sql`; it now allows exactly `0083_network_identity.sql` and `0085_network_person_findings.sql` (label updated). I also made the second half (`git diff HEAD`) filter line by line instead of removing the first matching line. **When item 110's migration 0084 lands, this allowance must be extended the same way** (that is a collision between the two items, not something I can resolve from here). |
| `scripts/test-assistant.ts`, `scripts/test-agent.ts` | The forbidden-import and forbidden-reference regexes gain `research-actions`, `person-research`, `network-research`, `findPersonFindings`, `researchPerson`, `strikeFinding`, `unstrikeFinding` and `network_person_findings`; every earlier alternative is still there. (`research-actions` also matches the funder side's own file, which these scans already forbade for the assistant.) |
| `scripts/network-test-support.ts` | A default row for `network_person_findings` (the column defaults of 0085). Older suites never insert one. |

## 7. Disclosure (ruling 0044 clause 10)

The capture disclosure (`NETWORK_DISCLOSURE`, rendered on the add and edit form, and, as the start of `NETWORK_IMPORT_DISCLOSURE`, on the import page) gains one sentence after the identity sentence: once a person is confirmed the platform may also research what the public web says about them in a few public, organizational kinds only (where they work, their title, a board, trustee or officer seat, a school, a role in a church or other organization), keeps each finding with its source marked as not yet reviewed for the user to review or strike, and that research shares the same details plus the description and page of the match the user confirmed and still not notes or how they know the person. Every phrase the earlier tests pin is unchanged. `RESEARCH_SHARED_STATEMENT` says the same at the click that spends and on the findings. The test (section 15) asserts each clause of the new sentence and, against the real prompts built from a row with sentinel notes and how-known text, that everything the disclosure says is shared is in what was sent and what it says is not shared is not.

## 8. What I saw, and what I could not see

* **Could not see:** the real app. `/network` and `/network/identity` sit behind sign-in and the dev server uses `.env.local`, whose Supabase target I did not open or sign in to (that could be production data). I did not start the dev server.
* **Saw:** every new screen rendered with fixture data (server-rendered HTML written to a scratch folder outside the repo, served on localhost, opened in the Browser pane at 390 px and, once, at 980 px): researching in place; "What we found" with grouped findings, source links, the page's own words, the label and Strike; the two collapsed sections closed and then opened (unsupported with its explanation; struck, struck through, with Restore); a failed research with "Try again" and the line that the person is still confirmed; a confirmed person not yet researched with "Research this person" and the cost; "Research your network (212)" idle (the next 50 of 212), running at "Researching 7 of 20" with Stop and a progress bar, and finished after a Stop; the Network page with a researched person, an unresearched confirmed person and an unconfirmed person (no research UI); the review screen with the separate research button. Nothing overflowed at 390 px.
* **Not seen, because static HTML cannot show it:** any click, the loop running, Stop, "Researching…" turning into "What we found" in the single-person card (I rendered the same `FindingsView` inside a mock card; the card's own done state needs React state and was not rendered), the remount of a person's block after the page re-renders, keyboard and focus behaviour. The handlers are covered by source scans and by running the same server functions in the same order, not by clicking.
* The findings section repeats the "what is shared" statement under every researched person's card in the people list. It is small and muted, but it is visibly repetitive at 20 cards a page; no design pass was attempted (CLAUDE.md). Tokens from `lib/ui.ts`, `boxSizing: border-box`, one spacing scale.

## 9. Decisions for the decision space (safest reading taken in each)

1. **"Researched" has no column; it is read from the ledger.** A person's current identity counts as researched when a finished `network_research` run (completed, or empty = looked and found nothing) ended after `identity_decided_at`. A failed run does not count, so "Try again" works with a plain call; a run from before a reset and a fresh confirmation does not count. The decision check above is the guard; a column would need a ruling on where "empty" lives.
2. **Automatic research is only in the single-person panel under the add form** (`PersonCard` in `single` mode). The review screen's own per-person "Confirm this is the person" starts no research: the card unmounts when the page re-renders, so a continuation there would be lost. Those people appear in "Research your network (N)". Say if the review screen's single confirm should research too.
3. **Restore columns beyond the brief.** The brief names `struck_by` and `struck_at`. A restore was to be "recorded with who and when" too, but the decision check ties the strike columns to the status, so a restore would erase its own record. I added `restored_by` and `restored_at` (set on a restore, cleared by the next strike). History beyond the last human action is not kept.
4. **The unique key is an expression index, not a constraint on the five columns.** `organization_named` and `role_text` are nullable, and distinct nulls would let a bare title be duplicated; the index compares `lower(coalesce(x, ''))`. The code reads a finding the same way (`findingKey`, tested).
5. **No DELETE policy, and the clears are triggers only.** A struck finding must stay recorded, so nobody can delete a finding directly. The clears for edit, reset, none-of-these, do-not-research and a different confirmation are an AFTER trigger on `network_connections`; I added no deletes to `actions.ts` or `identity-actions.ts` (a delete in application code would fail before 0085 is applied and leave a reset half done).
6. **A re-run is additive.** Nothing is deleted; findings already held are not rewritten; a struck finding stays struck. An earlier included finding that a later run no longer finds stays until a human strikes it.
7. **The wrong-person guard is token containment of the name, as specified, and it is weak in two known ways.** Every distinctive token of the recorded name must appear in the captured title or passage; a page that never names the person, or names a different Jane, is discarded. It does not catch a namesake with the same full name, or a page that has "Jane" and "Whitcombe" in unrelated places. Namesakes are handled by the confirmed match in the prompt and by the human strike.
8. **What the closed kinds do and do not guarantee about private life.** The tool has no field for family, health, finances, politics, belief or address and a kind outside the list is discarded and logged (tested with 18 attempts). But the kind is the model's claim: a model could label a private-life passage with one of the six kinds and an organization or role whose words are in that passage, and it would be stored as supported. Code cannot read the meaning of an organization or role string, and a word screen would discard real board seats ("Family Foundation", "Children's Hospital"), so I did not add one. A human strike is the remaining defence. This is the same floor slice A recorded for candidate text.
9. **At most 12 findings per person per run**, supported ones first; unsupported ones count toward the 12.
10. **Search settings.** Same tool version, `allowed_callers`, blocked domains, model, `max_uses` (3) and timeouts (120 s search, 60 s selection) as the identity look, by import. `max_tokens` is 2500 on each call. The cost note says research is "heavier than a match look because it reads more": that is the brief's statement, not something I measured.
11. **The confirmed match is in the prompt only.** Its headline, place and page identify which person to research. Its captured page is not added to the numbered source list (the capture contract: findings come only from sources this run's search returned). So a confirmed person whose page the new search does not return again yields a finding from it only if the search surfaces it again.
12. **Research is refused before any run when the findings table is missing** (migration 0085 not applied), and the Network page hides the research controls and says why. A person with a confirmed match that cannot be read is refused ("reset and confirm again").
13. **Strike is offered on unsupported findings too** (the brief says a human may strike "any"); a struck unsupported finding goes to the "Struck" section.
14. **Pages read more on every render.** `/network` and `/network/identity` now also read all confirmed people and all finished research runs (paged against exact counts), and `/network` the findings of the people on the page. Each research (and each strike) calls `revalidatePath`, as the identity look does, so a 50-person click re-renders those pages up to 50 times. Unmeasured; a quieter variant is the obvious fix if it is slow.
15. **`again` must be exactly `true`.** Any other value, including a string, is a plain call.
16. **`test-network-import`'s migration allowance names 0085 only** (section 6); 0084 from item 110 will collide there.

## 10. Not verified

* **No live Anthropic call was made.** Unmeasured: whether the real search accepts `blocked_domains`; what it returns for real people and how often it cites text; how often token containment marks a real finding supported (a recorded "Senior Pastor" against a page that says "Pastor" would fail the role test); the cost and latency of a research run; the number of findings a real person yields.
* Anything that needs a click in a browser (section 8). The first real use should be one person added by hand, watched, then a small list.
* That a server action invoked from a page inherits that page's `maxDuration` (450 s on `/network` and `/network/identity`) is my understanding of Next and Vercel, as in slice A, not tested. A research run is bounded by about three minutes of model timeouts.
* That the runner and the keyed `PersonResearchBlock` behave across the re-renders `revalidatePath` causes is my reading of React (stable position and keys, a key that changes with what the server holds), not something I observed. Calls running one at a time, so that Stop works between people, is assumed, not tested.
* The triggers and policies are proven on PGlite's Postgres, not on Supabase. `scripts/test-tenant-isolation.ts` was not run and has no 0085 section.
* Concurrency (two people clicking at once on the same person) was not tested beyond the unique index; two concurrent researches of one person would each write what is new and one could fail on the index.
* `loadResearchOverview` was exercised against the fake client with 63 people, not thousands.

## 11. Where to look

`lib/network-research.ts`; `lib/ai/person-research.ts`; `app/(dashboard)/network/research-actions.ts`; `app/(dashboard)/network/research/*`; `app/(dashboard)/network/identity/person-card.tsx` (the continuation, lines 130 to 146); `supabase/migrations/0085_network_person_findings.sql`; `scripts/test-network-research.ts` (sections 5 to 12 for the invariants), `scripts/test-network-research-migration.ts`, `scripts/mutation-check-network-research.ts`.

## 12. Migration 0085, exact SQL

```sql
-- STATE item 112, slice B of item 107, authorized by ruling 0044 (clauses 3, 4,
-- 5, 9 and 10, and clause 2's gate): once a human has CONFIRMED who a recorded
-- person is, the platform may research that one person on the public web and
-- record what it finds as FINDINGS of a closed list of kinds, each kept with
-- the page and passage the web search actually returned, labelled "not yet
-- reviewed by a person", and strikeable by a human. Findings are sourced and
-- strikeable; they are NOT approved one at a time (clause 5), and they feed
-- nothing yet: no path, strategy, draft or funder-facing text reads this table.
--
-- One new table, network_person_findings, plus triggers on it and one trigger on
-- network_connections.
--
--   * kind is a CLOSED list (clause 3): employer; title; board_seat (board,
--     trustee or officer seat); school (school attended); org_leadership_role
--     (leadership or staff role in a church or other organization);
--     public_affiliation (a publicly listed affiliation held in an
--     organization's name). A finding of any other kind -- family, children,
--     health, finances, politics, a private religious membership, a home
--     address -- cannot be stored: the CHECK refuses it, whatever the code does.
--   * organization_named is the entity as the SOURCE states it (null only for a
--     bare title), role_text what the source says they hold there. A model
--     selected these; they are a CLAIM, not a fact. source_url / source_title /
--     source_passage are what the web search RETURNED (the capture contract);
--     the model never types them. `supported` is computed by CODE, by token
--     containment of the claim in the captured text (the attestation precedent);
--     a finding the captured text does not support is stored with
--     supported = false, never deleted.
--   * status is included or struck. Only a human moves it, and the decision
--     check ties who/when to it, in the manner of 0077's
--     network_path_suggestions_decision_check and 0083's identity decision check:
--     a struck finding carries who struck it and when and nothing about a
--     restore; an included finding carries no strike, and, if it was restored,
--     who restored it and when. A struck finding STAYS RECORDED (clause 5): there
--     is no DELETE policy, so nobody can make one disappear.
--   * NO column holds a contact detail (clause 1); the only URL is the captured
--     source_url.
--
-- WHAT THE DATABASE ENFORCES, beyond shape (each is exercised against a real
-- Postgres by scripts/test-network-research-migration.ts):
--   * Org match on EVERY cross-table reference (hard rule 6; 0077's reasoning: a
--     foreign-key check runs as the table owner and does not respect RLS).
--     Security-definer triggers, in 0066/0077/0083's exact pattern (set
--     search_path = public), fire on insert OR update of the referencing columns:
--       finding.network_connection_id -> the connection's organization
--       finding.ai_run_id             -> the run's organization
--       finding.struck_by / restored_by -> the human belongs to the same
--                                          organization, and when a database
--                                          session is acting that human IS the
--                                          session's user
--   * A finding can be born only for a person whose identity is CONFIRMED and who
--     is not marked do_not_research (ruling 0044 clause 2's gate and clause 10):
--     an unconfirmed, "none of these" or do-not-research person cannot be given a
--     finding by any path, whatever the application does.
--   * Nothing about a finding is editable except striking it and restoring it.
--     A BEFORE UPDATE trigger refuses a change to any other column (the only
--     other change allowed is the foreign key's own ai_run_id -> null when a
--     ledger row is deleted, which keeps the table erasable).
--   * Findings rest on the identity a human confirmed, so they cannot outlive
--     it. An AFTER UPDATE trigger on network_connections DELETES a person's
--     findings whenever they stop being confirmed (editing the identifying
--     facts of a confirmed person, which 0083's trigger already resets to
--     unconfirmed; a human reset; "none of these"; the chosen candidate being
--     deleted), whenever the confirmed candidate is changed, and whenever the
--     person is marked do_not_research. This is a trigger so that no path --
--     the application, an import, a maintenance script -- can keep stale
--     findings. Erasing the person erases their findings (ON DELETE CASCADE).
--   * A source_url must be http(s) and must not be on a social or professional
--     network or a people-data broker (ruling 0044 clause 4). The list here is
--     the same list as 0083's candidate constraint and as
--     lib/network-identity.ts (SOCIAL_NETWORK_HOSTS, PEOPLE_DATA_BROKER_HOSTS);
--     scripts/test-network-research-migration.ts fails if they drift.
--   * One finding is stored once per person: a unique index over person, kind,
--     organization, role (case-insensitive, a missing value read as empty so a
--     bare title cannot be duplicated either) and source, so a second research
--     run does not duplicate -- and cannot resurrect a struck finding.
--
-- Tenant isolation (hard rule 6, 0033_multi_tenant_rls.sql): organization_id
-- references organizations(id) default my_organization_id() with RLS scoped by
-- it. Select, insert and update policies exist for authenticated (update exists
-- so a human can strike; the trigger above limits what an update may touch);
-- there is deliberately NO delete policy.
--
-- Additive under ruling 0020: one new table, its constraints, indexes, policies,
-- functions and triggers, and one new trigger (with its own function) on the
-- existing network_connections table. No existing column, policy, function or
-- trigger is dropped or redefined. Migrations 0001-0083 are untouched.
--
-- DEPLOY ORDER, both ways:
--   * MIGRATION AHEAD OF THE CODE: nothing reads the table; the Network page,
--     capture, import, identity and path-finding behave exactly as before. Safe.
--   * CODE AHEAD OF THE MIGRATION: the research controls read the table first.
--     When it is not there they are hidden and the page says why, and the
--     research action refuses BEFORE any ledger run is born or any model is
--     called (so no AI run is spent for findings that could not be saved).
--     Nothing is sent to anyone in either order.
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so this applies together or not at all. Re-running after
-- success fails on the existing table, index, policy and trigger names (no IF
-- NOT EXISTS) -- a refusal that rolls the whole script back, not damage.

create table network_person_findings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  -- Erasing a person erases what was found about them.
  network_connection_id uuid not null references network_connections (id) on delete cascade,
  -- The ledger row of the research run that produced this finding. ai_runs rows
  -- are retained, never deleted; SET NULL only keeps this table erasable.
  ai_run_id uuid references ai_runs (id) on delete set null,
  kind text not null,
  -- The entity as the source states it. Null only for a bare title.
  organization_named text,
  -- What the source says they hold there (a title, a seat, a degree).
  role_text text,
  -- The three below are what the web search actually RETURNED. The model chose
  -- an index into the captured list; it never typed any of these.
  source_url text not null,
  source_title text,
  source_passage text,
  -- Computed by code: every distinctive word of organization_named and role_text
  -- appears in the captured title, passage or address. A failure is stored as
  -- false (and shown under "could not be checked"), never deleted.
  supported boolean not null,
  support_detail jsonb not null default '{}'::jsonb,
  status text not null default 'included',
  struck_by uuid references auth.users (id),
  struck_at timestamptz,
  restored_by uuid references auth.users (id),
  restored_at timestamptz,
  created_at timestamptz not null default now()
);

-- The closed list (ruling 0044 clause 3). Keep in step with FINDING_KINDS in
-- lib/network-research.ts; the migration test fails if they drift.
alter table network_person_findings
  add constraint network_person_findings_kind_check
  check (kind in ('employer', 'title', 'board_seat', 'school', 'org_leadership_role', 'public_affiliation'));

-- A finding names something. A bare title names only the role; every other kind
-- names an organization.
alter table network_person_findings
  add constraint network_person_findings_shape_check
  check (
    (kind = 'title' and role_text is not null)
    or (kind <> 'title' and organization_named is not null)
  );

alter table network_person_findings
  add constraint network_person_findings_text_check
  check (
    (organization_named is null or (length(btrim(organization_named)) > 0 and length(organization_named) <= 300))
    and (role_text is null or (length(btrim(role_text)) > 0 and length(role_text) <= 300))
    and (source_title is null or length(source_title) <= 600)
    and (source_passage is null or length(source_passage) <= 4000)
  );

alter table network_person_findings
  add constraint network_person_findings_support_detail_check
  check (jsonb_typeof(support_detail) = 'object');

alter table network_person_findings
  add constraint network_person_findings_status_check
  check (status in ('included', 'struck'));

-- The status and the who/when say one thing, never two (0077's and 0083's
-- decision-check pattern). Struck: who and when, and no restore. Included:
-- no strike; a restore, if there is one, carries both who and when.
alter table network_person_findings
  add constraint network_person_findings_decision_check
  check (
    (status = 'struck'
      and struck_by is not null and struck_at is not null
      and restored_by is null and restored_at is null)
    or (status = 'included'
      and struck_by is null and struck_at is null
      and ((restored_by is null and restored_at is null) or (restored_by is not null and restored_at is not null)))
  );

-- A source is an http(s) page, and never a social or professional network or a
-- people-data broker (ruling 0044 clause 4). The host is read the same way the
-- code reads it: scheme://[userinfo@]host[:port][/...]. KEEP THIS LIST IN STEP
-- WITH 0083 (network_identity_candidates_source_url_check) AND
-- lib/network-identity.ts (SOCIAL_NETWORK_HOSTS, PEOPLE_DATA_BROKER_HOSTS);
-- scripts/test-network-research-migration.ts fails if they drift.
alter table network_person_findings
  add constraint network_person_findings_source_url_check
  check (
    source_url ~* '^https?://[^/?#[:space:]]+'
    and lower(substring(source_url from '^[hH][tT][tT][pP][sS]?://(?:[^/?#@]*@)?([^/?#:]+)'))
      !~ '(^|\.)(linkedin\.com|lnkd\.in|facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com|twitter\.com|x\.com|t\.co|threads\.net|tiktok\.com|snapchat\.com|pinterest\.com|reddit\.com|tumblr\.com|vk\.com|weibo\.com|xing\.com|whatsapp\.com|t\.me|bsky\.app|mastodon\.social|zoominfo\.com|rocketreach\.co|apollo\.io|lusha\.com|signalhire\.com|spokeo\.com|whitepages\.com|radaris\.com|beenverified\.com|truepeoplesearch\.com|fastpeoplesearch\.com|peoplefinders\.com|intelius\.com|pipl\.com)$'
  );

-- Once per person (a re-run does not duplicate, and cannot bring back a struck
-- finding): person, kind, organization, role and source. Case-insensitive, and a
-- missing organization or role reads as empty, so a bare title is unique too.
create unique index network_person_findings_unique_finding
  on network_person_findings (
    network_connection_id,
    kind,
    lower(coalesce(organization_named, '')),
    lower(coalesce(role_text, '')),
    source_url
  );

create index network_person_findings_organization_id_idx on network_person_findings (organization_id);
create index network_person_findings_connection_idx on network_person_findings (network_connection_id);
create index network_person_findings_ai_run_id_idx on network_person_findings (ai_run_id) where ai_run_id is not null;

comment on table network_person_findings is
  'Ruling 0044 clauses 3-5: what the public web says about a CONFIRMED recorded person, of a closed list of kinds, each with the page and passage the search returned. Labelled not yet reviewed by a person; a human may strike (and restore) a finding but never edit or delete one. Deleted only with its person, or when the identity it rests on stops being confirmed. Feeds nothing yet (paths use it from slice D).';
comment on column network_person_findings.kind is
  'employer | title | board_seat | school | org_leadership_role | public_affiliation. A CLOSED list (ruling 0044 clause 3); any other kind is refused here.';
comment on column network_person_findings.organization_named is
  'The entity as the SOURCE states it. A model selected it from the captured text: a claim, not a fact. Null only for a bare title.';
comment on column network_person_findings.supported is
  'Computed by CODE: every distinctive word of organization_named and role_text appears in the captured title, passage or address (token containment). false is stored, shown under "could not be checked against the source" and never used -- not deleted (the attestation precedent).';
comment on column network_person_findings.source_passage is
  'The text the web search returned for the source, scrubbed of contact details. The capture contract: the model never types it.';
comment on column network_person_findings.status is
  'included | struck. Only a human moves it (ruling 0044 clause 5). A struck finding stays recorded and is never used.';

-- Tenant isolation.
alter table network_person_findings enable row level security;

create policy "team members can read network person findings"
  on network_person_findings for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can record network person findings"
  on network_person_findings for insert
  to authenticated
  with check (organization_id = my_organization_id());

-- Striking and restoring. RLS cannot limit WHICH columns an update touches; the
-- guard trigger below does. There is deliberately NO delete policy.
create policy "team members can strike network person findings"
  on network_person_findings for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- Cross-table org integrity on EVERY reference, 0066/0077/0083's pattern, and
-- the gate: a finding is born only for a confirmed person who may be researched.
create function enforce_network_finding_connection() returns trigger as $$
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
      raise exception 'findings cannot be recorded for a person marked do not research';
    end if;
    if c.identity_status <> 'confirmed' then
      raise exception 'findings can be recorded only for a person whose identity is confirmed';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_person_findings_connection_org_match
  before insert or update of organization_id, network_connection_id on network_person_findings
  for each row execute function enforce_network_finding_connection();

create function enforce_network_finding_run_org_match() returns trigger as $$
begin
  if new.ai_run_id is not null
     and new.organization_id is distinct from (select organization_id from ai_runs where id = new.ai_run_id) then
    raise exception 'organization_id must match the referenced ai run''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_person_findings_run_org_match
  before insert or update of organization_id, ai_run_id on network_person_findings
  for each row execute function enforce_network_finding_run_org_match();

-- A strike or a restore is recorded as the human who made it, in the same
-- organization; a session-less context (a maintenance script) is not pinned.
create function enforce_network_finding_human() returns trigger as $$
declare
  who uuid;
begin
  foreach who in array array[new.struck_by, new.restored_by] loop
    if who is not null then
      if new.organization_id is distinct from (select organization_id from profiles where id = who) then
        raise exception 'the person who struck or restored a finding must belong to the same organization';
      end if;
      if auth.uid() is not null and who <> auth.uid() then
        raise exception 'a strike or restore is recorded as the person who made it';
      end if;
    end if;
  end loop;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_person_findings_human
  before insert or update of organization_id, struck_by, restored_by on network_person_findings
  for each row execute function enforce_network_finding_human();

-- Nothing about a finding is editable except striking and restoring it. (The one
-- other change allowed is the foreign key's own ai_run_id -> null, which keeps
-- the table erasable if a ledger row is ever deleted.)
create function guard_network_finding_update() returns trigger as $$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.network_connection_id is distinct from old.network_connection_id
     or (new.ai_run_id is distinct from old.ai_run_id and new.ai_run_id is not null)
     or new.kind is distinct from old.kind
     or new.organization_named is distinct from old.organization_named
     or new.role_text is distinct from old.role_text
     or new.source_url is distinct from old.source_url
     or new.source_title is distinct from old.source_title
     or new.source_passage is distinct from old.source_passage
     or new.supported is distinct from old.supported
     or new.support_detail is distinct from old.support_detail
     or new.created_at is distinct from old.created_at then
    raise exception 'a finding cannot be edited; it can only be struck or restored';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger network_person_findings_guard
  before update on network_person_findings
  for each row execute function guard_network_finding_update();

-- Findings rest on the identity a human confirmed. When a person stops being
-- confirmed, or is confirmed as someone else, or is marked do-not-research,
-- everything found about them is deleted. AFTER, so it sees the row as 0083's
-- BEFORE trigger left it (an edit to a confirmed person's facts has already been
-- turned into "unconfirmed" by then). Deliberately NOT guarded by
-- pg_trigger_depth(): when deleting the chosen candidate voids a decision (0083),
-- the findings must go with it.
create function clear_network_findings_after_identity_change() returns trigger as $$
begin
  if (old.identity_status = 'confirmed'
      and (new.identity_status <> 'confirmed' or new.identity_candidate_id is distinct from old.identity_candidate_id))
     or (new.do_not_research and not old.do_not_research) then
    delete from network_person_findings where network_connection_id = new.id;
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_clear_findings
  after update on network_connections
  for each row execute function clear_network_findings_after_identity_change();
```
