// STATE item 119 (rulings 0051 and 0052): the offline refresh of the leads for funders that file no return.
//
// Runs outside the web application with the service key. Three steps: (1) find the recipient keys that carry a signal, one funder EIN
// range at a time; (2) collect every paid grant that names those keys, one range at a time; (3) build the leads table. A range that times
// out is split in ten and retried. Safe to run again: the keys, rows and leads are recomputed whole; the curated table is never touched.
// Run it after any load of the funder reference tables or the faith-giving counts, and again if the rule version changes.
//
// Usage: npx tsx scripts/refresh-nofiling-leads.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

function env(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  const text = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const m = new RegExp(`^${name}=(.*)$`, "m").exec(text);
  if (!m) throw new Error(`${name} is not set`);
  return m[1].trim().replace(/^"|"$/g, "");
}

const URL_BASE = env("NEXT_PUBLIC_SUPABASE_URL");
const KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rpc(fn: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function clear(table: string, column: string): Promise<void> {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?${column}=not.is.null`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`clear ${table}: ${res.status} ${await res.text()}`);
}

let total = 0;
async function range(fn: string, from: string, to: string): Promise<void> {
  try {
    const n = Number(await rpc(fn, { p_from: from, p_to: to }));
    total += n;
    console.log(`${fn} ${from}..${to}  ${n}`);
  } catch (e) {
    if (from.length >= 6) throw e;
    console.log(`${fn} ${from}..${to} failed (${e instanceof Error ? e.message.slice(0, 80) : e}); splitting`);
    for (let d = 0; d <= 9; d++) await range(fn, from + d, d === 9 ? to : from + (d + 1));
  }
}

async function main() {
  const two = (n: number) => String(n).padStart(2, "0");
  console.log("clearing the working tables (the curated table is not touched)");
  await clear("funder_reference_nofiling_rows", "funder_ein");
  await clear("funder_reference_nofiling_keys", "lead_key");
  for (const fn of ["funder_reference_nofiling_scan_keys", "funder_reference_nofiling_scan_rows"]) {
    total = 0;
    for (let p = 0; p <= 99; p++) await range(fn, two(p), p === 99 ? "z" : two(p + 1));
    console.log(`${fn}: ${total} rows\n`);
  }
  // The build over the staged rows takes longer than the API's statement limit (found live 2026-11-17: HTTP 500, statement timeout; the
  // failed call rolls back, so the leads table is left as it was). If so, the last step is run in the Supabase SQL editor.
  try {
    const leads = Number(await rpc("funder_reference_nofiling_build", {}));
    console.log(`done: ${leads} leads built (rule no-filing-lead-v2); the curated records are unchanged`);
  } catch (e) {
    if (!/57014|statement timeout/i.test(String(e))) throw e;
    console.log("\nThe scans are done and the staged rows are fresh, but the build is too long for the API's statement limit (the leads table is unchanged).");
    console.log("Finish it in the Supabase SQL editor:   select funder_reference_nofiling_build();");
    console.log("Then run scripts/load-exempt-list.ts again so the IRS list is judged against the new leads.");
    process.exit(2);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
