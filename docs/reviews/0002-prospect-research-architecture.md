# Prospect Research Architecture

**Status:** seeking outside review. No implementation authorized.
**Date:** 2026-09-02

---

## 1. Context for a reviewer

Fundraising AI helps a nonprofit find, research, and approach funders —
foundations, corporate givers, family offices, and individual major donors. It
is a Next.js application on Vercel with Postgres, using the Anthropic API. A
human decides everything; the system gathers, reasons, and proposes.

Web research is not one feature. It runs at **four points in a deal**, each
with a different latency budget and a different question:

| Stage | Question it answers | Who is waiting | Budget |
|---|---|---|---|
| **Discovery** | Which funders plausibly fit this mission? | Nobody — batch | Minutes |
| **Research** | Is this one real, capable, and a fit? | A user | Seconds |
| **Outreach strategy** | What is the warmest path in? | A user | Seconds |
| **Strategy prep** | How do we frame the ask, and when? | A user | Seconds |

Today only Discovery and Research exist, as **two separate implementations
sharing nothing** — no common retrieval layer, no shared store. The same
prospect is researched from zero at every stage.

We have two problems. The first is performance. The second is judgment, and it
is the more important of the two.

---

## 2. Product decisions, settled

An earlier reviewer asked twelve questions before evaluating the architecture.
The answers below are now fixed, and the rest of this document assumes them.

**The decision Research must enable.** *Pursue or dismiss.* Research sits at
the screening/qualification boundary of the pipeline.

The warmest path in is **not** part of this decision. It is the work that
follows a *pursue*, not a precondition for one — a funder can be clearly worth
pursuing while the route to them is still unknown, and that is precisely when
the system should go find one. An earlier draft called it "a second output of
Research," which wrongly implied it gates the recommendation.

**The primary user.** A **nonprofit executive who is too busy running the
organization to actively fundraise.** Not an analyst, not a development
professional. The product may assume mission knowledge and judgment about
their own organization. It may **not** assume research judgment, patience for
a queue, or willingness to adjudicate evidence.

**Speed target.** *As fast as the user could move with a direct Google search
— ideally faster.* This is the sharpest constraint in the document, and
section 5.2 treats it as an architectural requirement rather than a number.

**Failure ranking, worst first.** Wrong organization · wrong material fact ·
excessive waiting · missed opportunity · incomplete coverage · cost. Cost is
last by explicit direction: at this build stage it is not the constraint.

**Recommendation vs. facts.** Research should recommend, and the
recommendation may use the nonprofit's own profile, capacity and priorities.
It always lands in a review state — a house rule that predates this document:
*AI drafts and suggests; humans decide.*

**Where more spend is authorized.** Never automatically. The system shows
likely value and cost; the user chooses.

**Cross-tenant reuse.** Deferred by decision, not undecided. The shared corpus
**is** part of Build 1; sharing it *across tenants* is not. Every Build 1
benefit — instant return visits across the four stages, and the separation of
retrieval from reasoning that makes quality measurable — is achieved entirely
within one tenant, while cross-tenant reuse adds a privacy and attribution
surface with no Build 1 payoff. The retrofit stays cheap because
`research_evidence` already carries `url`, `content_hash`, `provider` and
`retrieved_at` alongside `organization_id`. If it is ever taken up, the line
to argue is *share the retrieved corpus, never the claims*: public documents
have no tenant character, while claims are interpretations and approvals are
one organization's judgment.

**What "enough to act" means.** Two predicates, and no more:

- **Legitimate** — identified **and currently grantmaking**. Correct
  identification alone is insufficient; a correctly identified dormant
  foundation is legitimate and useless. Because filings lag one to two years,
  this is a two-level test: the *entity* gates (most recent filing shows
  grants paid, within two filing years — Tier 1, one second), while *program*
  currency is a Tier 2 flag that does not by itself dismiss. An entity that is
  dormant and a program that is paused are different verdicts.
