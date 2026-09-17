# 0012 — Step 4 wired: the availability ledger reaches the product

Build report. Authorized by `STATE.md` `## Authorized now` — ruling 0013, with
acceptance check (5) added by ruling 0017 and check (6) added 2026-09-17.
Rulings read in full before writing code: 0008, 0009, 0010, 0011, 0013, 0017.

Branch `build-1-qualification`. **Not merged.** STATE's merge clause was revised
2026-09-17 to make the merge a separate human approval gate; this report stops
at the gate.

---

## The invariant, stated without naming a funder

> Anything the interface offers a user as a reason to spend money is computed
> from the availability ledger for the decision that consumes it, and a fact the
> ledger says cannot be closed by more work is shown with its reason and offered
> nowhere.

---

## What decides each invariant, and every call site now routed through it

Ruling 0010 asks for the function and the call sites, not a count.

### 1. "Is this fact obtainable?" — `deriveAvailability` (`lib/availability.ts:194`)

Unchanged in this pass; it was already correct under rulings 0008 and 0011. It
had **zero** production callers, which is what ruling 0010 says makes Step 4
unfinished.

It now has exactly one caller, deliberately: `availabilityForResearchRun`
(`lib/availability.ts:274`). That function is the single place the live run's
stored columns are mapped onto an `AvailabilityInput`, so the four judgement
calls ruling 0013 constrains are made once, in one reviewable place, rather than
re-invented per call site. The mapping, and the reason for each:

| Input | Value | Why |
|---|---|---|
| `coverage` | `null` | Per-purpose coverage comes from Tier 2 (`lib/tier2/fetch.ts`), which is not in the live path. Ruling 0013 rejects inferring it. |
| `registry` | `{retrieved: true, publishesGrantsPaid: true}` when `research_runs.filing_fetched === true`, else `null` | `filing_fetched` is written at `app/(dashboard)/prospects/[id]/research-actions.ts:609` from `fetchedSources.some(classifySourceType(...) === "irs_filing")` — a record of retrieval, not an inference from one. |
| `publishesGrantsPaid` | `true` | Only `false` produces a verdict (`not_applicable` on `charitable_disbursements`, `lib/availability.ts:141`), and the live path records no form type. `true` asserts nothing: the fact lands on `checked_not_stated` instead. **Both are `obtainable: false`, so this choice changes the reason shown and never the offer.** |
| `subjectType` / `regime` | `"unknown"` | Neither is recorded. Search that establishes it: `grep -rn "subject_type\|disclosure_regime" supabase/migrations/` → no matches across all 65 migrations. |
| `siteReachable` | `true` | Under `coverage: null` this selects `not_checked` ("no page was read for X") over `retrieval_failed` ("the site could not be reached"). Both obtainable, so the offer does not turn on it — but the live path cannot evidence a *failed* attempt at a purpose, and claiming one would be the screen telling a user we tried when we did not. |

