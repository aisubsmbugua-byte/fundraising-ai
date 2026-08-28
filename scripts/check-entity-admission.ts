// Structural check on a completed research run's entity handling, plus the
// measurement that decides whether Stage 2 is needed.
//
// Why structural: the obvious test -- "produced zero claims from competing
// entities" -- was ALREADY passing before Stage 1 (0 of 47 and 0 of 80),
// because the extraction model happened to read entity context correctly. A
// test that is green before and after the fix proves nothing. So this
// asserts the property the gate is supposed to guarantee: every fragment
// admitted to extraction belongs to an entity we actually resolved, and no
// excluded-status evidence ever reached a claim.
//
// It also reports how much evidence would be lost if identity_unresolved
// were withheld from extraction (ChatGPT's Stage 2 proposal). That number is
// the input to the decision -- measured rather than assumed, because on a
// prospect with no website it could be most of the run.
//
// Usage: npx tsx --env-file=.env.local scripts/check-entity-admission.ts [runId]

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const EXCLUDED = new Set(["entity_mismatch", "unrelated_excluded"]);

async function main() {
  const runId = process.argv[2];
  const { data: run } = runId
    ? await admin.from("research_runs").select("*, prospects(name, ein)").eq("id", runId).single()
    : await admin.from("research_runs").select("*, prospects(name, ein)").eq("status", "ready").order("created_at", { ascending: false }).limit(1).single();
  if (!run) throw new Error("No completed run found.");

  const prospect = (run as { prospects: { name: string; ein: string | null } }).prospects;
  console.log(`Run v${run.version} -- ${prospect.name}`);
  console.log(`  resolution: ${run.entity_resolution_method} -> ${run.confirmed_ein ?? "(none)"}`);
  console.log(`  prospect saved EIN: ${prospect.ein ?? "(none)"}`);
  console.log(`  ${run.status_message}\n`);

  const { data: sources } = await admin.from("research_sources").select("id, url, entity_validation_status, source_ein").eq("research_run_id", run.id);
  const { data: evidence } = await admin.from("research_evidence").select("id, source_id").eq("research_run_id", run.id);
  const { data: links } = await admin.from("research_claim_sources").select("evidence_id, source_id").eq("research_run_id", run.id);
  const byId = new Map((sources ?? []).map((s) => [s.id, s]));

  const statusCounts: Record<string, number> = {};
  for (const s of sources ?? []) statusCounts[s.entity_validation_status ?? "null"] = (statusCounts[s.entity_validation_status ?? "null"] ?? 0) + 1;
  console.log("Sources by entity status:", JSON.stringify(statusCounts));

  // --- Structural assertion 1: no excluded-entity evidence supports a claim.
  const leaked = (links ?? []).filter((l) => {
    const s = byId.get(l.source_id as string);
    return s ? EXCLUDED.has(s.entity_validation_status ?? "") : false;
  });
  console.log(`\n[${leaked.length === 0 ? "PASS" : "FAIL"}] no excluded-entity evidence supports any claim (${leaked.length} violations)`);
  for (const l of leaked.slice(0, 5)) console.log("    ->", byId.get(l.source_id as string)?.url);

  // --- Structural assertion 2: consistent verdicts per entity. This is the
  // Maclellan v21 defect -- one organization, three URLs, two verdicts.
  const statusesByEin = new Map<string, Set<string>>();
  for (const s of sources ?? []) {
    if (!s.source_ein) continue;
    const set = statusesByEin.get(s.source_ein) ?? new Set<string>();
    set.add(s.entity_validation_status ?? "null");
    statusesByEin.set(s.source_ein, set);
  }
  const inconsistent = Array.from(statusesByEin.entries()).filter(([, set]) => set.size > 1);
  console.log(`[${inconsistent.length === 0 ? "PASS" : "FAIL"}] every entity has ONE verdict across its URLs (${inconsistent.length} split)`);
  for (const [ein, set] of inconsistent) console.log(`    -> ${ein}: ${Array.from(set).join(" / ")}`);

  // --- Structural assertion 3: when identity was resolved, the confirmed
  // entity's own sources are actually marked ein_confirmed.
  if (run.confirmed_ein) {
    const own = (sources ?? []).filter((s) => s.source_ein === run.confirmed_ein);
    const wrong = own.filter((s) => s.entity_validation_status !== "ein_confirmed");
    console.log(`[${wrong.length === 0 ? "PASS" : "FAIL"}] all ${own.length} sources for the confirmed EIN are ein_confirmed (${wrong.length} not)`);
  }

  // --- Stage 2 measurement: cost of withholding unresolved evidence.
  const unresolvedSourceIds = new Set((sources ?? []).filter((s) => s.entity_validation_status === "identity_unresolved").map((s) => s.id));
  const unresolvedEvidence = (evidence ?? []).filter((e) => unresolvedSourceIds.has(e.source_id as string));
  const unresolvedLinks = (links ?? []).filter((l) => unresolvedSourceIds.has(l.source_id as string));
  console.log(
    `\nStage 2 input -- if identity_unresolved were withheld from extraction:\n` +
      `  ${unresolvedEvidence.length} of ${(evidence ?? []).length} evidence fragments dropped\n` +
      `  ${unresolvedLinks.length} of ${(links ?? []).length} claim-evidence links lost`
  );

  if (leaked.length > 0 || inconsistent.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
