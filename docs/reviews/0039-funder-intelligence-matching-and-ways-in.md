# 0039 — Knowing what a funder funds, and how to get to it

Date: 2026-11-12. Status: proposal for the owner's order of work. Nothing here is built or authorized except what ruling 0050 already covers (the share-first list and the "ways in" panel).

## The problem, in a fundraiser's terms

A development officer, handed a funder, asks three things. **Does this funder fund what we do? Would it fund someone new like us? How do I get in front of them?** Until today the platform could answer only a crude version of the first: it counted grants to recipients with a word like "church" or "ministry" in their name. That cannot tell a funder of church planting overseas from a funder of church-run child care, says nothing about whether a funder takes new organizations, and says nothing about who to call. The cost is the one you saw: a ranked list that is mostly right at the top and quietly wrong below it, and a fundraiser who still has to do the thinking by hand.

The aim is for the platform to do that thinking itself, show its work, and leave the decision with a person: every suggestion arrives with *why it fits*, *how open it is*, and *the ways in*, each backed by something in the filings that can be checked.

## What changed today (ruling 0050)

- One list, ordered by how much of a funder's giving goes to work like the organization's, once it has at least five such grants in the organization's size band. A funder that gives to everything no longer outranks one that gives almost only to this work.
- Nobody is held apart for how it takes requests. About half of the funders that fit best say "pre-selected charities only" (4,312 of 8,598 for a ministry of Village Worship's size), and 808 are donor-advised fund sponsors, including faith-specific ones such as American Baptist Foundation and Back to the Bible. They are in the list, labelled.
- Each funder has a "Ways in" panel: the contact its own filing names, how to apply, deadlines and restrictions as filed, the officers and trustees it names, its website and (for charities) its stated mission, then one fixed paragraph of general practice, clearly labelled as not coming from the filing.

## One fact that changes how pre-selected funders should be treated

I measured eight of the pre-selected funders at the top of the list for Village Worship. Every one added new recipients last year that it had not given to the year before: Chotin Family Foundation 20 of its 45 recipients, Stover Foundation 13 of 35, Gilman and Lavon Hill Family Foundation 6 of 25, Slayton Foundation 20 of 127, Coffee Foundation 6 of 28, Word & Deed 9 of 114, Salt and Light 4 of 18, Robinson 4 of 20. "Pre-selected" describes how they decide, not a closed door. **Whether a funder is a closed circle or adds organizations every year is computable from filings we already hold**, and it is the single most useful thing to tell a fundraiser about how to approach it.

## What the database already holds and does not yet use

| Held | Amount | Used today |
|---|---|---|
| Stated purpose on each grant | 4.3 million foundation grants, 2.6 million charity grants | only as part of the "faith-named" word test |
| Contact, how to apply, deadlines, restrictions | on 49,971 of 182,654 foundation filings (27%) | now shown (0050) |
| Officers, directors and trustees | 845,000 rows across all 63,321 foundations | now shown (0050) |
| Websites | 53,701 foundations | now shown (0050) |
| Stated mission | all 43,999 charities and sponsors | now shown (0050) |
| Several years of grants per funder | 2 to 3 years for most | not used: it can show who a funder adds each year, whether giving is rising, and how big a typical grant is |

## The layers, in the order I recommend

Each layer needs its own ruling and your go. None sends anything or moves anyone through the pipeline; each only helps a person decide.

**1. Topic and place profile for each funder, by fixed rules (no model).** Replace the single "faith-named" test with a named list of topics that match the causes an organization can pick on its profile (for example overseas missions, church planting, children and youth, relief, Bible and media, anti-trafficking, education) and a list of countries and regions named in grant purposes. Each funder then gets counted per topic and per place, from its own grants, the same way the faith count is computed, and each organization's profile (causes, the places it works, its programs) is matched against it. Village Worship works in Uganda, Zambia, Kenya, Ukraine, Egypt and Jordan: a funder whose purposes name those countries is a different match from one that funds churches in Oklahoma. Computed once, offline, shown with the grants behind it. This is the biggest improvement for the least risk. About the same effort as the first version.

**2. How open the funder is, from its own history.** Per funder, computed from the years held: the share of recipients that are new each year, how many years the same recipients repeat, the typical grant in the organization's band, the direction of giving, how concentrated its recipients are by place. This turns "pre-selected" from a label into a measurement ("adds about a third of its recipients each year") and tells a fundraiser whether to expect an open door or a relationship route.

**3. Ways-in reasoning by situation, by fixed rules.** The "Ways in" panel today shows the filing's facts and one paragraph per kind. The next step is a small library of the routes a good advancement officer would think of, applied to the facts and each shown with its evidence: a filing that names a contact and states an application route; a pre-selected funder that adds new recipients (the way in is the same people who were added: ask them); a closed circle (the way in is a person); a family foundation (trustees share a surname: look for the family's church and city); a funder that gives mostly to other grantmakers (follow the money to the end funder); a donor-advised sponsor (be eligible and known to the people who give through it); a denominational foundation (match the organization's own denomination, which is already on its profile); and, where the organization has named peers, funders that gave to those peers (the "primed pump"). Where a funder's trustees share a name or a town with someone on the organization's profile, flag it as a lead to verify, never as fact. The rules propose routes; they never remove a funder.

**4. A written brief for each funder a person adds, by AI, from the checked facts.** After a funder is added (tens at a time, not thousands), a model reads that funder's own grants, purposes, terms and named people next to the organization's profile and proposes: why this funder might fund us, with the grants it relies on chosen by number so the quotes come from the filing and not from the model; what it funds that we do not (so the mismatch is visible); two or three ways in, ranked, with what would have to be checked; and a first-contact angle. Anything it asserts that the filing does not support is marked unsupported. A person approves it before it feeds a strategy, exactly as research claims do today. This is where the "creativity" lives: the model is told the routes from layer 3 and asked what else a thoughtful fundraiser would try, but may only propose; each proposal must cite what it rests on. It costs a few cents to tens of cents per funder and runs only on request.

**5. Peers and the funders behind them (the "primed pump"), and the web for what the filings lag on.** Peer matching needs the IRS exempt-organizations list so a foundation's recipient can be tied to an EIN (review 0037 step 2). The web layer (the existing research agent, run on a chosen funder) reads the funder's own guidelines and recent news, because a filing is one to two years old.

**The organization's side matters as much.** Matching is only as good as what the organization has told us. Today the profile has a mission, programs, who it serves, causes and places. To match well it also wants: the countries or regions where the money would be used; its denomination or affiliation (already collected); what the money is for (a program, general support, a building); the size of ask it wants; and three or four peer organizations. Each missing item should show as "add this to improve your matches", not as a blank.

## Standing principle (what you asked for)

The rules route; they do not shut out. The only reason a funder is left out is that its filed giving does not resemble the organization's work. How a funder takes requests, what kind it is and a stated restriction are things to think about and ask about, never grounds for hiding it. Every route and every fit statement points to something in a filing, and a person decides.

## Limits to know before you rely on it

- Filings run one to two years behind. A funder's current priorities can differ; layer 5 addresses it.
- Foundation grants name the recipient but carry no recipient EIN, so peer matching on that side is by name until the exempt-organizations list is loaded.
- Many grant purposes are one or two words ("general support"), so topic counts are a floor, not a measure.
- A named trustee matching a name on the organization's profile can be a different person. It is a lead, not a finding.
- Only 27% of foundation filings state any application contact; for the rest the way in is the people and the website.

## What I need from you

The order. My recommendation is layers 1 and 2 together (rules, no model, one ruling), then the organization-profile additions, then layer 3, then layer 4. Layer 5 can wait until the Convene pilot ministries are in. Say which and I will write the ruling for the first.
