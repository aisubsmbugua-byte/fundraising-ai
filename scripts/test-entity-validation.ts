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

const confirmedEin = determineConfirmedEin([
  "THE MACLELLAN FOUNDATION INC (EIN 62-6041468) - Grants, Funding, 990s",
  "Per 2024 IRS Form 990-PF data, EIN 62-6041468, assets of ~$258M...",
  "Some other page mentioning 62-6041468 in passing.",
]);
console.log(`Determined confirmed EIN: "${confirmedEin}" (expect "62-6041468")\n`);

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
    sourceUrl: "https://grantable.co/search/funders/profile/the-maclellan-foundation-inc-us-foundation-626041468",
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
const noEinConfirmed = determineConfirmedEin(["A funder with no publicly listed EIN, e.g. an individual donor-advised fund."]);
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

console.log(`\n${passCount} passed, ${failCount} failed.`);
if (failCount > 0) process.exit(1);
