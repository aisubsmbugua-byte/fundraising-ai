# Where should the human gate sit in the Research → Strategy handoff?

Prepared for external review · Fundraising AI · Build 1 (Research Agent)

## Context

Fundraising AI's Research Agent produces evidence-backed claims about a funder. An independent verification pass checks each claim against its own cited evidence — the verifier sees only the claim and that evidence, never the other claims and never the extraction prompt. A human then approves, corrects, or excludes each claim. Only approved claims reach Strategy.

We have just reordered the product so this is the critical path: accepting a prospect starts research, and no strategy is generated until a person has approved intelligence. This was a background concern while research was an internal tool. It is now the thing a fundraiser must get through before they can do anything else.

## What we measured

Across every prospect with a verified run — 2 funders, 61 claims, 34 of them "material":

| Measure | Maclellan v29 | Servants Heart v14 | Total |
|---|---|---|---|
| Claims | 18 (10 material) | 43 (24 material) | 61 (34) |
| Already decided | 0 | 13 | 13 |
| Verified, bulk-approvable | 6 | 0 | 6 |
| Needing an individual decision | 12 | 30 | 42 |
| — never checked, by design | 8 | 19 | 27 (64%) |
| — checked, not supported | 4 | 11 | 15 (36%) |

## The finding

Verification covers only 21 "material" claim keys: identity, eligibility, restrictions, financial capacity, application access, recent giving. Everything else — funder type, focus areas, geographic focus, international reach, key contacts — can never carry a verdict however good its evidence is. It surfaces as "Not yet checked" and demands an individual human decision.

The 27 "never checked" claims are **exactly** the 27 non-material claims. Not approximately: identically.

- 100% of non-material claims require manual judgement, with no automated support of any kind.
- 64% of the review burden is a coverage decision we made, surfacing as reviewer work.
- The 36% that is genuine signal — 15 decisions across two funders — is a defensible ask.

Meanwhile every material claim is accounted for cleanly: 13 decided, 6 verified and awaiting bulk approval, 15 genuinely flagged. The material path works. The non-material path has no automated support at all.

## Why "just verify everything" is not the obvious fix

Our first instinct was to extend verification to all claim keys. Examining it changed our view. We are presenting the argument against our own instinct so it can be attacked.

**1. It probably does not shrink the queue — it relabels it, downward.**

A verdict takes precedence over claim type in our review-state logic. A non-material claim today reads "Not yet checked" or "Interpretation". Verify it and it gets a real verdict; if that verdict is `partially_supported` it becomes "Partly supported", and if `unsupported` it becomes "Conflict". Both still require an individual decision, and both read as more alarming than what they replaced. We would convert 27 low-attention items into a smaller number of high-attention ones.

**2. The data suggests roughly half would come back flagged.**

Among material claims — the quotable, factual ones verification was designed for:

- Maclellan: 4 of 10 not fully supported (40%)
- Servants Heart: 11 of 24 not fully supported (46%)
- Combined: 15 of 34 (44%)

Non-material claims are more interpretive, not less, so their rate would plausibly be equal or higher. At 44%, verifying all 27 yields roughly 12 new explicit exceptions. The queue goes 42 → about 27: a 36% reduction, for roughly 80% more verification compute, with 12 items that became more alarming rather than resolved.

**3. Verification asks a question these claims cannot pass.**

The verifier asks: does the evidence state this? That is the right question for "charitable disbursements of $1,855,039 in FY2024". It is the wrong question for "focus areas: education, Christian ministry, international missions", which is a synthesis across several sources by construction. It was never a quotable fact, so a low verdict would not mean the claim is wrong — it would mean we asked a category error and then charged a human to adjudicate the result.

The material/non-material line may substantially *be* the quotable/interpretive line. If so, extending verification across it is extending a tool past its domain.

**4. It flattens a distinction that exists for a reason.**

The material set is defined by consequence, not by checkability: those 21 keys are the ones that can invalidate an ask. Giving `geographic_focus` a green "Verified" badge off one aggregator page puts it visually level with an EIN confirmed from an IRS filing. Today non-material claims at least look unchecked, which is honest.

