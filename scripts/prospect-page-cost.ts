// What a prospect page costs to render, broken down by loader.
//
// "The page feels slow" and "confirming takes a while" are the same
// measurement: confirming does one small UPDATE and then router.refresh(),
// which re-runs the whole server component tree. So the confirm button's
// latency is almost entirely the page's render cost, and optimising the
// action itself would achieve nothing.
//
// Times the real loaders rather than a reimplementation, for the same reason
// explain-entity-resolution calls the real resolver: a copy drifts, and a
// performance number that drifts from the code it describes sends you
// optimising the wrong thing.
//
// Usage: npx tsx --env-file=.env.local scripts/prospect-page-cost.ts "Mission to the World"

import { createClient } from "@supabase/supabase-js";
import { loadProspectIntelligence, strategyReadiness } from "../lib/prospect-intelligence";
import { ENTITY_RANKING_VERSION } from "../lib/research";
import { loadProspectWorkflow } from "../lib/prospect-workflow";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function time<T>(label: string, fn: () => Promise<T>): Promise<[string, number, T]> {
  const t = Date.now();
  const out = await fn();
  return [label, Date.now() - t, out];
}

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: prospect-page-cost.ts "<prospect name>"');
    process.exit(1);
  }
  const { data: rows } = await admin.from("prospects").select("id, name").ilike("name", `%${query}%`);
  if (!rows?.length) throw new Error(`No prospect matching "${query}".`);
  const p = rows[0];
  console.log(`\n=== ${p.name} ===\n`);

  // A performance tool that cannot say whether the cache was used is half a
  // tool: "the number did not move" has two opposite causes -- the cache is
  // not being hit, or it was never the expensive part -- and they call for
  // opposite fixes.
  const { data: run } = await admin
    .from("research_runs")
    .select("id, version, entity_ranking_version, entity_ranking")
    .eq("prospect_id", p.id as string)
    .eq("status", "ready")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cached = run?.entity_ranking_version === ENTITY_RANKING_VERSION && Boolean(run?.entity_ranking);
  console.log(
    `  ranking cache: ${cached ? "HIT" : "MISS"}  (stored v${run?.entity_ranking_version ?? "none"}, code v${ENTITY_RANKING_VERSION}, ranking ${run?.entity_ranking ? "present" : "absent"})`
  );
  if (cached) {
    const bytes = JSON.stringify(run!.entity_ranking).length;
    console.log(`  cached ranking size: ${(bytes / 1024).toFixed(1)}KB\n`);
  } else {
    console.log("");
  }

  // Sequential on purpose: the page runs these in Promise.all, so the wall
  // clock hides which one is expensive. Fixing the wrong loader is the usual
  // outcome of optimising against a parallel total.
  const results: [string, number][] = [];
  for (let pass = 1; pass <= 2; pass++) {
    const cold = pass === 1 ? " (cold)" : " (warm)";
    for (const [label, ms] of [
      await time("loadProspectIntelligence", () => loadProspectIntelligence(admin as never, p.id as string)),
      await time("loadProspectWorkflow", () => loadProspectWorkflow(admin as never, p.id as string)),
      await time("strategyReadiness", () => strategyReadiness(admin as never, p.id as string)),
    ] as [string, number, unknown][]) {
      results.push([label + cold, ms]);
    }
  }

  const total = results.filter(([l]) => l.includes("warm")).reduce((s, [, ms]) => s + ms, 0);
  for (const [label, ms] of results) {
    const share = label.includes("warm") ? ` ${((ms / total) * 100).toFixed(0)}% of warm total` : "";
    console.log(`  ${label.padEnd(38)} ${String(ms).padStart(6)}ms${share}`);
  }
  console.log(`\n  warm total (server data only, no React render)  ${total}ms`);
  console.log("  A confirm click pays this again: the action updates one row, then router.refresh().\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
