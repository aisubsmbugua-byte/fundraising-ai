# 0021 — An outcome can be taken back, and closed work is shown, not offered

Item 49, authorized by rulings 0027 and 0028. Build space, 2026-09-19.

## The invariant

A recorded outcome is voided only by an appended, human-written retraction row
— never an edit or a deletion — and whether an outcome is in effect is derived
in exactly one place; every surface that offers a prospect as work consults
that derivation, so an effectively-closed prospect is displayed everywhere and
offered nowhere.

Stated without naming a funder, per `docs/ledger/ROLE-build.md`.

## What changed

| File | What it is |
|---|---|
| `supabase/migrations/0068_prospect_outcome_retractions.sql` | One new table, append-only (insert+select policies only), unique per outcome, org-match trigger per 0066's pattern. **Not applied** — SQL delivered inline per the standing preference; safe to apply ahead of its code, and the code is safe ahead of the SQL (a select against the missing table returns an error the loaders treat as "no retractions"). |
| `lib/prospect-outcomes.ts` | The one derivation: `isOutcomeInEffect` (line 127), `latestOutcomeInEffect` (140); the work-list predicates `isClosedToWork` (319) and `isRevisitDue` (325); `buildOutcomeIndex` now REQUIRES retractions (227); `loadProspectOutcome` returns the outcome in effect plus a retracted-trace for display (349). |
| `app/(dashboard)/prospects/[id]/outcome-actions.ts` | `retractProspectOutcome` (line 120): the explicit human click. Inserts one retraction row, touches nothing else. |
| `components/ProspectOutcomePanel.tsx` | Retraction UI (expand-then-confirm, same shape as the record form; `buttonDanger`/`labelStyle`/`fieldStyle` tokens) at line 285; retracted-trace line in the empty state at 87. |
| `app/(dashboard)/prospects/[id]/page.tsx` | Reads the outcome in effect (line 82); header chips unchanged in form, now retraction-aware by derivation. |
| `app/(dashboard)/prospects/[id]/overview-tab.tsx` | Passes the trace through to the panel. |
| `app/(dashboard)/revisit/page.tsx` | Due now / Waiting / Scheduled exclude effective-`never` (line 36); a `revisit_on` whose date arrived joins Due now as a declined row (71) and leaves Revisit later (73). |
| `app/(dashboard)/revisit/followup-workspace.tsx` | Due now tab renders the due revisits (line 79). |
| `app/(dashboard)/layout.tsx` | Follow-up badge counts what the Due now tab holds — closed excluded, due revisits included (lines 51–56). |
| `app/(dashboard)/dashboard/page.tsx` | Today's priorities (line 133) and "Follow-ups due" (137) exclude effective-`never`; the stat moved from a head-count query to ids so the derivation can apply per row. |
| `app/(dashboard)/pipeline/page.tsx` | "Need attention" count and the most-stuck banner exclude effective-`never` (line 95); the board is handed the outcome index. |
| `app/(dashboard)/pipeline/prospect-card.tsx`, `board-view.tsx` | Every board card shows an effective outcome as a fact — Declined chip, disposition chip from `describeDisposition`, reason line (prospect-card.tsx:99). Nothing hidden; the card stays on the board. |
| `scripts/test-prospect-outcomes.ts` | 121 → 176 assertions. |
| `scripts/test-tenant-isolation.ts` | Extended with a `prospect_outcome_retractions` section (NOT EVALUATED when 0068 is absent, like the ai_runs section). **Did not run** — it writes to the live database and 0068 is not applied. |

## The rulings' tests of compliance, mapped

**0027 — record, retract, both readable; derivation reports no outcome in
effect; new outcome afterwards is a new row.** Offline: outcome+retraction
derives null, both-readable is a property of the derivation not mutating its
inputs, and a new row after retraction is in effect
(`scripts/test-prospect-outcomes.ts`, "ruling 0027" section). Database halves
(both rows readable through RLS; update/delete refused on the retraction) are
written in `scripts/test-tenant-isolation.ts` and **wait on 0068 being
applied**.

**0028 — a `never` prospect with a past due date appears in no work list, is
shown on the board and its page with its reason; retract it and it returns;
`revisit_on` tomorrow is absent today, due tomorrow.** The exclusion runs
through one predicate in all four work surfaces (revisit page, sidebar badge,
dashboard, pipeline signals — enforced by the consumer scan in
`scripts/test-prospect-outcomes.ts`, "one derivation, every consumer");
`isRevisitDue` is boundary-tested on the day before, of, and after.

## Numbers

- `npx tsc --noEmit`: exit 0.
- `npx next build`: compiles, 28 routes, no errors.
- `scripts/test-prospect-outcomes.ts`: 121 → **176 passed, 0 failed** (all offline).
- `scripts/test-ai-runs.ts`: 43 of 43 still passing (its closed-set scan sees no new model-calling file — the retraction path calls no model).
- `scripts/test-tenant-isolation.ts`: **not run** (live DB writes; 0068 unapplied). Its new section holds 7 assertions.

## Decisions taken in build (flagged, not silent)

1. **Column named `prospect_outcome_id`, not `outcome_id`** — matching
   `prospect_outcome_dispositions` in 0066 so the two child tables address an
   outcome identically.
2. **Per-prospect composition of the per-outcome rule**: the outcome in effect
   is the most recently recorded outcome that no retraction voids. Ruling 0027
   defines effectiveness per outcome; with multiple outcome rows on one
   prospect (recordProspectDecline does not forbid it), retracting the newest
   leaves an older unretracted one standing. Tested explicitly.
3. **The badge counts what its list shows**: the Follow-up sidebar badge
   includes due revisits, because the Due now tab it opens now lists them — a
   badge diverging from its list is the interface-asserts-otherwise defect.
4. **Dashboard priorities do not gain due revisits** — clause 3 requires a due
   revisit to surface as due, which the Follow-up page and badge do; adding a
   new row type to Today's priorities was judged beyond "smallest change".
5. **Retracted-trace line**: when a retraction leaves no outcome in effect, the
   panel's empty state says a record was retracted rather than showing an
   absence identical to "nothing ever happened" (never silently delete, even
   visually).

## Not confident / not done

- The retraction UI and both rulings' DB behaviour are unexercised against a
  real database until the owner applies 0068.
- Health chips still render on a closed prospect's board card ("stalled"
  beside "Declined · Never revisit") — display of a date fact, not a work
  offer, so left alone; flagged for the decision space.
- The pipeline stage drill-down (`stage-view-workspace.tsx`) and the pipeline
  List view show no outcome; ruling 0028 clause 2 names the board and the
  prospect page as the minimum, which is what shipped.
