# Reviewer Questions Answered

Companion to *Prospect Research Architecture* · Fundraising AI · Build 1

A reviewer asked twelve questions before evaluating the architecture brief.
Each answer below is marked with its standing: **settled** (a product decision,
now fixed), **established** (already true in the built system, with evidence),
**open** (genuinely undecided), or **owed** (we still have to answer it).

---

## 1. What exact decision should Research enable?

**Settled.** *Pursue or dismiss.*

Research sits at the screening/qualification boundary. It is not trying to
prepare an ask; it is trying to tell a busy executive whether this funder is
worth any further time.

The warmest path in is **not** part of this decision. It is the work that
follows a *pursue*, not a precondition for one — a funder can be clearly worth
pursuing while the route to them is unknown, and that is exactly when the
system should go and find one. An earlier draft described it as "a second
output of Research," which wrongly implied it gates the recommendation.

## 2. Where is the present user pain greatest?

**Established, from measurement rather than opinion.** Not the initial run.
Ranked:

1. **Reruns.** The system reports coverage gaps without distinguishing
   obtainable from unobtainable, so the user is invited to spend again on gaps
   that can never close. One prospect absorbed five runs chasing a document
   that direct probing later showed is not published at that source at all.
2. **Claim review.** 61 claims across two fully-reviewed funders, 42 requiring
   an individual human decision.
3. **Identity resolution** *was* the top pain and is now largely fixed — 21 of
   40 stored runs resolve, 20 of them by the funder's own domain.

## 3. What does "enough to act" mean in practice?

**Settled — and far simpler than the system currently assumes.** Two
predicates:

1. **It is a legitimate organization.** Real, correctly identified, and
   actually making grants.
2. **It is a match on funding priorities.** What they fund lines up with what
   this nonprofit does.

That is the whole bar for pursue-or-dismiss. Everything else — eligibility
detail, application mechanics, deadlines, grant sizes — belongs to later
stages and is not required to decide whether a funder is worth pursuing.

**This exposes a live misconfiguration.** The system holds 43 fact targets
graded 18 *required* / 13 *advisory* / 1 *unused*. But the two facts that
constitute predicate 2 —

    funding.focus_areas       advisory
    funding.geographic_focus  advisory

— are graded advisory, while `application.deadline`,
`application.fiscal_sponsorship_rules`, `funding.median_grant_size` and
`funding.grant_size_range` are required.

That grading is not wrong so much as calibrated for the wrong consumer: it
grades materiality *for a strategy run*, and there is no entry at all for the
pursue-or-dismiss decision that gates everything upstream of it. The codebase
had already learned this lesson once — a single shared materiality list "had
to be wrong for at least one" consumer, which is why grading was split by
consumer in the first place. The screening consumer was never added.

The consequence reaches the user directly: they are asked to adjudicate 42
claims graded for a decision they are not yet making.

**Predicate 1, precisely.** *Legitimate* means **identified and currently
grantmaking.** Correct identification alone is not enough — a correctly
identified dormant foundation is legitimate and useless. Both halves are
checkable from structured filing data: identity from the registry record,
active grantmaking from filing recency and reported giving.

## 4. Which failure is most damaging?

**Settled.** Worst first:

**Wrong organization** · wrong material fact · excessive waiting · missed
opportunity · incomplete coverage · cost.

The built system already agrees on the top item: identity gates every
downstream consumer, and an unresolved prospect yields nothing regardless of
how well-evidenced its individual claims are. Cost is last by explicit
direction — at this build stage it is not the constraint.

## 5. Who is the primary user?

**Settled.** A **nonprofit executive who is too busy running the organization
to actively fundraise.** Not an analyst, not a development professional, not a
consultant.

The product may assume mission knowledge and judgment about their own
organization. It may **not** assume research judgment, patience for a queue, or
willingness to adjudicate evidence. This is the answer that makes the 42-item
review queue a disqualifying defect rather than a workload question.

## 6. Should Research answer factual questions only, or recommend?

