# Build report: item 109, the shorter route through person identity (ruling 0044 clauses 2 and 9)

Build space, 2026-11-06. Authorized by `docs/ledger/STATE.md` "Authorized now" (item 109 only). Nothing under `docs/ledger/**`, `CLAUDE.md` or `supabase/migrations/**` was edited by me (`docs/ledger/STATE.md` already showed as modified in `git status` before I started; I did not touch it). Nothing committed or pushed. No migration. No live service was called and no real AI look was run. No STATE item was appended (the brief forbade editing `docs/ledger/**`): the decision space should open one from this report.

**The invariant implemented:** an automatic *look* is allowed, an automatic *confirmation* never is. Adding one person looks for their matches by itself; a list or import is looked up only after a click that states the count and the cost; in every case the only thing that turns a candidate into an identity is a human click on a button, and the server re-derives every refusal and the preselection itself.

## 1. What changed, file by file

New files:

| File | What it is |
|---|---|
| `lib/network-identity-flow.ts` | Pure logic, no Next/Supabase/model imports. `planAutoLook` (may one just-added person be looked at: the same `refusalForLook` the server applies, asked first, with the plain sentences), `buildLookupQueue` (the 50-per-click cap with a hard ceiling, de-duplication, "already done" skipping), `runLookupLoop` (the client's loop: one person at a time through an injected `look`, cap again, Stop, stop after 3 problems in a row, counts that add up), `lookupCostStatement` / `nextBatchText` / `progressText` / `lookupSummary`, `strongMatchPairs` (what "Confirm your network (N)" posts), `statusLineParts`, and `buildReviewPerson` plus the `ReviewPerson` / `ReviewCandidate` types (moved here so the review page and the in-place panel build a person the same way). |
| `app/(dashboard)/network/identity/person-card.tsx` | The candidate card, extracted from the review screen (`PersonCard`, `Evidence`, `RecordedFacts`, `SourceLink`). New `mode="single"` for the panel under the add form: two buttons, "Confirm this person" and "None of these". It is the only UI file that calls `confirmIdentity` and `markNoneOfThese`, each inside a click handler. |
| `app/(dashboard)/network/identity/lookup-runner.tsx` | "Confirm your network" for a list or import. `LookupRunnerView` (presentational, every phase renderable) and `LookupRunner` (fetches who is waiting at the click, builds the queue, runs the loop calling the existing `findIdentityCandidates(personId)` one person at a time, shows "Looking up 7 of 20", a progress bar and Stop; ends on the review screen). |
| `app/(dashboard)/network/add-person-result.tsx` | `AddPersonResultView`: what appears under the add form (looking, matches in place, saved-but-not-looked-at with "Add details", failed with "Try again", no matches). |
| `scripts/test-network-identity-flow.ts` | 114 assertions (section 3 below). |
| `scripts/mutation-check-network-identity-flow.ts` | 23 mutations of the new guards (section 4). |

Changed files:

| File | Change |
|---|---|
| `app/(dashboard)/network/actions.ts` | `addConnection` now returns the new person's id (`.insert(...).select("id").single()`), type `AddResult`. The insert payload keys are unchanged. |
| `app/(dashboard)/network/identity-actions.ts` | Two READ actions added: `loadLookupQueue` (who is waiting at the moment of the click: the first 50 ids and the full count; uses `planBulkLook`, so do-not-research, confirmed, none-of-these, name-only, already-has-candidates and already-looked people are not offered) and `loadPersonCandidates` (one person and their candidates, for the in-place panel; returns no person unless they still need a human choice). Neither writes, spends or looks anyone up. `findIdentityCandidates`, `confirmIdentity`, `confirmPreselectedIdentities` (server-side re-derivation untouched), `markNoneOfThese` and the bulk `findIdentityCandidatesForUnidentified` are unchanged. |
| `app/(dashboard)/network/network-workspace.tsx` | New `AddPersonSection` wraps the existing form: after a successful save it asks `planAutoLook`; if allowed it runs `findIdentityCandidates` (not awaited, so the form is free at once), then `loadPersonCandidates`, and shows the result in place. The "Who is who / Review who is who" panel is replaced by one "Confirm your network" section holding the `LookupRunner` button with the count. `IdentityPageData` gains optional `eligible`. |
| `app/(dashboard)/network/page.tsx` | Reads the identity overview (read-only) to give the button its count. |
| `app/(dashboard)/network/identity/page.tsx` | Title "Confirm your network"; builds people with `buildReviewPerson`; splits people with candidates into strong matches (up to 200 listed) and people needing a choice (paged, 20). |
| `app/(dashboard)/network/identity/identity-workspace.tsx` | Rewritten: compact status line (six chips) instead of "Where everyone stands"; secondary "Look up more people" button (the same runner); a "Strong matches" list, each row showing the person, the chosen candidate, source link and evidence, with a tick box (default ticked) and "Choose a different match" (opens the full card); one button "Confirm your network (N)" (N = ticked strong matches) posting `strongMatchPairs(...)` to `confirmPreselectedIdentities`; then "Needs your choice" cards. The old "Find matches for everyone not yet identified" and "Confirm all preselected / Show the N to check" are gone from the UI. |
| `app/(dashboard)/network/import/import-workspace.tsx` | After a successful import it READS who is waiting (`loadLookupQueue`) and shows "Nothing has been looked up…" and the `LookupRunner` button with the count. The import itself does nothing else. |
| `scripts/test-network-identity.ts` | Successor assertions for the changed UI wording; listed in section 5. |

Not changed: `lib/network-identity.ts`, `lib/ai/person-search.ts`, the migrations, `lib/network.ts` (both disclosures byte for byte), the import actions, the assistant and agent code. The bulk server action `findIdentityCandidatesForUnidentified` stays on the server and its section-10 tests still pass; no client file calls it any more (asserted).

## 2. Counts, before and after (real runs of `npx tsx scripts/<name>.ts`)

| Suite | Before | After |
|---|---|---|
| test-network | 183 / 0 | 183 / 0 |
| test-network-import | 156 / 0 | 156 / 0 |
| test-network-identity | 299 / 0 | 303 / 0 (+4 net: edits in section 5) |
| test-network-identity-migration | 96 / 0 | 96 / 0 |
| test-assistant | 585 / 0 | 585 / 0 |
| test-agent | 344 / 0 | 344 / 0 |
| test-supporters | 182 / 0 | 182 / 0 |
| test-send-draft | 268 / 0 | 268 / 0 |
| test-reply-address | 138 / 0 | 138 / 0 |
| test-ai-runs | 70 / 0 | 70 / 0 |
| test-health-status | 19 / 0 | 19 / 0 |
| **test-network-identity-flow** (new) | n/a | 114 / 0 |
| `npx tsc --noEmit` | clean | clean |
| `npx next build` | compiled earlier (item 108) | "Compiled successfully", types and lint passed; `/network`, `/network/identity`, `/network/import` in the route list |
| `npx tsx scripts/ledger-check.ts` | | "protocol intact" |
| earlier mutation script `mutation-check-network-identity.ts` | 18 of 18 | 18 of 18 still caught after my edits |

The existing assistant, agent and path-finding scans passed **unchanged**; I loosened none of them. `test-tenant-isolation` was not run (needs live credentials; unchanged from item 108).

## 3. What the new test (114 assertions) proves

1. Pure cap logic: 212 waiting gives a queue of 50 and "the next 50 of 212"; a caller asking for 5000 or Infinity still gets 50 (the ceiling); resumability (done people skipped); de-duplication; the cost statement wording.
2. The client loop with a stub: capped at 50 even when handed 80 and a cap of 1000; calls the action with the id and nothing else; progress "Looking up 7 of 20"; Stop; counts that add up; a thrown look is a counted problem; stops after 3 problems in a row; recovers if they are not consecutive.
3. `planAutoLook`: name-only and do-not-research are not looked at, with the plain sentences.
4. Strong-match gathering, the status line (six counts, "looked up, no match found" kept apart from "not looked at"), `buildReviewPerson`.
5. The REAL actions with a scripted model: a hostile queue containing a do-not-research, a confirmed, a none-of-these and a name-only person, with `{cap: 9999, ledger: false, skipRefusal: true}` passed as extra arguments, is refused by the server for all four: no run born, no model call. The three real people get one run and two model calls each; nobody is confirmed and not one write touched `network_connections`.
6. Add one person end to end through the same functions the page calls: `addConnection` returns the id, the look runs, `loadPersonCandidates` returns the candidates with the strong match preselected, and the person is still unconfirmed with no decider. A failing look leaves the person saved and "Try again" works.
7. An import spends nothing: no ledger run, no model call, nothing confirmed; the queue read shows both imported people waiting.
8. Source scans: no add-flow, lookup-button, import-flow or flow-library file names a confirm action; the only two UI files that name one are the person card and the review screen, and neither has an effect or timer; the loop starts only from the click handler; the import files never name a look; no client file calls the bulk action; the assistant, agent and HTTP routes reach none of the new names.
9. The screens rendered for every phase (looking, matches, name-only, do-not-research, failed, no matches, idle, running, stopping, finished, error, nobody waiting) and the unchanged disclosure on the add form.

## 4. Mutation table (`npx tsx scripts/mutation-check-network-identity-flow.ts`: 23 of 23 caught)

The script confirms the baseline passes, applies each mutation (the text to change must appear exactly once), runs the test, requires a FAIL whose label contains the named text, and restores the file byte for byte.

| # | Guard broken | File | Caught by (named assertion) | Result |
|---|---|---|---|---|
| F1 | 50-per-click cap in the queue builder | `lib/network-identity-flow.ts` | "THE CAP: 212 people waiting ..." | 104 / 9 |
| F1b | hard ceiling (caller may ask for more than 50) | same | "THE CEILING ..." | 110 / 3 |
| F1c | cap inside the client loop | same | "THE LOOP'S CAP: handed 80 people and a cap of 1000 ..." | 111 / 2 |
| F2 | Stop ignored | same | "STOP: after the 7th person ..." | 109 / 4 |
| F3 | no stop after problems in a row | same | "A BROKEN CONNECTION DOES NOT SPEND THE CLICK" | 112 / 1 |
| F4 | name-only person looked at automatically | same | "NAME ONLY: no look ..." | 104 / 9 |
| F4b | do-not-research person looked at automatically | same | "DO NOT RESEARCH: no look ..." | 108 / 5 |
| F5 | add flow confirms the person right after the look | `network-workspace.tsx` | "NO ADD-PERSON OR IMPORT CODE CAN CONFIRM ..." | 111 / 2 |
| F5b | add flow records "none of these" by itself | same | same assertion | 111 / 2 |
| F5c | person card confirms from an effect (no click) | `identity/person-card.tsx` | "neither of them has an effect, a timer or a page-load hook ..." | 112 / 1 |
| F6 | import success path calls the look | `import/import-workspace.tsx` | "AN IMPORT NEVER TRIGGERS A LOOK ..." | 112 / 1 |
| F6b | import action file imports the look | `import-actions.ts` | same, and "the import action imports nothing from the identity actions ..." | 111 / 2 |
| F7 | batch posts people the human unticked | `lib/network-identity-flow.ts` | "a person the human unticked or opened for a different choice is NOT in the pairs" | 112 / 1 |
| F7b | review screen posts every strong match, ignoring ticks | `identity/identity-workspace.tsx` | "the review screen's one batch button posts only strongMatchPairs(...) ..." | 112 / 1 |
| F8 | the lookup loop starts on mount, no click | `identity/lookup-runner.tsx` | "THE LOOKUP LOOP STARTS ONLY FROM A CLICK ..." and "its one effect only STOPS the loop ..." | 111 / 2 |
| F9 | button calls the bulk server action instead of the single-person one | same | "THE OLD BULK BUTTON IS GONE FROM THE UI ..." and "it calls the SINGLE-person action in the loop ..." | 111 / 2 |
| F10 | `addConnection` stops returning the id | `actions.ts` | "addConnection returns the new person's id ..." | 105 / 8 |
| F11 | cost statement dropped from the click that spends | `lookup-runner.tsx` | "IDLE: one button 'Confirm your network' ..." | 111 / 2 |
| F12 | the server's refusal removed | `identity-actions.ts` | "REFUSALS HOLD THROUGH THE CLIENT LOOP ..." (and 4 more) | 108 / 5 |
| F13 | add flow ignores the plan | `network-workspace.tsx` | "the add flow looks only after the save succeeded and only when the plan says so ..." | 112 / 1 |
| F14 | add flow looks even when the save failed | same | "afterSave is called only on success ..." | 112 / 1 |
| F15 | queue offers people the server would refuse | `identity-actions.ts` | "loadLookupQueue (a READ) names who is waiting ..." | 110 / 3 |
| F16 | the in-place read starts writing a confirmation | same | "AUTOMATIC LOOK, NO AUTOMATIC CONFIRMATION ..." (and the no-write scan) | 108 / 5 |

The earlier script (`mutation-check-network-identity.ts`) still catches all 18 of its mutations, including M7 (the batch confirm trusting the client's pair) and M1b (the server refusal), after the UI changes.

Where the evidence is a source scan rather than a behaviour (F5, F5b, F5c, F6, F6b, F8, F9, F13, F14), the guard is a regular-expression scan of the component source, not a click in a browser. It catches the shapes I thought of; a differently written auto-confirm in a client component would need a human reviewer or a browser test to be noticed.

## 5. Edits to the existing suite `scripts/test-network-identity.ts` (every one, with its successor)

All are consequences of the UI wording or structure changing; none weakens a guard. Net 299 to 303.

| Was | Now |
|---|---|
| Section 15, design-token / `boxSizing` scan read three files | reads five (adds `person-card.tsx`, `lookup-runner.tsx`, where the radio options and cards now live) |
| Section 15, "lists every candidate ... and the evidence line" required `evidenceItems(agreement)` in `identity/page.tsx` | requires `buildReviewPerson(` in the page and `evidenceItems(agreement)` in `lib/network-identity-flow.ts` (the same computation, moved) |
| Section 15, "'Confirm all preselected' shows every preselected person ... before the button" | successor: "'Confirm your network (N)' ... shows every strong-match person ... BEFORE the button ...", asserting the list, `will be confirmed as:`, `strongMatchPairs(strong, ...)`, `confirmPreselectedIdentities(pairs)` and no effect |
| Section 15, "the batch is never run automatically: ... only from an onClick" | successor: called once, inside `confirmNetwork`, referenced only as `onClick={confirmNetwork}` |
| Section 16, the review-screen render (props `preselected`, `people`, `cap`, `stateLabels`) | new props (`strong`, `strongTotal`, `others`); 14 assertions rewritten (successors keep every property: facts and source links, evidence marks, radios, preselected radio checked and "Suggested", disabled confirm for no preselection, unsupported-text warning, the "not proof" sentence, look again / do not research). The radio and preselected-radio assertions now render the person card directly, because a strong match is a compact row on the screen (radios appear when "Choose a different match" opens it) |
| Section 16, "'Confirm all preselected (1)' ... list NOT shown until opened" | successor: "Confirm your network (1)" is on the screen and the person with their chosen candidate is visible without opening anything; "Confirm all preselected" no longer exists; nobody is shown as confirmed by loading |
| Section 16, "'Find matches for everyone not yet identified (3)' states the cap of 10 ..." | successor: that button is gone; "Look up more people" states "3 people not yet identified. Each one costs one AI run. This click looks up all 3." |
| Section 16, "Where everyone stands: Not looked at: 3 ..." and "Not eligible, and why: 4 already confirmed" | successors: the status line ("4 confirmed", "2 still to review", ...) and "Cannot be looked up yet: 2 only a name recorded" |
| Section 16, "a person's card offers Find matches ..., and the list has a link to the review screen" | the card half kept; the link half replaced by two assertions about the "Confirm your network" entry (button with count and cost when people are waiting; a link into the review screen when nobody is) |

## 6. What I saw, and what I could not see

* **Could not see:** the real app. `/network` and `/network/identity` sit behind sign-in, and the dev server uses `.env.local`, whose Supabase target I did not open or sign in to (that could be production data). I did not start the dev server.
* **Saw:** every screen rendered with fixture data (server-rendered HTML written to a scratch folder outside the repo, served on localhost, opened in the Browser pane at its default 363 px width and, once, at 980 px): the review screen (status line, "Look up more people", three strong-match rows, the "Confirm your network (3)" button, one person needing a choice), the Network page entry ("Confirm your network" with "212 people not yet identified. Each one costs one AI run. This click looks up the next 50 of 212; click again for the rest." and the disclosure on the add form), and the in-place states (looking, matches with the suggested radio and the two buttons, name-only with "Add details", failed with "Try again", the lookup button idle, running at "Looking up 7 of 50" with Stop and a progress bar, and finished after a stop).
* **Two layout defects found by looking, both fixed:** at phone width the strong-match card pushed past the screen (a bare `display: grid` with no column template, the exact trap `lib/ui.ts` warns about; now `minmax(0, 1fr)`), and the evidence line could not wrap (its items were glued together; now a space between items). I looked at the fixed review screen again; the other screens were not re-opened after the second fix beyond the test suite.
* **Not seen, because static HTML cannot show it:** any click, the loop actually running in a browser, Stop, the "Looking for matches…" to matches transition, the auto-navigation after a finished click, the unmount stop, and focus or keyboard behaviour. The handlers are covered by source scans and by running the same server functions in the same order, not by clicking.
* No design pass was attempted (CLAUDE.md): tokens from `lib/ui.ts`, `boxSizing: border-box` on the cards and the progress bar, one spacing scale.

## 7. Decisions for the decision space (safest reading taken in each)

1. **Two buttons carry the words "Confirm your network", on different screens, doing different things.** On the Network page and the import result, "Confirm your network" runs the look-ups (the brief's item 2). On the review screen, "Confirm your network (N)" confirms the strong matches (item 3). The review screen's look-up button is labelled "Look up more people" and styled secondary, so the confirm button is the one primary button there. The owner said "confirm your network" for both; if the same words on two different actions is confusing, rename one.
2. **A strong-match row replaces the full card for people with one strong match.** The brief asked for every person to have their evidence and a choice and also a visible chosen candidate beside each person. I show one compact row (person, chosen candidate, source, evidence line, a tick box, and "Choose a different match" which swaps in the full card). People without a strong match get the full card. Unticking or opening a row removes that person from the batch.
3. **The batch lists at most 200 strong matches at a time** (`STRONG_MATCHES_PER_SCREEN`), so one click covers a screen a person can read and stays under the server's 500-pair limit. The rest appear after these are confirmed; the heading says "200 of 640".
4. **Stop after three problems in a row.** Not in the brief. A broken connection or an unapplied migration would otherwise burn a 50-person click on failures (a failed look can already have been metered). Easy to remove (`MAX_CONSECUTIVE_FAILURES`).
5. **A finished click from the Network page or the import result navigates to the review screen by itself** (`window.location.assign`, a full page load, so no router hook is needed in components that are server-rendered in tests), unless it was stopped or had a problem, in which case it shows the summary and a link first.
6. **The per-click cap is 50 on the client and the ids the server returns are also capped at 50**, but the server does not treat that as a boundary: `findIdentityCandidates` takes one id, refuses in code, and births one run. A client that loops over more ids simply makes more single-person requests; there is no server-side per-session budget. If a hard server limit on looks per hour is wanted, that is a separate ruling.
7. **Name-only is decided twice**: the page asks `planAutoLook` first (so the person gets the plain sentence without a server round trip), and the server's `refusalForLook` still refuses. The page's copy of the rule is the same function, not a second implementation.
8. **`addConnection` now returns the new id.** The insert's payload keys are unchanged (asserted). An id with no look is harmless: a look is a separate action.
9. **The bulk server action is left in place, unreferenced by the UI.** Its tests (section 10 of the earlier suite) still pass. It is now dead code from the UI's side; removal would be a separate change.
10. **The Network page now reads the whole identity overview on each render** (people, candidates, runs, paged past the 1000-row limit) to count who is waiting. The review page already did. For a network of many thousands this is several extra reads per page view. A cheaper exact count would need a new query or view; I did not add one.
11. **The review screen's title is "Confirm your network"** (was "Who is who"). The introductory paragraph under it is unchanged.

## 8. Not verified

* Anything that needs a click in a browser (section 6). The first real use should be a small list of the owner's people, watched.
* **Each look refreshes the page.** `findIdentityCandidates` calls `revalidatePath`, which in a server action makes Next send back a fresh render of the current page. A 50-person click therefore re-renders the Network or review page up to 50 times, each time reading the identity overview. I left it because the brief said to reuse the existing action unchanged; it is unmeasured, and a quieter variant of the action (no revalidate until the loop ends) is the obvious fix if it is slow.
* **The runner staying mounted across those refreshes** is my understanding of React (same position in the tree, stable keys), not something I observed. The review screen keeps it mounted even with nobody waiting (it renders nothing then) so the final summary is not lost when the last person is looked up.
* **Server-action ordering:** I rely on Next running a client's server-action calls one at a time, which is why Stop only takes effect between people. Not tested.
* **`maxDuration`:** each look runs inside the request of the page that invoked it (450 s, set on `/network` and `/network/identity`; the import page has none and would use the platform default). A look is bounded at about 180 s by its two model timeouts. That a server action inherits its page's limit on Vercel is my understanding, not tested; the import page's button should be tried once for that reason.
* Leaving the page stops the loop at the next person (an effect cleanup). In a browser, a person already in flight finishes on the server.
* Real preselection rates, real latency per look and cost per look are still unmeasured (as in item 108).
* `scripts/test-tenant-isolation.ts` was not run.

## 9. Where to look

`lib/network-identity-flow.ts`; `app/(dashboard)/network/identity/{lookup-runner,person-card,identity-workspace}.tsx`; `app/(dashboard)/network/{network-workspace,add-person-result}.tsx`; `app/(dashboard)/network/identity-actions.ts` (lines for `loadLookupQueue`, `loadPersonCandidates`); `scripts/test-network-identity-flow.ts`; `scripts/mutation-check-network-identity-flow.ts`.