**5. Cost, latency, and a failure surface that has already bitten us.**

Verification is a separate invocation precisely because chaining it risks killing a completed dossier — search (150s) plus extraction (280s) already crowds a 450s budget. Going from 24 to 43 claims per run makes verification slower and likelier to fail, and a failed verification leaves the run in "verification incomplete". More claims verified means more runs where nothing is.

**6. More model judgement is the wrong direction for this codebase.**

The through-line of this build has been moving guarantees out of model judgement and into code. Prompt-only compliance measured 52–80% across repeated runs. Entity ranking was removed entirely after failing three times. Adding 80% more model verdicts adds surface for exactly the inconsistency we have spent the project removing.

## The tension

Hard rule 3 of this project is: AI drafts and suggests; humans decide. But a queue of roughly 21 items per funder, two-thirds of them flagged for a reason the reviewer cannot act on, produces rubber-stamping. A gate that is always clicked through is worse than no gate, because it manufactures a false record of human judgement.

## Two structural findings alongside it

**Depth tiering and verification were designed against each other.** Verification is queued only for `dossier`-depth runs; a `screen` run has verification skipped entirely, so 100% of its material claims would enter the queue unchecked. Maclellan v29 above is screen depth and only carries verdicts because someone triggered verification by hand. This is currently masked because every user-facing run is now dossier, but it is latent.

**A blocked run still presents a review queue.** Our test prospect has an unconfirmed entity: 33 claims a person cannot usefully act on, because they may describe a different organization. The workflow state now asks for identity instead of review, but the claims are still listed below it.

## Options

**1. Expand verification to all claim keys.** "Not yet checked" largely disappears. Our own analysis above argues this converts unchecked claims into flagged claims without reducing decisions proportionally, at meaningful compute cost.

**2. Change what requires a decision.** Let unverified non-material claims flow to Strategy as explicitly advisory context, reserving human decisions for material claims. Matches what those claims actually are. Risk: 27 claims would reach the strategy prompt without individual review. Bounded by three things — they are low-consequence by construction (that is the definition of the set), they would be labelled advisory rather than presented as fact, and the strategy itself still passes a human gate.

**3. Restructure the review UI.** Group by section, allow section-level approval, sort by consequence. The measurement suggests this addresses the symptom only: re-arranging a queue does not change what is in it.

**4. Rely on the second gate.** The strategy is reviewed and approved by a human before anything reaches a funder. Does that make per-claim approval partly redundant for non-material context?

## Open questions we could not answer from our own data

1. **Is "material" drawn in the right place?** `people.key_contacts` is non-material today, yet a wrong name in an outreach email is not obviously low-consequence. If the set is mis-drawn, both options 1 and 2 inherit the error.
2. **Does the material/non-material line actually equal the quotable/interpretive line?** We assert a correlation. We have not measured it, and our argument in section 3 above depends on it.
3. **Is the 44% projection sound?** It assumes non-material claims fail verification at the same rate as material ones. Untested. It could be measured directly by verifying one run's non-material claims as a one-off experiment before committing to a policy.
4. **Should screen-depth runs be verified at all**, or is unverified screening acceptable precisely because screening is not the basis of an ask?
5. **Should a blocked run show claims at all?** Presenting 33 unreviewable claims under an identity prompt may be worse than showing none.
6. **Should a reviewer be told which of their decisions had no downstream effect?** We now withhold approved financial claims with no stated reporting period from the strategy payload entirely, so human approval no longer guarantees a claim is used — and the reviewer is not told.
7. **Is n=2 enough to set policy on?** Two funders, one of them screen depth. The ratio has been stable across both, but the sample is small.

## Constraints

- No auto-send, ever. Nothing reaches a funder without an explicit human click.
- No automatic pipeline-stage advancement.
- The strategy always passes human approval regardless of what is decided here.
- Two pre-beta testers, so historical data is not worth preserving.

## The direct question

Should the human gate sit on every claim, on material claims only, or on the strategy that results from them?

And if verification coverage is the real lever: is there a principled line between "material" and the rest, or is that distinction itself the mistake?
