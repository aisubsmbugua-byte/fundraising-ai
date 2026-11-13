// STATE item 117 (ruling 0049 clause 7): the offline refresh of the per-funder faith-named grant counts.
//
// Runs outside the web application with the service key, one EIN range at a time so each call stays inside the database's
// statement limit; a range that times out is split in ten and retried. Safe to run again: each range is deleted and
// recomputed whole. Run it after any load of the funder reference tables, and again if the rule version changes.
//
// Usage: npx tsx scripts/refresh-faith-giving.ts [--from 00] [--to 99]
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

async function call(from: string, to: string): Promise<Array<{ source: string; funders: number }>> {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/funder_reference_refresh_faith_giving`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_from: from, p_to: to }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as Array<{ source: string; funders: number }>;
}

const totals: Record<string, number> = { private_foundation: 0, public_charity: 0 };

async function range(from: string, to: string): Promise<void> {
  try {
    const rows = await call(from, to);
    for (const r of rows) totals[r.source] += Number(r.funders);
    console.log(`${from}..${to}  ${rows.map((r) => `${r.source}=${r.funders}`).join(" ")}`);
  } catch (e) {
    if (from.length >= 6) throw e;
    console.log(`${from}..${to} failed (${e instanceof Error ? e.message.slice(0, 80) : e}); splitting`);
    for (let d = 0; d <= 9; d++) await range(from + d, d === 9 ? to : from + (d + 1));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string, d: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : d);
  const first = Number(get("--from", "00"));
  const last = Number(get("--to", "99"));
  const two = (n: number) => String(n).padStart(2, "0");
  for (let p = first; p <= last; p++) {
    await range(two(p), p === 99 ? "z" : two(p + 1));
  }
  console.log(`\ndone: ${totals.private_foundation} private foundations, ${totals.public_charity} public charities computed (rule faith-name-v1)`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
