# 0020 — Item 42: what distinguishes the sites selection fails, diagnosed without a model call

**Date:** 2026-09-19
**Space:** build
**Authorization:** item 42 diagnosis dispatch — classification only. No code was
changed, no fixture was touched, no model was called. The Anthropic API was not
used: the reconstruction sets a placeholder value for the key environment
variable solely because `lib/ai/anthropic.ts` constructs its client at import
time, and the only function invoked from `lib/tier2/select.ts` is
`buildSelectionPrompt`, which is exported precisely so it can be inspected
offline. A paid re-run is the owner's decision, not taken here.
**Binding on this report:** ruling 0021 (every count names its set), ruling 0022
(every rate carries its per-case distribution), ruling 0024 (every absence claim
names the set it was checked over), review 0009 (classification, not repair).

---

## The question

In the 2026-09-19 paid run (review 0019), of the 7 cases whose ground-truth
pages reached the shortlist, 3 selected none of their true pages (ncf,
mariners, signatry) — while selecting other pages tagged for purposes the human
recorded as unpublished — and 4 selected everything or nearly (stewardship 5/5,
missio-nexus 4/4, maclellan 4/4 of available, antioch 4/5). Item 42 asks: what
distinguishes the failing sites' manifests from the working sites' — is there a
structural pattern a ruling could target, or is this model noise?

## Method: everything before the model call is deterministic, so rebuild it

Discovery (`lib/tier2/discovery.ts`), manifest construction
(`lib/tier2/manifest.ts`) and prompt rendering (`buildSelectionPrompt` in
`lib/tier2/select.ts`) involve no model. For each of the seven sites I re-ran
discovery against the live host and rebuilt the manifest and the prompt with
exactly the options `scripts/reference-recall.ts` uses — including its
opportunity handling at line 120: `buildManifest` receives an opportunity name
only when the fixture's funder string contains a spaced dash, which among these
seven is true only for missio-nexus ("Ministry Innovation Fund"); and
`selectPages` at line 129 receives only the manifest and funder name, so no
prompt in this measurement ever names the opportunity (an observation in its
own right, recorded below). Ground-truth URLs from
`docs/reference-set/cases.json` were located in each rendered manifest after
the same `canonicalizeUrl` normalization the script applies.

Reproduction: a scratch script importing those three modules, run with
`npx tsx` from the repo root. The load-bearing lines it mirrors are quoted here
so the procedure survives the scratchpad:

```
const manifest = buildManifest(found.urls, { host,
  opportunityName: /\s[—–-]\s/.test(c.funder)
    ? c.funder.split(/\s[—–-]\s/)[1]?.trim() ?? null : null });
const prompt = buildSelectionPrompt({ manifest, funderName: c.funder });
```

## Today's reconstruction against the recorded runs (drift check, item 32)

Population: the 7 item-42 sites, discovery run once each on 2026-09-19 (this
diagnosis), compared with the URL counts recorded in review 0015's completion
table (observed 2026-09-18).

| case | URLs 2026-09-18 (review 0015) | URLs today | manifest entries 0015 | entries today | capped today |
|---|---|---|---|---|---|
| maclellan | 40 | 40 | 14 | 14 | no |
| stewardship | 44 | 44 | 22 | 22 | no |
| ncf | 673 | 674 | 52 | 52 | no |
| missio-nexus | 8,648 | 8,577 | 60 | 60 | yes |
| antioch | 67 | 67 | 13 | 13 | no |
| mariners | 179 | 179 | 60 | 60 | yes |
| signatry | 520 | 520 | 60 | 60 | yes |

Drift observed: ncf +1 URL, missio-nexus −71 URLs; the other five are
identical. All 7 manifest entry counts are identical to review 0015's. Every
ground-truth URL that review 0019's run scored "in manifest" is in today's
reconstructed manifest too, so today's manifests are a faithful proxy for what
the model saw, to within that drift. This report cannot prove the 2026-09-19
prompts byte-identical to today's — the population is a live network (item 32)
— and does not claim it.

