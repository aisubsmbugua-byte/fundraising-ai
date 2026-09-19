// Demonstrates tenant isolation on the seven Build 1 research tables
// (research_runs, research_claims, research_expected_facts,
// research_eval_reviews, research_sources, research_claim_sources,
// research_evidence) and on the two ruling-0019 outcome tables added in
// migration 0066 (prospect_outcomes, prospect_outcome_dispositions), in both
// directions, using two REAL authenticated `authenticated`-role
// sessions -- not the service-role client, which bypasses RLS entirely
// and would prove nothing. Sessions are minted the same way
// middleware.ts's DISABLE_AUTH bypass mints kanjii's dev session
// (generateLink -> verifyOtp), just parameterized to two throwaway users.
//
// Creates two throwaway orgs + users, runs the assertions, then tears
// everything down. Safe to re-run with no manual SQL in between, for two
// reasons that are both load-bearing:
//
//  1. Setup is idempotent. Before creating anything, `purgeTestIdentities`
//     removes any organization named exactly "Isolation Test Org A"/"Isolation
//     Test Org B", any profile in one of those orgs, and any auth user whose
//     email is exactly one of the two below -- children before parents. A run
//     that leaked heals itself on the next run instead of blocking it.
//  2. The same purge is the teardown, and it runs in a `finally` that wraps
//     creation as well as the assertions. A failure partway through setup --
//     the exact case that used to strand the first org, its profile and its
//     auth user -- is covered, because teardown finds what to delete by
//     identity rather than by ids the failed setup never returned.
//
// Teardown cannot fail quietly: every delete is checked, the purge re-queries
// afterwards to confirm nothing is left, and anything still standing is printed
// as "CLEANUP PROBLEM" and forces a non-zero exit even when every assertion
// passed. A harness that leaks into a live database silently is worse than one
// that fails.
//
// Every deletion here is scoped to those two exact org names and two exact
// emails -- equality, never a pattern -- and the purge refuses to touch an org
// that contains a profile with any other email address. This runs against the
// real database, which holds real organizations.
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
const ORG_A_NAME = "Isolation Test Org A";
const ORG_B_NAME = "Isolation Test Org B";

// The whole of the test identity. Nothing outside these four literals is ever
// deleted, and they are matched by equality, never by `like`/`ilike` -- a
// pattern could match a real organization or a real person's account.
const TEST_ORG_NAMES = [ORG_A_NAME, ORG_B_NAME];
const TEST_EMAILS = [EMAIL_A, EMAIL_B];

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

// Every auth user whose email is EXACTLY one of the two test addresses.
// listUsers is paginated; a partial page ends the walk.
async function findTestAuthUsers(): Promise<{ id: string; email: string }[]> {
  const found: { id: string; email: string }[] = [];
  const perPage = 200;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed on page ${page}: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) {
      if (u.email && TEST_EMAILS.includes(u.email)) found.push({ id: u.id, email: u.email });
    }
    if (users.length < perPage) return found;
  }
}

// Every organization whose name is EXACTLY one of the two test org names.
// There can legitimately be more than one of each: a run that died between the
// org insert and the user insert leaves an "Isolation Test Org A" behind, and
// the next run creates another.
async function findTestOrgIds(): Promise<string[]> {
  const { data, error } = await admin.from("organizations").select("id, name").in("name", TEST_ORG_NAMES);
  if (error) throw new Error(`Could not list test organizations: ${error.message}`);
  return (data ?? []).filter((o) => TEST_ORG_NAMES.includes(o.name as string)).map((o) => o.id as string);
}

