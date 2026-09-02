// Entity ranking, built from the live Discipleship Ministries failure.
//
// The prospect "Discipleship Ministries — Racial Ethnic Local Church Grants
// (UMC)" produced three candidates, all carrying the single reason
// `Name contains "Discipleship"`, and the resolver offered them as equals:
//
//   International Discipleship Ministries          philanthropy.org
//   Board of Discipleship of the United Methodist Church   google.com   <- correct
//   Christ Discipleship Ministries INC             philanthropy.org
//
// Everything needed to rank them was already on the record: "UMC" in the
// prospect's own name, nccumc.org as the capture domain, Nashville TN as the
// location, and the grant's name. One token was used; the rest was discarded.
//
// Pure logic, no API call and no database.
// Run: npx tsx scripts/test-entity-scoring.ts

import {
  acronymsIn,
  classifySourceDomain,
  extractOfficialWebsite,
  identityTokens,
  nameYieldsAcronym,
  scoreEntityCandidates,
  outstandingIntelligence,
  outstandingIntelligenceDirectives,
  focusKeysFor,
  sameState,
  siteNameFromTitles,
  tokenDiscrimination,
  claimRequiresLegalEntity,
  type EntityCandidate,
} from "../lib/research";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}

function candidate(over: Partial<EntityCandidate> & { ein: string; name: string }): EntityCandidate {
  return {
    layer: "legal",
    domain: null,
    key: over.ein,
    location: null,
    website: null,
    orgType: null,
    sourceCount: 1,
    status: null,
    whyMatch: [],
    attributeCount: 2,
    matchText: over.name,
    score: 0,
    evidence: [],
    ...over,
  };
}

