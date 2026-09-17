// Where do several prospect rows describe the same underlying funder?
//
// Two separate questions land on the same query, which is why this is one
// script rather than two:
//
//   1. DUPLICATES -- the same organization entered the pipeline twice, usually
//      because Discovery surfaced it from two different sources and nothing
//      deduped them. `prospects` has no dedupe_key, so nothing catches this.
//
//   2. MULTIPLE OPPORTUNITIES -- one legal entity legitimately offers several
//      distinct funding programs, each of which deserves its own pursue or
//      dismiss decision. A denomination with a disaster-relief fund and a
//      church-planting fund is one entity and two decisions.
//
// The table cannot currently tell these apart, and that is the point: a
// prospect row holds ONE opportunity_name, so two programs under one entity
// can only be stored as two rows that look exactly like a duplication bug.
// This script reports the collisions and lets a human read which is which.
//
// Read-only. Safe to run against production.
//
// Usage: npx tsx --env-file=.env.local scripts/entity-collisions.ts

import { createClient } from "@supabase/supabase-js";

import { fetchAllRows } from "../lib/fetch-all-rows";
import { funderIdentityKey } from "../lib/legitimacy";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

type Row = {
  id: string;
  name: string | null;
  legal_name: string | null;
  opportunity_name: string | null;
  ein: string | null;
  website: string | null;
  operating_identity_domain: string | null;
  stage: string | null;
  organization_id: string | null;
};

// Delegates to lib/legitimacy.ts. "Are these the same funder?" is one question
// and two implementations of it drift: this file and a Tier 1 report once
// disagreed about whether three National Christian Foundation rows were one
// organization or three.
function identityKey(r: Row) {
  const { key, basis } = funderIdentityKey(r);
  return basis === "row" ? null : { key, basis };
}

async function main() {
  const { count, error: countError } = await admin
    .from("prospects")
    .select("id", { count: "exact", head: true });
  if (countError) throw new Error(`prospect count: ${countError.message}`);

  const rows = await fetchAllRows<Row>(
    () =>
      admin
        .from("prospects")
        .select("id, name, legal_name, opportunity_name, ein, website, operating_identity_domain, stage, organization_id")
        .order("id"),
    count,
    "prospects"
  );

  const groups = new Map<string, { basis: string; rows: Row[] }>();
  let unkeyed = 0;
  for (const r of rows) {
    const k = identityKey(r);
    if (!k) {
      unkeyed++;
      continue;
    }
    const g = groups.get(k.key) ?? { basis: k.basis, rows: [] };
    g.rows.push(r);
    groups.set(k.key, g);
  }

  const collisions = [...groups.entries()].filter(([, g]) => g.rows.length > 1);

  console.log(`prospects: ${rows.length}`);
  console.log(`distinct entities: ${groups.size}${unkeyed ? `  (${unkeyed} with no usable identity key)` : ""}`);
  console.log(`entities with more than one prospect row: ${collisions.length}\n`);

  if (!collisions.length) {
    console.log("No collisions. Every prospect row is its own entity, so the");
    console.log("one-prospect/one-opportunity model is not currently constraining anything.");
    return;
  }

  for (const [key, g] of collisions.sort((a, b) => b[1].rows.length - a[1].rows.length)) {
    // Distinct, non-null opportunity names are the signal that separates a
    // real multi-program entity from a straight duplicate.
    const opportunities = new Set(g.rows.map((r) => r.opportunity_name).filter(Boolean) as string[]);
    const verdict =
      opportunities.size > 1
        ? "MULTIPLE OPPORTUNITIES -- distinct programs, needs separate decisions"
        : opportunities.size === 1
          ? "AMBIGUOUS -- one named opportunity across several rows"
          : "LIKELY DUPLICATE -- no opportunity named on any row";

    console.log(`${key}  (matched on ${g.basis})  x${g.rows.length}`);
    console.log(`  ${verdict}`);
    for (const r of g.rows) {
      const opp = r.opportunity_name ? `opportunity="${r.opportunity_name}"` : "opportunity=<none>";
      console.log(`    ${r.id.slice(0, 8)}  stage=${r.stage ?? "?"}  ${opp}  name="${r.name ?? ""}"`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