- **Matches funding priorities** — plus one disqualifier: a stated
  **geographic restriction** that bars this nonprofit. A stated rule gates; a
  historical giving *pattern* does not. That distinction already exists in the
  data model, split deliberately because "one disqualifies us, the other
  colours the pitch."

Eligibility detail, application mechanics, deadlines and grant sizes belong to
later stages. Section 5.5 draws out the consequences, which are larger than
they first appear.

**How the match is decided.** Deterministic rules disqualify; graded model
judgment matches. A stated eligibility rule either bars this nonprofit or does
not — that is code, and it can only ever *subtract*. No rule can establish a
match: deciding whether "after-school literacy in Memphis churches" is an
instance of "Christian education in the Southeast" is semantic judgment.
Rules filter out, judgment ranks in — which also means no judgment call is
spent on a funder already ineligible. The verdict is graded (*strong /
plausible / weak*) with reasoning and cited evidence; the pursue threshold is
a product setting, not an architectural one. The other operand is the
nonprofit's own `org_profile`.

**What evidence supports it.** Both *stated* priorities (the funder's own
current material) and *revealed* priorities (recent grants and filings) are
admissible, never conflated. Revealed evidence may carry the match alone —
requiring a program description would systematically dismiss invitation-only
and small private funders, which are often the least competitive and best
prospects. It must be labeled by basis, since that changes the outreach, and
stamped with its vintage, since filings lag.

**The unit being pursued is the opportunity**, inheriting legitimacy from the
legal entity behind it. The predicates deliberately resolve at different
layers — legitimacy at the legal entity, priorities at the opportunity, the
warmest path at the operating organization — so one entity may carry several
opportunities with different verdicts. **One prospect / one opportunity stays
fixed for Build 1**: a read-only census of the live pipeline found 32
prospects, 30 distinct entities, and zero multi-opportunity records. The
architecture must not preclude the later split.

**What the human approves.** The recommendation, and thereby the facts it
cited, scoped to that decision. Uncited facts stay unapproved until the stage
that needs them. Roughly five facts in front of the user rather than
forty-two.

**When legitimacy cannot be established.** Return *insufficient evidence* and
offer authorized deeper research — never auto-dismiss. Dismissing on absent
evidence converts an evidence gap into a decision and would systematically
penalize small and private funders, which are often less competitive and
therefore better prospects. Only positive disconfirming evidence dismisses.

**What would prove the architecture works.** Four outcomes: quickly finding
funders that match on priorities; quickly producing the warmest approach using
the social network; producing a proposal aligned to that specific donor; and
**the user being consulted only for critical decisions, as they would be with
an advancement director.** The fourth governs the rest. Nobody asks their
advancement director to walk them through 42 evidence citations before
deciding whether to pursue a funder — so any design that returns a queue
instead of an answer has failed, whatever its retrieval quality.

**Still open:** where the pursue threshold sits on the graded match scale — a
setting to calibrate against real prospects, not a design decision; and the
cross-cutting measurement problem, since none of the four outcomes above is
measurable while retrieval and reasoning share a single model call.

---

## 3. Problem one — retrieval is neither fast nor accurate

**Measured.** Repeated runs of the same prospect, same code, same session:
3–5 minutes each, with no run faster than the first; up to 400,000 input tokens
per run; and four different coverage outcomes across four completed runs. The
best result came from the *least* tuned configuration. A full session of
optimization moved nothing.

**Root cause.** All retrieval happens inside **one agentic model call**. The
model is handed a search tool and a page-fetch tool and decides for itself what
to look up, in what order, and when to stop. That is up to thirteen serialized
model turns, each re-reading a context that grows toward 400k tokens.

Two consequences follow directly:

- **Latency is model turns over a growing context, not network time.** A faster
  search provider does not address this; the search API was never the slow part.
- **The retrieval plan is generated fresh on every run.** Which searches fire
  and which pages open is a sampling outcome, not a decision. There is nothing
  to converge on — two runs of the same prospect are two different experiments.

