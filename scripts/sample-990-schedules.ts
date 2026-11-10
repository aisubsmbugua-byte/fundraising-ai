// STATE item 116 (ruling 0047 clause 5): the first act of the public-charity / donor-advised-fund
// build -- confirm, ON A SAMPLE, that the IRS archives we already hold contain Form 990 returns
// carrying Schedule I (grants to organizations) and Schedule D Part I (donor-advised funds), and
// report what the elements look like BEFORE any reader is written.
//
// Read-only and local: it reads index CSVs and ZIP archives that are already on disk, writes
// nothing, opens no database, makes no network call, and downloads nothing. Permanent: run it again
// on the server's copy of the archives, or after the IRS changes a form.
//
// SAMPLE. Systematic (every k-th Form 990 row in the index order, so the same inputs give the same
// sample, as the loader's verification sample does) over the returns whose tax period falls in the
// requested years and whose index row names its archive and that archive is on disk.
//
// Usage: npx tsx scripts/sample-990-schedules.ts --index-dir ~/irs-data/index --zips-dir ~/irs-data/zips \
//          [--years 2022,2023,2024] [--n 300] [--json out.json]

import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readIndexEach } from "../lib/funder-reference/sources";
import { openZip, fileSource } from "../lib/funder-reference/zip";
import { parseXml, child, descendants, type XmlNode } from "../lib/funder-reference/xml";
import type { IndexRow } from "../lib/funder-reference/document";

