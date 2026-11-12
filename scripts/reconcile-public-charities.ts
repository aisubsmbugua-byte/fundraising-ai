// Item 116: the moved-filer reconcile. See lib/funder-reference/reconcile-990.ts for why it exists.
//
// For every funder whose stored kind_basis does not list exactly the tax periods of its stored returns, it
// reads every stored return (standing and superseded) from the IRS archives on disk, recomputes the kind labels
// and the basis with the loader's own rule, and (only with --apply --confirm-write-to-supabase) updates the
// funder's three kind columns. It changes nothing else: no identity field, no filing, no figure, no recipient.
// Dry run by default. Writes one run record of its own kind (public_charity_reconcile) when it applies.
//
// Usage (server): scripts/reconcile-public-charities.ts --archives-dir DIR [--result-file F]
//                 [--apply --confirm-write-to-supabase]
import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { archiveProvider } from "../lib/funder-reference/sources";
import { parseReturn990 } from "../lib/funder-reference/parse-990";
import { DEFAULT_CHARITY_THRESHOLD, factsOf, type PeriodFacts } from "../lib/funder-reference/charity-scope";
import { needsReconcile, reconcileKinds, type KindsPatch } from "../lib/funder-reference/reconcile-990";

const RECONCILER_VERSION = "reconcile-public-charities/1.0.0";
type Row = Record<string, unknown>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const archivesDir = arg("archives-dir");
  const resultFile = arg("result-file");
  const apply = flag("apply");
  if (!archivesDir) { console.error("--archives-dir is required"); process.exit(2); }
  if (apply && !flag("confirm-write-to-supabase")) { console.error("--apply also needs --confirm-write-to-supabase"); process.exit(2); }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment."); process.exit(2); }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const provider = archiveProvider({ dir: resolve(archivesDir), remote: false, userAgent: "FundraisingAI-charity-reconcile/1.0" });
  const started = new Date().toISOString();

  async function page(table: string, cols: string, order: string): Promise<Row[]> {
    const out: Row[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(table).select(cols).order(order, { ascending: true }).range(from, from + 999);
      if (error) throw new Error(`read ${table}: ${error.message}`);
      out.push(...((data ?? []) as unknown as Row[]));
      if ((data ?? []).length < 1000) break;
    }
    return out;
  }

  console.log(`${RECONCILER_VERSION}; ${apply ? "APPLY" : "dry run"}`);
  const orgs = await page("charity_reference_organizations", "ein, is_grantmaking_public_charity, is_daf_sponsor, kind_basis", "ein");
  const filings = await page("charity_reference_filings", "ein, object_id, status, tax_period_end, document_archive_url, document_member", "object_id");
  const byEin = new Map<string, Row[]>();
  for (const f of filings) byEin.set(String(f.ein), [...(byEin.get(String(f.ein)) ?? []), f]);
  const candidates = orgs.filter((o) => needsReconcile(o.kind_basis, (byEin.get(String(o.ein)) ?? []).filter((f) => f.status !== "unread").map((f) => String(f.tax_period_end))));
  console.log(`${orgs.length} funders, ${filings.length} filings; ${candidates.length} funder(s) whose stored basis does not list the periods of their stored returns`);

  const patches = new Map<string, KindsPatch>();
  const result = { none: [] as string[], patch: [] as Array<{ ein: string; label_changed: boolean; basis_added: number }>, refuse: [] as Array<{ ein: string; why: string }> };
  for (let i = 0; i < candidates.length; i += 40) {
    const chunk = candidates.slice(i, i + 40);
    const wanted = chunk.flatMap((o) => (byEin.get(String(o.ein)) ?? []).filter((f) => f.status !== "unread"));
    const bytes = new Map<string, Uint8Array | { error: string }>();
    const groups = new Map<string, Row[]>();
    for (const f of wanted) groups.set(basename(String(f.document_archive_url)).replace(/\.zip$/, ""), [...(groups.get(basename(String(f.document_archive_url)).replace(/\.zip$/, "")) ?? []), f]);
    for (const [name, list] of groups) {
      const members = new Set(list.map((f) => String(f.document_member)));
      const zip = await provider.open(name, { keep: (m) => members.has(m) });
      if (!zip) { for (const f of list) bytes.set(String(f.object_id), { error: `archive ${name} is not on disk` }); continue; }
      try {
        for (const f of list) {
          const entry = zip.find(String(f.document_member));
          if (!entry) { bytes.set(String(f.object_id), { error: `member ${String(f.document_member)} not in ${name}` }); continue; }
          try { bytes.set(String(f.object_id), await zip.read(entry)); } catch (e) { bytes.set(String(f.object_id), { error: (e as Error).message }); }
        }
      } finally { await zip.close(); }
    }
    for (const o of chunk) {
      const ein = String(o.ein);
      const mine = (byEin.get(ein) ?? []).filter((f) => f.status !== "unread");
      const periods: PeriodFacts[] = [];
      let bad: string | null = null;
      for (const f of mine) {
        const b = bytes.get(String(f.object_id));
        if (!b || "error" in b) { bad = `return ${String(f.object_id)} could not be read: ${b && "error" in b ? b.error : "not fetched"}`; break; }
        try {
          const p = parseReturn990(Buffer.from(b).toString("utf8"));
          periods.push({ ...factsOf(p), taxPeriodEnd: p.taxPeriodEnd });
        } catch (e) { bad = `return ${String(f.object_id)} did not parse: ${(e as Error).message}`; break; }
      }
      if (bad) { result.refuse.push({ ein, why: bad }); continue; }
      const r = reconcileKinds({ is_grantmaking_public_charity: Boolean(o.is_grantmaking_public_charity), is_daf_sponsor: Boolean(o.is_daf_sponsor), kind_basis: o.kind_basis }, periods, DEFAULT_CHARITY_THRESHOLD);
      if (r.action === "none") result.none.push(ein);
      else if (r.action === "refuse") result.refuse.push({ ein, why: r.why });
      else { result.patch.push({ ein, label_changed: r.labelChanged, basis_added: r.basisAdded }); patches.set(ein, r.patch); }
    }
    console.log(`  read ${Math.min(i + 40, candidates.length)} of ${candidates.length}`);
  }
  console.log(`to change: ${result.patch.length} (labels change for ${result.patch.filter((p) => p.label_changed).length}); already right: ${result.none.length}; refused: ${result.refuse.length}`);
  for (const r of result.refuse.slice(0, 10)) console.log(`  refused ${r.ein}: ${r.why}`);

  let applied = 0;
  if (apply && result.refuse.length === 0) {
    for (const [ein, patch] of patches) {
      const { error } = await db.from("charity_reference_organizations").update(patch).eq("ein", ein);
      if (error) throw new Error(`update ${ein}: ${error.message}`);
      applied++;
    }
    const { error } = await db.from("funder_reference_runs").insert({
      started_at: started, finished_at: new Date().toISOString(), loader_version: RECONCILER_VERSION, status: "completed",
      parameters: { kind: "public_charity_reconcile", threshold: DEFAULT_CHARITY_THRESHOLD }, sources: {},
      counts: { candidates: candidates.length, patched: applied, label_changed: result.patch.filter((p) => p.label_changed).length, already_right: result.none.length, refused: 0 },
      notes: "Recomputed kind labels and kind_basis from every stored return of each funder whose stored basis did not list the periods of its stored returns (a filer that moved states). No other column changed.",
    });
    if (error) console.error(`(note) the patches are applied but the run record could not be written: ${error.message}`);
    console.log(`applied ${applied}`);
  } else if (apply) console.log("NOT applied: some funders were refused; nothing was changed");

  if (resultFile) writeFileSync(resultFile, JSON.stringify({ version: RECONCILER_VERSION, apply, candidates: candidates.length, applied, ...result }, null, 2));
  process.exit(result.refuse.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(3); });