**Settled.** Recommend — and the recommendation may use the nonprofit's own
profile, capacity and priorities.

This is consistent with two rules that predate the question: *AI drafts and
suggests; humans decide* (all AI output lands in a review state, never a done
state), and *only human-approved claims may feed a strategy run*. A
recommendation is a proposal in a review state, not an outcome.

## 7. Should the four stages share within one nonprofit only, or across tenants?

**Open.** Not decided, and it materially changes what "one shared corpus"
means.

The constraint: every org-scoped table is tenant-isolated by RLS, as a hard
rule. Cross-tenant reuse would be a deliberate exception requiring its own
decision record.

A line is arguably available at **share the retrieved corpus, never the
claims.** Public documents have no tenant character — a 990 filing is the same
document for everyone. Claims are interpretations, and approvals are one
organization's judgment about relevance to its own mission. Whether that line
is sound or a false comfort is question 7 back to the reviewers.

## 8. How should "structurally unavailable" be distinguished from "not found"?

**Settled in principle.** Three grades of evidence, weakest to strongest:

1. The authoritative source for that fact class was retrieved and does not
   contain it.
2. The subject's type does not produce that disclosure — an individual has no
   990; an invitation-only funder publishes no guidelines.
3. A source states it explicitly.

Only the third is certainty. The first two amount to "we looked where it would
be," which is honest **if labeled as such** and dishonest if presented as
proof.

Worth noting: the governing rule already exists in this codebase — *never
silently collapse "not evaluated" and "evaluated and clean" into one value* —
and is enforced for claim verification but not for availability. This is not a
new principle, it is an unapplied one.

## 9. When the prospect is a program inside a larger institution, what is the subject?

**Established in part — two of the four layers already exist.**

The system models identity as two questions that resolve on different evidence:

- **Operating identity** — which organization is this in practice? Settled from
  the organization's own domain.
- **Legal identity** — which EIN? Settled from a filing.

The **opportunity** and the **parent organization** are not modeled at all.

Direction: a connected profile containing all four. The reason to trust that
answer is the history behind the existing split — collapsing two identity
questions into one forced a wrong answer for at least one consumer, which is
why there are two layers today rather than one. The same logic extends.

## 10. What are acceptable targets for cost and waiting time?

**Settled.** *As fast as the user could move with a direct Google search —
ideally faster.*

This is a shape, not just a number. A search engine's advantage is that it
shows something in about a second and lets the user start judging while the
rest arrives; a single call returning everything at 30 seconds still feels
slower. The target ladder:

| Moment | What the user has |
|---|---|
| **~1 second** | Identity and capacity confirmed — the right organization, roughly its size |
| **~10 seconds** | A usable fit read from the subject's own material |
| **~45 seconds, non-blocking** | Full picture, open-ended context, recommendation |
| **Return visits** | Effectively instant, from the stored corpus |

Discovery remains batch and overnight; nobody waits on it. **Cost is
explicitly not a constraint at this build stage.**

Current state for contrast: 3–5 minutes, with nothing shown until the end.

## 11. Should deeper research be automatic or user-authorized?

**Settled.** Authorized. When the base run finds an important obtainable gap,
the system shows the likely value and the cost, and the user chooses.

Consistent with the existing hard rule against advancing state automatically.

## 12. What would prove this architecture is working?

**Settled.** Four outcomes, the last of which governs the others:

1. **Quickly finding organizations that match on funding priorities.**
2. **Quickly producing the warmest approach strategy**, using the social
   network — the smallest degree of separation to a real introduction.
3. **Producing a pitch deck or grant proposal aligned to that specific donor.**
4. **The user being used only for critical decisions — as one would with an
   advancement director.**

The fourth is the standard the whole product is measured against, and it is a
sharper test than any process metric. Nobody asks their advancement director
to walk them through 42 evidence citations before deciding whether to pursue a
funder. They ask: *is this real, do they fund what we do, and how do we get
in?* Any design that returns a queue instead of an answer has failed this
test regardless of its retrieval quality.

