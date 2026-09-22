# Review 0022 — the provisional credit schedule, from measured runs

Decision space, 2026-09-22. Implements decision 0006's next step: per-operation
credit prices from measured costs where measurements exist, estimates labelled
as estimates where they do not (ruling 0021 applies to a price's basis).
Everything here is a PROPOSAL until the owner signs off; nothing is billed to
anyone today.

## The measured base

Population and basis stated per row. Model prices used for token-priced
estimates: the operations run on claude-sonnet-4-6 ($3 in / $15 out per MTok)
except research's newest run on claude-sonnet-5 ($2 / $10); verified against
current Anthropic pricing 2026-09-22, not recalled.

| operation | basis | cost per run |
|---|---|---|
| research | **measured** — 45 priced rows in research_runs (the system's own cost accounting, searches included), median 155K in / 12K out | p10 $0.15 · **p50 $0.65** · p90 $1.07 · max $1.16 |
| discovery_search | **measured tokens** — 6 completed ledger rows, ~40K in / ~2K out each ≈ $0.15; web-search per-call fees NOT in token counts, allowance added | ~$0.15 tokens + fee allowance → **~$0.25 planning figure** |
| draft (intro email) | **measured** — 1 ledger row, 2.5K/520 | ~$0.015 |
| revisit_suggest | **measured** — 1 ledger row, 2.0K/230 | ~$0.01 |
| strategy | **estimate** — unmeasured; structure (search + analysis) parallels research's | $0.30–0.60 assumed |
| research_verify | **estimate** — unmeasured, single call over run context | ~$0.05 assumed |
| channel_fit | **estimate** — unmeasured, single small call | ~$0.02 assumed |
| proposal_draft | **estimate** — being built (item 63); long-form output | $0.10–0.15 assumed |

Distribution note per ruling 0022: research costs are not one population —
13 of 45 runs sit at or under $0.25 and 7 above $0.90; the median carries the
middle only.

## Proposed credit prices

Design rules: fixed price per operation type (decision 0006 — never per
token); margin ≈ 3–6× on measured cost at the proposed plan rates; failed,
empty and platform-killed runs cost the customer **nothing** (the recorded
recommendation, now proposed as policy — note this makes the empty-run
problem OUR margin loss: today's empty research run spent ~$0.20 of model
time to find nothing, which is what decision 0004 §3's dead-end guard
precondition is about).

| operation | credits | basis |
|---|---|---|
| Research run | 25 | measured |
| Strategy run | 15 | provisional (estimate) |
| Discovery search | 10 | provisional (measured tokens + fee allowance) |
| Proposal draft | 5 | provisional (estimate) |
| Intro email / call-prep draft | 1 | measured |
| Channel-fit suggestion | 1 | provisional |
| Revisit suggestion | 1 | measured |
| Claim verification | 2 | provisional |
| Any failed / empty / killed run | 0 | policy |

Every provisional row re-prices from ledger rows as they accumulate; the
ledger records exactly what the schedule needs, by construction.

## Proposed plans (owner's call, not mine)

- **Starter — $49/month**: 300 credits, 2 seats. (≈ 12 research runs, or a
  monthly mix of ~2 discoveries + 6 research + drafts.)
- **Growth — $99/month**: 750 credits, 5 seats.
- **Top-up**: $10 per 100 credits.
- Allowances sized so a typical small team rarely thinks about credits
  (decision 0006); credits are accounting truth, not daily experience.

At these rates a credit yields $0.10–0.16 of revenue; research at 25 credits
returns 3.8–6.3× its measured median cost. The number that would break this
is discovery's true per-search fee volume — re-measure before launch.

## Proposed founding-tester terms

Free for 90 days at 500 credits/month, in exchange for: a weekly 30-minute
feedback conversation (or written notes), permission to observe usage through
the run ledger, and a case-study/testimonial option on success. After 90
days: 50% off any plan for the first year. Two named organizations maximum
at these terms — scarcity is honest here, since the ledger observation IS
the product's pricing research.

## Also observed while measuring

- The cron fired 6 channel discovery searches while testers are paused —
  background model spend (~$1/night order) the owner may want paused too.
- The killed-run encoding caught its first real specimen: a discovery row
  born with no terminal outcome. Ruling 0026 clause 2 working as designed.
- Research's newest run came back `empty` — 84K tokens for zero claims —
  now visible per-run in the ledger instead of only in margins.

## Handed to the ledger

Owner sign-off wanted on: the credit prices, the two plans, the top-up rate,
and the founding terms. On yes, decision 0008 records them; item 25 then
holds only "re-price provisional rows from ledger data before launch."
