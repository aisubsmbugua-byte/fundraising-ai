// One predicate for "is this funder's identity settled, and settled for what".
//
// This is the third time in one build that a concept was introduced and wired
// into some of its call sites but not all: dedupe reached 1 of 3 write paths,
// the two-layer identity reached storage but not candidate construction, and
// then reached the intelligence payload but not verification. The shape is
// always the same, and the countermeasure is to make the concept impossible to
// hold in parts -- one function, and a check that fails when a caller decides
// for itself.
//
// So this file tests two different things:
//   1. the predicate's own rules
//   2. that no query fetches the legal half of the answer alone
//
// (2) is the one that matters. A consumer selecting only dossier_confirmed can
// only ever conclude "identity unknown" about an organization the resolver has
// named -- not because it decided wrongly, but because it never fetched the
// facts that would let it decide at all. Five call sites did exactly this.
//
// Run: npx tsx scripts/test-identity-predicate.ts

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { identityState, identitySettledFor, isConfirmedDossier, IDENTITY_PURPOSES } from "../lib/research";

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const NOTHING = { entity_resolution_method: "unresolved", operating_identity_method: "unresolved" };
const AMBIGUOUS_FILINGS = { entity_resolution_method: "ambiguous_filings", operating_identity_method: "unresolved" };
// The live Stewardship shape: the funder's own website identified the
// organization, and no filing has been tied to it.
const OPERATING_ONLY = {
  entity_resolution_method: "ambiguous_filings",
  confirmed_ein: null,
  operating_identity_name: "Stewardship Foundation",
  operating_identity_method: "official_opportunity_page",
};
const LEGAL = { entity_resolution_method: "authoritative_filing", confirmed_ein: "91-6020515" };

check("nothing known: organization unknown", identityState(NOTHING).operatingKnown, false);
check("nothing known: filing unknown", identityState(NOTHING).legalConfirmed, false);
check("competing filings alone settle nothing", identityState(AMBIGUOUS_FILINGS).operatingKnown, false);

check("their own website identifies the organization", identityState(OPERATING_ONLY).operatingKnown, true);
// The safety property. An operating match must never be promoted to a filing:
// that is precisely the unsafe answer the two layers exist to prevent.
check("but not the filing", identityState(OPERATING_ONLY).legalConfirmed, false);
check("and it names them", identityState(OPERATING_ONLY).organizationName, "Stewardship Foundation");

check("a confirmed filing settles the organization too", identityState(LEGAL).operatingKnown, true);
check("and the filing", identityState(LEGAL).legalConfirmed, true);

// ---------------------------------------------------------------------------
// What each purpose licenses
// ---------------------------------------------------------------------------

// The change this whole exercise was for: verification asks whether a sentence
// matches its evidence. A filing has no bearing on that, and requiring one
// left 126 claims across four prospects with no verdict at all.
check("a known organization may be verified", identitySettledFor(OPERATING_ONLY, "verify"), true);
check("and described", identitySettledFor(OPERATING_ONLY, "describe"), true);
check("and may reach a strategy", identitySettledFor(OPERATING_ONLY, "strategy"), true);
// And the line that must not move.
check("but may not carry a filing's figures", identitySettledFor(OPERATING_ONLY, "legal_claim"), false);

for (const p of IDENTITY_PURPOSES) {
  check(`an unknown organization licenses nothing (${p})`, identitySettledFor(NOTHING, p), false);
}
check("a confirmed filing licenses everything", IDENTITY_PURPOSES.every((p) => identitySettledFor(LEGAL, p)), true);

// dossier_confirmed is the LEGAL layer, and stays that way -- it is a stored
// column recording what was true of the filing when the run finished.
check("isConfirmedDossier is the legal layer", isConfirmedDossier(OPERATING_ONLY), false);
check("and agrees with it", isConfirmedDossier(LEGAL), true);

// ---------------------------------------------------------------------------
// No caller may fetch the legal half alone
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Every .select(...) that asks for dossier_confirmed, anywhere in the app.
const offenders: string[] = [];
for (const file of [...sourceFiles("app"), ...sourceFiles("lib")]) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\.select\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g)) {
    const cols = m[1];
    if (!cols.includes("dossier_confirmed")) continue;
    // The whole point: fetching the legal answer obliges you to fetch the
    // operating one, so whoever reads the row is at least ABLE to decide
    // correctly. Nothing here can force them to call identitySettledFor, but
    // this removes the failure that actually happened.
    if (!cols.includes("operating_identity_method")) offenders.push(file);
  }
}
check(`no query fetches dossier_confirmed without the operating layer (${offenders.join(", ") || "none"})`, offenders, []);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