Against the speed target this is not a shortfall of degree. A person gets a
first useful signal from a search engine in about a second. We take three to
five minutes and show nothing until the end.

---

## 4. Problem two — the intelligence layer does not adapt

Every prospect is different. A foundation with published guidelines, a
family office that discloses nothing, a corporate giving program run through a
parent company, an individual major donor with no filings at all — each has a
different amount of information in the world, held in different places, and
each requires a different thing from us before a human can act.

**Our system behaves as though they are all the same.** It has one fixed idea
of what a complete dossier looks like, runs one strategy to fill it, and
reports everything it did not find as a gap. Four failures follow.

**4.1 No model of what is knowable.** The system never asks *what kind of
subject is this, and what should therefore exist?* An invitation-only
foundation has no published guidelines to find; an individual has no filings.
The system searches for them anyway, fails, and reports failure.

**4.2 Absence is undifferentiated.** "Not found" collapses three genuinely
different states: **found**, **structurally unavailable** (this subject does
not publish this, anywhere), and **not yet retrieved** (it exists and we have
not looked hard enough). Only the third justifies further work. Because we
cannot tell them apart, the user is invited to re-run against gaps that can
never close.

The house rule for this already exists and was simply not applied here:
*never silently collapse "not evaluated" and "evaluated and clean" into one
value.* We enforce it for claim verification and not for availability.

**4.3 The sufficiency test is calibrated for the wrong decision.** There are 43
fact targets graded 18 *required* / 13 *advisory* / 1 *unused*. But the two
facts that constitute the actual pursue-or-dismiss test — `funding.focus_areas`
and `funding.geographic_focus`, which are simply *what they fund and where* —
are both graded **advisory**, while `application.deadline`,
`application.fiscal_sponsorship_rules`, `funding.median_grant_size` and
`funding.grant_size_range` are **required**.

The grading is not wrong so much as aimed at the wrong consumer: it grades
materiality for a *strategy run*, and there is no entry at all for the
screening decision that gates everything upstream of it. The codebase learned
this exact lesson once already — a single shared materiality list "had to be
wrong for at least one" consumer, which is why grading was split per-consumer.
The screening consumer was never added.

This is the recurring defect shape of the whole build: a concept wired into
some call sites and not all.

**4.4 The output is a claim pile — and the pile is the product's biggest
usability failure.** A run produces 54–75 claims. Measured across two
fully-reviewed funders: **61 claims, 42 requiring an individual human
decision**, of which 27 could never carry an automated verdict by design.
That queue is the gate standing between a prospect and any strategy.

For an analyst that is a defensible workload. For a nonprofit executive too
busy to fundraise, it is disqualifying — and it is why the promised product,
an actionable lead, does not currently arrive. The system is a retrieval tool
wearing the label of an intelligence system.

---

## 5. Proposed direction

Three shifts. **Code decides where to look; the model decides what it means.**
**Answers arrive in layers rather than all at once.** And **the human decision
moves up from the claim to the prospect.**

### 5.1 Classify the subject before researching it

First, cheaply and deterministically where possible: what kind of prospect is
this — private foundation, community foundation, corporate program, family
office, individual — and what disclosure regime applies?

From that, derive the **expected evidence surface**: what should exist for a
subject of this type, and where it lives. This is what makes everything
downstream adaptive rather than one-size-fits-all, and what lets the system
tell a gap from an absence.

### 5.2 Retrieve in tiers, in parallel — and render each tier as it lands

Against the expected surface:

- **Tier 1 — structured sources**, where the subject type has them: registry
  and filing APIs. Sub-second, deterministic, zero variance. Large for some
  subject types and empty for others, which is exactly why classification
  comes first.
- **Tier 2 — known-address fetches**: the subject's own site, derived by rule,
  fetched concurrently.
- **Tier 3 — open-ended search**, only for what genuinely has no address: news,
  personnel, current priorities, relationship signals.

Tiers 1 and 2 run in parallel in code. Tier 3 gets a bounded budget, not an
open loop.