Note what these are **not**: they are outcome measures, not machine measures.
An earlier draft of this answer proposed fewer reruns, more approved
strategies, and time-to-first-answer. Those are diagnostics worth tracking,
but they measure the apparatus rather than the job, and optimizing them would
not necessarily move any of the four above.

**One caveat carries over.** None of this is measurable while retrieval and
reasoning share a single model call — retrieval variance swamps any change to
reasoning quality, so we currently cannot tell whether an improvement to
analysis worked. Separating them is a precondition for evaluating this
architecture or any alternative to it.

**One dependency worth naming.** Outcome 2 is not a web-research problem. The
warmest path depends on who *this nonprofit* already knows, which is
relationship data the platform holds rather than anything retrievable from the
public web. It is a distinct capability, and no amount of improvement to
retrieval will deliver it.

---

# Second Round

Seven further questions, asked after the first twelve were answered. Numbered
13–19 here to avoid collision; they were put as 1–7.

## 13. What exactly is the unit being pursued?

*When a grant program sits inside an agency inside a denomination, does the
pursue/dismiss decision attach to the opportunity, the operating organization,
or the legal entity?*

**Settled: the opportunity** — inheriting legitimacy from the legal entity
behind it.

The two predicates resolve at different layers, and that is correct rather
than a problem to be tidied away:

| Predicate | Resolves at | Why |
|---|---|---|
| **Legitimate** | Legal entity | Who holds the money and files the return |
| **Matches priorities** | Opportunity | A denomination's disaster-relief fund and its church-planting fund have genuinely different priorities |
| *(Warmest path, later)* | Operating organization | That is who you actually talk to |

One legal entity can therefore carry several opportunities with different
verdicts, and that is the expected case for denominations and agencies.

This is the same lesson the codebase already learned about identity: operating
and legal identity were split because collapsing two questions into one forces
a wrong answer for at least one consumer. The `prospects` table already
carries `name`, `legal_name` and `opportunity_name` — and already recorded the
failure mode, where *"Mustard Seed Foundation - General Grants"* was stored
with `opportunity_name` null, the display name asserting a program the
structured field had correctly declined.

**Follow-on scoping decision, not yet made.** `prospects` is one row with an
`opportunity_name` column. It cannot represent two opportunities under one
legal entity as two separate pursue decisions. The direction above is settled;
whether the schema changes to match within Build 1 is still to be decided.

## 14. What qualifies as "currently grantmaking"?

**Settled: a two-level test**, driven by one hard constraint — **filings lag
one to two years, structurally.** "Active right now" can never be established
from filing data, so the gate must not ask for it.

- **Entity level (Tier 1, ~1 second) — this is what gates.** The most recent
  filing shows grants paid, and that filing falls within two filing years.
- **Program level (Tier 2) — a flag, not a gate.** Does the program still
  appear in the funder's own material? Its absence is recorded and surfaced,
  and does not by itself dismiss.

The distinction that matters downstream: **an entity that is dormant and a
program that is paused are different verdicts** with different next actions.
Requiring program-level currency at the gate would break the one-second rung
of the ladder, because it cannot be answered from structured data.

## 15. Does geographic compatibility belong in the minimum fit decision?

**Settled — and the codebase had already answered it.** The two facts were
split deliberately, with the reasoning recorded at the point of the split:

> "Grants only to organizations in the Southeast" and "most grants have gone
> to the Southeast" read almost identically and mean entirely different
> things: one disqualifies us, the other colours the pitch.

- **`funding.geographic_restriction`** — a stated rule. **Belongs in the
  gate**, as an automatic dismissal. It is the cheapest dismissal available.
- **`funding.geographic_focus`** — a historical pattern. **Does not gate.** It
  is a fit signal feeding the priorities match.

Two refinements. A restriction is stated in the funder's own words, making it
a **Tier 2 fact, not Tier 1** — the gate needs the ten-second rung to apply
it, not the one-second rung. And the **absence of a stated restriction is not
evidence that none exists**: per question 8 that is "checked, not stated," not
"no restriction."