## Which true pages were selected is derivable, per URL, from the recorded run

The run output does not print which URLs the model selected, but for these
seven cases the per-case selection tallies in review 0019 force a unique
assignment, because each case's stated judgements concentrate on one or two
URLs. This is arithmetic over recorded aggregates, not an inference of
unstated selections:

- **antioch 4/5**: the faq page carries 4 judgements and the homepage 1; the
  only splits reachable are 5/5 (both selected), 4/5 (faq only), 1/5 (homepage
  only), 0/5 (neither). Recorded 4/5 forces: faq selected, homepage not.
- **maclellan 4/4 of available**: faq (3 judgements) and grantees (1) both
  selected. **stewardship 5/5**: all three distinct URLs selected.
  **missio-nexus 4/4**: both distinct URLs selected.
- **ncf 0/2, mariners 0/3, signatry 0/3**: none of their distinct true URLs
  selected (one URL for ncf and mariners, two for signatry).

## The per-URL table: every distinct true URL in a shortlist, both groups

Population: the 13 distinct (case, ground-truth URL) pairs present in the
reconstructed manifests of the 7 sites — 11 URLs plus faq double-counted
nowhere; ncf's second stated URL (recipient restrictions) is 404 and never
retrieved (item 32), and maclellan's application-process URL likewise, so
neither appears here. "Advertised" means the entry is either mandatory-flagged
by `isMandatoryPath` (`lib/tier2/manifest.ts`) — a funding-vocabulary keyword
begins a path segment or appears in the title — or opportunity-promoted to the
head of the manifest. Both are name signals; the manifest line (URL + title) is
the only evidence the model is shown.

| case | true page (path — title) | index / length | mandatory | opp-promoted | selected (derived) |
|---|---|---|---|---|---|
| maclellan | /faq — "FAQs" | 0 / 14 | yes | no | yes |
| maclellan | /grantees — untitled | 3 / 14 | yes | no | yes |
| stewardship | /guidelines-themes — "Guidelines & Themes" | 2 / 22 | yes | no | yes |
| stewardship | /applying-for-funding/eligibility-for-funding — "Applying for Funding" | 3 / 22 | yes | no | yes |
| stewardship | /applying-for-funding/submitting-a-letter-of-inquiry — "Submitting a Letter of Inquiry" | 7 / 22 | yes | no | yes |
| missio-nexus | /innovation — "Innovation" | 2 / 60 | no | yes | yes |
| missio-nexus | /innovation/2023-innovation-fund — untitled | 4 / 60 | no | yes | yes |
| antioch | /faq — "FAQ" | 0 / 13 | yes | no | yes |
| antioch | / (homepage) — "Skip to Content" | 4 / 13 | no | no | **no** |
| ncf | /support — untitled | 41 / 52 | no | no | **no** |
| mariners | /care-recovery — "Care & Recovery" | 6 / 60 | no | no | **no** |
| signatry | /user-agreement — "User Agreement" | 52 / 60 | no | no | **no** |
| signatry | /what-is-a-donor-advised-fund — "What is a Donor Advised Fund?" | 54 / 60 | no | no | **no** |

**The separation is perfect on this run: 8 of 8 advertised true URLs were
selected; 0 of 5 unadvertised true URLs were selected.** Per ruling 0022 that
is the distribution, not a rate: no case sits between the modes, and the
failing class has a name. The same split in judgement units: 17 of 17
judgements whose URL is advertised were selected, 0 of 9 whose URL is not
(populations: the 26 stated judgements whose URL is in a reconstructed
manifest, partitioned 17/9 by the advertised test above).

Note what the table does to the working/failing site framing: antioch, a
"working" site, contains one unadvertised true page — the homepage, titled
"Skip to Content" by its accessibility link — and that page is exactly its one
selection miss. The boundary runs through pages, not sites. The three "failing"
sites are simply the sites where **every** true page is unadvertised.