function arg(name: string, dflt: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const indexDir = arg("index-dir");
const zipsDir = arg("zips-dir");
if (!indexDir || !zipsDir) {
  console.error("usage: --index-dir <dir> --zips-dir <dir> [--years 2022,2023,2024] [--n 300] [--json out.json]");
  process.exit(2);
}
const years = (arg("years", "2022,2023,2024") as string).split(",").map(Number);
const want = Number(arg("n", "300"));
const jsonOut = arg("json");

const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const top = (m: Map<string, number>, n = 40) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

async function main() {
  // ---- the candidate rows: Form 990, tax period in the years, archive named and on disk
  const rows: IndexRow[] = [];
  let totalIndexRows = 0;
  let form990 = 0;
  let noBatch = 0;
  let zipMissing = 0;
  for (const f of readdirSync(indexDir!).filter((f) => /^index_\d{4}\.csv$/.test(f)).sort()) {
    const { totalRows } = await readIndexEach(join(indexDir!, f), { returnType: "990", periodYears: years, eins: null }, (r) => {
      form990++;
      if (!r.batchId) return void noBatch++;
      if (!existsSync(join(zipsDir!, `${r.batchId}.zip`))) return void zipMissing++;
      rows.push(r);
    });
    totalIndexRows += totalRows;
  }
  const k = Math.max(1, Math.floor(rows.length / want));
  const sample = rows.filter((_, i) => i % k === 0).slice(0, want);
  console.log(`index rows read: ${totalIndexRows.toLocaleString()}; Form 990 returns with a tax period in ${years.join(",")}: ${form990.toLocaleString()}`);
  console.log(`  not usable here: ${noBatch.toLocaleString()} name no archive (2022 and 2023 indexes carry no batch column), ${zipMissing.toLocaleString()} name an archive not on disk`);
  console.log(`  candidates: ${rows.length.toLocaleString()}; sample: every ${k}th, ${sample.length} returns\n`);

  // ---- read each sampled return from its archive
  const byBatch = new Map<string, IndexRow[]>();
  for (const r of sample) (byBatch.get(r.batchId!) ?? byBatch.set(r.batchId!, []).get(r.batchId!)!).push(r);
  const out = {
    read: 0, unreadable: [] as string[], notFound: 0,
    hasSchedI: 0, hasSchedD: 0, hasSchedDDafPartI: 0, hasBoth: 0,
    returnVersions: new Map<string, number>(),
    scheduleChildren: new Map<string, number>(), // top-level elements under IRS990ScheduleI
    schedIGroupChildren: new Map<string, number>(), // elements under a recipient row
    schedDDafElements: new Map<string, number>(),
    irs990Flags: new Map<string, number>(), // Part IV style yes/no and counts on the main form that concern DAFs and grants
    examples: { schedI: [] as string[], schedD: [] as string[], both: [] as string[] },
    sizeBuckets: new Map<string, number>(),
    // ruling 0047 clause 8 (the $100,000 line) and the row projection: grants to organizations per return
    orgGrants: [] as number[], // Part IX line 1 domestic + foreign totals, one per read return that states them
    orgGrantsStated: 0,
    scheduleIRows: [] as number[], // recipient rows on Schedule I, one per return that has the schedule
    inScope: { charity: 0, daf: 0, both: 0, charityRows: [] as number[], dafReturns: [] as string[] },
    xmlBytes: [] as number[],
  };
  const dafish = /donoradvised|\bDAF|AdvisedFund/i;
  const grantish = /grants?to|schedulei|GrantsAndSimilar|RecipientTable|Grant/i;

  for (const [batch, rs] of byBatch) {
    const wantNames = new Set(rs.map((r) => `${r.objectId}_public.xml`));
    const zip = await openZip(await fileSource(join(zipsDir!, `${batch}.zip`)), { keep: (n) => wantNames.has(n.slice(n.lastIndexOf("/") + 1)) });
    for (const r of rs) {
      const e = zip.findObject(r.objectId);
      if (!e) {
        out.notFound++;
        continue;
      }
      let root: XmlNode;
      try {
        root = parseXml(Buffer.from(await zip.read(e)).toString("utf8"));
      } catch (err) {
        out.unreadable.push(`${r.objectId}: ${(err as Error).message.slice(0, 80)}`);
        continue;
      }
      out.read++;
      out.xmlBytes.push(e.size);
      tally(out.returnVersions, root.attrs.returnVersion ?? "?");
      const data = child(root, "ReturnData");
      const f990 = child(data, "IRS990");
      const si = child(data, "IRS990ScheduleI");
      const sd = child(data, "IRS990ScheduleD");
      if (si) {
        out.hasSchedI++;
        if (out.examples.schedI.length < 4) out.examples.schedI.push(`${r.objectId} EIN ${r.ein} ${r.taxpayerName}`);
        for (const c of si.children) tally(out.scheduleChildren, c.name);
        for (const g of si.children.filter((c) => /RecipientTable/i.test(c.name)).slice(0, 5)) for (const c of g.children) tally(out.schedIGroupChildren, c.name);
      }
      let dafRows = 0;
      if (sd) {
        out.hasSchedD++;
        // every element under Schedule D that looks like a donor-advised-fund element (name and parent shown)
        const hits: string[] = [];
        const walk = (n: XmlNode, path: string) => {
          for (const c of n.children) {
            const p = `${path}/${c.name}`;
            if (dafish.test(c.name)) hits.push(p);
            walk(c, p);
          }
        };
        walk(sd, "IRS990ScheduleD");
        for (const h of new Set(hits)) tally(out.schedDDafElements, h);
        dafRows = hits.length;
        if (hits.some((h) => /TotalNumberOf|NumberOf|Total|Grants|Contributions|Assets/i.test(h))) out.hasSchedDDafPartI++;
        if (out.examples.schedD.length < 4 && hits.length) out.examples.schedD.push(`${r.objectId} EIN ${r.ein} ${r.taxpayerName}`);
      }
      const num = (n: XmlNode | null) => (n && /^-?\d+$/.test(n.text) ? Number(n.text) : null);
      const dom = num(child(child(f990, "GrantsToDomesticOrgsGrp"), "TotalAmt"));
      const frn = num(child(child(f990, "GrantsToForeignOrgsGrp"), "TotalAmt"));
      if (dom !== null || frn !== null) {
        out.orgGrantsStated++;
        out.orgGrants.push((dom ?? 0) + (frn ?? 0));
      }
      const siRows = si ? si.children.filter((c) => /RecipientTable/i.test(c.name)).length : 0;
      if (si) out.scheduleIRows.push(siRows);
      const charityInScope = (dom ?? 0) + (frn ?? 0) >= 100_000;
      const dafInScope = dafRows > 0 && (num(child(sd, "DonorAdvisedFundsHeldCnt")) ?? 0) > 0;
      if (charityInScope) {
        out.inScope.charity++;
        out.inScope.charityRows.push(siRows);
      }
      if (dafInScope) {
        out.inScope.daf++;
        out.inScope.dafReturns.push(`${r.objectId} ${r.taxpayerName}`);
      }
      if (charityInScope && dafInScope) out.inScope.both++;
      if (si && dafRows) {
        out.hasBoth++;
        if (out.examples.both.length < 3) out.examples.both.push(`${r.objectId} EIN ${r.ein} ${r.taxpayerName}`);
      }
      if (f990) for (const d of f990.children) if (dafish.test(d.name) || /^(GrantsToOrganizationsInd|GrantsToIndividualsInd|DonorAdvisedFundInd|ScheduleIRequiredInd|ScheduleDRequiredInd)$/.test(d.name) || /GrantsAndSimilarAmountsPaid|TotalGrants|CYGrantsAndSimilarPaidAmt/.test(d.name)) tally(out.irs990Flags, `${d.name}=${d.text || "(group)"}`.slice(0, 90));
      // descendants() is used to be sure no Schedule is nested somewhere else
      if (!si && descendants(root, "IRS990ScheduleI").length) tally(out.scheduleChildren, "(IRS990ScheduleI found NOT under ReturnData)");
    }
    await zip.close();
  }

  const pct = (n: number) => `${n} (${out.read ? ((100 * n) / out.read).toFixed(1) : "0"}%)`;
  console.log(`read ${out.read} of ${sample.length}; not found in their archive: ${out.notFound}; unreadable: ${out.unreadable.length}`);
  if (out.unreadable.length) console.log("  unreadable:", out.unreadable.slice(0, 5).join(" | "));
  console.log(`return versions: ${top(out.returnVersions, 8).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  console.log(`\nSchedule I (grants to organizations) present: ${pct(out.hasSchedI)}`);
  console.log(`Schedule D present: ${pct(out.hasSchedD)}; with a donor-advised-fund element under it: ${pct(out.hasSchedDDafPartI)}`);
  console.log(`Schedule I and a donor-advised-fund element together: ${pct(out.hasBoth)}`);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  console.log(`\nIN SCOPE by ruling 0047 clause 8 (of ${out.read} read): public charity with grants to organizations of $100,000 or more (Part IX line 1, domestic plus foreign): ${pct(out.inScope.charity)}; donor-advised fund sponsor (Schedule D reports at least one fund): ${pct(out.inScope.daf)}; both: ${out.inScope.both}`);
  console.log(`  returns that state a Part IX line 1 total: ${out.orgGrantsStated}; of those with any grants to organizations: ${out.orgGrants.filter((g) => g > 0).length}`);
  console.log(`  Schedule I recipient rows on an in-scope charity return: mean ${mean(out.inScope.charityRows).toFixed(1)}, median ${median(out.inScope.charityRows)}, max ${Math.max(0, ...out.inScope.charityRows)}`);
  console.log(`  XML size of a sampled Form 990: mean ${(mean(out.xmlBytes) / 1024).toFixed(0)} KB, median ${(median(out.xmlBytes) / 1024).toFixed(0)} KB`);
  console.log(`  donor-advised fund sponsors found: ${out.inScope.dafReturns.join(" | ") || "none in this sample"}`);
  console.log(`\nelements directly under IRS990ScheduleI:\n  ${top(out.scheduleChildren).map(([k, v]) => `${k} x${v}`).join("\n  ")}`);
  console.log(`\nelements inside a recipient row of Schedule I:\n  ${top(out.schedIGroupChildren).map(([k, v]) => `${k} x${v}`).join("\n  ")}`);
  console.log(`\ndonor-advised-fund elements under IRS990ScheduleD:\n  ${top(out.schedDDafElements).map(([k, v]) => `${k} x${v}`).join("\n  ")}`);
  console.log(`\nmain-form (IRS990) elements about grants or donor-advised funds:\n  ${top(out.irs990Flags, 30).map(([k, v]) => `${k} x${v}`).join("\n  ")}`);
  console.log(`\nexamples to open by hand:\n  Schedule I: ${out.examples.schedI.join("; ")}\n  donor-advised fund: ${out.examples.schedD.join("; ")}\n  both: ${out.examples.both.join("; ")}`);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ ...out, returnVersions: top(out.returnVersions), scheduleChildren: top(out.scheduleChildren), schedIGroupChildren: top(out.schedIGroupChildren), schedDDafElements: top(out.schedDDafElements), irs990Flags: top(out.irs990Flags), sample: sample.length }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
