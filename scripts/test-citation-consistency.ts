// Demonstrates Stage 4 (Citation Consistency Validation) of the Research
// Department redesign: assessCitationConsistency() is pure, deterministic
// string logic -- no Anthropic call, no DB -- so this runs without the
// still-missing local ANTHROPIC_API_KEY, unlike the other scripts.
//
// Naming reminder (per the design): "consistent" proves the extraction
// step didn't drift from what the search step actually cited. It does NOT
// prove the live webpage still says that -- see lib/research.ts's own doc
// comment on assessCitationConsistency.
//
// Usage: npx tsx scripts/test-citation-consistency.ts

import { assessCitationConsistency, type ResearchCitationConsistency } from "../lib/research";

let passCount = 0;
let failCount = 0;
function check(label: string, actual: ResearchCitationConsistency, expected: ResearchCitationConsistency) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -- got "${actual}", expected "${expected}"`);
  if (pass) passCount++;
  else failCount++;
}

// Exact match.
check(
  "Exact match -> consistent",
  assessCitationConsistency(
    "The Maclellan Foundation does not accept unsolicited grant proposals",
    ["The Maclellan Foundation does not accept unsolicited grant proposals"]
  ),
  "consistent"
);

// Same text, different whitespace/case -- normalization should still match.
check(
  "Whitespace/case difference -> consistent",
  assessCitationConsistency(
    "  The Maclellan Foundation   does NOT accept unsolicited grant proposals  ",
    ["the maclellan foundation does not accept unsolicited grant proposals"]
  ),
  "consistent"
);

// Extraction quoted a shorter span of the same underlying citation.
check(
  "Substring of a longer cited excerpt -> consistent",
  assessCitationConsistency(
    "does not accept unsolicited grant proposals",
    ["The Maclellan Foundation does not accept unsolicited grant proposals, requests, or letters of inquiry."]
  ),
  "consistent"
);

// Deliberately mismatched -- a real drift case, e.g. extraction invented a
// number the citation never contained.
check(
  "Genuinely different claim text -> drifted",
  assessCitationConsistency("Total assets are approximately $183 million", ["Total assets are approximately $167 million"]),
  "drifted"
);

// Source has no recorded search-time excerpts at all (came only from
// searchedSources, never explicitly cited in the search summary's prose).
check("No source excerpts available -> unverifiable", assessCitationConsistency("Some claim text", []), "unverifiable");

// Claim never supplied an excerpt in the first place.
check("Claim has no excerpt -> no_excerpt", assessCitationConsistency(undefined, ["Some source text"]), "no_excerpt");
check("Claim has empty-string excerpt -> no_excerpt", assessCitationConsistency("   ", ["Some source text"]), "no_excerpt");

console.log(`\n${passCount} passed, ${failCount} failed.`);
if (failCount > 0) process.exit(1);