**The tiers finish at different times, and the interface must not wait for the
slowest.** Meeting "as fast as Google" is not mainly about total duration — a
search engine's real advantage is that it shows something immediately and lets
the user start forming a judgment while the rest arrives. A single call
returning everything at 30 seconds still feels slower than Google. The target
is a ladder:

| Moment | What the user has |
|---|---|
| **~1 second** | Identity and capacity confirmed from structured data — enough to know this is the right organization and roughly its size |
| **~10 seconds** | A usable fit read from the subject's own material |
| **~45 seconds, non-blocking** | Full picture, open-ended context, recommendation |
| **Return visits** | Effectively instant, from the stored corpus |

The last row is where *faster than Google* becomes literally true: the second
and third times anyone touches this prospect, nothing needs retrieving.

### 5.3 Record availability, not just findings

For every target fact: **found**, **checked and structurally unavailable**, or
**not checked**. Three grades of evidence justify the middle verdict, weakest
to strongest: the authoritative source for that fact class was retrieved and
does not contain it; the subject's type does not produce that disclosure; or a
source states it explicitly. Only the third is certainty — the others amount to
"we looked where it would be," which is honest if labeled as such.

This ends the rerun treadmill: the user is only offered more work where more
work can help.

It also fixes what absence is allowed to mean. **Absence never dismisses.**
When evidence cannot establish legitimacy, the verdict is *insufficient
evidence* with authorized deeper research offered — not a dismissal. Only
positive disconfirming evidence dismisses. Auto-dismissing on a gap would
convert missing data into a decision and would systematically penalize small
and private funders, which are often less competitive and therefore better
prospects.

### 5.4 Move the human decision up from the claim to the prospect

The house rule is that humans decide. It does not say humans decide *each
claim* — that was an implementation choice, and for this user it is the wrong
one. Settled: Research presents a **recommendation with its reasoning**, and
the executive approves that recommendation **and thereby the facts it cited**,
scoped to that decision. Facts the recommendation did not cite stay
unapproved, gathered and stored, until the stage that actually needs them
gates them under its own grading.

This keeps the rule literally true — every fact that influenced a human
decision was visible to that human — while putting roughly five facts in front
of the user instead of forty-two. The dependency it creates:
`loadApprovedIntelligence` currently admits only human-approved claims to a
strategy run, so the cited subset becomes approved intelligence at the moment
the recommendation is approved.

A reviewer should still attack this. It concentrates a great deal of trust in
the synthesis step, and the same measurements that motivate it show 44% of
material claims arriving not-fully-supported. An executive may also approve
without reading the five — true of any recommendation-level approval,
including a human advancement director's. The counter-argument is that 42
decisions do not produce more scrutiny than 5; they produce a queue nobody
finishes, and unreviewed claims that flow downstream regardless.

### 5.5 Give each stage its own sufficiency bar — and make the first one small

The pursue-or-dismiss bar is two predicates: **legitimate** and **matches on
funding priorities**. Not eighteen fields. The other stages have their own,
higher bars — an application needs eligibility rules and deadlines; outreach
needs a named contact and a real past grant to reference; a proposal needs
grant sizes and giving history. Today all of it is demanded at the first gate.

Two consequences, and the second is the more important:

**It fixes the review burden at its source.** Most of the 42 decisions a user
currently faces concern facts that do not bear on the decision in front of
them. Grading per-stage removes them from that gate without discarding
anything — they are still gathered, still stored, still there when their own
stage arrives.

**It makes the speed target reachable.** Tier 1 answers *legitimate* —
identified, filing, still paying grants. Tier 2 supplies both halves of the
second predicate: the stated eligibility rules that can disqualify
deterministically, and the priority material the graded judgment reads.
**Tier 3 is not required for the gating decision at all.**

The ~10-second rung is therefore achievable not mainly because retrieval got
parallel, but because the question got smaller. The expensive, open-ended,
slow tier moves to the stages that actually need it — where a user has already
committed to the funder and a longer wait buys something.

