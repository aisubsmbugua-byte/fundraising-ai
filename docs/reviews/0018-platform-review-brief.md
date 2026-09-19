# Fundraising AI — platform review brief

Prepared 18 September 2026 for independent review. Written for a reader outside
the project who cannot run anything and should not have to take our word for
much. Where a claim is soft, it says so.

## What this is, and the problem it exists for

Small nonprofit teams raise money from seven kinds of funder — foundations,
denominations, individual churches, businesses, major donors, and so on. The
work of finding the right ones is mostly reading: hundreds of organisations,
each with a website that may or may not say who it funds, where, how much, and
whether it accepts approaches at all. A two-person advancement team cannot read
that much, so in practice they pursue whoever they already know, and the
relationships they invest most in are the ones they record least about.

The product is an advancement platform that does the reading. It finds
candidate funders, screens them, researches the promising ones, and drafts
everything from a first email to a full proposal. A human approves every step
that touches a funder.

The constraint that shapes the whole system: **the AI proposes, a person
decides.** Nothing is sent without a click. Nothing advances a stage on its own.
Every AI output lands somewhere a human reviews it, never in a "done" state.
This is not a hedge about model quality — it is the product. An advancement
officer who cannot see why a recommendation was made cannot defend it to a
board.

## Where it stands today

Five weeks of work: 255 commits between 14 August and 18 September, 66 database
migrations, 24 screens, 43 internal modules, 17 test suites.

**The core product is built and live.** Nine planned slices — from the initial
deployment through a custom CRM, a human-gated pipeline, screening rules,
candidate discovery, AI drafting, an evidence library, relationship memory, and
email sending — are all deployed. A user can add funders, move them through six
pipeline stages, have the system search the live web for new candidates, screen
them into three tiers, and have AI draft outreach grounded in the nonprofit's
own verified outcomes.

**A second, more capable screening system is roughly 40% built and mostly not
yet visible.** The live screening uses rules a human wrote. Running beside it is
an evidence-first pipeline that resolves a funder's legal identity against a
public charity registry, fetches its actual website, and decides what it can and
cannot honestly conclude. It is ten steps; four are done. Parts of it have begun
reaching real screens — notably the honesty work described below — but most of
it has no user-facing entry point yet.

**Two organisations use the system.** One is the owner's. One is a paying
tester. There is no usage data in any statistically meaningful sense.

## How we build, and why it looks unusual

Three things an outside reviewer will notice immediately.

**Work happens in thin vertical slices.** Each slice is a complete feature from
database to screen, shipped before the next begins. The application has been
deployed and working since day one.

**Decisions are separated from construction.** Two roles operate on the same
codebase: one sets direction, checks finished work, and issues binding rules;
the other writes code against those rules and may not issue them. They
communicate only through files in the repository, so nothing binds until it is
written down.

**Binding rules are enforced by a program, not by memory.** There are 21 sealed
rules covering things like "a count offered as evidence names the set it was
counted over" and "a step is finished when its guarantee holds in the running
product, not in a test". A checker runs at the end of every working session and
fails if a rule is contradicted, if a document cites a file that does not exist,
or if work was changed without an authorising rule.

The reason for this machinery is empirical rather than philosophical. Measured
compliance with instructions given only in prose, on this codebase, is between
52% and 80%. Nearly every defect found has taken one of two shapes: a model
writing down a value the system already knew, or an interface asserting
something the code had already decided otherwise. So any guarantee that matters
is expressed in code — a type that will not compile, a database policy that
returns zero rows — rather than in wording.

A worked example from this week. The rule that a declined funder keeps its
reason required that "never revisit" can only ever come from a deliberate human
act, and that a blank field always means "nobody has decided". That is enforced
three ways: the value is stored as the *absence* of a record, so there is
nothing to get wrong; the type carries a marker that makes a hand-written
"never" fail to compile; and the database grants no permission to update or
delete a recorded decision — verified by a test showing that even the
organisation that recorded it cannot erase its own entry.

