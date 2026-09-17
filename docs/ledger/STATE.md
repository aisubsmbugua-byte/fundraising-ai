# STATE

The handoff file. Both spaces write it. Every open item names the side that owns
it and the state it is in — if an item has no owner, nobody is doing it and both
spaces think the other one is.

Last touched by: **build** · 2026-09-17

## Authorized now

- ruling: 0013
- parallel: **Item 24 (ledger tooling, ruling 0014 and friends) is authorized to
  run at the same time**, from 2026-09-17. It is not a Build 1 pipeline step, so
  ruling 0005's one-step-at-a-time does not bind it — that rule exists to keep
  pipeline changes small enough that a gap is visible at the boundary, and
  tooling is not in that sequence. The serial queue was also a consequence of the
  build space being a single conversation; it no longer is. Run it in an isolated
  worktree: it edits `scripts/ledger-check.ts`, which the other job executes as a
  Stop hook every turn.
- objective: Close the paid-rerun treadmill for every gap the live path can
  honestly decide, and make the remainder visible rather than silent.
- approved decision: Ruling 0013 — item 13 settled as option (a).
- scope: Wire `obtainableGaps()` into every user-facing "still missing" string
  and every follow-up search target. Pass `coverage: null`. Delete — do not
  reword — any copy implying the whole fact set was checked.
- exclusions: Do not infer per-purpose coverage from `official_site_fetched` or
  anything else the live run records (ruling 0013 rejects this explicitly). Do
  not start Step 5 (ruling 0010). Do not touch items 10 or 15 — both are
  approved and both wait.
- acceptance checks: (1) With `coverage: null`, no interface string asserts
  completeness over the fact set — `research-tab.tsx`'s "Every information
  category was found" is the named target and must be unreachable. (2) Registry
  facts reach `not_applicable` / `checked_not_stated` where warranted and are
  not offered. (3) Site facts are all obtainable and all still offered.
  (4) Ruling 0010's grep test: `deriveAvailability` and `obtainableGaps` have
  production callers, and every path that names something missing traces to one.
  (5) **Added 2026-09-17 by ruling 0017 — this amends work in flight.** Every
  fact in the required set is reachable on screen in every state, each with its
  reason; a `checked_not_stated` fact is visibly different from a `not_checked`
  one to a reader who has never seen the vocabulary. Exactly the obtainable facts
  carry an action. Any "remove from view" behaviour already written is superseded
  — say so in the report rather than silently reworking it.
  (6) **Added 2026-09-17 — same file, same pass, no new job.** Remove the claim
  that a search "spends credits" (`research-panel.tsx:172` and `:201`). There is
  no credits concept in any of 65 migrations; the app is telling a nonprofit they
  are drawing down a balance that does not exist. It may become true later (see
  `docs/decisions/0004-commercial-model.md`) — it is false now. Replace with
  what is true and stays true whatever the pricing model becomes: the run costs
  real money and takes several minutes. Do not name a balance, an allowance or a
  quota. Build is already editing these exact strings under ruling 0017, so this
  is a wording correction inside work in flight, not an addition to it.
- dependencies: None. Item 8 is *not* a dependency — that decoupling is the
  substance of ruling 0013.
- pattern to follow: `research-actions.ts:599` —
  `grantSchedulePresent && !grantScheduleRead`. Verified in the decision space.
- unresolved: None blocking. The site half is tracked as item 16 and lifts on
  its own when Tier 2 reaches the live path.
- **merge: STOP before it.** Revised 2026-09-17. Ruling 0020 clause 2 still holds
  — Step 4 is not complete until `build-1-qualification` is on `main` — but the
  merge is now a **separate human approval gate**, not the build space's to
  perform. Finish the work, pass the checks, write the review, then stop and
  report. The owner sees the checks before anything deploys.
  - This deploys. `main` auto-deploys to Vercel, so merging ships Build 1's
    first user-visible behaviour: ruling 0003's handoff contract becomes live
    (accepting a candidate carries opportunity name and source URL into the
    prospect), plus Step 4's availability work. Everything else in Build 1 —
    `qualification`, `registry/`, `tier2/`, `legitimacy` — stays dark, having no
    entry point.
  - Safe to merge: migrations 0063–0065 are already applied and verified
    additive, and the 7 commits carry no non-additive change.
  - If the build fails or the acceptance checks do not pass, **do not merge** —
    raise an item and stop. A merge is the one step in this job that is
    outward-facing.
