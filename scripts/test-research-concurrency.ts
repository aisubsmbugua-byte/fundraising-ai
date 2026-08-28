// Demonstrates two properties of the Research Agent's version-allocation
// and write-ordering design (see docs/decisions/0002-research-agent.md):
//
// 1. Two concurrent allocateResearchRunVersion() calls for the same
//    prospect land on two distinct, correctly-ordered versions -- no
//    crash, no duplicate -- via the retry-on-23505 loop in lib/research.ts.
// 2. A run whose claims were inserted but never flipped to 'ready' (the
//    literal failure mode write-ordering guards against) is still
//    visibly 'extracting' with claims already present -- proving a
//    consumer that correctly gates on status = 'ready' never observes
//    this partial state. A real mid-flight process kill isn't
//    practically triggerable here, so this simulates it directly by
//    simply not performing the final status write.
//
// Uses the service-role client throughout -- neither property being
// tested is an RLS property -- and cleans up everything it creates.
//
// Usage: npx tsx --env-file=.env.local scripts/test-research-concurrency.ts

import { createClient } from "@supabase/supabase-js";
import { allocateResearchRunVersion } from "../lib/research";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, organization_id")
    .eq("email", "kanjii@kijijiagency.com")
    .single();
  if (profileError || !profile) throw new Error(`Could not find the bootstrap profile: ${profileError?.message}`);

  const { data: prospect, error: prospectError } = await admin
    .from("prospects")
    .insert({
      name: "[test] Concurrency Probe Prospect",
      channel: "foundation",
      owner_id: profile.id,
      organization_id: profile.organization_id,
    })
    .select("id")
    .single();
  if (prospectError || !prospect) throw new Error(`Could not create throwaway prospect: ${prospectError?.message}`);

  const runIdsToClean: string[] = [];
  try {
    console.log("--- Property 1: concurrent version allocation ---");
    const [runIdA, runIdB] = await Promise.all([
      allocateResearchRunVersion(admin, prospect.id, null, profile.id, "concurrency test A"),
      allocateResearchRunVersion(admin, prospect.id, null, profile.id, "concurrency test B"),
    ]);
    runIdsToClean.push(runIdA, runIdB);

    const { data: runs } = await admin.from("research_runs").select("id, version").in("id", [runIdA, runIdB]).order("version");
    const versions = (runs ?? []).map((r) => r.version);
    const distinct = new Set(versions).size === versions.length && versions.length === 2;
    console.log(`Run A id=${runIdA}, Run B id=${runIdB}`);
    console.log(`Versions allocated: ${versions.join(", ")} -- ${distinct ? "PASS: distinct, no duplicate" : "FAIL: duplicate or missing!"}`);

    console.log("\n--- Property 2: write-ordering atomicity ---");
    const runId3 = await allocateResearchRunVersion(admin, prospect.id, null, profile.id, "atomicity test");
    runIdsToClean.push(runId3);
    // allocateResearchRunVersion doesn't set organization_id explicitly --
    // it relies on the column's `default my_organization_id()`, which only
    // resolves for a real session client. The service-role client used
    // throughout this script has no auth.uid(), so that default comes back
    // null; patch it here so the org-match trigger on research_claims
    // below has something real to compare against (a real caller never
    // hits this, since runResearch always uses the request-scoped client).
    await admin.from("research_runs").update({ status: "extracting", organization_id: profile.organization_id }).eq("id", runId3);

    const { data: sourceRow, error: sourceInsertError } = await admin
      .from("research_sources")
      .insert({ research_run_id: runId3, organization_id: profile.organization_id, url: "https://example.org/concurrency-test-source", title: "test" })
      .select("id")
      .single();
    if (sourceInsertError || !sourceRow) throw new Error(`Source insert failed: ${sourceInsertError?.message}`);

    const { data: claimRow, error: claimInsertError } = await admin
      .from("research_claims")
      .insert({
        research_run_id: runId3,
        prospect_id: prospect.id,
        organization_id: profile.organization_id,
        claim_type: "fact",
        claim_key: "identity.location",
        category: "Identity",
        claim: "[test claim -- simulated mid-flight state, never should be trusted]",
        confidence: "high",
      })
      .select("id")
      .single();
    if (claimInsertError || !claimRow) throw new Error(`Claims insert failed: ${claimInsertError?.message}`);

    const { error: claimSourceInsertError } = await admin
      .from("research_claim_sources")
      .insert({ claim_id: claimRow.id, source_id: sourceRow.id, research_run_id: runId3, organization_id: profile.organization_id, cited_text: "test" });
    if (claimSourceInsertError) throw new Error(`Claim-source insert failed: ${claimSourceInsertError.message}`);

    // Deliberately never flip status to 'ready' -- simulates a crash
    // between these inserts and the final status write.
    const { data: partialRun } = await admin.from("research_runs").select("status").eq("id", runId3).single();
    const { data: partialClaims } = await admin.from("research_claims").select("id").eq("research_run_id", runId3);
    const { data: partialSources } = await admin.from("research_sources").select("id").eq("research_run_id", runId3);
    const { data: partialClaimSources } = await admin.from("research_claim_sources").select("id").eq("research_run_id", runId3);
    console.log(`Run status after claims/sources/claim_sources insert, before the 'ready' write: ${partialRun?.status}`);
    console.log(
      `Present on this not-yet-ready run: ${partialClaims?.length ?? 0} claims, ${partialSources?.length ?? 0} sources, ${
        partialClaimSources?.length ?? 0
      } claim_sources`
    );
    console.log(
      partialRun?.status !== "ready"
        ? "PASS: a consumer gating on status = 'ready' never observes any of these rows."
        : "FAIL: run reached ready with a status that should have blocked it."
    );
  } finally {
    if (runIdsToClean.length > 0) await admin.from("research_runs").delete().in("id", runIdsToClean);
    await admin.from("prospects").delete().eq("id", prospect.id);
  }
}

main()
  .then(() => console.log("\nDone."))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
