// Demonstrates the entity-validation gate (Research Agent v10 evidence-
// first redesign): classifySourceEntity() is pure, deterministic string
// logic -- no Anthropic call, no DB -- so this runs without the still-
// missing local ANTHROPIC_API_KEY, unlike the other scripts.
//
// Cases are drawn directly from the real Maclellan Foundation run that
// motivated this design: a genuinely unrelated organization
// (marymcclellanfoundation.org) sat unflagged in a real source list, and
// the real findings describe legitimately affiliated sibling foundations
// (different EINs, same family name) that must NOT be excluded the same
// way.
//
// Usage: npx tsx scripts/test-entity-validation.ts

import { classifySourceEntity, deriveEntityNameToken, determineConfirmedEin, type ResearchEntityValidationStatus } from "../lib/research";

let passCount = 0;
let failCount = 0;
function check(label: string, actual: ResearchEntityValidationStatus, expected: ResearchEntityValidationStatus) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -- got "${actual}", expected "${expected}"`);
  if (pass) passCount++;
  else failCount++;
}

const nameToken = deriveEntityNameToken("Maclellan Foundation");
console.log(`Derived name token: "${nameToken}" (expect "Maclellan")\n`);

// Mirrors the real Maclellan corpus: the researched entity's own EIN
// dominates, while legitimately affiliated sibling foundations each
// contribute their own EIN once. The leader must still be confirmed.
const confirmedEin = determineConfirmedEin(
  [
    { url: "https://www.instrumentl.com/990-report/maclellan-foundation-inc", texts: ["THE MACLELLAN FOUNDATION INC (EIN 62-6041468) - Grants, Funding, 990s"] },
    { url: "https://impala.digital/public/profiles/62-6041468/overview", texts: ["Per 2024 IRS Form 990-PF data, EIN 62-6041468, assets of ~$258M..."] },
    { url: "https://www.grantmakers.io/profiles/v0/626041468-maclellan-foundation-inc/", texts: ["Maclellan Foundation Inc profile"] },
    { url: "https://www.guidestar.org/profile/62-6268981", texts: ["Hugh and Charlotte Maclellan Charitable Trust"] },
    { url: "https://www.grantmakers.io/profiles/v0/237159802-robert-l-and-kathrina-h-maclellan-foundation/", texts: ["Robert L and Kathrina H Maclellan Foundation"] },
  ],
  nameToken
);
console.log(`Determined confirmed EIN: "${confirmedEin}" (expect "62-6041468" -- dominant leader, siblings don't block it)\n`);

// The real contaminating source: no EIN stated, and "Maclellan" does not
// appear as a substring of "McClellan" -- this is what should have been
// (and, after this fix, is) caught before ever reaching extraction.
check(
  "Real contamination case: Mary McClellan Foundation -> unrelated_excluded",
  classifySourceEntity({
    sourceUrl: "https://marymcclellanfoundation.org/grant-information/",
    sourceTexts: ["Grant Information - The Mary McClellan Foundation"],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin,
  }),
  "unrelated_excluded"
);

// A legitimate secondary aggregator that never states an EIN but clearly
// names the right entity.
check(
  "Aggregator with matching name, no EIN -> legal_name_confirmed",
  classifySourceEntity({
    sourceUrl: "https://grantable.co/search/funders/profile/the-maclellan-foundation-inc-us-foundation",
    sourceTexts: ["The Maclellan Foundation Inc — Grants, Financials & Contact | Grantable"],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin,
  }),
  "legal_name_confirmed"
);

// The prospect's own official domain.
check(
  "Prospect's own domain -> official_domain_confirmed",
  classifySourceEntity({
    sourceUrl: "https://maclellan.net/faq/",
    sourceTexts: ["FAQ - Maclellan Foundation"],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin,
  }),
  "official_domain_confirmed"
);

// A source restating the confirmed EIN.
check(
  "Source restates the confirmed EIN -> ein_confirmed",
  classifySourceEntity({
    sourceUrl: "https://www.instrumentl.com/990-report/maclellan-foundation-inc",
    sourceTexts: ["Maclellan Family Foundations | Chattanooga, TN | 990 Report", "EIN: 62-6041468"],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin,
  }),
  "ein_confirmed"
);

// The real affiliated-sibling case: a different EIN, but the name token
// still matches -- must NOT be excluded like the Mary McClellan case.
check(
  "Different EIN but matching name (real sibling foundation case) -> affiliate_related_entity",
  classifySourceEntity({
    sourceUrl: "https://example.org/maclellan-family-foundations-overview",
    sourceTexts: [
      "The foundation is part of the Maclellan Family Foundations, a group of grantmakers that includes The Maclellan Foundation Inc (MFI), Christian Education Charitable Trust (CECT), EIN 58-1234567, and the Robert L. and Kathrina H. Maclellan Foundation (RL).",
    ],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin,
  }),
  "affiliate_related_entity"
);

// A different EIN AND a non-matching name -- a genuine mismatch, not an affiliate.
check(
  "Different EIN and non-matching name -> entity_mismatch",
  classifySourceEntity({
    sourceUrl: "https://example.org/some-other-charity",
    sourceTexts: ["Some Other Charity, EIN 11-1111111, unrelated to this research."],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin,
  }),
  "entity_mismatch"
);

// No EIN found anywhere in the run -- the EIN step must be skipped
// entirely, never block on absence, for every source.
const noEinConfirmed = determineConfirmedEin(
  [{ url: "https://example.org/maclellan-mention", texts: ["A funder with no publicly listed EIN, e.g. an individual donor-advised fund."] }],
  nameToken
);
console.log(`\nNo-EIN-anywhere case, determined confirmed EIN: ${JSON.stringify(noEinConfirmed)} (expect null)`);
check(
  "No EIN anywhere in the run, name matches -> legal_name_confirmed (never blocked on EIN absence)",
  classifySourceEntity({
    sourceUrl: "https://example.org/maclellan-mention",
    sourceTexts: ["A brief mention of the Maclellan Foundation's giving."],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin: noEinConfirmed,
  }),
  "legal_name_confirmed"
);

// The real ProPublica false-positive found in the v10 Maclellan run: the
// correct EIN sits in the URL with no dash (.../organizations/626041468),
// and the captured title was just the bare domain, so neither the dashed
// EIN_PATTERN nor the name-token check could recognize it -- it must still
// resolve to ein_confirmed via the undashed-URL check.
check(
  "ProPublica Nonprofit Explorer, EIN in URL with no dash -> ein_confirmed",
  classifySourceEntity({
    sourceUrl: "https://projects.propublica.org/nonprofits/organizations/626041468",
    sourceTexts: ["projects.propublica.org", "Summary charts: organization finances over time"],
    prospectWebsite: "https://maclellan.net",
    nameToken,
    confirmedEin,
  }),
  "ein_confirmed"
);

// --- The real Servants Heart Foundation case (run v1, no website on file).
// Two genuinely different, similarly-named real organizations both attract
// well-indexed sources: the prospect (Newport Beach CA, EIN 58-2218044) and
// "Servants Heart Family Foundation" (Carlisle PA, EIN 88-2110698). Both
// pass the name-token check ("Servants"), so name alone cannot separate
// them, and the Carlisle entity happened to state its EIN in more places.
// A plain majority vote therefore elevated the WRONG entity's sources to
// ein_confirmed while the right entity's sat at legal_name_confirmed. The
// dominance test must refuse to confirm either one.
console.log("\n--- Servants Heart Foundation: competing similarly-named real entities ---");
const shNameToken = deriveEntityNameToken("Servants Heart Foundation");
console.log(`Derived name token: "${shNameToken}" (expect "Servants")`);

const shSources = [
  // The prospect itself -- EIN only ever appears undashed, inside URLs.
  { url: "https://projects.propublica.org/nonprofits/organizations/582218044", texts: ["Servants Heart Foundation Inc - Nonprofit Explorer - ProPublica"] },
  { url: "https://www.causeiq.com/organizations/servants-heart-foundation-inc,582218044/", texts: ["Servant's Heart Foundation | Newport Beach, CA | Cause IQ"] },
  { url: "https://www.grantable.co/search/funders/profile/servants-heart-foundation-inc-us-foundation-582218044", texts: ["SERVANT'S HEART FOUNDATION INC | Foundation Profile & Grants"] },
  { url: "https://www.taxexemptworld.com/organization.asp?tn=1319509", texts: ["Servants Heart Foundation Inc - 501C3 Nonprofit - Newport Beach, CA - 582218044"] },
  // A different real organization -- states its EIN in dashed form repeatedly.
  { url: "https://impala.digital/public/profiles/88-2110698/programs", texts: ["SERVANTS HEART FAMILY FOUNDATION (EIN 88-2110698) - Programs & Services"] },
  { url: "https://getholdings.com/nonprofits/ein/882110698", texts: ["Servants Heart Family Foundation — Carlisle, PA | EIN 88-2110698"] },
  { url: "https://platform.grantadvance.com/public-funder/882110698-SERVANTS-HEART-FAMILY-FOUNDATION", texts: ["servants heart family foundation"] },
];
const shConfirmedEin = determineConfirmedEin(shSources, shNameToken);
const shPass = shConfirmedEin === null;
console.log(
  `${shPass ? "PASS" : "FAIL"}: competing EINs must not confirm a winner -- got ${JSON.stringify(shConfirmedEin)}, expected null`
);
if (shPass) passCount++;
else failCount++;

// With no confirmed EIN, the prospect's own sources must still be usable
// (name matched), not excluded -- withholding trust must never cost coverage.
check(
  "Servants Heart: prospect's own source stays usable when EIN is ambiguous -> legal_name_confirmed",
  classifySourceEntity({
    sourceUrl: "https://www.causeiq.com/organizations/servants-heart-foundation-inc,582218044/",
    sourceTexts: ["Servant's Heart Foundation | Newport Beach, CA | Cause IQ"],
    prospectWebsite: null,
    nameToken: shNameToken,
    confirmedEin: shConfirmedEin,
  }),
  "legal_name_confirmed"
);

// A genuinely unrelated organization must still be excluded even with no
// confirmed EIN to compare against -- exclusion can't depend on the EIN step.
check(
  "Servants Heart: unrelated org still excluded with no confirmed EIN -> unrelated_excluded",
  classifySourceEntity({
    sourceUrl: "https://philanthropy.org/990/report/812637735/servant-s-heart-of-mint-hill-inc",
    sourceTexts: ["Servant's Heart of Mint Hill INC — Form 990 financials (EIN 81-2637735)"],
    prospectWebsite: null,
    nameToken: shNameToken,
    confirmedEin: shConfirmedEin,
  }),
  "unrelated_excluded"
);

console.log(`\n${passCount} passed, ${failCount} failed.`);
if (failCount > 0) process.exit(1);