- report: Follow ruling 0010 — name the function deciding each invariant and
  every call site routed through it. Test counts are not a completion claim.
  Write to `docs/reviews/0012-*.md`.

## Next authorized

Two jobs, in this order. Take each up without waiting for the decision space.

**Reordered twice on 2026-09-17, and the second reorder stands.** First the
tooling was moved behind the customer-facing work on the stated priority that
trust in the product is paramount. Then the owner supplied the input that call
was missing: exposure is one real org (the owner's) plus one paid tester. The
trust-damage argument assumed strangers and there are none, so it does not carry
the weight put on it — the wasted-spend case cost the owner, not a customer.

What low exposure actually is: a window that expires. Process infrastructure is
cheapest to build before anything depends on it, and `--seal` is corrupting the
audit baseline every session in the meantime. So the tooling goes first, on the
reasoning that it is *pre-scale work*, not on the reasoning that it is urgent.

### First — item 24: ledger tooling, one job not four

- ruling: 0014 (primary) — carries 0012, 0015 and 0018 in the same job
- objective: Every rule this ledger has written down is enforced by the check
  rather than by someone remembering it. Four rulings have been issued against
  `scripts/ledger-check.ts` and none is implemented, so the protocol currently
  relies on discipline in exactly the places it was built not to.
- scope: One pass over `scripts/ledger-check.ts` and the files it reads.
  1. **0014 first — it is actively biting.** Split `--seal` (records ruling
     hashes, and nothing else) from `--baseline` (re-records working-tree
     exemptions). Give `.baseline.json` a schema that distinguishes a path
     grandfathered at ledger creation from one exempted later, each later entry
     carrying a date and reason. The decision space has hand-restored this file
     after every seal for an entire session; that is the interim procedure this
     removes.
  2. **0012** — `rulings/.confirmed.json`, written only by the decision space,
     keyed by ruling id, carrying a three-valued verdict (`unconfirmed` /
     `confirmed` / `refuted`) and the artifact checked against. Warn only when a
     ruling is `reconstructed` **and** `unconfirmed`. `refuted` fails rather than
     warns. `--seal` must not touch this file.
  3. **0015** — validate the `status` column in the open-items table. Reject a
     value outside the six; reject a work state on a `decision`-owned item;
     fail any item at `tested` or beyond whose row names no evidence; check
     `released` against the deployed branch and fail if its commits are not
     there.
  4. **0018** — every file path, table name and symbol cited anywhere in
     `docs/**` must exist. This is the one that catches a fact inferred from a
     name rather than read from the artifact.
  5. **0020** — the additive-migration check. List migrations ahead of the
     deployed branch (`git diff --name-only main...HEAD -- supabase/migrations/`)
     and fail any that is not additive: a `drop column` / `drop table`, a
     `rename`, an `alter column … type`, or a `not null` without `default`.
     Verify statically; do not trust a declaration in a comment. 0063–0065 are
     all additive and must pass.
- exclusions: Do not change which paths are governed. Do not re-examine or prune
  the grandfathered path list — it is historical and those paths are committed.
  Do not retroactively assign statuses to closed items. Do not touch Build 1
  code; this job is tooling only.
- acceptance checks: (1) `--seal` on a dirty tree leaves `.baseline.json`
  byte-identical. (2) A later baseline entry is distinguishable from a
  grandfathered one by reading the file alone. (3) Removing a confirmation entry
  makes the warning return; a `refuted` verdict fails the check. (4) An item
  claiming `released` from a feature branch fails. (5) A doc citing a
  non-existent path fails — verify with a deliberately bad citation, then remove
  it.
- dependencies: Step 4 closing. Nothing else. These four do not depend on each
  other beyond sharing a file, which is why they are one job.
- authorization and limits: Tooling only, no migration, no user action needed.
  If any of the four turns out to need a schema or behaviour change the ruling
  did not anticipate, stop and raise an item — do not decide it in build, the
  way item 13 was correctly escalated rather than guessed.
- report: `docs/reviews/0013-*.md`, per ruling 0010 — name what each check now
  rejects, and show one failing example per rule.

### Second — item 23: a funder can say no (ruling 0019)

Needs a migration — user-applied, SQL inline in the closing message per standing
preference. Full constraint is in ruling 0019; the load-bearing part is that
`never` comes only from an explicit human action, and an absent field is always
`undecided`, never `never`.

## Open items

| id | owner | status | subject | opened |
|----|-------|--------|---------|--------|
| 2 | build | tested | **Step 4 — 0009 wired.** `deriveAvailability` now reaches the product through one mapping function, `availabilityForResearchRun` (`lib/availability.ts:274`), called from `lib/prospect-intelligence.ts:417`, `research-actions.ts:251` and `app/admin/research/page.tsx:273`; `obtainableGaps` reaches every gap surface through one filter, `offerableGaps` (`lib/availability.ts:337`). All six acceptance checks met — check (2) only partly, see the review: `not_applicable` is unreachable in the live path because neither route to it has a recorded input. Evidence: `docs/reviews/0012-step-4-wiring-availability.md`; `scripts/test-availability.ts` 37 → 65 passing; 660 assertions passing across 13 test files, 2 skipped for missing Supabase env; `npx tsc --noEmit` clean; `npx next build` compiles, 28 routes. **Not released — not merged.** | 2026-09-16 |
| 26 | decision | proposed | **Which decision does the Research tab serve?** The ledger there names `screening` as its consumer (ruling 0011 forbids a default, so a call had to be made; the reasoning is in review 0012). But the dossier that tab shows is also the input to a strategy run, and strategy's required set has 8 keys screening's does not — `accepts_unsolicited`, `deadline`, `invitation_mechanism`, `fiscal_sponsorship_rules`, `grant_size_range`, `median_grant_size`, `international_reach`, `total_assets`. Under ruling 0017 those 8 are not displayed with a reason on that screen. If the tab serves both decisions, the fix is a second ledger beside the first, not a change to either function. Build did not decide this — which decision a screen serves is direction. | 2026-09-17 |
| 17 | build | tested | **Rulings 0008 and 0011 complete.** `deriveAvailability` evaluates every source a fact could come from and combines them (unread outranks failed outranks silent); `keys` required, no default. Evidence: `scripts/test-availability.ts` 29 → 37 passing, including 0008's compliance case and a self-contradiction guard; tsc clean. Not released — rides with item 2. | 2026-09-16 |
| 16 | decision | approved | **Tracking, not work.** The site half of the treadmill stays open by construction until Tier 2 reaches the live path — required by ruling 0013 so a partial close cannot read as a complete one. Under ruling 0016 the lift condition is now concrete rather than pending a cutover: it closes when a ruling lands `lib/tier2/` in the live path, same pattern as 0003 and 0009. Nothing to supersede. Keep open for exactly as long as `coverage` is null in the live run. | 2026-09-16 |
| 23 | build | approved | **Queued — do not start.** Ruling 0019: record a prospect outcome when a funder declines — reason plus a three-valued revisit disposition (`revisit_on <date>` / `never` / `undecided`). `never` only ever from an explicit human action; absent means `undecided`, never `never`. Reversible, retained, not deletion. Excludes referral capture and any terminal stage. Needs a migration (user-applied, SQL inline in the closing message). | 2026-09-17 |
| 25 | decision | proposed | **Commercial model recorded as provisional** — subscription with a set number of searches, then credits. See `docs/decisions/0004-commercial-model.md`. Three things follow, in the order they must be answered: (a) the app says a search "spends credits" and no credits concept exists in any of 65 migrations — wrong every day it waits, cheap to fix; (b) "a search" currently means two unrelated operations (a channel-wide discovery search, and a single-prospect research run) — settle before pricing; (c) a failed, empty or platform-killed run does not map to any existing column — settle before metering. **Nothing blocks work in flight; all three get expensive once customers are on a plan.** | 2026-09-17 |
| 21 | decision | proposed | **From the doc audit — remaining half.** Hard rule 1 ("no auto-send") is currently true only *by absence*: there is no send code at all, so nothing enforces it. The moment Slice 8 starts, that guarantee has to move into construction — a send path reachable only from a handler taking an approved draft id and a live human session. Not urgent; decide before Slice 8 is picked up. The other half of this item became ruling 0019. | 2026-09-17 |
| 20 | decision | proposed | **Deferred by ruling 0016, not dropped.** When the live Slice 3 rules engine and the qualification pipeline both have something to say about one prospect, what does the user see? Not a precedence question — neither system acts, both are advisory under hard rule 3 and ruling 0002 — so it is a display decision. Revisit when `lib/qualification.ts` approaches landing; designing it now would design against output that is still changing (same reasoning as ruling 0007). | 2026-09-17 |
| 24 | build | released | **Ledger tooling — done and in the main tree.** Rulings 0012, 0014, 0015, 0018 and 0020 implemented in `scripts/ledger-check.ts` (931 lines, checks split into exported functions with git behind a port so they can be driven against fixtures). Evidence: `scripts/test-ledger-check.ts` 61/61 passing with one failing example per rule; the live check run against this repo found 4 real stale citations in `docs/decisions/` which are now fixed; 407 citations verified per run; `--seal` leaves `.baseline.json` and `.confirmed.json` byte-identical. Counterchecked in the decision space, not accepted on report. | 2026-09-17 |
| 28 | decision | proposed | **Ruling 0018's mechanical half shipped for paths only; table names and symbols need a ruling, not a build decision.** Table names are checkable with near-zero noise — 29 tables parsed from the migrations, exactly **one** cited name in `docs/**` has no table behind it. But that one sits inside ruling 0018 itself, in the table of wrong claims the ruling exists to record, in a file that is immutable. Enabling the check makes the ledger permanently red with no legal remedy. Symbols give 19 misses, most legitimate — `revisit_on` in the Slice 7 doc is unbuilt, not wrong. Both need a vocabulary for *quoted, not asserted* and *planned, not present*. Build stopped rather than guessing, correctly. The mechanism is probably already discovered: build wrote the six bad paths in its own report **without backticks** so the report would pass its own check — so backticks mean "this is real", plain text means "I am discussing it". The remedy for the one immutable violation is an entry in `.baseline.json`'s new `exempted` schema, dated and reasoned. | 2026-09-17 |
| 1 | decision | approved | **0002, 0003 and 0006 are now recorded as `confirmed` in `rulings/.confirmed.json`**, each with the file and line it was checked against — the mechanism ruling 0012 called for, built under item 24. The check went from five warnings to two, and the two that remain are the ones genuinely unverified. **0005 and 0007 stay `unconfirmed`**: process decisions with no code artifact, and `search_session_transcripts` is unavailable in unsupervised mode. Retry with tool approval. | 2026-09-16 |
| 5 | decision | proposed | Untested end to end: whether newly discovered named opportunities carry name + source URL through the handoff contract in a live run. 0003 is confirmed as code; confirming code exists is not confirming it runs. Needs one live run, same as item 4. | 2026-09-16 |
| 4 | build | approved | **The real bottleneck, and it has been open all session.** Step 3b: selection and fetch recall against the frozen reference set has never been measured. Needs a user-run model call — the assistant sandbox has no API key. Build 1 is 4 steps into 10, and steps 5–10 all sit on top of retrieval whose recall is unknown. With two orgs there is no usage data either, so the reference set is the *only* evidence available about whether any of this works. Blocked on user execution, not on a ruling. | 2026-09-16 |
| 18 | build | released | **Migrations 0063–0065 are applied to the live database** and verified additive (ruling 0020 clause 3): every new column is `not null default <value>`, every new check bounds only a new column, `qualification_stages` is a new table. Closes when the branch merges and schema and code are back in step. | 2026-09-17 |

## Closed items

| id | subject | closed |
|----|---------|--------|
| 8 | **Build 1's landing. Settled by ruling 0016**: no cutover event — each module lands when a ruling establishes it is correct, gated by ruling 0010. Ratifies what was already happening unnamed: `discovery-handoff` landed under 0003, `availability` is landing under 0009. The item's own premise was wrong — "no defined landing" described an *undeclared* one already used twice. The display question survives as item 20, deferred. | 2026-09-17 |
| 9 | **Roadmap docs refreshed 2026-09-17.** Every slice doc now carries an "As built" section stating what actually shipped; `architecture/OVERVIEW.md` rewritten against the real 65 migrations, lib and app layout, and all three invariants re-verified as enforced; `slices/README.md` now carries per-slice status and explains Build 1's relationship to the slices; `decisions/0002`'s "ships dark / if ever" statements corrected against ruling 0016. Findings that needed a decision rather than a doc edit became item 21. | 2026-09-17 |
| 6 | **Branch merge. Decided 2026-09-17: `build-1-qualification` merges to `main` as the last act of Step 4**, not as a follow-up — ruling 0020 clause 2, a landing merges in the work that performs it. The earlier "do not merge yet" was decided on a false picture: it assumed parts of Build 1 were already live, and ruling 0020 established that none are. Verified safe — migrations already applied and additive, no non-additive change in the 7 commits. Conditional on the acceptance checks passing; a failing build does not merge. | 2026-09-17 |
| 27 | **Step 4 merged and deployed 2026-09-17.** Counterchecked in the decision space before the merge, not accepted on report: `deriveAvailability` went from zero production callers to fifteen across five files; three false-completeness strings deleted; the "spends credits" claim replaced with what is true regardless of pricing; 65 availability assertions passing; `next build` clean. Merged fast-forward, pushed by the owner, confirmed live on GitHub by querying the server rather than local state. The three narrowings build flagged rather than rounded up are carried as items 16, 26 and 28. | 2026-09-17 |
| 13 | 0009 could not be fully honoured: `deriveAvailability` needs per-purpose `coverage`, only Tier 2 produces it, Tier 2 is not in the live path. **Settled by ruling 0013** — ship the registry half, label it honestly, track the rest as item 16. | 2026-09-16 |
| 14 | Build's finding: the live path already implements obtainability at `research-actions.ts:599` while `lib/research.ts:332` asks no availability question at all. Verified in the decision space, carried into ruling 0013 as the pattern to follow. | 2026-09-16 |
| 12 | The build space had no "nothing binds until it is in a file" rule, so build-side findings went to chat and the user carried them by hand. **Done** — `ROLE-build.md` now carries it, extended to findings outside the authorized work. | 2026-09-16 |
| 11 | Build verified rulings 0008 and 0010 independently rather than accepting them. No dispute. Recorded because a countercheck that agrees is still a countercheck. | 2026-09-16 |
| 7 | Where confirmation of a reconstructed ruling is recorded. **Settled by ruling 0012.** Implementation queued as item 10. | 2026-09-16 |
| 3 | Whether the availability ledger's screening default scope is right. **Settled by ruling 0011**: the narrowness is correct, the default is the defect. | 2026-09-16 |

## Format

`## Authorized now` takes `- key: value` lines. `ruling` is a ruling id or
`none`; the remaining keys follow the handoff shape — objective, approved
decision, scope, exclusions, acceptance checks, dependencies, unresolved,
report.

Open items are a table; `owner` is `decision` or `build`; `status` is one of the
six states in ruling 0015 (`proposed`, `approved`, `implemented`, `tested`,
`released`, `verified`), and decision items may only use the first two. Anything
at `tested` or beyond names its evidence in the row. If parts of an item sit at
different states, it is two items.

Move an item to Closed rather than deleting it — what was decided and then
dropped is itself a fact worth keeping. Compress on the way out: full reasoning
lives in the ruling, and this file is read every turn by both spaces.
