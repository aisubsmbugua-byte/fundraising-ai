// What a prospect's current strategy was actually built from.
//
// The handoff from research to strategy is the one place where a human's
// claim-by-claim decisions either travel or silently don't, and nothing in
// the UI can show that: the strategy panel renders prose, and prose looks
// equally confident whether it rests on approved intelligence or on a web
// search the model did on its own. The only honest check is to read the
// stored run and ask what it was permitted to see.
//
// Deliberately calls the real loadApprovedIntelligence rather than
// reimplementing its rules. A copy of the gate would drift from the gate,
// and a check that drifts from the thing it checks is worse than none.
//
// Three questions, in the order they can go wrong:
//   1. Is the strategy grounded at all (approved_intelligence_run_id set)?
//   2. Is it grounded in the CURRENT research (or has research re-run since,
//      which resets every approval -- see 0051's header)?
//   3. Does the gate still return the claims it was grounded in?
//
// Usage: npx tsx --env-file=.env.local scripts/check-strategy-provenance.ts "Servants Heart"

import { createClient } from "@supabase/supabase-js";
import { loadApprovedIntelligence } from "../lib/prospect-intelligence";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const nameQuery = process.argv[2];
  if (!nameQuery) {
    console.error('Usage: check-strategy-provenance.ts "<prospect name>"');
    process.exit(1);
  }

  const { data: prospects } = await admin.from("prospects").select("id, name, ein").ilike("name", `%${nameQuery}%`);
  if (!prospects?.length) throw new Error(`No prospect matching "${nameQuery}".`);
  if (prospects.length > 1) {
    console.error(`Ambiguous -- ${prospects.length} prospects match:`);
    for (const p of prospects) console.error(`  ${p.name}`);
    process.exit(1);
  }
  const prospect = prospects[0];
  console.log(`${prospect.name} (EIN ${prospect.ein ?? "unset"})\n`);

  const { data: run } = await admin
    .from("strategy_runs")
    .select("id, status, created_at, approved_intelligence_run_id, approved_strategy, approved_at, evidence_item_ids")
    .eq("prospect_id", prospect.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) throw new Error("No strategy run for this prospect.");

  console.log(`Latest strategy run ${run.id.slice(0, 8)} -- ${run.status}, ${run.created_at}`);
  console.log(`  human-approved: ${run.approved_at ? `yes (${run.approved_at})` : "no"}`);
  console.log(`  evidence items cited: ${(run.evidence_item_ids as string[] | null)?.length ?? 0}`);

  // 1. Grounded at all. Null is exactly what the legacy banner keys off.
  const groundedIn = run.approved_intelligence_run_id as string | null;
  console.log(`\n[${groundedIn ? "PASS" : "FAIL"}] grounded in approved intelligence (legacy banner ${groundedIn ? "clears" : "shows"})`);
  if (!groundedIn) {
    console.log("    This strategy was built without approved intelligence. Regenerate it after");
    console.log("    approving research claims, or leave the banner up -- it is telling the truth.");
    return;
  }

  // 2. Grounded in the current research. An approval is tied to a claim row,
  //    and a re-run makes new claim rows, so research that ran after this
  //    strategy leaves it resting on decisions about superseded wording.
  const { data: latest } = await admin
    .from("research_runs")
    .select("id, version, completed_at")
    .eq("prospect_id", prospect.id)
    .eq("status", "ready")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: grounding } = await admin.from("research_runs").select("version").eq("id", groundedIn).maybeSingle();
  const current = latest?.id === groundedIn;
  console.log(`\n[${current ? "PASS" : "WARN"}] grounded in the current research run`);
  console.log(`    strategy built from: v${grounding?.version ?? "?"}`);
  console.log(`    latest ready run:    v${latest?.version ?? "?"}`);
  if (!current) console.log("    Research re-ran after this strategy. Approvals do not carry across runs; regenerate.");

  // 3. What the gate hands over today.
  const approved = await loadApprovedIntelligence(admin, prospect.id);
  if (!approved) {
    console.log("\n[FAIL] loadApprovedIntelligence returns null -- identity is unresolved on the latest run,");
    console.log("       so a strategy regenerated now would get no research at all.");
    return;
  }
  console.log(`\nApproved intelligence available now: v${approved.version}, EIN ${approved.confirmedEin ?? "(none)"}, ${approved.claims.length} claims`);
  const overrides = approved.claims.filter((c) => c.humanOverride);
  console.log(`  human overrides (approved against the evidence): ${overrides.length}`);
  for (const c of overrides) console.log(`    ${c.claimKey}: ${c.overrideNote ?? "(no note)"}`);
  console.log("  keys:");
  for (const c of approved.claims) {
    const period = c.reportingPeriod && !["not_time_bound", "unstated"].includes(c.reportingPeriod) ? ` [${c.reportingPeriod}]` : "";
    console.log(`    ${c.claimKey}${period} -- ${c.claim.slice(0, 90)}${c.claim.length > 90 ? "..." : ""} (${c.sources.length} src)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