// An organization identified by its own website, with no EIN anywhere. The
// case the resolver could not previously represent at all.
function operatingCandidate(over: Partial<EntityCandidate> & { domain: string; name: string }): EntityCandidate {
  return {
    layer: "operating",
    ein: null,
    key: over.domain,
    location: null,
    website: over.domain,
    orgType: null,
    sourceCount: 1,
    status: "official_domain_confirmed",
    whyMatch: [],
    attributeCount: 2,
    matchText: over.name,
    score: 0,
    evidence: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Token discrimination
// ---------------------------------------------------------------------------

const THREE = [
  "International Discipleship Ministries",
  "Board of Discipleship of the United Methodist Church",
  "Christ Discipleship Ministries INC",
];
const idf = tokenDiscrimination(THREE);

// The heart of it: a token in every candidate cannot choose between them, and
// nobody had to put it on a stoplist for that to be true.
check("a token in every candidate has zero discriminating power", idf("discipleship"), 0);
check("a token in one candidate has power", idf("methodist") > 0, true);
check("a token in two of three has less power than one of three", idf("ministries") < idf("methodist"), true);
check("a token in no candidate contributes nothing", idf("presbyterian"), 0);

// ---------------------------------------------------------------------------
// Initialisms
// ---------------------------------------------------------------------------

check("UMC is read out of the prospect name", acronymsIn("Discipleship Ministries — Racial Ethnic Local Church Grants (UMC)"), ["UMC".toLowerCase()]);
check("the Methodist agency spells UMC", nameYieldsAcronym("Board of Discipleship of the United Methodist Church", "umc"), true);
check("an unrelated ministry does not", nameYieldsAcronym("Christ Discipleship Ministries INC", "umc"), false);
check("initials must be consecutive", nameYieldsAcronym("United Fund of Missouri and Colorado", "umc"), false);
check("a one-letter acronym is not an acronym", nameYieldsAcronym("United Methodist Church", "u"), false);

// ---------------------------------------------------------------------------
// Domain classification -- an unknown domain must NOT read as official
// ---------------------------------------------------------------------------

check(
  "a search engine is third party",
  classifySourceDomain("google.com", { entityName: "Board of Discipleship of the United Methodist Church" }),
  "third_party"
);
check("a known aggregator is third party", classifySourceDomain("propublica.org", { entityName: "Anything" }), "third_party");
check(
  "an unrecognised domain is unverified, never official",
  classifySourceDomain("philanthropy.org", { entityName: "International Discipleship Ministries" }),
  "unverified"
);
check(
  "a domain carrying the entity's name is official",
  classifySourceDomain("worship.calvin.edu", { entityName: "Calvin Institute of Christian Worship" }),
  "official"
);
check(
  "a domain carrying the entity's initialism is affiliated, not official",
  classifySourceDomain("nccumc.org", { entityName: "Board of Discipleship of the United Methodist Church" }),
  "affiliated"
);
check("the prospect's own host is official", classifySourceDomain("msfdn.org", { entityName: "Whoever", prospectHost: "msfdn.org" }), "official");

// The live bug: two funders were shown philanthropy.org and google.com as
// their homepages, because anything off the denylist was treated as official.
check("an unrelated domain is not returned as a website", extractOfficialWebsite(["https://philanthropy.org/x"], [], "International Discipleship Ministries"), null);
check("a matching domain is", extractOfficialWebsite(["https://worship.calvin.edu/grants"], [], "Calvin Institute of Christian Worship"), "worship.calvin.edu");

// ---------------------------------------------------------------------------
// The real case, end to end
// ---------------------------------------------------------------------------

const DISCIPLESHIP = [
  candidate({ ein: "46-4894412", name: "International Discipleship Ministries", sourceCount: 2 }),
  candidate({
    ein: "62-0475840",
    name: "Board of Discipleship of the United Methodist Church",
    location: "Nashville, TN",
    // What the agency's own page says -- where a grant programme is actually
    // named. No registered legal name contains "Racial Ethnic Local Church
    // Grants", so a name-only matcher can never see it.
    matchText:
      "Board of Discipleship of the United Methodist Church. Racial Ethnic Local Church Grants support congregations in Nashville and beyond.",
  }),
  candidate({ ein: "58-1992720", name: "Christ Discipleship Ministries INC" }),
];

const ranking = scoreEntityCandidates(DISCIPLESHIP, {
  prospectName: "Discipleship Ministries — Racial Ethnic Local Church Grants (UMC)",
  funderName: "Discipleship Ministries",
  opportunityName: "Racial Ethnic Local Church Grants",
  prospectLocation: "Nashville, TN",
  captureDomain: "nccumc.org",
});

check("the Methodist agency wins", ranking.leader?.ein, "62-0475840");
check("and it is decisive", ranking.confident, true);
check("the margin is real", ranking.margin >= 1.5, true);

// The aggregator that happened to be scraped twice must no longer come first.
check("source count no longer decides", ranking.ranked[0].name, "Board of Discipleship of the United Methodist Church");

// Evidence must name the things that actually moved the score.
const ev = ranking.leader?.evidence.join(" ") ?? "";
check("evidence cites the initialism", ev.includes('spells out "UMC"'), true);
check("evidence cites the affiliated source", ev.includes("nccumc.org"), true);
check("evidence cites the location", ev.includes("Nashville, TN"), true);
// The most specific thing known about the opportunity has to be able to speak.
check("evidence cites the grant programme by name", ev.includes('Runs the "Racial Ethnic Local Church Grants" programme'), true);

// A name match must outrank the same token found only in page text.
const NAME_VS_TEXT = [
  candidate({ ein: "77-7777777", name: "Wesley Methodist Trust" }),
  candidate({ ein: "88-8888888", name: "Generic Charitable Trust", matchText: "Generic Charitable Trust works with methodist congregations" }),
];
const nameVsText = scoreEntityCandidates(NAME_VS_TEXT, { prospectName: "Wesley Methodist Trust" });
check("a name match beats a text-only match", nameVsText.leader?.ein, "77-7777777");

// ---------------------------------------------------------------------------
// Abstention -- the safeguard that stops a better-looking ranking from
// becoming an unsafe one
// ---------------------------------------------------------------------------

// Two genuinely similar entities, nothing to separate them.
const TIED = [
  candidate({ ein: "11-1111111", name: "Maclellan Foundation" }),
  candidate({ ein: "22-2222222", name: "Maclellan Foundation Inc" }),
];
const tied = scoreEntityCandidates(TIED, { prospectName: "Maclellan Foundation" });
check("two indistinguishable candidates abstain", tied.confident, false);

// A lone weak candidate has a huge margin over nothing, and must still fail.
const WEAK = [candidate({ ein: "33-3333333", name: "Some Ministries" })];
const weak = scoreEntityCandidates(WEAK, { prospectName: "Some Ministries" });
check("a wide margin over an empty field is not confidence", weak.confident, false);

// Margin alone is not enough either way round: a strong leader with a close
// second is still a coin flip.
const CLOSE = [
  candidate({ ein: "44-4444444", name: "United Methodist Church Foundation", location: "Nashville, TN" }),
  candidate({ ein: "55-5555555", name: "United Methodist Church Fund", location: "Nashville, TN" }),
];
const close = scoreEntityCandidates(CLOSE, { prospectName: "United Methodist Church (UMC)", prospectLocation: "Nashville, TN", captureDomain: "nccumc.org" });
check("a close second forces abstention", close.confident, false);

// ---------------------------------------------------------------------------
// Two-layer identity
// ---------------------------------------------------------------------------

check("assets depend on a legal entity", claimRequiresLegalEntity("funding.total_assets"), true);
check("the legal name does too", claimRequiresLegalEntity("identity.legal_name"), true);
check("a published deadline does not", claimRequiresLegalEntity("application.deadline"), false);
check("a geographic restriction does not", claimRequiresLegalEntity("funding.geographic_restriction"), false);
check("focus areas do not", claimRequiresLegalEntity("funding.focus_areas"), false);

// ---------------------------------------------------------------------------
// Operating candidates -- an organization identified by its own website
//
// The real Stewardship Foundation case, reduced. The funder's own domain was
// captured five times and classified official_domain_confirmed on every one,
// and could not become a candidate because an organization does not publish
// its EIN. The resolver was left choosing between whichever filings a
// directory happened to list, and abstained -- correctly, on a candidate set
// that could not contain the answer.
// ---------------------------------------------------------------------------

const STEWARDSHIP = [
  operatingCandidate({ domain: "stewardshipfdn.org", name: "Stewardship Foundation", sourceCount: 5, attributeCount: 3 }),
  candidate({ ein: "91-6020515", name: "Stewardship Foundation", location: "Tacoma, WA", sourceCount: 4, attributeCount: 3 }),
  candidate({ ein: "33-0273191", name: "Stewardship Foundation", sourceCount: 2 }),
  candidate({ ein: "94-3375380", name: "Environmental Stewardship Foundation" }),
  candidate({ ein: "87-2557013", name: "Hansen Stewardship Foundation" }),
  // Present in the real run, and load-bearing here: without a candidate that
  // does NOT say "stewardship", the token appears in every name, its
  // discriminating power is correctly zero, and nothing scores on the name at
  // all. Keeping it makes this set behave like the live one.
  candidate({ ein: "59-3071337", name: "Stewards Foundation INC" }),
];
const stewardship = scoreEntityCandidates(STEWARDSHIP, {
  prospectName: "The Stewardship Foundation",
  funderName: "The Stewardship Foundation",
  prospectWebsite: "https://stewardshipfdn.org",
  prospectLocation: "Tacoma, Washington",
});
check("the funder's own website wins over lookalike filings", stewardship.leader?.domain, "stewardshipfdn.org");
check("and that is a confident answer", stewardship.confident, true);
// The whole point of two layers: knowing the organization is not knowing the
// filing. Auto-confirming the EIN here would be the unsafe answer wearing the
// safe one's clothes.
check("without claiming to know the EIN", stewardship.leader?.ein, null);
check("the legal layer is still offered, ranked below", stewardship.ranked[1]?.ein, "91-6020515");

// A prospect whose name is one distinctive token could never reach an absolute
// threshold of 3, however good the evidence -- so the old gate measured name
// length, not confidence.
check("a two-word funder can now be resolved at all", stewardship.leader!.score >= 0.45 * stewardship.achievable, true);

// ---------------------------------------------------------------------------
// Structural tokens decide nothing
// ---------------------------------------------------------------------------

// "the" measured 1.386 on the real run against "stewardship" at 0.470: rare
// among candidate NAMES, therefore scored as highly distinctive. It reached
// the user as "Their material mentions 'the'".
const allEvidence = stewardship.ranked.flatMap((c) => c.evidence).join(" ");
check("\"the\" never appears as evidence", /"the"/.test(allEvidence), false);
check("nor does \"foundation\"", /"foundation"/.test(allEvidence), false);
check("the distinctive token still does", /"stewardship"/.test(allEvidence), true);

// ---------------------------------------------------------------------------
// Location, however it was written
// ---------------------------------------------------------------------------

// extractLocation always yields "Tacoma, WA"; a prospect's stored location is
// whatever a person typed. The old comparison was endsWith() against an
// abbreviation-only regex, so a spelled-out state silently scored nothing.
check("Washington matches WA", sameState("Tacoma, WA", "Tacoma, Washington"), true);
check("and WA matches Washington", sameState("Seattle, Washington", "Spokane, WA"), true);
check("West Virginia is not Virginia", sameState("Charleston, WV", "Richmond, Virginia"), false);
check("a city ending in a state's letters is not that state", sameState("Tacoma", "Boston, MA"), false);
check("no location is not a match", sameState(null, "Tacoma, WA"), false);
const located = stewardship.ranked.find((c) => c.ein === "91-6020515");
check("the filing's state now corroborates", located!.evidence.some((e) => e.includes("Tacoma")), true);

// ---------------------------------------------------------------------------
// An organization is named by what recurs across its pages
// ---------------------------------------------------------------------------

// Taking the head of a title is right for a directory ("Maclellan Foundation
// Inc - ProPublica") and exactly wrong for the funder's own site, where the
// head is the page: candidates arrived named "Multi-Year Grant Request".
check(
  "the recurring segment is the organization",
  siteNameFromTitles(["Multi-Year Grant Request | Maclellan Foundation", "Grants | Maclellan Foundation"]),
  "Maclellan Foundation"
);
check(
  "page-title boilerplate is not a name",
  siteNameFromTitles(["Welcome to the Stewardship Foundation"], "stewardship"),
  "Stewardship Foundation"
);
check(
  "a page whose subject is not the funder yields nothing",
  siteNameFromTitles(["Grants Available for Local Churches"], "discipleship"),
  null
);

// ---------------------------------------------------------------------------
// Abstention still holds, and now says why
// ---------------------------------------------------------------------------

check("an abstention names its reason", tied.abstainReasons.length > 0, true);

// The real Maclellan v23 shape: two candidates that both score well and score
// close. This is what the copy "several organizations share this name" was
// standing in for -- and it was usually false, because what is actually
// ambiguous is two specific candidates, not a name.
const NEAR = [
  operatingCandidate({ domain: "maclellan.net", name: "Maclellan Foundation", sourceCount: 3, attributeCount: 3 }),
  candidate({ ein: "62-6045999", name: "The Maclellan Foundation Inc", location: "Chattanooga, TN", website: "maclellan.net", sourceCount: 3, attributeCount: 3 }),
  candidate({ ein: "23-7412370", name: "Christian Education Charitable Trust" }),
];
const near = scoreEntityCandidates(NEAR, {
  prospectName: "Maclellan Foundation",
  prospectWebsite: "https://maclellan.net",
  prospectLocation: "Chattanooga, TN",
});
check("two strong close candidates abstain", near.confident, false);
check(
  "and the reason names both, not \"several organizations\"",
  near.abstainReasons.some((r) => r.includes("scored too close together") && r.includes("Maclellan")),
  true
);
check("a confident result gives no reasons", stewardship.abstainReasons, []);

// ---------------------------------------------------------------------------
// What another search could actually add, per funder
// ---------------------------------------------------------------------------

// The real Stewardship run: a category with no facts AND the document that
// would have supplied them.
const stewardshipGaps = outstandingIntelligence({
  missingInformation: ["recent_grants"],
  missingSourceClasses: ["grant_schedule"],
});
check("the missing document is named first", stewardshipGaps[0]?.label, "their 990 grant schedule");
check(
  "and says what it is worth -- grant size and priorities",
  /average grant size and giving priorities/.test(stewardshipGaps[0]?.worth ?? ""),
  true
);
// Availability genuinely differs by funder: a DAF sponsor or a church may file
// nothing of the sort. The copy must hedge on that, not on effort.
check("hedged on availability", /if they publish one/.test(stewardshipGaps[0]?.worth ?? ""), true);
check("the empty category comes after the document", stewardshipGaps[1]?.label, "recent grants");

// The real Mission to the World run: same category missing, but every source
// class was read -- so there is no document to promise.
const mtwGaps = outstandingIntelligence({ missingInformation: ["recent_grants"], missingSourceClasses: [] });
check("nothing invented when every source was read", mtwGaps.length, 1);
check("just the category", mtwGaps[0]?.label, "recent grants");

// A screen-depth run records neither, and must not produce a list of things
// it never looked for.
check("a run that recorded nothing claims nothing", outstandingIntelligence({ missingInformation: null, missingSourceClasses: null }), []);
check("nor does a complete one", outstandingIntelligence({ missingInformation: [], missingSourceClasses: [] }), []);
// An unrecognised value must be dropped rather than rendered raw at a user.
check("an unknown section is not shown", outstandingIntelligence({ missingInformation: ["not_a_section"], missingSourceClasses: [] }), []);

// ---------------------------------------------------------------------------
// A targeted follow-up searches for the gap, not for the funder again
// ---------------------------------------------------------------------------

const stewardshipKeys = focusKeysFor({ missingInformation: ["recent_grants"], missingSourceClasses: ["grant_schedule"] });
check("sources are aimed at before empty categories", stewardshipKeys, ["grant_schedule", "recent_grants"]);

const directives = outstandingIntelligenceDirectives(stewardshipKeys);
check("every key yields an instruction", directives.length, stewardshipKeys.length);
// The whole point of targeting: name the actual document, not the topic.
check("the filing schedule is named specifically", /Schedule I|Part XV/.test(directives[0]), true);

// The two maps are keyed identically on purpose -- a gap shown to a user with
// no matching instruction would be an offer the search cannot act on.
const shown = outstandingIntelligence({ missingInformation: ["recent_grants"], missingSourceClasses: ["grant_schedule"] });
check("everything shown to a user can be searched for", directives.length, shown.length);

// Unknown keys must not reach a prompt, where they would be searched for
// literally.
check("an unknown key yields no instruction", outstandingIntelligenceDirectives(["not_a_key"]), []);
check("and is not a focus target", focusKeysFor({ missingInformation: ["not_a_key"], missingSourceClasses: [] }), []);
check("a run with no gaps targets nothing", focusKeysFor({ missingInformation: null, missingSourceClasses: null }), []);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
