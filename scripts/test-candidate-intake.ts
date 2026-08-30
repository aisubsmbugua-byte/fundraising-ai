// The duplicate predicates every candidate write path now shares.
//
// These rules previously lived inside Donor Finder's search action and were
// untested, which is part of how they came to guard one write path out of
// three. Moving them into lib/candidate-intake.ts is only half the fix; this
// is the half that stops them drifting.
//
// Pure logic, no API call and no database. Run: npx tsx scripts/test-candidate-intake.ts

import { isAlreadyKnown, isSameOrg, isUniqueViolation, normalizeOrgName } from "../lib/candidate-intake";

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

// The live case: five byte-identical rows written through a form that never
// asked. The predicate always handled this -- it was simply never called.
check("identical names match", isSameOrg("Graceway Church", "Graceway Church"), true);
check("a known funder is recognized", isAlreadyKnown([{ name: "Graceway Church", organization: null }], "Graceway Church"), true);

check("leading 'The' is ignored", isSameOrg("The Maclellan Foundation", "Maclellan Foundation"), true);
check("case and padding are ignored", isSameOrg("  MACLELLAN foundation ", "Maclellan Foundation"), true);
check("an expanded name contains the short one", isSameOrg("Assemblies of God", "Assemblies of God World Missions (AGWM)"), true);

// The false positive that must not happen: a near-miss name belonging to a
// real, unrelated organization. Same case the entity gate exists to catch.
check("Mary McClellan is not Maclellan", isSameOrg("Maclellan Foundation", "Mary McClellan Foundation"), false);
check("unrelated funders don't match", isSameOrg("Mustard Seed Foundation", "We Raise Foundation"), false);

// Containment is guarded by length so a short generic token cannot swallow
// everything it appears inside.
check("a short token doesn't match by containment", isSameOrg("God", "Assemblies of God"), false);
check("empty names never match", isSameOrg("", "Graceway Church"), false);

// The organization field is a second, independent way to recognize the same
// funder under a different display name.
check(
  "a match on organization counts",
  isAlreadyKnown([{ name: "Some Programme Name", organization: "Mariners Church" }], "Unrelated Display Name", "Mariners Church"),
  true
);
check(
  "no match on either field",
  isAlreadyKnown([{ name: "Mustard Seed Foundation", organization: null }], "We Raise Foundation", null),
  false
);
check("an empty known list matches nothing", isAlreadyKnown([], "Graceway Church"), false);

check("normalizeOrgName strips 'The' and lowercases", normalizeOrgName("  The Stewardship Foundation "), "stewardship foundation");

// The constraint firing must be translated, not surfaced. It means the check
// was raced past -- a double-submit -- and the person needs plain words.
check("unique violation is recognized", isUniqueViolation({ code: "23505" }), true);
check("another database error is not", isUniqueViolation({ code: "23503" }), false);
check("a missing error is not a violation", isUniqueViolation(null), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
