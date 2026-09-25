// Demonstrates tenant isolation on the seven Build 1 research tables
// (research_runs, research_claims, research_expected_facts,
// research_eval_reviews, research_sources, research_claim_sources,
// research_evidence), on the two ruling-0019 outcome tables added in
// migration 0066 (prospect_outcomes, prospect_outcome_dispositions), on the
// ruling-0026 run ledger added in migration 0067 (ai_runs), on the
// ruling-0027 retraction table added in migration 0068
// (prospect_outcome_retractions), on the ruling-0029 send-attempt
// ledger added in migration 0069 (draft_send_attempts), and on drafts
// itself (which carries the send facts since 0069), in both
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
// Sections that could not run at all -- e.g. a table whose migration is not
// yet applied. "Not evaluated" and "evaluated and clean" are different facts
// (CLAUDE.md), so these are reported by name rather than silently skipped.
const notEvaluated: string[] = [];
// Behaviour the run OBSERVED that is a known gap, not a pass or a fail --
// listed by name at the end so an assertion that documents a current gap
// cannot be mistaken for evidence the gap is closed.
const knownGaps: string[] = [];
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
//                 prospect_outcomes, prospect_outcome_dispositions and (via
//                 prospect_outcomes) prospect_outcome_retractions, all of
//                 which carry an `auth.users` FK that would otherwise block
//                 the user delete (0035:22/88/167, 0066:44/74, 0068:47).
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
    // ai_runs references organizations with no cascade and no delete policy
    // (service role bypasses RLS, which is the only reason this cleanup can
    // work at all), so its test rows must go before the org rows can.
    // Error 42P01 / PGRST205 (relation does not exist / not in the PostgREST schema cache) is tolerated: it just means
    // migration 0067 has not been applied yet, and the ai_runs section
    // below reports itself as NOT EVALUATED in that case.
    const { error: aiRunsError } = await admin.from("ai_runs").delete().in("organization_id", orgIds);
    if (aiRunsError && aiRunsError.code !== "42P01" && aiRunsError.code !== "PGRST205") {
      problems.push(`[${phase}] deleting ai_runs in test orgs failed: ${aiRunsError.message}`);
    }

    // draft_send_attempts references drafts with NO cascade (0069 -- a
    // draft with send history is deliberately undeletable), so surviving
    // attempts would block the prospects->drafts cascade delete below.
    // 42P01/PGRST205 tolerated: migration 0069 not applied yet, and the
    // section below reports itself NOT EVALUATED in that case.
    const { error: sendAttemptsError } = await admin.from("draft_send_attempts").delete().in("organization_id", orgIds);
    if (sendAttemptsError && sendAttemptsError.code !== "42P01" && sendAttemptsError.code !== "PGRST205") {
      problems.push(`[${phase}] deleting draft_send_attempts in test orgs failed: ${sendAttemptsError.message}`);
    }

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

    // --- Ruling 0027's retraction table (migration 0068) ---
    //
    // Same treatment: two real authenticated sessions, never the service-role
    // client. The table's own properties beyond isolation: append-only (no
    // update, no delete, even for the owning org), one retraction per outcome,
    // and -- ruling 0027's test of compliance -- after a retraction both the
    // outcome row and the retraction row are still readable.
    const { error: retractionsProbeError } = await admin.from("prospect_outcome_retractions").select("id").limit(1);
    if (retractionsProbeError && (retractionsProbeError.code === "42P01" || retractionsProbeError.code === "PGRST205")) {
      notEvaluated.push(
        "prospect_outcome_retractions -- migration 0068 is not applied to this database, so its assertions did not run"
      );
      console.log(
        "\nNOT EVALUATED: prospect_outcome_retractions (migration 0068 not applied). Apply 0068 and re-run; this is not a pass.\n"
      );
    } else {
      const { data: retractionA, error: retractionAError } = await clientA
        .from("prospect_outcome_retractions")
        .insert({ prospect_outcome_id: outcomeA.id, note: "[test] Org A retraction", retracted_by: a.userId })
        .select("id")
        .single();
      if (retractionAError || !retractionA)
        throw new Error(`Org A prospect_outcome_retractions insert failed: ${retractionAError?.message}`);

      // Ruling 0027's test of compliance: record, retract, and BOTH rows stay
      // readable -- the retraction voids the outcome without erasing it.
      const { data: outcomeStillReadable } = await clientA.from("prospect_outcomes").select("id").eq("id", outcomeA.id);
      check(
        "after retraction, the retracted outcome row is still readable by its own org (ruling 0027: the record survives its own reversal)",
        (outcomeStillReadable?.length ?? 0) === 1
      );
      const { data: retractionReadable } = await clientA
        .from("prospect_outcome_retractions")
        .select("id")
        .eq("id", retractionA.id);
      check("...and so is the retraction row itself", (retractionReadable?.length ?? 0) === 1);

      const { data: readRetraction } = await clientB
        .from("prospect_outcome_retractions")
        .select("id")
        .eq("id", retractionA.id);
      check("Org B cannot SELECT Org A's prospect_outcome_retractions row by id", (readRetraction?.length ?? 0) === 0);

      // FK checks bypass RLS; the org-match trigger is what stops this.
      const { error: crossRetractionError } = await clientB.from("prospect_outcome_retractions").insert({
        prospect_outcome_id: outcomeA.id,
        note: "[test] cross-org attempt",
        retracted_by: b.userId,
      });
      check(
        "Org B cannot INSERT a prospect_outcome_retractions row against Org A's outcome (org-match trigger)",
        !!crossRetractionError
      );

      const { data: ownRetractionUpdate } = await clientA
        .from("prospect_outcome_retractions")
        .update({ note: "edited" })
        .eq("id", retractionA.id)
        .select("id");
      check(
        "prospect_outcome_retractions has no update policy -- even Org A's own UPDATE on its own row affects 0 rows",
        (ownRetractionUpdate?.length ?? 0) === 0
      );

      const { data: ownRetractionDelete } = await clientA
        .from("prospect_outcome_retractions")
        .delete()
        .eq("id", retractionA.id)
        .select("id");
      check(
        "prospect_outcome_retractions has no delete policy -- a retraction is itself retained (ruling 0027 clause 4)",
        (ownRetractionDelete?.length ?? 0) === 0
      );

      const { error: secondRetractionError } = await clientA.from("prospect_outcome_retractions").insert({
        prospect_outcome_id: outcomeA.id,
        note: "[test] second retraction of the same outcome",
        retracted_by: a.userId,
      });
      check(
        "a second retraction of the same outcome is refused (unique on prospect_outcome_id) -- the first already voided it",
        !!secondRetractionError
      );
    }

    // --- Ruling 0026's run ledger (migration 0067) ---
    //
    // Same treatment as the tables above: two real authenticated sessions,
    // never the service-role client -- except for the one assertion that is
    // ABOUT the service role, where bypassing RLS is the point being tested.
    // The ledger's additional properties: no delete policy (run records are
    // retained), and updates reach only unfinalized rows, so a terminal
    // outcome is written once through any session-client code path.
    const { error: aiRunsProbeError } = await admin.from("ai_runs").select("id").limit(1);
    if (aiRunsProbeError && (aiRunsProbeError.code === "42P01" || aiRunsProbeError.code === "PGRST205")) {
      notEvaluated.push("ai_runs -- migration 0067 is not applied to this database, so its assertions did not run");
      console.log("\nNOT EVALUATED: ai_runs (migration 0067 not applied). Apply 0067 and re-run; this is not a pass.\n");
    } else {
      const { data: aiRunA, error: aiRunAError } = await clientA
        .from("ai_runs")
        .insert({ operation: "research", source_table: "research_runs", source_id: runA.id })
        .select("id, outcome, ended_at")
        .single();
      if (aiRunAError || !aiRunA) throw new Error(`Org A ai_runs birth insert failed: ${aiRunAError?.message}`);
      check("an ai_runs birth row is born unfinalized (outcome and ended_at null)", aiRunA.outcome === null && aiRunA.ended_at === null);

      const { data: readAiRun } = await clientB.from("ai_runs").select("id").eq("id", aiRunA.id);
      check("Org B cannot SELECT Org A's ai_runs row by id", (readAiRun?.length ?? 0) === 0);

      const { data: aiRunCrossUpdate } = await clientB
        .from("ai_runs")
        .update({ outcome: "completed", ended_at: new Date().toISOString() })
        .eq("id", aiRunA.id)
        .select("id");
      check("Org B's UPDATE on Org A's ai_runs row affects 0 rows", (aiRunCrossUpdate?.length ?? 0) === 0);

      const { error: aiRunCrossInsertError } = await clientB
        .from("ai_runs")
        .insert({ operation: "research", organization_id: a.orgId });
      check("Org B cannot INSERT an ai_runs row claiming Org A's organization_id (insert policy)", !!aiRunCrossInsertError);

      const { data: aiRunFinalize } = await clientA
        .from("ai_runs")
        .update({ outcome: "completed", ended_at: new Date().toISOString(), model: "test-model", input_tokens: 1, output_tokens: 1 })
        .eq("id", aiRunA.id)
        .select("id");
      check("Org A can finalize its own unfinalized ai_runs row (update affects 1 row)", (aiRunFinalize?.length ?? 0) === 1);

      const { data: aiRunRefinalize } = await clientA
        .from("ai_runs")
        .update({ outcome: "failed", ended_at: new Date().toISOString() })
        .eq("id", aiRunA.id)
        .select("id");
      check(
        "a finalized ai_runs row is out of update reach even for its own org (terminal written once -- update policy gates on outcome is null)",
        (aiRunRefinalize?.length ?? 0) === 0
      );

      const { error: aiRunAdminRewriteError } = await admin
        .from("ai_runs")
        .update({ outcome: "failed", ended_at: new Date().toISOString() })
        .eq("id", aiRunA.id);
      check(
        "even the service-role client cannot rewrite a finalized ai_runs row (terminal-once trigger, not just RLS)",
        !!aiRunAdminRewriteError
      );

      const { data: aiRunDelete } = await clientA.from("ai_runs").delete().eq("id", aiRunA.id).select("id");
      check("ai_runs has no delete policy -- a run record is retained, not deleted", (aiRunDelete?.length ?? 0) === 0);
    }

    // --- Ruling 0029's send-attempt ledger (migration 0069) ---
    //
    // Same treatment: two real authenticated sessions. The ledger's own
    // guarantees (birth preconditions, one live attempt, terminal-once,
    // the drafts mirror) are exercised in scripts/test-send-draft.ts; this
    // section owns the tenant-isolation half -- hard rule 6 on the new
    // org-scoped table -- plus its no-delete retention.
    const { error: sendAttemptsProbeError } = await admin.from("draft_send_attempts").select("id").limit(1);
    if (sendAttemptsProbeError && (sendAttemptsProbeError.code === "42P01" || sendAttemptsProbeError.code === "PGRST205")) {
      notEvaluated.push("draft_send_attempts -- migration 0069 is not applied to this database, so its assertions did not run");
      console.log("\nNOT EVALUATED: draft_send_attempts (migration 0069 not applied). Apply 0069 and re-run; this is not a pass.\n");
    } else {
      // An APPROVED draft under Org A -- the attempt birth trigger refuses
      // anything else, and that refusal is test-send-draft.ts's subject,
      // not this one's.
      const { data: draftA, error: draftAError } = await clientA
        .from("drafts")
        .insert({
          prospect_id: prospectA.id,
          kind: "intro_email",
          subject: "[test] Org A draft subject",
          content: "[test] Org A draft body",
          status: "approved",
          created_by: a.userId,
        })
        .select("id")
        .single();
      if (draftAError || !draftA) throw new Error(`Org A draft insert failed: ${draftAError?.message}`);

      const attemptPayload = {
        draft_id: draftA.id,
        recipient_email: "org-a-funder@example.org",
        subject: "[test] Org A draft subject",
        body: "[test] Org A draft body",
      };
      const { data: attemptA, error: attemptAError } = await clientA
        .from("draft_send_attempts")
        .insert({ ...attemptPayload, attempted_by: a.userId })
        .select("id, outcome, completed_at")
        .single();
      if (attemptAError || !attemptA) throw new Error(`Org A send attempt birth failed: ${attemptAError?.message}`);
      check("a draft_send_attempts row is born unfinalized (outcome and completed_at null)", attemptA.outcome === null && attemptA.completed_at === null);

      const { data: readAttempt } = await clientB.from("draft_send_attempts").select("id").eq("id", attemptA.id);
      check("Org B cannot SELECT Org A's draft_send_attempts row by id", (readAttempt?.length ?? 0) === 0);

      const { error: crossAttemptError } = await clientB
        .from("draft_send_attempts")
        .insert({ ...attemptPayload, attempted_by: b.userId });
      check("Org B cannot INSERT a send attempt against Org A's draft (org-match birth trigger)", !!crossAttemptError);

      const { error: impersonationError } = await clientA
        .from("draft_send_attempts")
        .insert({ ...attemptPayload, attempted_by: b.userId });
      check("an attempt cannot name someone else as its author (insert policy: attempted_by = auth.uid())", !!impersonationError);

      const { data: crossUpdate } = await clientB
        .from("draft_send_attempts")
        .update({ outcome: "failed", completed_at: new Date().toISOString(), error_note: "[test] cross-org" })
        .eq("id", attemptA.id)
        .select("id");
      check("Org B's UPDATE on Org A's draft_send_attempts row affects 0 rows", (crossUpdate?.length ?? 0) === 0);

      const { data: attemptDelete } = await clientA.from("draft_send_attempts").delete().eq("id", attemptA.id).select("id");
      check("draft_send_attempts has no delete policy -- even Org A's own DELETE on its own row affects 0 rows", (attemptDelete?.length ?? 0) === 0);

      const { data: finalize } = await clientA
        .from("draft_send_attempts")
        .update({ outcome: "failed", completed_at: new Date().toISOString(), error_note: "[test] provider refused" })
        .eq("id", attemptA.id)
        .select("id");
      check("Org A can finalize its own unfinalized attempt (update affects 1 row)", (finalize?.length ?? 0) === 1);

      const { data: refinalize } = await clientA
        .from("draft_send_attempts")
        .update({ outcome: "failed", completed_at: new Date().toISOString(), error_note: "[test] second write" })
        .eq("id", attemptA.id)
        .select("id");
      check(
        "a finalized attempt is out of update reach even for its own org (terminal written once -- update policy gates on outcome is null)",
        (refinalize?.length ?? 0) === 0
      );
    }

    // --- drafts (migrations 0017 + 0033, send facts from 0069) ---
    //
    // drafts is the highest-value org-scoped table this script had never
    // covered: since 0069 it carries the send facts (sent_at, sent_by,
    // resend_message_id). Same treatment -- two real authenticated sessions,
    // equality-matched test rows only. No send attempt is created here (the
    // draft_send_attempts FK has no cascade, so an attempt would block the
    // purge's prospects -> drafts cascade); this draft stays status 'draft'
    // and is removed by that cascade when its prospect goes.
    const { data: draftGovA, error: draftGovAError } = await clientA
      .from("drafts")
      .insert({
        prospect_id: prospectA.id,
        kind: "intro_email",
        subject: "[test] Org A governed draft",
        content: "[test] Org A governed draft body",
        status: "draft",
        created_by: a.userId,
      })
      .select("id")
      .single();
    if (draftGovAError || !draftGovA) throw new Error(`Org A drafts insert failed: ${draftGovAError?.message}`);

    const { data: readDraft } = await clientB.from("drafts").select("id").eq("id", draftGovA.id);
    check("Org B cannot SELECT Org A's drafts row by id", (readDraft?.length ?? 0) === 0);

    const { data: draftCrossUpdate } = await clientB
      .from("drafts")
      .update({ subject: "[test] cross-org rewrite" })
      .eq("id", draftGovA.id)
      .select("id");
    check("Org B's UPDATE on Org A's drafts row affects 0 rows", (draftCrossUpdate?.length ?? 0) === 0);
    const { data: draftAfterCross } = await admin.from("drafts").select("subject").eq("id", draftGovA.id).single();
    check("...and Org A's draft subject is verifiably unchanged (read via the service role, not trusting the 0-row response)", draftAfterCross?.subject === "[test] Org A governed draft");

    // Item 73 closes the gap item 72 documented here: drafts had RLS on its
    // own organization_id but no org-match trigger on prospect_id, and FK
    // checks bypass RLS, so Org B could link a draft to Org A's prospect.
    // Migration 0075's drafts_prospect_org_match refuses it. The assertion is
    // therefore INVERTED (passes when refused) -- but "the insert succeeded"
    // is ambiguous between "0075 is not applied" and "0075 is broken", and
    // an unapplied migration must read as neither a pass nor a fail of the
    // fix. Applied-ness is probed with a service-role insert carrying sent
    // facts, which only 0075's drafts_no_insert_with_sent_facts refuses
    // (0069's sent-once trigger is update-only); PostgREST cannot read
    // pg_trigger. If the probe insert lands it is deleted at once.
    const { data: probeDraft, error: probeDraftError } = await admin
      .from("drafts")
      .insert({
        prospect_id: prospectA.id,
        kind: "intro_email",
        subject: "[test] 0075 applied-ness probe",
        content: "[test] probe",
        status: "draft",
        created_by: a.userId,
        organization_id: a.orgId,
        sent_at: new Date().toISOString(),
        sent_by: a.userId,
        resend_message_id: "[test] probe",
      })
      .select("id")
      .single();
    // A missing send column (0069 absent) also means 0075 cannot be in effect.
    const probeColumnsMissing = !!probeDraftError && (probeDraftError.code === "42703" || probeDraftError.code === "PGRST204");
    if ((!probeDraftError && probeDraft) || probeColumnsMissing) {
      if (probeDraft) await admin.from("drafts").delete().eq("id", probeDraft.id);
      notEvaluated.push("drafts cross-org prospect link -- migration 0075 is not applied to this database, so the org-match refusal was not evaluated");
      console.log("\nNOT EVALUATED: drafts org-match on prospect_id (migration 0075 not applied). Apply 0075 and re-run; this is not a pass.\n");
    } else {
      const { data: crossDraft, error: crossDraftError } = await clientB
        .from("drafts")
        .insert({
          prospect_id: prospectA.id,
          kind: "intro_email",
          subject: "[test] cross-org draft against Org A's prospect",
          content: "[test] cross-org attempt",
          status: "draft",
          created_by: b.userId,
        })
        .select("id, organization_id")
        .single();
      check(
        "Org B cannot INSERT a drafts row referencing Org A's prospect (org-match trigger on drafts.prospect_id, migration 0075)",
        !!crossDraftError && !crossDraft
      );
      if (crossDraft) {
        // The fix failed; leave no row behind.
        await admin.from("drafts").delete().eq("id", crossDraft.id);
      }
    }

    const { data: draftOwnUpdate } = await clientA
      .from("drafts")
      .update({ subject: "[test] Org A edited its own draft" })
      .eq("id", draftGovA.id)
      .select("id");
    check("Org A can UPDATE its own drafts row while status is draft (affects 1 row)", (draftOwnUpdate?.length ?? 0) === 1);

    // Send facts exist only from migration 0069; without it there is no
    // column to attack, and the section says so rather than passing.
    if (sendAttemptsProbeError && (sendAttemptsProbeError.code === "42P01" || sendAttemptsProbeError.code === "PGRST205")) {
      notEvaluated.push("drafts send-fact isolation -- migration 0069 is not applied to this database, so drafts has no send columns to test");
      console.log("\nNOT EVALUATED: drafts send facts (migration 0069 not applied). This is not a pass.\n");
    } else {
      const { data: sendFactsCrossUpdate } = await clientB
        .from("drafts")
        .update({ sent_at: new Date().toISOString(), sent_by: b.userId, resend_message_id: "[test] cross-org forged send fact" })
        .eq("id", draftGovA.id)
        .select("id");
      check("Org B's UPDATE writing send facts (sent_at, sent_by, resend_message_id) on Org A's draft affects 0 rows", (sendFactsCrossUpdate?.length ?? 0) === 0);
      const { data: sendFactsAfter } = await admin
        .from("drafts")
        .select("sent_at, sent_by, resend_message_id")
        .eq("id", draftGovA.id)
        .single();
      check(
        "...and Org A's draft carries no send facts afterwards (read via the service role)",
        !!sendFactsAfter && sendFactsAfter.sent_at === null && sendFactsAfter.sent_by === null && sendFactsAfter.resend_message_id === null
      );
    }

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

    // --- org_sending_enablement (migration 0076, ruling 0032) ---
    // Sending is off per organization until a superadmin turns it on. Reads
    // are org-scoped; writes are superadmin-only, so NEITHER test user (both
    // is_superadmin = false) can write -- not even to its own org's row.
    // Rows are seeded through the service role; org deletion cascades them
    // (on delete cascade), so the purge needs no extra step. NOT-EVALUATED
    // when the table does not exist yet (42P01 / PGRST205).
    const { error: enablementSeedError } = await admin
      .from("org_sending_enablement")
      .insert({ organization_id: a.orgId, enabled: true });
    if (enablementSeedError && (enablementSeedError.code === "42P01" || enablementSeedError.code === "PGRST205")) {
      notEvaluated.push("org_sending_enablement isolation -- migration 0076 is not applied to this database");
      console.log("\nNOT EVALUATED: org_sending_enablement (migration 0076 not applied). This is not a pass.\n");
    } else {
      if (enablementSeedError) throw new Error(`org_sending_enablement seed failed: ${enablementSeedError.message}`);

      const { data: enBRead } = await clientB.from("org_sending_enablement").select("organization_id").eq("organization_id", a.orgId);
      check("Org B cannot SELECT Org A's org_sending_enablement row", (enBRead?.length ?? 0) === 0);
      const { data: enARead } = await clientA.from("org_sending_enablement").select("enabled").eq("organization_id", a.orgId);
      check("Org A's member CAN read its own organization's enablement row", (enARead?.length ?? 0) === 1 && enARead![0].enabled === true);

      const { data: enAOwnUpdate } = await clientA
        .from("org_sending_enablement")
        .update({ enabled: false })
        .eq("organization_id", a.orgId)
        .select("organization_id");
      check("A same-org NON-superadmin member's UPDATE of its own enablement row affects 0 rows", (enAOwnUpdate?.length ?? 0) === 0);
      const { data: enAfterOwn } = await admin.from("org_sending_enablement").select("enabled").eq("organization_id", a.orgId).single();
      check("...and the row is verified unchanged via the service role (still enabled)", enAfterOwn?.enabled === true);

      const { data: enBCrossUpdate } = await clientB
        .from("org_sending_enablement")
        .update({ enabled: false })
        .eq("organization_id", a.orgId)
        .select("organization_id");
      check("Org B's UPDATE of Org A's enablement row affects 0 rows", (enBCrossUpdate?.length ?? 0) === 0);

      const { error: enBSelfEnable } = await clientB
        .from("org_sending_enablement")
        .insert({ organization_id: b.orgId, enabled: true });
      check("A non-superadmin member cannot INSERT (enable) its OWN organization -- refused by RLS", enBSelfEnable !== null);
      const { data: enBRowAfter } = await admin.from("org_sending_enablement").select("organization_id").eq("organization_id", b.orgId);
      check("...and no enablement row exists for Org B afterwards (absence = off)", (enBRowAfter?.length ?? 0) === 0);

      const { error: enACrossInsert } = await clientA
        .from("org_sending_enablement")
        .insert({ organization_id: b.orgId, enabled: true });
      check("Org A's member cannot INSERT an enablement row for Org B", enACrossInsert !== null);

      const { data: enADelete } = await clientA
        .from("org_sending_enablement")
        .delete()
        .eq("organization_id", a.orgId)
        .select("organization_id");
      check("No delete policy: a member's DELETE of its own enablement row affects 0 rows", (enADelete?.length ?? 0) === 0);
      const { data: enStillThere } = await admin.from("org_sending_enablement").select("enabled").eq("organization_id", a.orgId);
      check("...and the row still exists, verified via the service role", (enStillThere?.length ?? 0) === 1 && enStillThere![0].enabled === true);
    }
  } finally {
    cleanupProblems = await purgeTestIdentities("teardown");
  }

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  for (const n of notEvaluated) console.log(`NOT EVALUATED: ${n}`);
  for (const g of knownGaps) console.log(`KNOWN GAP: ${g}`);
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