## What we actually know about whether it works

This is the weakest part of the picture and the reason for an outside read.

**The first measurement of retrieval quality was taken today.** Against twelve
funders whose websites a person had read by hand, recording exactly which pages
state each decision-critical fact, the system retrieved 72% of those pages and
carried 60% through to the shortlist it actually reads.

**Those percentages are misleading, and the shape underneath matters more.** Of
the ten cases that contribute, eight retrieve every single page correctly and
two retrieve nothing at all. Nothing lies in between. So 72% does not describe
the system's behaviour on any funder — it is the ratio of sites that work to
sites that do not, wearing the costume of an accuracy rate. Both failures have
identified structure: one funder keeps its grant pages on a different subdomain
the crawler never leaves; the other is a very large site where the pages exist,
are reachable, and still never surface, for reasons not yet established.

That reframes the open question from "is retrieval good enough" to "what kind of
site does this miss completely, and how common is that kind among real funders".
Two examples is not enough to answer it.

**Three things remain entirely unmeasured.** Whether the system picks the right
pages to read from those it found; whether it reads them successfully; and —
most importantly — whether it claims to have found something where a human
established the funder publishes nothing. That last one is how a user ends up
trusting a judgement resting on nothing, and there is currently no number for
it. It requires a paid model run the owner has not yet made.

**The reference set is decaying.** Two of its recorded pages now return "not
found", and a case included specifically because the site blocked automated
access no longer blocks it. The set is marked frozen, but it points at other
people's websites, which do not hold still.

## What is pending

Eleven questions are open and waiting on a decision rather than on work. The
ones with real consequence:

- **Where the AI pipeline lands.** It is 40% built, and no document yet says
  what must be true for it to become the thing users actually touch.
- **What the product charges for.** The intended model is a subscription with a
  number of searches, then credits. "A search" currently names two operations
  that differ by orders of magnitude in cost. A failed or empty run maps to
  nothing that is recorded. Both get expensive the moment anyone is on a plan.
- **What a screen is for.** One dossier view serves two different decisions —
  screening a funder, and planning an approach to it — which need different
  facts. Eight facts the second decision needs are currently not shown.
- **Whether a recorded outcome can be taken back.** A decline recorded by
  mistake currently cannot be undone, by design. That may be wrong.
- **How two screening systems disagree in front of a user.** Both are advisory
  and neither acts, so it is a presentation question, but it has no answer.

## What I would challenge, reviewing this from outside

Offered because a brief that only defends itself is not worth reading.

**Is the process proportionate to the stage?** Twenty-one binding rules, 18
written reviews, a custom compliance checker and a two-role separation, for a
product with two users. The case for it is that this is pre-scale work, cheapest
before anything depends on it, and that it has repeatedly caught real defects —
including, this week, four dead references in the project's own decision
records, and a reported figure of 407 that was actually 337. The case against is
that the same effort spent on users would have produced evidence the project
does not have. Both are real. I lean toward the first and am aware that is the
comfortable answer for the party that built the machinery.

**Is the build order right?** The AI pipeline has consumed most of recent effort
and almost none of it is visible to a user. The most recent piece of genuinely
user-facing work — letting a funder say no — took one day.

**Is the reference set the right instrument?** Twelve hand-read funders is the
only evidence about retrieval quality that exists. It is decaying, it points at
live websites, and it was assembled by the same people who built the thing it
measures.

**Is "a no is data" worth the engineering it received?** It is defensible as a
differentiator, and it got two tables, a compile-time guarantee and a
database-level retention rule. A reviewer might reasonably ask whether a nullable
column would have done.

## What would be most useful from a reviewer

1. Whether the bimodal retrieval result changes what should be built next, or
   whether it is a solvable crawler problem being over-read.
2. Whether the governance overhead is investment or avoidance at this stage.
3. What the fastest honest route is to evidence from real users, given two
   organisations and no usage data.
4. Whether anything in the list of pending decisions should be answered before,
   not after, more capability is built.
