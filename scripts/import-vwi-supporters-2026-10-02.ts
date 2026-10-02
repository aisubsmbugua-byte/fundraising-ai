// One-time data operation, kept (not thrown away) as a record of what was
// done -- see docs/ledger/STATE.md item 84.
//
// The owner imported their real 12-contact VWI supporter list through the
// CSV importer before the item 84 fix landed; every pledge amount silently
// came in null (the file's header, "Projected Annual Amount", wasn't a
// column parseSupporterCsvRow recognized yet). The owner asked for the bad
// rows deleted (already done, see STATE.md's "Authorized now" note) and the
// real contacts re-inserted once the parser was fixed.
//
// This script does NOT re-implement any parsing or matching logic -- it
// imports and calls the real, now-fixed parseCsv (lib/candidates.ts) and
// parseSupporterCsvRow (lib/supporters.ts) directly, the same functions
// importSupportersCsv (app/(dashboard)/supporters/actions.ts) uses, so this
// is the production code path exercised once, not a parallel reimplementation.
//
// It writes with the service-role key because this runs outside any
// logged-in session (no cookies, no auth.uid()), so organization_id and
// created_by -- which importSupportersCsv leaves to RLS/session defaults --
// are set explicitly here instead, to the real VWI org and the real owner
// profile, both confirmed by direct query before running this.
//
// Usage: npx tsx scripts/import-vwi-supporters-2026-10-02.ts

import { readFileSync } from "node:fs";
import { parseCsv } from "../lib/candidates";
import { parseSupporterCsvRow } from "../lib/supporters";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORGANIZATION_ID = "340d8e2b-68bf-40e6-bb92-55f40387393a"; // VWI, confirmed via profiles query
const CREATED_BY = "c39a8ef0-c160-4234-ac2d-3e636f359b61"; // kanjii@kijijiagency.com, confirmed via profiles query
const CSV_PATH = "/Users/kanjii/Downloads/VWI supporter list.csv";

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set (source .env.local)");
  }

  const text = readFileSync(CSV_PATH, "utf-8");
  const rows = parseCsv(text);
  console.log(`Read ${rows.length} data row(s) from ${CSV_PATH}`);

  // Pre-insert duplicate check against the live table (should be empty --
  // confirmed by a direct GET before this script was written -- but parsed
  // the same way the real importer does: known accumulates as rows commit).
  const known: { name: string; email: string | null }[] = [];
  const toInsert: Record<string, unknown>[] = [];
  let errorCount = 0;
  let duplicateCount = 0;

  for (const row of rows) {
    const outcome = parseSupporterCsvRow(row, known);
    if (outcome.kind === "error") {
      errorCount++;
      console.log(`  ERROR: ${JSON.stringify(row)}`);
      continue;
    }
    if (outcome.kind === "duplicate") {
      duplicateCount++;
      console.log(`  DUPLICATE: ${JSON.stringify(row)}`);
      continue;
    }
    known.push({ name: outcome.supporter.name, email: outcome.supporter.email });
    toInsert.push({
      ...outcome.supporter,
      organization_id: ORGANIZATION_ID,
      created_by: CREATED_BY,
    });
  }

  console.log(`Parsed: ${toInsert.length} to insert, ${errorCount} error(s), ${duplicateCount} duplicate(s)`);
  console.log(`${toInsert.length} + ${errorCount} + ${duplicateCount} = ${toInsert.length + errorCount + duplicateCount} (of ${rows.length} rows read)`);

  for (const s of toInsert) {
    console.log(`  INSERT: ${s.name} | $${s.pledged_amount} ${s.pledged_frequency} | ${s.email ?? "(no email)"}`);
  }

  if (toInsert.length === 0) {
    console.log("Nothing to insert.");
    return;
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/supporters`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(toInsert),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Insert failed: ${res.status} ${body}`);
  }

  const inserted = await res.json();
  console.log(`\nInserted ${inserted.length} supporter(s) into organization ${ORGANIZATION_ID}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
