# 0037 — Partner build list: review, and the reference-first matching engine

Date: 2026-11-12. Status: recommendations for the owner's decision; nothing here is a ruling yet.

## What we have already (so the list is read against it, not in a vacuum)

| Partner item | State today |
|---|---|
| 1. Funder database | **Built.** 63,321 private foundations + 43,999 grantmaking public charities / donor-advised-fund sponsors (about 107k, in line with the 100–120k the partner quotes). EIN, kind (a funder can be a charity and a sponsor at once), assets, giving, average gift, every value linked to its filing. **Gaps:** focus areas (not stored), geography (only the funder's own state and the grants' recipient states). |
| 2. Grantee-to-funder index | **Data is there, index is not.** 2.70M public-charity grant rows, 95% carrying the recipient's EIN. 4.31M private-foundation grant rows carrying **no recipient EIN at all** (the 990-PF does not require one) — name, city and state only. |
| 3. Ministry profile and application | **Partly.** Organization profile and evidence library exist. No statement of faith, no named peers, no "what makes us stand out". |
| 4. Match engine | **Not built.** Today's discovery is web search; matching is by channel, not by who funded whom. |
| 5. Outreach kit | **Mostly built.** Strategy run, drafts, human approval, no auto-send. Missing: "what they have funded in the space" drawn from the grant rows. |
| 6. Funder-side view | Not built. See recommendation. |
| 7. Pilot | Not started. |
| 8. Data hygiene | Filing date and tax period are shown on every value (ruling 0045). Name matching across years is not solved for foundations. |

## Tested, not assumed: the "primed pump" runs on our data

Five real peer ministries, looked up by EIN on the charity side and by name on the foundation side:

| Peer | Funders found (charity side, by EIN) | Funders found (foundation side, by name) |
|---|---|---|
| Global Disciples | 11 ($3.98M) | 14 ($0.76M) |
| Missio Nexus | 4 ($1.47M) | 2 |
| OC International Support Foundation | 0 | 10 ($0.29M) |
| Global Missions Project | 4 ($0.08M) | 0 |
| Worship Quest Ministries | 1 ($10k) | 0 |

Two readings. The idea works. And the two sides are not the same quality: the charity side is exact (EIN to EIN), the foundation side is a name match and some peers vanish from it (the same peer shows 0 on one side and 10 on the other). A ministry's peer list therefore returns a real but incomplete answer unless we fix the foundation side. That is the single biggest technical risk in the list.

## Recommendations on the direction decided on the call

1. **Christian ministries only, statement of faith in the application — agree.** Store the statement verbatim and have a human decide; the AI should not judge theology. Fits hard rule 3.
2. **~100 ministries from Global Convene, charge them — agree on the pilot, change the billing.** There is no billing or credits system in the product (decision 0004 is still provisional, and says metering must not ship before its three open questions are answered). Do not build billing for a 12-ministry pilot: invoice it outside the app, flat fee.
3. **Back door for funders (show McClellan the vetted ministries) — defer.** It is a different product (two-sided), it needs a funder who has agreed to it, and it brushes against hard rule 1: pushing ministries at a funder is outreach. It also meets a fact in our own data: some funders state they give only to pre-selected charities (Servants Heart, First Fruit, Kern all do). Build only if a funder partner opts in, as a pull view they sign in to, never something we send them.
4. **Primed pump — the strongest idea on the list; build it first.** Tested above. Rank by how much of the funder's giving goes to that space, not just whether it ever gave: National Christian Foundation has given to almost everybody, and an unranked "every funder of your peers" list is mostly noise.
5. **"Go as wide as possible" — agree, because the data is already national.** The limit is not data; it is vetting ministries (a human step). Width is free, vetting is the bottleneck.

## The build list, item by item

1. **Funder database: add focus areas and geography as derived values.** Derive from what the funder actually funded (recipient names, purposes, states), labelled "derived from N grants", not typed by a model. This is the "capture, don't retype" rule.
2. **Grantee-to-funder index: build it, and add the IRS exempt-organizations master list.** It maps name and address to EIN for every exempt organization. It fixes the foundation side and name-change tracking in one step. Until then, foundation-side matches carry a confidence label and a human confirms.
3. **Ministry profile: add statement of faith, sector, geography, budget, up to four stand-out points, and named peers.** Peers are picked by EIN from a search, never free text. Churches do not file a return and cannot be peers; the form must say so instead of failing quietly.
4. **Match engine: peers, then their funders, ranked by fit, each with the reason.** Fit = gift size against the ask, recency, geography, share of the funder's giving in the space. Every reason is computed from stored grant rows, so it can be checked by clicking through to the filing. Output is a list for human review (rule 3); accepting a row creates the prospect exactly as today and starts the strategy run — with the EIN already resolved, which web discovery never achieved.
5. **Outreach kit: "who to write to" should be the funder's own stated way in** (the application terms we already store, the funder's website), not a hunt for named people. A funder that only gives to pre-selected charities is shown as "no unsolicited requests" and ranked down, not offered a letter. Drafts, never sends.
6. **Funder-side view: defer** (see above).
7. **Pilot: 12 ministries.** Success = meetings booked and dollars raised, recorded by the human on the prospect (outcomes table exists). Suggest the pilot also counts "matches a ministry judged real" to measure the engine itself.
8. **Data hygiene:**
   - 990 lag of 1–2 years: show the tax period beside every number (already done).
   - Anonymous DAF grants: the sponsor appears, the donor does not and cannot; say so on screen rather than leave a gap.
   - Name matching: EIN where stated; the master list plus normalised name, city and state where not; every non-EIN match shows its confidence.

## What does not make sense, or is a trap

- Charging through the app before billing exists (above).
- Anything that implies we can name the individual behind a donor-advised fund. We cannot.
- A funder-facing view that sends ministries to funders unprompted.
- AI judging a statement of faith.
- "Average gift" alone as the fit measure: a funder's average is dominated by a few large grants. Use the range its grants actually fall in.

## Proposed build order (each step useful on its own, each needs a ruling first)

1. **Reference-first discovery** (the owner's item 1): the funder database becomes the top source in the candidate queue. Candidates come from the filings, with EIN, size, state and last-given year attached, and a reason the funder is on the list. Web search remains, below it.
2. **Grantee-to-funder index plus the master list**, so the pump is accurate on both sides.
3. **Ministry profile additions** (faith statement, peers, stand-out points).
4. **The pump match engine** and its ranked list.
5. **Outreach kit** additions.
6. **Pilot** (12 ministries) — no new build, a plan.
7. Funder-side view, only if a funder agrees.

## Decisions needed from the owner

- The clean-out of Village Worship's candidates and prospects (scope below).
- Go on build step 1 and the ruling for it.
- Whether to load the IRS exempt-organizations master list (public, free; large).
- Pilot pricing and who the 12 are.
