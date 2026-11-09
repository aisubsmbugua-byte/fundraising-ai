// Item 114 (ruling 0046 clause 4): a fingerprint of every stored reference row,
// so two loads of the same input can be compared byte for byte.
//
// For each reference table it prints the row count and the SHA-256 of all rows
// written as canonical JSON (keys sorted, rows sorted by the table's key). The
// columns that legitimately differ between two runs of the same input are left out
// and named here: run_id, loaded_at and checked_at (they say WHEN and by WHICH run),
// never a value taken from a filing. Run it before and after a change to the code
// that reads or stores a value, on the same input; equal output means the stored
// values did not change.
//
// Usage: npx tsx scripts/funder-reference-rows-digest.ts --db pglite:<dir>
//        (a library function, rowsDigest(), is also used by the memory acceptance test)

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const VOLATILE_COLUMNS = ["run_id", "loaded_at", "checked_at"];
export const DIGEST_TABLES: Array<[string, string]> = [
  ["funder_reference_filings", "object_id"],
  ["funder_reference_foundations", "ein"],
  ["funder_reference_figures", "ein, tax_period_end"],
  ["funder_reference_people", "filing_object_id, listed_in, ordinal"],
  ["funder_reference_grants", "filing_object_id, kind, ordinal"],
  ["funder_reference_application_terms", "filing_object_id"],
  ["funder_reference_period_coverage", "ein, period_year"],
];

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}

export async function rowsDigest(db: Queryable): Promise<Record<string, { rows: number; sha256: string }>> {
  const out: Record<string, { rows: number; sha256: string }> = {};
  for (const [table, order] of DIGEST_TABLES) {
    const h = createHash("sha256");
    let n = 0;
    // to_jsonb so bigint, date, numeric and timestamptz arrive as plain JSON values; paged so a large table never sits in memory whole
    for (let from = 0; ; from += 5000) {
      const r = await db.query(`select to_jsonb(t) as r from ${table} t order by ${order} limit 5000 offset ${from}`);
      for (const x of r.rows as Array<{ r: Record<string, unknown> }>) {
        const row = { ...x.r };
        for (const c of VOLATILE_COLUMNS) delete row[c];
        h.update(JSON.stringify(canon(row)) + "\n");
        n++;
      }
      if (r.rows.length < 5000) break;
    }
    out[table] = { rows: n, sha256: h.digest("hex") };
  }
  return out;
}

async function main() {
  const i = process.argv.indexOf("--db");
  const spec = i >= 0 ? process.argv[i + 1] : undefined;
  if (!spec || !spec.startsWith("pglite:")) {
    console.error("usage: --db pglite:<dir>");
    process.exit(2);
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(resolve(spec.slice(7)));
  await db.waitReady;
  const d = await rowsDigest(db);
  for (const [t, v] of Object.entries(d)) console.log(`${t.padEnd(40)} ${String(v.rows).padStart(8)} rows  ${v.sha256}`);
  await db.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
