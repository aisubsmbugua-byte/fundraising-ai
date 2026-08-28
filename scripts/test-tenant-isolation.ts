// Demonstrates tenant isolation on all seven Build 1 tables (research_runs,
// research_claims, research_expected_facts, research_eval_reviews,
// research_sources, research_claim_sources, research_evidence), in both
// directions, using two REAL authenticated `authenticated`-role
// sessions -- not the service-role client, which bypasses RLS entirely
// and would prove nothing. Sessions are minted the same way
// middleware.ts's DISABLE_AUTH bypass mints kanjii's dev session
// (generateLink -> verifyOtp), just parameterized to two throwaway users.
//
// Creates two throwaway orgs + users, runs the assertions, then tears
// everything down in a finally block -- safe to re-run. If a previous run
// left test data behind (e.g. this script crashed before cleanup), delete
// any organizations named "Isolation Test Org A"/"Isolation Test Org B"
// and their auth users (emails below) before re-running.
//
// Usage: npx tsx --env-file=.env.local scripts/test-tenant-isolation.ts

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const EMAIL_A = "isolation-test-a@fundraising-ai-test.local";
const EMAIL_B = "isolation-test-b@fundraising-ai-test.local";

let passCount = 0;
let failCount = 0;
function check(label: string, pass: boolean) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}`);
  if (pass) passCount++;
  else failCount++;
}

// Mints a real `authenticated`-role session for a known email -- no email
// is actually sent (generateLink doesn't deliver it, verifyOtp redeems the
// token directly), same mechanism middleware.ts already uses.
async function sessionClientFor(email: string): Promise<SupabaseClient> {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) throw new Error(`generateLink failed for ${email}: ${error?.message}`);
  const client = createClient(supabaseUrl!, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: verifyError } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
  if (verifyError) throw new Error(`verifyOtp failed for ${email}: ${verifyError.message}`);
  return client;
}

async function createTestOrgAndUser(orgName: string, email: string) {
  const { data: org, error: orgError } = await admin.from("organizations").insert({ name: orgName }).select("id").single();
  if (orgError || !org) throw new Error(`Failed to create ${orgName}: ${orgError?.message}`);

  const { data: created, error: userError } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !created.user) throw new Error(`Failed to create user ${email}: ${userError?.message}`);

  const { error: profileError } = await admin
    .from("profiles")
    .insert({ id: created.user.id, organization_id: org.id, is_superadmin: false, email });
  if (profileError) throw new Error(`Failed to create profile for ${email}: ${profileError.message}`);

  return { orgId: org.id as string, userId: created.user.id as string };
}

async function main() {
  const a = await createTestOrgAndUser("Isolation Test Org A", EMAIL_A);
  const b = await createTestOrgAndUser("Isolation Test Org B", EMAIL_B);

  try {
    const clientA = await sessionClientFor(EMAIL_A);
    const clientB = await sessionClientFor(EMAIL_B);

    // --- Seed one full set of rows under Org A ---
    const { data: prospectA, error: prospectAError } = await clientA
      .from("prospects")
      .insert({ name: "[test] Org A Probe Prospect", channel: "foundation", owner_id: a.userId })
      .select("id")
      .single();
    if (prospectAError || !prospectA) throw new Error(`Org A prospect insert failed: ${prospectAError?.message}`);

    const { data: runA, error: runAError } = await clientA
      .from("research_runs")
      .insert({ prospect_id: prospectA.id, version: 1, status: "researching", status_message: "test", created_by: a.userId })
      .select("id")
      .single();
    if (runAError || !runA) throw new Error(`Org A run insert failed: ${runAError?.message}`);

    const { data: claimA, error: claimAError } = await clientA
      .from("research_claims")
      .insert({
        research_run_id: runA.id,
        prospect_id: prospectA.id,
        claim_type: "fact",
        claim_key: "identity.location",
        category: "Identity",
        claim: "[test] Org A claim",
        confidence: "high",
      })
      .select("id")
      .single();
    if (claimAError || !claimA) throw new Error(`Org A claim insert failed: ${claimAError?.message}`);

    const { data: expectedA, error: expectedAError } = await clientA
      .from("research_expected_facts")
      .insert({
        prospect_id: prospectA.id,
        claim_key: "identity.location",
        category: "Identity",
        expected_claim: "[test] Org A expected fact",
        authored_by: a.userId,
      })
      .select("id")
      .single();
    if (expectedAError || !expectedA) throw new Error(`Org A expected_facts insert failed: ${expectedAError?.message}`);

    const { data: reviewA, error: reviewAError } = await clientA
      .from("research_eval_reviews")
      .insert({ research_run_id: runA.id, claim_id: claimA.id, verdict: "match", reviewed_by: a.userId })
      .select("id")
      .single();
    if (reviewAError || !reviewA) throw new Error(`Org A eval_reviews insert failed: ${reviewAError?.message}`);

    const { data: sourceA, error: sourceAError } = await clientA
      .from("research_sources")
      .insert({ research_run_id: runA.id, url: "https://example.org/org-a-source", title: "[test] Org A source" })
      .select("id")
      .single();
    if (sourceAError || !sourceA) throw new Error(`Org A source insert failed: ${sourceAError?.message}`);

    const { data: evidenceA, error: evidenceAError } = await clientA
      .from("research_evidence")
      .insert({
        research_run_id: runA.id,
        source_id: sourceA.id,
        url: "https://example.org/org-a-source",
        kind: "citation_fragment",
        exact_text: "[test] Org A evidence",
        content_hash: "test-hash",
      })
      .select("id")
      .single();
    if (evidenceAError || !evidenceA) throw new Error(`Org A evidence insert failed: ${evidenceAError?.message}`);

    const { data: claimSourceA, error: claimSourceAError } = await clientA
      .from("research_claim_sources")
      .insert({ claim_id: claimA.id, source_id: sourceA.id, evidence_id: evidenceA.id, research_run_id: runA.id, cited_text: "[test]" })
      .select("id")
      .single();
    if (claimSourceAError || !claimSourceA) throw new Error(`Org A claim_source insert failed: ${claimSourceAError?.message}`);

    console.log("Seeded one row per table (seven total) under Org A.\n");

    // --- Org B must not be able to read any of it by direct id ---
    const { data: readRun } = await clientB.from("research_runs").select("id").eq("id", runA.id);
    check("Org B cannot SELECT Org A's research_runs row by id", (readRun?.length ?? 0) === 0);

    const { data: readClaim } = await clientB.from("research_claims").select("id").eq("id", claimA.id);
    check("Org B cannot SELECT Org A's research_claims row by id", (readClaim?.length ?? 0) === 0);

    const { data: readExpected } = await clientB.from("research_expected_facts").select("id").eq("id", expectedA.id);
    check("Org B cannot SELECT Org A's research_expected_facts row by id", (readExpected?.length ?? 0) === 0);

    const { data: readReview } = await clientB.from("research_eval_reviews").select("id").eq("id", reviewA.id);
    check("Org B cannot SELECT Org A's research_eval_reviews row by id", (readReview?.length ?? 0) === 0);

    const { data: readSource } = await clientB.from("research_sources").select("id").eq("id", sourceA.id);
    check("Org B cannot SELECT Org A's research_sources row by id", (readSource?.length ?? 0) === 0);

    const { data: readClaimSource } = await clientB.from("research_claim_sources").select("id").eq("id", claimSourceA.id);
    check("Org B cannot SELECT Org A's research_claim_sources row by id", (readClaimSource?.length ?? 0) === 0);

    const { data: readEvidence } = await clientB.from("research_evidence").select("id").eq("id", evidenceA.id);
    check("Org B cannot SELECT Org A's research_evidence row by id", (readEvidence?.length ?? 0) === 0);

    // --- Org B must not be able to insert a child row against Org A's run (the trigger) ---
    const { error: crossClaimError } = await clientB.from("research_claims").insert({
      research_run_id: runA.id,
      prospect_id: prospectA.id,
      claim_type: "fact",
      claim_key: "identity.location",
      category: "Identity",
      claim: "[test] cross-org attempt, should be rejected",
      confidence: "high",
    });
    check("Org B cannot INSERT a research_claims row against Org A's run (org-match trigger)", !!crossClaimError);

    const { error: crossReviewError } = await clientB
      .from("research_eval_reviews")
      .insert({ research_run_id: runA.id, verdict: "match", reviewed_by: b.userId });
    check("Org B cannot INSERT a research_eval_reviews row against Org A's run (org-match trigger)", !!crossReviewError);

    // Org B has its own real prospect/run/claim/source at this point in
    // the script (created just below for the symmetry check would be too
    // late -- create a minimal Org B claim/source pair now so this cross-
    // tenant FK case is a real attempt: Org B trying to link ITS OWN claim
    // to ORG A's source, and vice versa, not just referencing nothing).
    const { data: prospectBEarly } = await clientB
      .from("prospects")
      .insert({ name: "[test] Org B Probe Prospect (early)", channel: "foundation", owner_id: b.userId })
      .select("id")
      .single();
    const { data: runBEarly } = await clientB
      .from("research_runs")
      .insert({ prospect_id: prospectBEarly!.id, version: 1, status: "researching", status_message: "test", created_by: b.userId })
      .select("id")
      .single();
    const { data: claimBEarly } = await clientB
      .from("research_claims")
      .insert({
        research_run_id: runBEarly!.id,
        prospect_id: prospectBEarly!.id,
        claim_type: "fact",
        claim_key: "identity.location",
        category: "Identity",
        claim: "[test] Org B claim",
        confidence: "high",
      })
      .select("id")
      .single();

    const { error: crossClaimSourceError } = await clientB
      .from("research_claim_sources")
      .insert({ claim_id: claimBEarly!.id, source_id: sourceA.id, research_run_id: runBEarly!.id, cited_text: "[test] cross-org attempt" });
    check("Org B cannot INSERT a research_claim_sources row citing Org A's source (org-match trigger)", !!crossClaimSourceError);

    const { error: crossSourceError } = await clientB
      .from("research_claim_sources")
      .insert({ claim_id: claimA.id, source_id: sourceA.id, research_run_id: runBEarly!.id, cited_text: "[test] cross-org attempt, wrong run" });
    check(
      "Org B cannot INSERT a research_claim_sources row against its own run pointing at Org A's claim (org-match trigger)",
      !!crossSourceError
    );

    const { error: crossEvidenceSourceRunError } = await clientB.from("research_evidence").insert({
      research_run_id: runBEarly!.id,
      source_id: sourceA.id,
      url: "https://example.org/org-a-source",
      kind: "citation_fragment",
      exact_text: "[test] cross-org attempt",
      content_hash: "test-hash",
    });
    check(
      "Org B cannot INSERT a research_evidence row against its own run pointing at Org A's source (source-run-match trigger)",
      !!crossEvidenceSourceRunError
    );

    // --- Org B must not be able to update Org A's row ---
    const { data: updateResult } = await clientB.from("research_runs").update({ status: "error" }).eq("id", runA.id).select("id");
    check("Org B's UPDATE on Org A's research_runs row affects 0 rows", (updateResult?.length ?? 0) === 0);

    // research_sources/research_claim_sources have NO update policy at all
    // (insert + select only, by design -- they're immutable historical
    // records of what was searched/cited, same "never alter the original"
    // principle as research_claims). Confirm that holds for the OWNING org
    // too, not just a cross-tenant attempt -- this is what "no one can
    // update" should look like, not an org-scoping gap.
    const { data: ownUpdateResult } = await clientA.from("research_sources").update({ title: "edited" }).eq("id", sourceA.id).select("id");
    check("research_sources has no update policy -- even Org A's own UPDATE on its own row affects 0 rows", (ownUpdateResult?.length ?? 0) === 0);

    const { data: ownEvidenceUpdateResult } = await clientA
      .from("research_evidence")
      .update({ exact_text: "edited" })
      .eq("id", evidenceA.id)
      .select("id");
    check(
      "research_evidence has no update policy -- even Org A's own UPDATE on its own row affects 0 rows",
      (ownEvidenceUpdateResult?.length ?? 0) === 0
    );

    // --- Symmetry: one probe under Org B, unreachable from Org A ---
    const { data: prospectB } = await clientB
      .from("prospects")
      .insert({ name: "[test] Org B Probe Prospect", channel: "foundation", owner_id: b.userId })
      .select("id")
      .single();
    const { data: runB } = await clientB
      .from("research_runs")
      .insert({ prospect_id: prospectB!.id, version: 1, status: "researching", status_message: "test", created_by: b.userId })
      .select("id")
      .single();
    const { data: readRunB } = await clientA.from("research_runs").select("id").eq("id", runB!.id);
    check("Org A cannot SELECT Org B's research_runs row by id (symmetry check)", (readRunB?.length ?? 0) === 0);

    // Cleanup of seeded rows: deleting the prospects cascades through
    // research_runs -> research_claims/research_key_coverage/
    // research_sources/research_claim_sources/research_eval_reviews, and
    // research_expected_facts references prospects directly, same on
    // delete cascade.
    await admin.from("prospects").delete().in("id", [prospectA.id, prospectBEarly!.id, prospectB!.id]);
  } finally {
    await admin.from("profiles").delete().in("id", [a.userId, b.userId]);
    await admin.auth.admin.deleteUser(a.userId);
    await admin.auth.admin.deleteUser(b.userId);
    await admin.from("organizations").delete().in("id", [a.orgId, b.orgId]);
  }

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