## 16. What does the human approve?

**Settled.** The executive approves **the recommendation, and thereby the
facts that recommendation cited** — scoped to that decision only. Facts the
recommendation did not cite remain unapproved, and are approved later by
whichever stage actually needs them, under that stage's own grading.

This keeps the governing rule literally true — *every fact that influenced a
human decision was visible to that human* — while removing the queue. The
number in front of the user becomes roughly five facts rather than
forty-two.

**The dependency this creates.** `loadApprovedIntelligence` currently lets
only human-approved claims feed a strategy run. Under this model the cited
subset becomes approved intelligence at the moment the recommendation is
approved; the rest is gathered, stored, and gated later.

**The honest risk**, stated for reviewers to attack: an executive may approve
a recommendation without reading the five facts under it. That is true of any
recommendation-level approval, including a human advancement director's. The
difference is that five facts can be read and forty-two cannot — a queue
nobody finishes provides less scrutiny, not more, and routes unreviewed
claims downstream regardless.

## 17. Is the warmest path required before "pursue" is recommended?

**Settled: no.** See question 1 — the phrasing that created this ambiguity was
ours and has been corrected. The bar is two predicates and the path is not one
of them. A funder can be clearly worth pursuing while the route to them is
unknown; that is precisely the situation in which the system should go and
find one. If no path exists, that is a strategy problem to solve, not a reason
to dismiss a well-matched funder.

## 18. What happens when public evidence cannot establish legitimacy quickly?

**Settled: return "insufficient evidence." Never auto-dismiss.**

The reasoning comes straight from the settled failure ranking. Dismissing on
absent evidence converts an evidence gap into a decision, and it would
systematically penalize small and private funders — which are frequently
*less competitive*, and therefore better prospects for a small nonprofit.
Auto-dismissal manufactures a **missed opportunity** (fourth-worst) in order
to avoid **incomplete coverage** (fifth-worst). That trade is backwards.

So the system returns insufficient evidence and offers authorized deeper
research, consistent with questions 8 and 11.

**One distinction to hold sharp:** *insufficient evidence to confirm
legitimacy* and *evidence that this is not a grantmaker* are different
verdicts. Only the second dismisses. Absence never does.

## 19. Is cross-tenant public-document reuse a near-term requirement?

**Settled: future-compatible, tenant-contained in Build 1.**

Every Build 1 benefit of the shared corpus is achieved **entirely within one
tenant** — instant return visits across the four stages, and the separation of
retrieval from reasoning that makes quality measurable at all. Cross-tenant
reuse adds a privacy and attribution surface with no Build 1 payoff.

The retrofit is cheap because the existing shape already anticipates it.
`research_evidence` carries `url`, `content_hash` (sha256), `provider` and
`retrieved_at` **as well as** `organization_id` — hard-rule-compliant today,
and already holding exactly the columns a later cross-tenant dedupe would
need.

So the shared corpus **is** part of Build 1; sharing it *across tenants* is
not. Question 7 stays open as a deliberate deferral rather than an
undecided one.

---

# Third Round

Three final questions, numbered 20–22 here; they were put as 1–3.

## 20. How is "matches funding priorities" decided?

**Settled: deterministic rules disqualify, graded model judgment matches.**
Neither alone is sufficient, and the division is not a compromise — the two
mechanisms can do genuinely different things.

| Step | Mechanism | Can dismiss? | Can establish a match? |
|---|---|---|---|
| **Eligibility rules** | Code, deterministic | **Yes** | No |
| **Priority match** | Model judgment, evidence-backed | No | **Yes, graded** |

**Rules can only ever subtract.** A stated rule — a geographic restriction, an
eligible-organization-type limit, an excluded recipient class — either bars
this nonprofit or does not. That belongs in code: it is cheap, it is
deterministic, and a model asked "does this rule bar us" will hedge where code
will not. The gate applies whichever such rules were actually captured.