Note what this costs: the disqualifier lives at Tier 2, not Tier 1, so the
one-second rung can confirm the right organization and its capacity but cannot
rule it out on geography. That is the correct order anyway — dismissal should
not outrun the evidence for it.

Alongside this, research should still report readiness rather than coverage:
*we have enough to decide*, or *this specific thing is missing, it is
obtainable, and here is what it costs*.

### 5.6 One corpus, shared across the four stages

Everything retrieved is stored and reused. Later stages read what earlier ones
fetched and spend retrieval only on what is genuinely new — the mechanism
behind the "return visits" row above.

It also makes the system **measurable**. Today retrieval and reasoning happen in
the same call, so retrieval variance swamps any change to reasoning quality: we
cannot currently tell whether an improvement to analysis worked. Separating
them is a precondition for evaluating anything proposed here.

**Tenant-contained in Build 1**, by decision. Both benefits above land entirely
within one organization; cross-tenant reuse would add a privacy and attribution
surface with no Build 1 payoff. The later retrofit stays cheap because
`research_evidence` already carries `url`, `content_hash`, `provider` and
`retrieved_at` alongside `organization_id`.

### 5.7 On changing search providers

We had drafted a proposal to swap in a dedicated search API plus a dedicated
extraction service. Our read: it optimizes the wrong layer. It speeds the fast
part while leaving the serialized model turns intact, and does nothing for
problem two. It is a reasonable implementation of Tier 3, not an alternative
to restructuring.

---

## 6. What we would give up, and the risks

- **Loss of improvisation.** An agentic loop can chase an unanticipated lead; a
  planned one cannot. Mitigation: a bounded, gap-directed follow-up pass after
  the planned base, targeting only named obtainable gaps — user-authorized, per
  section 2.
- **Misclassification propagates.** If the subject-type classifier is wrong, the
  entire plan is wrong. This concentrates risk in one early step and needs its
  own confidence handling and a fallback to broad search. Given that *wrong
  organization* is ranked our worst possible failure, this deserves more
  scrutiny than anything else proposed here.
- **Coverage becomes a code responsibility.** If a plan omits a source class, no
  run will find it. The availability ledger makes omissions visible, not absent.
- **Sufficiency and synthesis are judgment calls.** Being confidently wrong is
  worse than reporting an honest gap — and section 5.4 deliberately reduces the
  number of places a human would catch it.
- **Subjects with no disclosure regime.** Individuals, family offices, private
  companies. The tiered model degrades to Tier 3 alone — which is exactly the
  architecture we are trying to move away from.

---

## 7. Questions for reviewers

1. Is the diagnosis of problem one right — that latency and variance both trace
   to a single agentic call rather than to the search provider?
2. Is subject-type classification the right primary axis for adapting the
   research plan, or is there a better one — disclosure regime, relationship
   state, deal stage? And how should a system that ranks *wrong organization*
   as its worst failure protect a plan that now depends on an early classifier?
3. Is section 5.4 defensible — moving the human gate from each claim to the
   prospect — for a user who will not work a 42-item queue? If not, what is the
   alternative that does not simply route unreviewed claims downstream?
4. Is *legitimate + matches funding priorities* a sound bar for pursue-or-
   dismiss, or is it too thin — are there funders it would wrongly advance
   that a fuller check would catch? And is per-stage grading the right way to
   hold the other facts without demanding them early?
5. Is a planned retrieval strategy the right trade against losing the model's
   ability to improvise, given the follow-up pass as mitigation?
6. For subjects with little or no public disclosure, what is the realistic
   ceiling on automated research, and where should the system stop and hand off
   to a human?
7. The gate now carries one disqualifier — a stated geographic restriction —
   available only at Tier 2. Is a two-second-slower dismissal the right trade
   for not dismissing on Tier 1 evidence alone?
8. Filings lag one to two years, so *currently grantmaking* is entity-level at
   the gate and program-level only as a flag. Does that let a genuinely
   dormant program through often enough to matter?
9. What are we not asking?
