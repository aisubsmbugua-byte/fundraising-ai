// Recompute every candidate's dedupe_key from its stored parts.
//
// dedupe_key is DERIVED data. Whenever the derivation changes -- as it did
// when trailing generic words started being stripped from the opportunity
// name -- every stored key becomes a key computed under rules that no longer
// exist, and the duplicate check silently starts comparing old keys against
// new ones. That failure is invisible: it looks exactly like "no duplicates
// found".
//
// So this is a permanent maintenance tool, not a one-off. Run it after any
// change to candidateDedupeKey. It is idempotent and safe to re-run: it reads
// the same columns the search path writes, calls the same function, and only
// issues an update where the value actually differs.
//
// Deliberately calls the real candidateDedupeKey rather than reimplementing
// it. A copy of the derivation would drift from the derivation, and a backfill
// that drifts is worse than none.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/backfill-candidate-dedupe-keys.ts          # report only
//   npx tsx --env-file=.env.local scripts/backfill-candidate-dedupe-keys.ts --write  # apply

import { createClient } from "@supabase/supabase-js";
import { candidateDedupeKey } from "../lib/candidates";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const write = process.argv.includes("--write");

  const { data: candidates, error } = await admin
    .from("candidates")
    .select("id, name, funder_name, opportunity_name, source_domain, asserted_fields, dedupe_key");
  if (error) throw new Error(error.message);
  if (!candidates?.length) {
    console.log("No candidates.");
    return;
  }

  let changed = 0;
  let unchanged = 0;

  for (const c of candidates) {
    // An unattested opportunity is excluded from the key. Where attestation
    // was never evaluated (every row predating it), asserted_fields is null
    // and the opportunity counts -- "not checked" is not "failed".
    const opportunityAttested = c.asserted_fields ? !c.asserted_fields.includes("opportunity_name") : true;
    const next = candidateDedupeKey({
      sourceDomain: c.source_domain,
      funderName: c.funder_name,
      opportunityName: c.opportunity_name,
      opportunityAttested,
      name: c.name,
    });

    if (next === c.dedupe_key) {
      unchanged++;
      continue;
    }
    changed++;
    console.log(`${c.name}\n  old: ${c.dedupe_key ?? "(null)"}\n  new: ${next}`);
    if (write) {
      const { error: updateError } = await admin.from("candidates").update({ dedupe_key: next }).eq("id", c.id);
      if (updateError) console.error(`  update failed: ${updateError.message}`);
    }
  }

  console.log(`\n${candidates.length} candidates: ${changed} to update, ${unchanged} already correct.`);

  // Surface collisions rather than resolving them. Two rows sharing a key are
  // duplicates that were written before the key could catch them; which one to
  // keep is a judgement about real funders, not something a backfill should
  // decide on its own.
  const byKey = new Map<string, string[]>();
  for (const c of candidates) {
    const k = c.dedupe_key;
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), c.name]);
  }
  const collisions = [...byKey.entries()].filter(([, names]) => names.length > 1);
  if (collisions.length > 0) {
    console.log(`\n${collisions.length} existing duplicate group(s) -- review by hand:`);
    for (const [k, names] of collisions) console.log(`  ${k}\n    ${names.join("\n    ")}`);
  }

  if (!write && changed > 0) console.log("\nReport only. Re-run with --write to apply.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
