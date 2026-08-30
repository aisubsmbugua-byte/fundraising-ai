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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