// Removes the test identity and everything hanging off it, children before
// parents. Returns the problems it could not resolve; an empty array means the
// database is provably clean of test rows, because this re-queries to check.
//
// Deletion order is forced by the schema, not by taste:
//   prospects  -- `on delete cascade` from prospects clears research_runs,
//                 research_claims, research_sources, research_evidence,
//                 research_claim_sources, research_claim_verifications,
//                 research_eval_reviews, research_expected_facts,
//                 prospect_outcomes and prospect_outcome_dispositions, all of
//                 which carry an `auth.users` FK that would otherwise block
//                 the user delete (0035:22/88/167, 0066:44/74).
//   profiles   -- `references organizations(id)` with no cascade (0032:30),
//                 so a surviving profile blocks the org delete.
//   auth users -- referenced by prospects.owner_id and friends with no
//                 cascade, so this only succeeds after the rows above are gone.
//   orgs       -- last, once nothing references them.
async function purgeTestIdentities(phase: string): Promise<string[]> {
  const problems: string[] = [];
  const orgIds = await findTestOrgIds();

  // Refuse to delete an org that holds anyone but the two test users. If a real
  // organization were ever named exactly "Isolation Test Org A", this is what
  // stops the purge rather than the org name alone.
  if (orgIds.length > 0) {
    const { data: occupants, error: occupantsError } = await admin
      .from("profiles")
      .select("id, email, organization_id")
      .in("organization_id", orgIds);
    if (occupantsError) throw new Error(`Could not inspect profiles in test orgs: ${occupantsError.message}`);
    const strangers = (occupants ?? []).filter((p) => !TEST_EMAILS.includes(p.email as string));
    if (strangers.length > 0) {
      throw new Error(
        `Refusing to purge: organization(s) ${orgIds.join(", ")} named as test orgs contain non-test profile(s) ` +
          `${strangers.map((s) => s.email).join(", ")}. Resolve by hand; this script will not delete a real org.`
      );
    }
  }

  let deletedProspects = 0;
  if (orgIds.length > 0) {
    const { data: prospects, error: prospectsError } = await admin
      .from("prospects")
      .delete()
      .in("organization_id", orgIds)
      .select("id");
    if (prospectsError) problems.push(`[${phase}] deleting prospects in test orgs failed: ${prospectsError.message}`);
    deletedProspects = prospects?.length ?? 0;

    const { error: profilesError } = await admin.from("profiles").delete().in("organization_id", orgIds);
    if (profilesError) problems.push(`[${phase}] deleting profiles in test orgs failed: ${profilesError.message}`);
  }

  const users = await findTestAuthUsers();
  for (const u of users) {
    // Belt and braces: a profile can exist for a test user whose org row was
    // already gone, and it would block nothing -- but it is still test data.
    const { error: profileError } = await admin.from("profiles").delete().eq("id", u.id);
    if (profileError) problems.push(`[${phase}] deleting profile ${u.id} (${u.email}) failed: ${profileError.message}`);
    const { error: userError } = await admin.auth.admin.deleteUser(u.id);
    if (userError) problems.push(`[${phase}] deleting auth user ${u.email} failed: ${userError.message}`);
  }

  if (orgIds.length > 0) {
    const { error: orgError } = await admin.from("organizations").delete().in("id", orgIds);
    if (orgError) problems.push(`[${phase}] deleting test organizations failed: ${orgError.message}`);
  }

  // Confirm, don't assume. A delete that silently affected zero rows and a
  // delete that worked look identical from the call site.
  const remainingOrgs = await findTestOrgIds();
  if (remainingOrgs.length > 0) problems.push(`[${phase}] ${remainingOrgs.length} test organization(s) still present: ${remainingOrgs.join(", ")}`);
  const remainingUsers = await findTestAuthUsers();
  if (remainingUsers.length > 0)
    problems.push(`[${phase}] ${remainingUsers.length} test auth user(s) still present: ${remainingUsers.map((u) => u.email).join(", ")}`);
  const { data: remainingProfiles, error: remainingProfilesError } = await admin.from("profiles").select("id, email").in("email", TEST_EMAILS);
  if (remainingProfilesError) problems.push(`[${phase}] could not re-check profiles: ${remainingProfilesError.message}`);
  else if ((remainingProfiles?.length ?? 0) > 0)
    problems.push(`[${phase}] ${remainingProfiles!.length} test profile(s) still present: ${remainingProfiles!.map((p) => p.email).join(", ")}`);

  // Printed here rather than only at the call site, so a problem is visible even
  // when an exception is on its way up out of the `finally` that called this.
  for (const p of problems) console.error(`CLEANUP PROBLEM: ${p}`);

  const removed = orgIds.length + users.length + deletedProspects;
  if (removed > 0) {
    console.log(
      `[${phase}] removed ${orgIds.length} test org(s), ${users.length} test auth user(s), ${deletedProspects} prospect(s) in those orgs (cascade covers their research and outcome rows).`
    );
  } else {
    console.log(`[${phase}] nothing to remove -- no test org, profile or auth user present.`);
  }
  return problems;
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
  // Idempotent setup. A previous run that died partway through creation left
  // an org, a profile or an auth user behind; without this, every run after it
  // dies on the duplicate email and no assertion ever executes.
  const preRunProblems = await purgeTestIdentities("pre-run");
  if (preRunProblems.length > 0) {
    throw new Error("Pre-run cleanup could not clear previous test data; refusing to run against a dirty database.");
  }

  let cleanupProblems: string[] = [];
  try {
    // Inside the try: a failure here is exactly the case that used to leak.
    const a = await createTestOrgAndUser(ORG_A_NAME, EMAIL_A);
    const b = await createTestOrgAndUser(ORG_B_NAME, EMAIL_B);

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

    const { data: verificationA, error: verificationAError } = await clientA
      .from("research_claim_verifications")
      .insert({ research_run_id: runA.id, claim_id: claimA.id, verdict: "supported", reason: "[test]", model: "test-model", evidence_count: 1 })
      .select("id")
      .single();
    if (verificationAError || !verificationA) throw new Error(`Org A verification insert failed: ${verificationAError?.message}`);

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

    const { data: readVerification } = await clientB.from("research_claim_verifications").select("id").eq("id", verificationA.id);
    check("Org B cannot SELECT Org A's research_claim_verifications row by id", (readVerification?.length ?? 0) === 0);

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

    const { error: crossVerificationError } = await clientB.from("research_claim_verifications").insert({
      research_run_id: runBEarly!.id,
      claim_id: claimA.id,
      verdict: "supported",
      reason: "[test] cross-tenant",
      model: "test-model",
      evidence_count: 0,
    });
    check(
      "Org B cannot INSERT a research_claim_verifications row against its own run pointing at Org A's claim (claim-run-match trigger)",
      !!crossVerificationError
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

    // --- Ruling 0019's two tables (migration 0066) ---
    //
    // Hard rule 6 and CLAUDE.md: nothing in the codebase catches a table that
    // ships without tenant isolation, so these get the same treatment as the
    // seven above -- two real authenticated sessions, never the service-role
    // client, which bypasses RLS and would prove nothing.
    const { data: outcomeA, error: outcomeAError } = await clientA
      .from("prospect_outcomes")
      .insert({ prospect_id: prospectA.id, outcome: "declined", reason: "[test] Org A decline", recorded_by: a.userId })
      .select("id")
      .single();
    if (outcomeAError || !outcomeA) throw new Error(`Org A prospect_outcomes insert failed: ${outcomeAError?.message}`);

    const { data: dispositionA, error: dispositionAError } = await clientA
      .from("prospect_outcome_dispositions")
      .insert({ prospect_outcome_id: outcomeA.id, disposition: "never", reason: "[test] Org A close", decided_by: a.userId })
      .select("id")
      .single();
    if (dispositionAError || !dispositionA)
      throw new Error(`Org A prospect_outcome_dispositions insert failed: ${dispositionAError?.message}`);

    const { data: readOutcome } = await clientB.from("prospect_outcomes").select("id").eq("id", outcomeA.id);
    check("Org B cannot SELECT Org A's prospect_outcomes row by id", (readOutcome?.length ?? 0) === 0);

    const { data: readDisposition } = await clientB
      .from("prospect_outcome_dispositions")
      .select("id")
      .eq("id", dispositionA.id);
    check("Org B cannot SELECT Org A's prospect_outcome_dispositions row by id", (readDisposition?.length ?? 0) === 0);

    const { data: outcomeUpdate } = await clientB
      .from("prospect_outcomes")
      .update({ reason: "edited" })
      .eq("id", outcomeA.id)
      .select("id");
    check("Org B's UPDATE on Org A's prospect_outcomes row affects 0 rows", (outcomeUpdate?.length ?? 0) === 0);

    // A foreign key check runs as the table owner and ignores RLS, so nothing
    // above stops Org B pointing its own row at Org A's outcome. The org-match
    // triggers in 0066 do -- this is the same hole left open on eight existing
    // columns and recorded in docs/decisions/0001-multi-tenancy.md.
    const { error: crossDispositionError } = await clientB.from("prospect_outcome_dispositions").insert({
      prospect_outcome_id: outcomeA.id,
      disposition: "never",
      reason: "[test] cross-org attempt",
      decided_by: b.userId,
    });
    check(
      "Org B cannot INSERT a prospect_outcome_dispositions row against Org A's outcome (org-match trigger)",
      !!crossDispositionError
    );

    const { error: crossOutcomeError } = await clientB.from("prospect_outcomes").insert({
      prospect_id: prospectA.id,
      outcome: "declined",
      reason: "[test] cross-org attempt",
      recorded_by: b.userId,
    });
    check("Org B cannot INSERT a prospect_outcomes row against Org A's prospect (org-match trigger)", !!crossOutcomeError);

    // Ruling 0019 is explicit that this is retention, not deletion, and that a
    // reversal leaves the original readable. Both are properties of the policy
    // set rather than of the code that calls it: no update policy and no delete
    // policy on the disposition log means the OWNING org cannot edit or remove
    // its own recorded decision either.
    const { data: ownDispositionUpdate } = await clientA
      .from("prospect_outcome_dispositions")
      .update({ disposition: "undecided" })
      .eq("id", dispositionA.id)
      .select("id");
    check(
      "prospect_outcome_dispositions has no update policy -- even Org A's own UPDATE on its own row affects 0 rows",
      (ownDispositionUpdate?.length ?? 0) === 0
    );

    const { data: ownDispositionDelete } = await clientA
      .from("prospect_outcome_dispositions")
      .delete()
      .eq("id", dispositionA.id)
      .select("id");
    check(
      "prospect_outcome_dispositions has no delete policy -- a recorded decision cannot be deleted by anyone",
      (ownDispositionDelete?.length ?? 0) === 0
    );

    const { data: ownOutcomeDelete } = await clientA.from("prospect_outcomes").delete().eq("id", outcomeA.id).select("id");
    check("prospect_outcomes has no delete policy -- a recorded no is retained, not deleted", (ownOutcomeDelete?.length ?? 0) === 0);

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

    // Seeded rows are not deleted by id here: the teardown below deletes every
    // prospect in the two test orgs, which cascades through research_runs ->
    // research_claims/research_key_coverage/research_sources/
    // research_claim_sources/research_eval_reviews, and through
    // research_expected_facts and prospect_outcomes, which reference prospects
    // directly with the same `on delete cascade`. Doing it by identity rather
    // than by captured id is what lets the teardown cover a failed setup.
  } finally {
    cleanupProblems = await purgeTestIdentities("teardown");
  }

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  if (cleanupProblems.length > 0) {
    console.error(
      `\nTeardown left ${cleanupProblems.length} problem(s) above -- test data is still in the live database. ` +
        `Exiting non-zero regardless of the assertion result: a harness that leaks quietly is how this script blocked itself before.`
    );
    process.exit(1);
  }
  console.log("Teardown verified: no test organization, profile or auth user remains.");
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  // "Aborted after 17 assertions" and "ran everything and 17 passed" are
  // different facts; an aborted run says so rather than printing nothing and
  // letting the reader assume either one.
  console.error(`Run aborted. Of the assertions that executed before the abort: ${passCount} passed, ${failCount} failed.`);
  process.exit(1);
});