## What the failing sites' true pages look like, and what stood beside them

- **ncf** — the true page is the path /support, untitled, at index 41 of 52,
  in a manifest of donor-facing DAF pages. Nothing in the line says it states
  grant priorities; on a donor-services site the word reads as a help desk.
  Standing beside it, name-plausible lookalikes for the very purposes at
  stake: index 37 /requirements (titled "Learn more"), 24 /forms, 27
  /guide-to-giving-at-ncf, 0 /open ("Open a fund"), 39 /solutions ("How we
  help").
- **signatry** — the true pages are /user-agreement ("User Agreement", index
  52 of 60) and /what-is-a-donor-advised-fund (index 54). A human found the
  funder's priorities inside its user agreement; no name signal could
  advertise that. Beside them: 34 /how-to-set-up-a-donor-advised-fund ("How to
  Set Up a DAF"), 47 /start ("Start a Fund"), 30 /forms ("Forms for Donors"),
  28 /fees, 20 /charitable-solicitation-notice.
- **mariners** — the true page is /care-recovery ("Care & Recovery"), index 6
  of 60 — early, so position is not the mechanism here. The manifest is a
  church's navigation: of its 60 entries, 0 are mandatory-flagged, and 0 match
  any of the tokens eligib, guideline, criteria, restrict, requirement,
  qualif, faq, who-we, apply, grant, fund, donat, nonprofit, proposal in path
  or title (checked case-insensitively over all 60 reconstructed entries).
  There is no funding vocabulary anywhere for a name-reader to find — true
  page or decoy.

Common structure: the three failing cases are the reference set's two DAF
sponsors and its church — organizations that are not conventional grantmakers,
whose decision-critical facts a human found by reading pages named for
something else. The four working cases are conventional foundations whose
guidelines/faq/apply pages are named as such (or, for missio-nexus, whose
manifest was saturated by opportunity promotion, placing both true pages in
the top five indices). That composition is by the set's own design (review
0009 chose each case for a failure class); how common the unadvertised-page
shape is among real funders is exactly the question ruling 0022 says a
bimodal result opens, and nothing here answers it.

## The over-claim half: what stood where the absent purposes were claimed

Review 0019 records 7 mixed-site over-claims (0 of 7 absence precision): ncf
geographic restriction and application process, missio-nexus geographic
restriction, mariners geographic and recipient restrictions, signatry
geographic restriction and application process. The run output does not record
which page was tagged for any of them, and this report does not infer it. What
the reconstructed manifests establish:

- On ncf and signatry, name-plausible wrong candidates for the over-claimed
  purposes exist (listed above): a model reading names would find an
  "eligibility-looking" or "process-looking" page to tag.
- On mariners, they do not: 0 of 60 entries carry any of the funding-vocabulary
  tokens listed above, yet both eligibility over-claims still happened. So a
  plausible decoy is **not necessary** for an over-claim — whichever pages
  were tagged on mariners, their names did not support the tag. The over-claim
  mechanism is at least partly the abstention channel not firing (item 43's
  territory, ruled in 0024), not only decoy attraction.
- missio-nexus selected 4 of 4 true pages **and** over-claimed its one
  recorded absence. Presence failure and absence failure are therefore
  separable: a site can be perfect on the advertised axis and still claim a
  page for an unpublished fact. Item 42's "misdirection" framing conjoins two
  mechanisms that the deterministic evidence keeps apart.

## Hypotheses, ranked

**H1 — supported: selection is name-reading, and the failing class is "true
page whose name does not advertise its purpose."** The model's entire evidence
per page is one manifest line; the advertised/unadvertised partition separates
selected from unselected true URLs 8-of-8 against 0-of-5 on this run,
including the within-site antioch split. This is structural and rulable: the
axis is already computed deterministically (the mandatory flag plus
opportunity promotion), so it can be measured on every future run without a
model call. It also explains the apparent perversity in item 42's finding —
on decoy-rich sites the name-reader picks name-plausible wrong pages over
content-right, name-silent ones, because names are all it has.

**H2 — partially supported, subordinate to H1: manifest length and position.**
The failing sites have long manifests (52–60 entries) with true pages late
(indices 41, 52, 54 — 79–90% of the way down); the working sites' true pages
sit at indices 0–7. But mariners' true page sits at index 6 of 60 and was
still not selected, so position cannot be the mechanism on its own; and
position is largely H1's shadow, since mandatory entries sort first.

**H3 — contradicted: group collapse.** All 13 in-manifest true URLs stand
alone (group size 1 in every reconstructed manifest); none is hidden behind a
"[1 of ~N]" representative.

**H4 — excluded by construction: the cap.** The population is conditioned on
shortlist presence; every page here was in the manifest the model saw.

**H5 — cannot reach: model noise.** One paid run; selection variance is
unpriced, and only a re-run can price it. What the deterministic evidence does
say: a noise explanation must produce a perfect 8/8-vs-0/5 split along a
name-legibility axis by chance, on the same run in which the same model
over-claimed absences on 7 of 7 mixed-site opportunities. Noise is not needed
to explain any observation in this report; it cannot be excluded as a
contributor to any single choice (signatry's donor-advised-fund explainer is
the nearest call — its title is topically adjacent to the recipient
restrictions recorded on it, and it still was not selected).

## What this cannot establish

- Which page the model tagged for any over-claimed purpose — the run output
  does not say, and no re-derivation can recover it.
- Selection variance: whether a second identical call selects differently.
  Owner's paid decision.
- The counterfactual: whether the model would select ncf's /support page if it
  carried a title, or mariners' care-recovery page if the prompt named the
  grant opportunity. Testable only with a model call.
- Byte-identity of today's manifests with the 2026-09-19 run's (live-network
  drift: ncf +1 URL, missio-nexus −71 today against review 0015's counts).
- How common the unadvertised-true-page shape is among real funders outside
  this 12-case set. The set over-represents it by design.

## One observation outside the question, recorded not acted on

`scripts/reference-recall.ts` passes the opportunity name to `buildManifest`
(line 120) but not to `selectPages` (line 129), whose prompt supports it. So
missio-nexus's model was never told the subject was the Ministry Innovation
Fund; it succeeded anyway because opportunity promotion had already saturated
the manifest with innovation pages. The one mechanism that demonstrably
rescues unadvertised sites — promotion by opportunity tokens — is currently a
manifest-side lever only, invisible to the model's reasoning. Whether the live
pipeline (as opposed to this measurement script) passes it is not established
here.

## Handed to the ledger

Proposals only; deciding is the decision space's.

1. **Item 42's classification, proposed:** the failing class is "a true page
   whose manifest line does not advertise its purpose", not "three bad sites"
   and not established as model noise. A ruling could bind the measurement
   first: selection recall reported split by the advertised/unadvertised axis
   (both already computed deterministically), the same way ruling 0022 made
   the retrieval split visible — so the next run prices each population
   separately and the day an advertised page is missed is announced.
2. **A ruling on what selection may claim about unadvertised pages.** A
   name-reader structurally cannot find them; per review 0009, per-case
   vocabulary additions are not a fix (no vocabulary makes a church's
   care-recovery page say "priorities" without reading it). The general
   responses worth weighing are architectural — a cheap read-then-select pass,
   or accepting the bound and recording it as a known ceiling with its
   distribution — and choosing among them is direction, not build.
3. **The over-claim half stays item 43/44's**, and this diagnosis adds one
   fact to it: on mariners the over-claim happened with zero name-plausible
   candidates in the manifest (0 of 60 entries carrying funding vocabulary),
   so the abstention channel fails even when abstaining has no competition.
4. **Small, checkable:** whether `selectPages` should receive the opportunity
   name the script already computes for `buildManifest` — one argument,
   currently dropped between lines 120 and 129 of
   `scripts/reference-recall.ts`, and its live-path equivalent unverified.