**No rule can add.** "We fund Christian education in the Southeast" against "we
run after-school literacy programs in Memphis churches" — deciding whether one
is an instance of the other is semantic judgment. Nothing deterministic
resolves it, and this is the work models are genuinely good at.

So the order is **rules filter out, judgment ranks in**, which also serves
speed: no judgment call is spent on a funder already ineligible. The other
operand is the nonprofit's own `org_profile` — mission, programs, who it
serves, outcomes.

**The match verdict is graded**, not binary: *strong / plausible / weak*, each
with its reasoning and its cited evidence. Where the pursue threshold sits is
a product setting, not an architectural one, and can move without redesign.

Per the standing house rule, the model **selects** its supporting evidence
from the ledger rather than writing its own — the same reason extraction
selects `evidence_ids` instead of typing quotes.

Two constraints carried forward: the **absence** of a stated rule is not
evidence that none exists, and absence never dismisses (questions 8 and 18).

## 21. What evidence is sufficient to establish an opportunity's priorities?

**Settled: both stated and revealed evidence are admissible, and must never be
conflated.**

- **Stated priorities** — the funder's own current material. The strongest
  evidence of forward-looking intent.
- **Revealed priorities** — recent grants and filings. What they actually
  funded, which sometimes beats a stale or aspirational guidelines page.

This distinction already exists in the data model in miniature:
`funding.geographic_focus` is documented as "where grants have HISTORICALLY
gone, as a description of past behaviour," explicitly opposed to a stated
rule. The same pattern generalizes to priorities as a whole.

**Revealed evidence can carry the match on its own.** Requiring a program
description would systematically dismiss invitation-only and small private
funders that publish nothing — precisely the funders the settled failure
ranking says not to dismiss, and frequently the least competitive and best
prospects for a small nonprofit.

Three conditions on using it:

1. **Label the basis.** It changes the outreach: on stated priorities you can
   quote their guidelines back to them; on revealed priorities you cite a
   grant they actually made.
2. **Stamp the vintage.** Filings lag one to two years, so a revealed match is
   always evidence about the past.
3. **Expect it to be missing.** Grant schedules are frequently unobtainable —
   one filer examined during this work publishes none through the usual
   aggregator, and its filing PDF returns HTTP 403. That is an availability
   fact under question 8, not a research failure.

## 22. Should the architecture review decide the unresolved schema question?

**No — and this is a scoping answer, not a deferral.** The schema follows
mechanically from the layering claim in question 13. If the reviewer validates
that the unit of pursuit is the opportunity and that the predicates resolve at
different layers, the schema consequence is entailed. If the layering is
rejected, the question dissolves. The useful review action is to **evaluate the
layering and flag the schema as a consequence**, not to specify a table.

**The Build 1 call, measured rather than assumed.** A diagnostic over the live
pipeline (`scripts/entity-collisions.ts`, read-only) reports:

    prospects: 32
    distinct entities: 30
    entities with more than one prospect row: 1

    domain:ncfgiving.com  x3   LIKELY DUPLICATE -- no opportunity named
      "National Christian Foundation (NCF) - Donor Advised Fund / Regranting"
      "National Christian Foundation"
      "National Christian Foundation (NCF)"

**Zero live multi-opportunity records.** But note the first row: a program
qualifier — *Donor Advised Fund / Regranting* — sitting in the display name
with `opportunity_name` null. That is the previously documented Mustard Seed
failure recurring, on an entity whose entire business is running many
programs. The pressure toward opportunity-level records is real; it is landing
in free text rather than in the structured field.

So: **one prospect / one opportunity stays fixed for Build 1.** No record needs
otherwise today, and the retrieval and intelligence restructure is already
large. Two conditions attach — the architecture must not *preclude* the later
split, and the problem that is actually live gets fixed: NCF sits in the
pipeline three times because `prospects` has no dedupe key.

**Caveat on the measurement.** 32 prospects is a small sample and every one is
a US Christian-sector funder. A denomination-heavy pipeline would surface real
multi-opportunity cases quickly, which is precisely the case that motivated
the question.