**Consumer named at every call site: `screening`.** Ruling 0011 forbids a
default and requires the caller to name its decision. Three reasons for
`screening` rather than `strategy`, all from ruling text rather than preference:
ruling 0008's compliance probe is run against screening's required set
(`rulings/0008…:58-59`, "the only two `either` keys in screening's required
set"); ruling 0011 reasons about this exact surface in screening's terms
("screening requires `funding.recent_grants` because for the 22% of prospects
with no reachable site, revealed giving is the only evidence of fit there is");
and the measured harm — five paid runs chasing a 990 grant schedule — is
`funding.recent_grants`, which is *required* for screening and only *advisory*
for strategy. Choosing `strategy` would have dropped that fact out of the ledger
entirely and taken the grant-schedule offer with it, which is the opposite of
what ruling 0013 asks for. **This is a build judgement, not a ruling; see the
open question at the end.**

Call sites of `availabilityForResearchRun`, all three:

1. `lib/prospect-intelligence.ts:417` — `loadProspectIntelligence`, feeding the
   prospect Research tab.
2. `app/(dashboard)/prospects/[id]/research-actions.ts:251` — `runResearch`,
   computing the next paid run's search targets.
3. `app/admin/research/page.tsx:273` — the superadmin run audit, which labels
   sections "missing" beside a button that pays for another run.

### 2. "May this be offered as work?" — `obtainableGaps` → `offerableGaps` (`lib/availability.ts:219`, `:337`)

`obtainableGaps` also had zero production callers. It now has two:
`lib/availability.ts:344` (inside `offerableGaps`) and
`app/(dashboard)/prospects/[id]/research-tab.tsx:160`.

`offerableGaps` is the single filter ruling 0009 demands between the ledger and
the rerun treadmill. It does not move the gap vocabulary — `outstandingIntelligence`
and `FOCUS_SEARCH_DIRECTIVES` (`lib/research.ts:380`, `:408`) are untouched;
what changed is their input. Two rules:

- Where the ledger has graded a fact, the ledger decides. A section whose graded
  facts are **all** unobtainable is not offered, in any wording.
- Where the ledger has nothing to say — a section holding no fact *this*
  consumer requires, e.g. `leadership` — the facts are still `not_checked`, so
  the section continues to be offered. This is ruling 0013's general invariant
  applied to itself: the guard does not reach past the evidence it has.

Every surface that names something missing, outstanding, a gap, or a target of a
run, and what it now reads:

| Surface | file:line | Input now |
|---|---|---|
| Button's gap list ("What another search could still find") | `research-panel.tsx:172` | `intelligence.offer` via `outstandingIntelligence` at `research-tab.tsx:152` |
| Confirm dialog's named targets | `research-panel.tsx:222` | same list |
| Banner sentence on the Research tab | `research-tab.tsx:293-301` | `obtainableGaps(ledger)` at `research-tab.tsx:160` |
| Banner heading ("Research available, with gaps") | `research-tab.tsx:262` | `openFacts.length` |
| Grant-schedule note under Coverage | `research-tab.tsx:404` | `intelligence.offer.sourceClasses` |
| Next run's search directives | `research-actions.ts:266` (`focusKeysFor`) | `offerableGaps(...)` at `research-actions.ts:260` |
| Admin run audit chips | `app/admin/research/page.tsx:291` | `offerableGaps(...)` at `:272` |

There is no remaining path that computes "what is missing" from the presence or
absence of claims. Search that establishes it:
`grep -rn "missingSourceClasses\|missingSections" --include="*.ts" --include="*.tsx" app/ lib/`
— every hit is either inside `offerableGaps`, an argument being passed *into*
it, or `lib/prospect-intelligence.ts:531`, which is the raw retrieval
diagnostic on the type and is now read by no UI.

### 3. "What does the user see for a fact that cannot be obtained?" — `AVAILABILITY_WORDING` + `factLabel` (`lib/availability.ts:371`, `:409`)

Ruling 0017's display half. One call site: the **"What screening needs"** block
at `research-tab.tsx:363-386`, which lists all 13 screening-required facts in
every state, each with the ledger's own `reason`, and marks *exactly* the
obtainable ones with "another search could find this"
(`research-tab.tsx:378-380`, keyed off `f.obtainable`).

**On ruling 0017's "say so rather than silently reworking it":** there was no
already-written "remove from view" behaviour to supersede. At session start
`git status --short` showed only `lib/availability.ts` and
`scripts/test-availability.ts` modified among code files; `research-tab.tsx` was
untouched, and its Coverage card showed section chips for all seven sections.
Nothing was removed from view and then restored — the per-fact display is new.

---

## The acceptance checks, one by one

**(1) With `coverage: null`, no interface string asserts completeness over the
fact set; `research-tab.tsx`'s "Every information category was found" must be
unreachable.** Met. The string is deleted, not reworded. Search:
`grep -rn "Every information category\|Everything looked for was found\|Nothing is recorded as missing" --include="*.ts" --include="*.tsx" app/ lib/ components/ scripts/`
returns one hit, `research-tab.tsx:288`, inside a comment recording the deletion.
Three false-completeness strings were removed, not one:

- `research-tab.tsx` — "Every information category was found."
- `research-panel.tsx` — "Everything looked for was found on {date}."
- `research-panel.tsx` — "Nothing is recorded as missing for this funder."

Each replacement states the two facts separately, as ruling 0009 requires:
how many were **found**, and how many were **looked for in every source that
could carry them and not stated** (`research-tab.tsx:297-301`,
`research-panel.tsx:198-202`). The third had a worse failure: it rendered
whenever `gaps` was empty, including when there was no ledger at all. The panel
now takes a `coverage` prop that is `null` in that case
(`research-panel.tsx:34`, `:44-52`) and says **nothing** about coverage rather
than defaulting to the flattering reading.

**(2) Registry facts reach `not_applicable` / `checked_not_stated` where
warranted and are not offered.** Met, with one honest limit. With
`filing_fetched === true`, `funding.total_annual_giving`,
`funding.charitable_disbursements` and `funding.funder_type` reach
`checked_not_stated` and drop out of `obtainableGaps`. `not_applicable` is
**not** reachable in the live path, because both routes to it
(`lib/availability.ts:135` on `regime === "none_public"`, and `:141` on form
type) need a value the live path does not record. That is a *narrower* close
than the check's wording implies, and I am reporting it rather than rounding it
up: the registry half stops lying, but it stops lying by saying "we read it and
it did not carry this", never by saying "they never file this".

**(3) Site facts are all obtainable and all still offered.** Met. Asserted in
`scripts/test-availability.ts` — "every site fact is still obtainable, filing or
no filing" and "no site fact is ever declared settled". Nothing is suppressed on
the site side; item 16 stays open exactly as ruling 0013 requires.

**(4) Ruling 0010's grep test.** Met — see the tables above. The grep that
previously returned only `lib/availability.ts` and its own test now returns four
production files.

**(5) Ruling 0017's display requirement.** Met. All 13 required facts render in
every state with their reason; the five state labels are pairwise distinct and
carry no internal vocabulary (asserted in the test file: "no two states read the
same", "no internal vocabulary leaks into the wording"). `checked_not_stated`
reads *"Checked — they do not state it"*; `not_checked` reads *"Nobody has
looked yet"*. Exactly the obtainable facts carry an action.

**(6) The false "credits" claim.** Met. Both strings replaced:

- `research-panel.tsx:187` — "…it costs real money and takes several minutes."
- `research-panel.tsx:226` — "It costs real money and takes several minutes."

No balance, allowance or quota is named. Search establishing the claim was
false: `grep -rn "credit" supabase/` returns nothing across all 65 migrations.
`grep -rn "credit" --include="*.ts" --include="*.tsx" app/ lib/ components/`
now returns two hits, both comments (`research-panel.tsx:182` recording the
correction, `lib/research.ts:1751` an unrelated use of "credited").

---

## Measurements, real numbers

- `npx tsc --noEmit` — clean, no output.
- `npx next build` — "✓ Compiled successfully", 28 routes generated.
- Test suite, every `scripts/test-*.ts`, run individually:

| file | result |
|---|---|
| test-availability.ts | 65 passed, 0 failed (was 37) |
| test-candidate-attestation.ts | 19 passed, 0 failed |
| test-candidate-intake.ts | 16 passed, 0 failed |
| test-citation-consistency.ts | 7 passed, 0 failed |
| test-decision-contract.ts | 69 passed, 0 failed |
| test-discovery-handoff.ts | 31 passed, 0 failed |
| test-entity-scoring.ts | 71 passed, 0 failed |
| test-entity-validation.ts | 140 passed, 0 failed |
| test-identity-predicate.ts | 28 passed, 0 failed |
| test-legitimacy.ts | 78 passed, 0 failed |
| test-prospect-workflow.ts | 23 passed, 0 failed |
| test-tier2-manifest.ts | 70 passed, 0 failed |
| test-tier2-selection.ts | 43 passed, 0 failed |
| **total** | **660 passed, 0 failed** |
| test-research-concurrency.ts | **did not run** — "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" |
| test-tenant-isolation.ts | **did not run** — same, plus anon key |

The 28 new assertions in `test-availability.ts` are not a completion claim and
are not offered as one. They cover the *mapping* (`availabilityForResearchRun`)
and the *filter* (`offerableGaps`) rather than the derivation, which is where a
guess would have hidden — the derivation already had 37 tests and still shipped
ruling 0008's defect, because no real input ever reached it.

- `npx tsx scripts/ledger-check.ts` — "ok protocol intact", 5 pre-existing
  warnings about reconstructed rulings 0002/0003/0005/0006/0007.

---

## What I did not check

- **Nothing was run in a browser.** No dev server was started and no page was
  rendered against real data. The display half of ruling 0017 is verified by the
  type checker, the production build, and assertions over the wording map — not
  by looking at it. Spacing, alignment and how the 13-row list reads at the
  bottom of a long tab are **unverified**.
- **No live research run was executed.** Every claim about what the ledger
  produces for a real prospect is a claim about the code path, derived from
  stored columns I read (`filing_fetched`, `missing_information`,
  `missing_source_classes`, `research_claims.evidence_missing`) — not from
  observing one. This is the same gap as open item 5.
- **The two Supabase-backed test files did not run**, so nothing here is
  evidence about tenant isolation or research concurrency. Neither touches the
  code changed in this pass.
- **`registry.retrieved` is only as good as `filing_fetched`.** That column is
  computed from the URL host of fetched pages
  (`classifySourceType`, `research-actions.ts:74-88`: propublica, guidestar,
  irs.gov, 990finder, candid). A filing read from a domain outside that list
  records `false`, and the ledger will then say "no registry record was
  retrieved" when one was. That errs toward **offering more work**, never toward
  suppressing it, which is the safe direction — but it is a real inaccuracy and
  I have not measured how often it happens.
- **One behaviour change I want named rather than buried:** a section is now
  dropped from the offer when all of its *screening-required* facts are settled,
  even if it also holds facts screening does not require. Concretely, once a
  filing has been read, `financial_capacity` stops being offered — which also
  stops offering `funding.total_assets`, `grant_size_range`,
  `median_grant_size` and `grant_count_annual`, none of which screening
  requires. This is the intended reading of rulings 0009 and 0011 (the offer is
  computed from the consuming decision's required set), and it is exactly the
  measured harm case. It is still a reduction in what the button will chase, and
  the decision space should see it as such.

---

## One open question, raised as an item rather than decided

The Research tab's ledger names `screening` as its consumer. But the dossier
that tab displays is also the input to a **strategy** run
(`loadApprovedIntelligence`, `lib/prospect-intelligence.ts:619`), and strategy's
required set is different: 18 keys, of which 8 are not in screening's —
`application.accepts_unsolicited`, `application.deadline`,
`application.invitation_mechanism`, `application.fiscal_sponsorship_rules`,
`funding.grant_size_range`, `funding.median_grant_size`,
`funding.international_reach`, `funding.total_assets`.

Under ruling 0017 those 8 facts are *not* displayed with a reason on that
screen, because they are not in the consumer's required set this call site
names. If the decision space reads the Research tab as serving both decisions,
that is a gap in ruling 0017's coverage and the fix is a second ledger beside
the first, not a change to either function. I have not made that call — it is a
question about which decision a screen serves, which ruling 0011 puts with the
consumer and ruling 0016 puts with the decision space. Recorded as item 26.
