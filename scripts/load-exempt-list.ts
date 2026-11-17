// STATE item 119, stage two (ruling 0053): load the IRS list of exempt organizations for the leads of funders that file no return.
//
// Runs outside the web application with the service key, on files YOU downloaded. It reads the four regional files of the IRS Exempt
// Organizations Business Master File extract (eo1.csv to eo4.csv, https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf),
// keeps only the rows the ruling keeps (about 1.98 million are read, a few thousand are sent), replaces the table whole, and asks the
// database to judge them (funder_reference_exempt_list_apply). It makes no request but to your own database and calls no model.
//
// Order of work after any funder load or a new IRS posting:
//   1. npx tsx scripts/refresh-nofiling-leads.ts      (the leads found in filings; this script matches against them)
//   2. npx tsx scripts/load-exempt-list.ts --dir <directory holding eo1.csv..eo4.csv> --posted <the IRS page's "updated data posting date", yyyy-mm-dd>
//
// Usage: npx tsx scripts/load-exempt-list.ts --dir <dir> --posted 2026-11-10 [--dry-run]
//   --dry-run   read the files and the lead keys, print what would be sent, write nothing
import { createReadStream, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseCsvLine } from "../lib/funder-reference/sources";
import { bmfIndex, bmfRow, leadKeyOf, sendRow, toStoredRow } from "../lib/funder-reference/exempt-list";

function env(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  const text = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const m = new RegExp(`^${name}=(.*)$`, "m").exec(text);
  if (!m) throw new Error(`${name} is not set`);
  return m[1].trim().replace(/^"|"$/g, "");
}
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dryRun = process.argv.includes("--dry-run");

const FILES = ["eo1.csv", "eo2.csv", "eo3.csv", "eo4.csv"];

async function main() {
  const dir = arg("dir");
  const posted = arg("posted");
  if (!dir || !posted || !/^\d{4}-\d{2}-\d{2}$/.test(posted)) throw new Error("usage: --dir <directory holding eo1.csv to eo4.csv> --posted yyyy-mm-dd [--dry-run]");
  for (const f of FILES) if (!existsSync(join(dir, f))) throw new Error(`${join(dir, f)} is missing`);
  const listVersion = `eo-bmf-${posted}`;

  const base = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  // the keys of every lead and curated record: any listed organization with one of these keys is sent, whatever it must file
  async function getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let off = 0; ; off += 1000) {
      const res = await fetch(`${base}/rest/v1/${path}`, { headers: { ...headers, Range: `${off}-${off + 999}`, "Range-Unit": "items" } });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      const page = (await res.json()) as T[];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }
  const leadKeys = new Set<string>([
    ...(await getAll<{ lead_key: string }>("funder_reference_nofiling_leads?select=lead_key&order=lead_key")).map((r) => r.lead_key),
    ...(await getAll<{ lead_key: string }>("funder_reference_curated_funders?select=lead_key&order=lead_key")).map((r) => r.lead_key),
  ]);
  console.log(`${leadKeys.size} lead and curated keys to match`);
  if (leadKeys.size === 0) console.log("note: there are no leads; run scripts/refresh-nofiling-leads.ts first if you expect some (only the tiered rows will be sent)");

  const send: Record<string, string | null>[] = [];
  const seen = new Set<string>();
  let total = 0;
  let religiousNoReturn = 0;
  let skipped = 0;
  for (const f of FILES) {
    const rl = createInterface({ input: createReadStream(join(dir, f), { encoding: "latin1" }), crlfDelay: Infinity });
    let idx: Record<string, number> | null = null;
    for await (const line of rl) {
      if (line === "") continue;
      const cells = parseCsvLine(line);
      if (!idx) {
        try {
          idx = bmfIndex(cells);
        } catch (e) {
          throw new Error(`${f}: ${e instanceof Error ? e.message : e}`);
        }
        continue;
      }
      const row = bmfRow(cells, idx);
      total++;
      if (!/^\d{9}$/.test(row.EIN)) {
        skipped++;
        continue;
      }
      if ((row.FILING_REQ_CD === "06" || row.FILING_REQ_CD === "13") && row.STATUS === "01") religiousNoReturn++;
      if (!sendRow(row, leadKeys)) continue;
      if (seen.has(row.EIN)) throw new Error(`EIN ${row.EIN} appears twice in the files`);
      seen.add(row.EIN);
      send.push(toStoredRow(row, listVersion, posted));
    }
    console.log(`${f} read`);
  }
  const byMatch = send.filter((r) => leadKeys.has(leadKeyOf(r.name, r.state) ?? "")).length;
  console.log(`${total} organizations read (${skipped} without a nine-digit EIN skipped); ${religiousNoReturn} religious and not required to file; ${send.length} to send (${byMatch} match a lead key)`);
  if (dryRun) {
    console.log("dry run: nothing written");
    return;
  }

  console.log("replacing the table");
  let res = await fetch(`${base}/rest/v1/funder_reference_exempt_list?ein=not.is.null`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`clear: ${res.status} ${await res.text()}`);
  for (let i = 0; i < send.length; i += 500) {
    res = await fetch(`${base}/rest/v1/funder_reference_exempt_list`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(send.slice(i, i + 500)) });
    if (!res.ok) throw new Error(`insert at ${i}: ${res.status} ${await res.text()}`);
  }
  console.log(`${send.length} rows written; asking the database to judge them`);
  res = await fetch(`${base}/rest/v1/rpc/funder_reference_exempt_list_apply`, { method: "POST", headers, body: "{}" });
  if (!res.ok) throw new Error(`apply: ${res.status} ${await res.text()}`);
  console.log(JSON.stringify(await res.json(), null, 2));
  console.log("done. The Donor Finder reads the table at once; the page needs no refresh step.");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
