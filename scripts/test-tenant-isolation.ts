// Demonstrates tenant isolation on the seven Build 1 research tables
// (research_runs, research_claims, research_expected_facts,
// research_eval_reviews, research_sources, research_claim_sources,
// research_evidence), on the two ruling-0019 outcome tables added in
// migration 0066 (prospect_outcomes, prospect_outcome_dispositions), on the
// ruling-0026 run ledger added in migration 0067 (ai_runs), on the
// ruling-0027 retraction table added in migration 0068
// (prospect_outcome_retractions), on the ruling-0029 send-attempt
// ledger added in migration 0069 (draft_send_attempts), and on drafts
// itself (which carries the send facts since 0069), on the ruling-0033
// network tables added in migration 0077 (network_connections,
// network_path_suggestions), and on the ruling-0034 supporter tables added in
// migration 0078 (supporters, supporter_gifts, supporter_interactions), and on
// the ruling-0037 assistant tables added in migration 0080 (assistant_threads,
// assistant_messages, assistant_proposals -- which additionally need a
// SAME-ORG teammate, because a thread is personal to the user it acts as), and
// the ruling-0038 command record added in migration 0081
// (assistant_command_events -- append-only, born before the effect), in
// both directions, using two REAL authenticated `authenticated`-role
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

import { createHash, randomUUID } from "node:crypto";
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
// A same-org teammate of A, created only inside the assistant section (0080):
// a thread is personal to its author, so "another member of the SAME org
// cannot read it" is a different fact from "another org cannot".
const EMAIL_A2 = "isolation-test-a2@fundraising-ai-test.local";
const ORG_A_NAME = "Isolation Test Org A";
const ORG_B_NAME = "Isolation Test Org B";

// The whole of the test identity. Nothing outside these four literals is ever
// deleted, and they are matched by equality, never by `like`/`ilike` -- a
// pattern could match a real organization or a real person's account.
const TEST_ORG_NAMES = [ORG_A_NAME, ORG_B_NAME];
const TEST_EMAILS = [EMAIL_A, EMAIL_B, EMAIL_A2];

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

    // network_connections (0077, ruling 0033) references organizations and
    // auth.users with NO cascade, so surviving rows would block the profile,
    // auth-user and org deletes below. Deleting a connection cascades to its
    // network_path_suggestions (which also cascade from prospects), so this
    // one delete clears both new tables and must precede the prospects delete.
    // 42P01/PGRST205 tolerated: migration 0077 not applied yet, and the
    // network section below reports itself NOT EVALUATED in that case.
    const { error: networkError } = await admin.from("network_connections").delete().in("organization_id", orgIds);
    if (networkError && networkError.code !== "42P01" && networkError.code !== "PGRST205") {
      problems.push(`[${phase}] deleting network_connections in test orgs failed: ${networkError.message}`);
    }

    // supporters (0078, ruling 0034) references organizations with NO
    // cascade; supporter_gifts and supporter_interactions both cascade FROM
    // supporters, so this one delete clears all three new tables and must
    // precede the profile/org deletes below. 42P01/PGRST205 tolerated:
    // migration 0078 not applied yet, and the supporters section below
    // reports itself NOT EVALUATED in that case.
    const { error: supportersError } = await admin.from("supporters").delete().in("organization_id", orgIds);
    if (supportersError && supportersError.code !== "42P01" && supportersError.code !== "PGRST205") {
      problems.push(`[${phase}] deleting supporters in test orgs failed: ${supportersError.message}`);
    }

    // The external-agent tables (0082, ruling 0039) reference organizations,
    // auth.users and each other with NO cascade, so surviving rows would block
    // the profile, auth-user and org deletes below. Children first: the call
    // log and the approval requests name a token. (The service role bypasses
    // RLS, which has no delete policy on any of them -- the only reason this
    // cleanup can work.) 42P01/PGRST205 tolerated: migration 0082 not applied
    // yet, and the agent section below reports itself NOT EVALUATED.
    for (const table of ["agent_call_log", "agent_approval_requests", "agent_tokens"]) {
      const { error: agentCleanupError } = await admin.from(table).delete().in("organization_id", orgIds);
      if (agentCleanupError && agentCleanupError.code !== "42P01" && agentCleanupError.code !== "PGRST205") {
        problems.push(`[${phase}] deleting ${table} in test orgs failed: ${agentCleanupError.message}`);
      }
    }

    // assistant_threads (0080, ruling 0037) references organizations and
    // auth.users with NO cascade, so surviving rows would block the profile,
    // auth-user and org deletes below. assistant_messages and
    // assistant_proposals both cascade FROM assistant_threads, so this one
    // delete clears all three new tables. (The service role bypasses RLS,
    // which has no delete policy on any of them -- the only reason this
    // cleanup can work.) 42P01/PGRST205 tolerated: migration 0080 not applied
    // yet, and the assistant section below reports itself NOT EVALUATED.
    const { error: assistantError } = await admin.from("assistant_threads").delete().in("organization_id", orgIds);
    if (assistantError && assistantError.code !== "42P01" && assistantError.code !== "PGRST205") {
      problems.push(`[${phase}] deleting assistant_threads in test orgs failed: ${assistantError.message}`);
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

    // --- Network paths (migration 0077, ruling 0033) ---
    // network_connections is the organization's own editable, deletable note
    // about a person; network_path_suggestions is the AI's proposal anchored to
    // one connection and one approved research claim. Two real authenticated
    // sessions, never the service role, for every isolation assertion. The
    // three org-match triggers (prospect, connection, claim) are exercised by
    // cross-org INSERTs that must be REFUSED, and the update-repoint case
    // covers the extension 0077 makes beyond 0066's insert-only pattern.
    // NOT-EVALUATED when the tables do not exist (42P01 / PGRST205).
    const { error: networkProbeError } = await admin.from("network_connections").select("id").limit(1);
    if (networkProbeError && (networkProbeError.code === "42P01" || networkProbeError.code === "PGRST205")) {
      notEvaluated.push("network_connections / network_path_suggestions -- migration 0077 is not applied to this database, so their assertions did not run");
      console.log("\nNOT EVALUATED: network tables (migration 0077 not applied). Apply 0077 and re-run; this is not a pass.\n");
    } else {
      const { data: connA, error: connAError } = await clientA
        .from("network_connections")
        .insert({ recorded_by: a.userId, person_name: "[test] Org A person", strength: "warm" })
        .select("id")
        .single();
      if (connAError || !connA) throw new Error(`Org A network connection insert failed: ${connAError?.message}`);
      const { data: connB, error: connBError } = await clientB
        .from("network_connections")
        .insert({ recorded_by: b.userId, person_name: "[test] Org B person", strength: "close" })
        .select("id")
        .single();
      if (connBError || !connB) throw new Error(`Org B network connection insert failed: ${connBError?.message}`);

      const { data: nbRead } = await clientB.from("network_connections").select("id").eq("id", connA.id);
      check("Org B cannot SELECT Org A's network_connections row by id", (nbRead?.length ?? 0) === 0);
      const { data: nbUpdate } = await clientB.from("network_connections").update({ person_name: "[test] hijacked" }).eq("id", connA.id).select("id");
      check("Org B's UPDATE of Org A's network_connections row affects 0 rows", (nbUpdate?.length ?? 0) === 0);
      const { data: nbDelete } = await clientB.from("network_connections").delete().eq("id", connA.id).select("id");
      check("Org B's DELETE of Org A's network_connections row affects 0 rows", (nbDelete?.length ?? 0) === 0);
      const { data: connAAfter } = await admin.from("network_connections").select("person_name").eq("id", connA.id).single();
      check("...and Org A's connection is verified unchanged via the service role", connAAfter?.person_name === "[test] Org A person");

      const { error: noStrengthError } = await clientA
        .from("network_connections")
        .insert({ recorded_by: a.userId, person_name: "[test] no strength" });
      check("A connection with NO strength is refused (not null, no default)", !!noStrengthError);
      const { error: badStrengthError } = await clientA
        .from("network_connections")
        .insert({ recorded_by: a.userId, person_name: "[test] bad strength", strength: "best-friend" });
      check("A connection with a strength outside the closed list is refused", !!badStrengthError);
      const { error: foreignRecorderError } = await clientA
        .from("network_connections")
        .insert({ recorded_by: b.userId, person_name: "[test] wrong recorder", strength: "warm" });
      check("A connection cannot be recorded as someone else (recorded_by must be the session user)", !!foreignRecorderError);

      const { data: ownUpdate } = await clientA.from("network_connections").update({ notes: "[test] edited" }).eq("id", connA.id).select("id");
      check("Org A CAN edit its own connection (editable by design, ruling 0033 clause 2)", (ownUpdate?.length ?? 0) === 1);

      // Suggestions.
      const { data: sugA, error: sugAError } = await clientA
        .from("network_path_suggestions")
        .insert({
          prospect_id: prospectA.id,
          network_connection_id: connA.id,
          funder_claim_id: claimA.id,
          reasoning: "[test] Org A path",
          model_confidence: "low",
        })
        .select("id, status, decided_by, decided_at")
        .single();
      if (sugAError || !sugA) throw new Error(`Org A network suggestion insert failed: ${sugAError?.message}`);
      check("A new suggestion is born 'suggested' with no decider and no decision time", sugA.status === "suggested" && sugA.decided_by === null && sugA.decided_at === null);

      const { data: sbRead } = await clientB.from("network_path_suggestions").select("id").eq("id", sugA.id);
      check("Org B cannot SELECT Org A's network_path_suggestions row by id", (sbRead?.length ?? 0) === 0);
      const { data: sbUpdate } = await clientB.from("network_path_suggestions").update({ reasoning: "[test] hijacked" }).eq("id", sugA.id).select("id");
      check("Org B's UPDATE of Org A's suggestion affects 0 rows", (sbUpdate?.length ?? 0) === 0);
      const { data: sbDelete } = await clientB.from("network_path_suggestions").delete().eq("id", sugA.id).select("id");
      check("Org B's DELETE of Org A's suggestion affects 0 rows", (sbDelete?.length ?? 0) === 0);
      const { data: sugStill } = await admin.from("network_path_suggestions").select("reasoning").eq("id", sugA.id).single();
      check("...and Org A's suggestion is verified unchanged via the service role", sugStill?.reasoning === "[test] Org A path");

      // The three org-match triggers: each cross-org insert must be REFUSED.
      // Org B's session inserts under Org B's own organization_id (the default)
      // while citing one of Org A's rows; RLS alone would let that through
      // because the row's own organization_id is Org B's.
      const { error: xConnErr } = await clientB.from("network_path_suggestions").insert({
        prospect_id: prospectBEarly!.id,
        network_connection_id: connA.id,
        funder_claim_id: claimBEarly!.id,
        reasoning: "[test] cross-org connection",
      });
      check("Org B cannot INSERT a suggestion citing Org A's CONNECTION (connection org-match trigger)", !!xConnErr);
      const { error: xProspectErr } = await clientB.from("network_path_suggestions").insert({
        prospect_id: prospectA.id,
        network_connection_id: connB.id,
        funder_claim_id: claimBEarly!.id,
        reasoning: "[test] cross-org prospect",
      });
      check("Org B cannot INSERT a suggestion citing Org A's PROSPECT (prospect org-match trigger; the claim-prospect check also fires)", !!xProspectErr);
      const { error: xClaimErr } = await clientB.from("network_path_suggestions").insert({
        prospect_id: prospectBEarly!.id,
        network_connection_id: connB.id,
        funder_claim_id: claimA.id,
        reasoning: "[test] cross-org claim",
      });
      check("Org B cannot INSERT a suggestion citing Org A's CLAIM (claim org-match trigger)", !!xClaimErr);
      const { error: xOwnErr } = await clientB.from("network_path_suggestions").insert({
        prospect_id: prospectBEarly!.id,
        network_connection_id: connB.id,
        funder_claim_id: claimBEarly!.id,
        reasoning: "[test] control: all three references are Org B's own",
      });
      check("Control: Org B CAN insert a suggestion whose three references are all its own", !xOwnErr);

      // A claim from a different prospect of the SAME org is also refused.
      const { data: prospectA2 } = await clientA
        .from("prospects")
        .insert({ name: "[test] Org A second prospect", channel: "foundation", owner_id: a.userId })
        .select("id")
        .single();
      const { error: wrongProspectClaimErr } = await clientA.from("network_path_suggestions").insert({
        prospect_id: prospectA2!.id,
        network_connection_id: connA.id,
        funder_claim_id: claimA.id,
        reasoning: "[test] claim belongs to a different prospect",
      });
      check("A suggestion citing a claim that belongs to a DIFFERENT prospect is refused (claim-prospect check)", !!wrongProspectClaimErr);

      // Update-repoint: the extension beyond 0066's insert-only pattern.
      const { error: repointErr } = await clientA.from("network_path_suggestions").update({ network_connection_id: connB.id }).eq("id", sugA.id);
      check("Org A cannot UPDATE its suggestion to point at Org B's connection (update-time org-match trigger)", !!repointErr);
      const { data: sugAfterRepoint } = await admin.from("network_path_suggestions").select("network_connection_id").eq("id", sugA.id).single();
      check("...and the suggestion still points at Org A's own connection", sugAfterRepoint?.network_connection_id === connA.id);

      // Only a human's update decides; nothing is born decided.
      const { error: bornAcceptedErr } = await clientA.from("network_path_suggestions").insert({
        prospect_id: prospectA.id,
        network_connection_id: connA.id,
        funder_claim_id: claimA.id,
        reasoning: "[test] born accepted",
        status: "accepted",
        decided_by: a.userId,
        decided_at: new Date().toISOString(),
      });
      check("A suggestion cannot be INSERTED already accepted (insert policy admits only 'suggested')", !!bornAcceptedErr);
      const { error: undecidedAcceptErr } = await clientA.from("network_path_suggestions").update({ status: "accepted" }).eq("id", sugA.id);
      check("Accepting without a decider and time is refused (decision check constraint)", !!undecidedAcceptErr);
      const { data: decided } = await clientA
        .from("network_path_suggestions")
        .update({ status: "accepted", decided_by: a.userId, decided_at: new Date().toISOString() })
        .eq("id", sugA.id)
        .select("status");
      check("A human decision (status + decided_by + decided_at) is accepted", decided?.[0]?.status === "accepted");

      // Deleting a person deletes every path derived from them (clause 2).
      const { data: connToDelete } = await clientA
        .from("network_connections")
        .insert({ recorded_by: a.userId, person_name: "[test] to be erased", strength: "acquaintance" })
        .select("id")
        .single();
      const { data: sugToCascade } = await clientA
        .from("network_path_suggestions")
        .insert({ prospect_id: prospectA.id, network_connection_id: connToDelete!.id, funder_claim_id: claimA.id, reasoning: "[test] derived path" })
        .select("id")
        .single();
      const { data: deletedOwn } = await clientA.from("network_connections").delete().eq("id", connToDelete!.id).select("id");
      check("Org A CAN delete its own connection (deletable by design)", (deletedOwn?.length ?? 0) === 1);
      const { data: cascaded } = await admin.from("network_path_suggestions").select("id").eq("id", sugToCascade!.id);
      check("Deleting a connection deletes the suggestions derived from it (foreign key cascade)", (cascaded?.length ?? 0) === 0);

      // A suggestion does not outlive its anchoring claim.
      const { data: claimA2 } = await clientA
        .from("research_claims")
        .insert({ research_run_id: runA.id, prospect_id: prospectA.id, claim_type: "fact", claim_key: "people.key_contacts", category: "People", claim: "[test] Jane Test, Director", confidence: "high" })
        .select("id")
        .single();
      const { data: connForClaim } = await clientA
        .from("network_connections")
        .insert({ recorded_by: a.userId, person_name: "[test] claim-cascade person", strength: "close" })
        .select("id")
        .single();
      const { data: sugClaim } = await clientA
        .from("network_path_suggestions")
        .insert({ prospect_id: prospectA.id, network_connection_id: connForClaim!.id, funder_claim_id: claimA2!.id, reasoning: "[test] anchored path" })
        .select("id")
        .single();
      await admin.from("research_claims").delete().eq("id", claimA2!.id);
      const { data: claimCascaded } = await admin.from("network_path_suggestions").select("id").eq("id", sugClaim!.id);
      check("Deleting the anchoring claim deletes the suggestion (foreign key cascade)", (claimCascaded?.length ?? 0) === 0);
    }

    // --- Supporters (migration 0078, ruling 0034) ---
    // Three tables: supporters (team-scoped "for all", like prospects and
    // candidates), supporter_gifts (append-only -- insert and select ONLY,
    // no update, no delete, matching ruling 0019's posture), and
    // supporter_interactions (team-scoped "for all", like the existing
    // `interactions` table). Two real authenticated sessions, never the
    // service-role client, for every isolation assertion. Both org-match
    // triggers are exercised by cross-org INSERTs that must be REFUSED; the
    // supporter_interactions trigger ALSO covers UPDATE OF supporter_id
    // (0077's hardening), exercised by the repoint case below.
    // NOT-EVALUATED when the tables do not exist (42P01 / PGRST205).
    const { error: supportersProbeError } = await admin.from("supporters").select("id").limit(1);
    if (supportersProbeError && (supportersProbeError.code === "42P01" || supportersProbeError.code === "PGRST205")) {
      notEvaluated.push("supporters / supporter_gifts / supporter_interactions -- migration 0078 is not applied to this database, so their assertions did not run");
      console.log("\nNOT EVALUATED: supporter tables (migration 0078 not applied). Apply 0078 and re-run; this is not a pass.\n");
    } else {
      const { data: supporterA, error: supporterAError } = await clientA
        .from("supporters")
        .insert({ created_by: a.userId, name: "[test] Org A supporter", source_type: "event", pledged_amount: 25, pledged_frequency: "monthly" })
        .select("id")
        .single();
      if (supporterAError || !supporterA) throw new Error(`Org A supporter insert failed: ${supporterAError?.message}`);
      const { data: supporterB, error: supporterBError } = await clientB
        .from("supporters")
        .insert({ created_by: b.userId, name: "[test] Org B supporter", source_type: "website" })
        .select("id")
        .single();
      if (supporterBError || !supporterB) throw new Error(`Org B supporter insert failed: ${supporterBError?.message}`);

      const { data: supReadB } = await clientB.from("supporters").select("id").eq("id", supporterA.id);
      check("Org B cannot SELECT Org A's supporters row by id", (supReadB?.length ?? 0) === 0);
      const { data: supUpdateB } = await clientB.from("supporters").update({ name: "[test] hijacked" }).eq("id", supporterA.id).select("id");
      check("Org B's UPDATE of Org A's supporters row affects 0 rows", (supUpdateB?.length ?? 0) === 0);
      const { data: supDeleteB } = await clientB.from("supporters").delete().eq("id", supporterA.id).select("id");
      check("Org B's DELETE of Org A's supporters row affects 0 rows", (supDeleteB?.length ?? 0) === 0);
      const { data: supAfter } = await admin.from("supporters").select("name").eq("id", supporterA.id).single();
      check("...and Org A's supporter is verified unchanged via the service role", supAfter?.name === "[test] Org A supporter");

      const { error: noNameError } = await clientA.from("supporters").insert({ created_by: a.userId, source_type: "event" });
      check("A supporter with NO name is refused (not null)", !!noNameError);
      const { error: badSourceError } = await clientA.from("supporters").insert({ created_by: a.userId, name: "[test] bad source", source_type: "carrier-pigeon" });
      check("A supporter with a source_type outside the closed list is refused", !!badSourceError);
      const { error: badFrequencyError } = await clientA
        .from("supporters")
        .insert({ created_by: a.userId, name: "[test] bad frequency", source_type: "other", pledged_frequency: "weekly" });
      check("A supporter with a pledged_frequency outside the closed list is refused", !!badFrequencyError);

      const { data: supOwnUpdate } = await clientA.from("supporters").update({ notes: "[test] edited" }).eq("id", supporterA.id).select("id");
      check("Org A CAN edit its own supporter (team-scoped, like prospects/candidates)", (supOwnUpdate?.length ?? 0) === 1);

      // Gift history: append-only.
      const { data: giftA, error: giftAError } = await clientA
        .from("supporter_gifts")
        .insert({ supporter_id: supporterA.id, amount: 25, gift_date: "2026-09-01", recorded_by: a.userId })
        .select("id")
        .single();
      if (giftAError || !giftA) throw new Error(`Org A gift insert failed: ${giftAError?.message}`);

      const { data: giftReadB } = await clientB.from("supporter_gifts").select("id").eq("id", giftA.id);
      check("Org B cannot SELECT Org A's supporter_gifts row by id", (giftReadB?.length ?? 0) === 0);

      const { error: crossGiftError } = await clientB.from("supporter_gifts").insert({ supporter_id: supporterA.id, amount: 10, gift_date: "2026-09-02", recorded_by: b.userId });
      check("Org B cannot INSERT a supporter_gifts row against Org A's supporter (org-match trigger)", !!crossGiftError);

      const { error: zeroAmountError } = await clientA.from("supporter_gifts").insert({ supporter_id: supporterA.id, amount: 0, gift_date: "2026-09-01", recorded_by: a.userId });
      check("A gift of $0 is refused (amount > 0 check)", !!zeroAmountError);
      const { error: negativeAmountError } = await clientA.from("supporter_gifts").insert({ supporter_id: supporterA.id, amount: -5, gift_date: "2026-09-01", recorded_by: a.userId });
      check("A negative gift amount is refused (amount > 0 check)", !!negativeAmountError);
      const { error: impersonatedGiftError } = await clientA.from("supporter_gifts").insert({ supporter_id: supporterA.id, amount: 10, gift_date: "2026-09-01", recorded_by: b.userId });
      check("A gift cannot be recorded as someone else (recorded_by must be the session user)", !!impersonatedGiftError);

      const { data: giftOwnUpdate } = await clientA.from("supporter_gifts").update({ amount: 999 }).eq("id", giftA.id).select("id");
      check("supporter_gifts has no update policy -- even Org A's own UPDATE on its own row affects 0 rows", (giftOwnUpdate?.length ?? 0) === 0);
      const { data: giftOwnDelete } = await clientA.from("supporter_gifts").delete().eq("id", giftA.id).select("id");
      check("supporter_gifts has no delete policy -- even Org A's own DELETE on its own row affects 0 rows", (giftOwnDelete?.length ?? 0) === 0);

      // Supporter interactions: team-scoped "for all", like `interactions`.
      const { data: suppInteractionA, error: suppInteractionAError } = await clientA
        .from("supporter_interactions")
        .insert({ supporter_id: supporterA.id, kind: "call", summary: "[test] thanked them", created_by: a.userId })
        .select("id")
        .single();
      if (suppInteractionAError || !suppInteractionA) throw new Error(`Org A supporter interaction insert failed: ${suppInteractionAError?.message}`);

      const { data: interactionReadB } = await clientB.from("supporter_interactions").select("id").eq("id", suppInteractionA.id);
      check("Org B cannot SELECT Org A's supporter_interactions row by id", (interactionReadB?.length ?? 0) === 0);

      const { error: crossInteractionError } = await clientB
        .from("supporter_interactions")
        .insert({ supporter_id: supporterA.id, kind: "call", summary: "[test] cross-org attempt", created_by: b.userId });
      check("Org B cannot INSERT a supporter_interactions row against Org A's supporter (org-match trigger)", !!crossInteractionError);

      const { data: interactionOwnUpdate } = await clientA
        .from("supporter_interactions")
        .update({ summary: "[test] edited" })
        .eq("id", suppInteractionA.id)
        .select("id");
      check("Org A CAN edit its own supporter_interactions row (relationship memory, editable like `interactions`)", (interactionOwnUpdate?.length ?? 0) === 1);

      // Repoint: the org-match trigger covers UPDATE OF supporter_id too
      // (0077's hardening), since this table -- unlike supporter_gifts --
      // has an update policy and so has a path an insert-only trigger misses.
      const { error: repointError } = await clientA.from("supporter_interactions").update({ supporter_id: supporterB!.id }).eq("id", suppInteractionA.id);
      check("Org A cannot UPDATE its supporter_interactions row to point at Org B's supporter (update-time org-match trigger)", !!repointError);
      const { data: afterRepoint } = await admin.from("supporter_interactions").select("supporter_id").eq("id", suppInteractionA.id).single();
      check("...and the row still points at Org A's own supporter", afterRepoint?.supporter_id === supporterA.id);

      const { data: interactionOwnDelete } = await clientA.from("supporter_interactions").delete().eq("id", suppInteractionA.id).select("id");
      check("Org A CAN delete its own supporter_interactions row (editable/deletable like `interactions`)", (interactionOwnDelete?.length ?? 0) === 1);

      // Deleting a supporter cascades to its gifts and interactions.
      const { data: toDelete } = await clientA.from("supporters").insert({ created_by: a.userId, name: "[test] to be erased", source_type: "other" }).select("id").single();
      const { data: giftToCascade } = await clientA.from("supporter_gifts").insert({ supporter_id: toDelete!.id, amount: 5, gift_date: "2026-09-01", recorded_by: a.userId }).select("id").single();
      const { data: interactionToCascade } = await clientA
        .from("supporter_interactions")
        .insert({ supporter_id: toDelete!.id, kind: "note", summary: "[test] will be cascaded", created_by: a.userId })
        .select("id")
        .single();
      const { data: deletedSupporter } = await clientA.from("supporters").delete().eq("id", toDelete!.id).select("id");
      check("Org A CAN delete its own supporter", (deletedSupporter?.length ?? 0) === 1);
      const { data: giftCascaded } = await admin.from("supporter_gifts").select("id").eq("id", giftToCascade!.id);
      check("Deleting a supporter deletes its gift history (foreign key cascade)", (giftCascaded?.length ?? 0) === 0);
      const { data: interactionCascaded } = await admin.from("supporter_interactions").select("id").eq("id", interactionToCascade!.id);
      check("Deleting a supporter deletes its interaction history (foreign key cascade)", (interactionCascaded?.length ?? 0) === 0);
    }

    // --- Prospect gifts (migration 0079, ruling 0035) ---
    // The institutional-funder half of the same append-only gift ledger
    // ruling 0034 gave supporters (supporter_gifts, just above): insert and
    // select ONLY, no update, no delete, matching ruling 0019's retention
    // posture. Keyed to `prospects` directly rather than a separate parent
    // table, so prospectA/prospectB (created at the top of this run) are
    // reused here rather than seeding new rows. Both real authenticated
    // sessions, never the service-role client, for every isolation
    // assertion. NOT-EVALUATED when the table does not exist (42P01 /
    // PGRST205).
    const { error: prospectGiftsProbeError } = await admin.from("prospect_gifts").select("id").limit(1);
    if (prospectGiftsProbeError && (prospectGiftsProbeError.code === "42P01" || prospectGiftsProbeError.code === "PGRST205")) {
      notEvaluated.push("prospect_gifts -- migration 0079 is not applied to this database, so its assertions did not run");
      console.log("\nNOT EVALUATED: prospect_gifts (migration 0079 not applied). Apply 0079 and re-run; this is not a pass.\n");
    } else {
      const { data: prospectGiftA, error: prospectGiftAError } = await clientA
        .from("prospect_gifts")
        .insert({ prospect_id: prospectA.id, amount: 500, gift_date: "2026-09-01", recorded_by: a.userId })
        .select("id")
        .single();
      if (prospectGiftAError || !prospectGiftA) throw new Error(`Org A prospect gift insert failed: ${prospectGiftAError?.message}`);

      const { data: prospectGiftReadB } = await clientB.from("prospect_gifts").select("id").eq("id", prospectGiftA.id);
      check("Org B cannot SELECT Org A's prospect_gifts row by id", (prospectGiftReadB?.length ?? 0) === 0);

      const { error: crossProspectGiftError } = await clientB
        .from("prospect_gifts")
        .insert({ prospect_id: prospectA.id, amount: 10, gift_date: "2026-09-02", recorded_by: b.userId });
      check("Org B cannot INSERT a prospect_gifts row against Org A's prospect (org-match trigger)", !!crossProspectGiftError);

      const { error: zeroProspectGiftAmountError } = await clientA
        .from("prospect_gifts")
        .insert({ prospect_id: prospectA.id, amount: 0, gift_date: "2026-09-01", recorded_by: a.userId });
      check("A prospect gift of $0 is refused (amount > 0 check)", !!zeroProspectGiftAmountError);
      const { error: negativeProspectGiftAmountError } = await clientA
        .from("prospect_gifts")
        .insert({ prospect_id: prospectA.id, amount: -5, gift_date: "2026-09-01", recorded_by: a.userId });
      check("A negative prospect gift amount is refused (amount > 0 check)", !!negativeProspectGiftAmountError);
      const { error: impersonatedProspectGiftError } = await clientA
        .from("prospect_gifts")
        .insert({ prospect_id: prospectA.id, amount: 10, gift_date: "2026-09-01", recorded_by: b.userId });
      check("A prospect gift cannot be recorded as someone else (recorded_by must be the session user)", !!impersonatedProspectGiftError);

      const { data: prospectGiftOwnUpdate } = await clientA.from("prospect_gifts").update({ amount: 999 }).eq("id", prospectGiftA.id).select("id");
      check("prospect_gifts has no update policy -- even Org A's own UPDATE on its own row affects 0 rows", (prospectGiftOwnUpdate?.length ?? 0) === 0);
      const { data: prospectGiftOwnDelete } = await clientA.from("prospect_gifts").delete().eq("id", prospectGiftA.id).select("id");
      check("prospect_gifts has no delete policy -- even Org A's own DELETE on its own row affects 0 rows", (prospectGiftOwnDelete?.length ?? 0) === 0);

      // Cascade: deleting a prospect deletes its gift history. A dedicated
      // prospect, not prospectA itself -- prospectA is reused by other
      // sections above and below this one.
      const { data: prospectToDelete } = await clientA
        .from("prospects")
        .insert({ name: "[test] Org A prospect to be erased", channel: "foundation", owner_id: a.userId })
        .select("id")
        .single();
      const { data: prospectGiftToCascade } = await clientA
        .from("prospect_gifts")
        .insert({ prospect_id: prospectToDelete!.id, amount: 5, gift_date: "2026-09-01", recorded_by: a.userId })
        .select("id")
        .single();
      const { data: deletedProspectForGift } = await clientA.from("prospects").delete().eq("id", prospectToDelete!.id).select("id");
      check("Org A CAN delete its own prospect", (deletedProspectForGift?.length ?? 0) === 1);
      const { data: prospectGiftCascaded } = await admin.from("prospect_gifts").select("id").eq("id", prospectGiftToCascade!.id);
      check("Deleting a prospect deletes its gift history (foreign key cascade)", (prospectGiftCascaded?.length ?? 0) === 0);
    }

    // --- Assistant (migration 0080, ruling 0037) ---
    // Three tables, all scoped by organization AND author: a thread is
    // personal to the user the assistant acts as. No delete policy on any of
    // them. messages: insert + select + update-while-running, with a trigger
    // pinning the birth columns and permitting running -> terminal once.
    // proposals: insert (pending, unclaimed) + select + update-while-pending,
    // with a trigger pinning payload/action/subject/summary/expiry and
    // permitting only claim -> execute|fail, or dismiss, each once. Both
    // org-match triggers are exercised by cross-org and cross-author INSERTs
    // that must be REFUSED. Real authenticated sessions, never the service
    // role, for every isolation assertion; the service role is used only to
    // prove the triggers hold even for it. NOT-EVALUATED when the tables do
    // not exist (42P01 / PGRST205). WRITTEN, NOT EXECUTED by the build space:
    // it needs a live database with 0080 applied.
    const { error: assistantProbeError } = await admin.from("assistant_threads").select("id").limit(1);
    if (assistantProbeError && (assistantProbeError.code === "42P01" || assistantProbeError.code === "PGRST205")) {
      notEvaluated.push("assistant_threads / assistant_messages / assistant_proposals -- migration 0080 is not applied to this database, so their assertions did not run");
      console.log("\nNOT EVALUATED: assistant tables (migration 0080 not applied). Apply 0080 and re-run; this is not a pass.\n");
    } else {
      // The same-org teammate. Created here, not in setup, so a database
      // without 0080 never gains the extra identity.
      const { data: a2User, error: a2UserError } = await admin.auth.admin.createUser({ email: EMAIL_A2, email_confirm: true });
      if (a2UserError || !a2User.user) throw new Error(`Failed to create ${EMAIL_A2}: ${a2UserError?.message}`);
      const { error: a2ProfileError } = await admin
        .from("profiles")
        .insert({ id: a2User.user.id, organization_id: a.orgId, is_superadmin: false, email: EMAIL_A2 });
      if (a2ProfileError) throw new Error(`Failed to create profile for ${EMAIL_A2}: ${a2ProfileError.message}`);
      const clientA2 = await sessionClientFor(EMAIL_A2);

      const { data: threadA, error: threadAError } = await clientA.from("assistant_threads").insert({ title: "[test] Org A thread" }).select("id").single();
      if (threadAError || !threadA) throw new Error(`Org A thread insert failed: ${threadAError?.message}`);

      const { data: threadReadB } = await clientB.from("assistant_threads").select("id").eq("id", threadA.id);
      check("Org B cannot SELECT Org A's assistant_threads row by id", (threadReadB?.length ?? 0) === 0);
      const { data: threadReadA2 } = await clientA2.from("assistant_threads").select("id").eq("id", threadA.id);
      check("A teammate in the SAME org cannot SELECT Org A's user's thread (a thread is personal to its author)", (threadReadA2?.length ?? 0) === 0);
      const { data: threadOwnRead } = await clientA.from("assistant_threads").select("id").eq("id", threadA.id);
      check("The author CAN read their own thread", (threadOwnRead?.length ?? 0) === 1);
      const { data: threadUpdate } = await clientA.from("assistant_threads").update({ title: "[test] renamed" }).eq("id", threadA.id).select("id");
      check("assistant_threads has no update policy -- even the author's UPDATE affects 0 rows", (threadUpdate?.length ?? 0) === 0);
      const { data: threadDelete } = await clientA.from("assistant_threads").delete().eq("id", threadA.id).select("id");
      check("assistant_threads has no delete policy -- even the author's DELETE affects 0 rows", (threadDelete?.length ?? 0) === 0);

      // Messages.
      const { error: crossMessageError } = await clientB
        .from("assistant_messages")
        .insert({ thread_id: threadA.id, role: "user", status: "completed", content: "[test] cross-org", finalized_at: new Date().toISOString() });
      check("Org B cannot INSERT an assistant_messages row into Org A's thread (org-match trigger)", !!crossMessageError);
      const { error: crossAuthorError } = await clientA2
        .from("assistant_messages")
        .insert({ thread_id: threadA.id, role: "user", status: "completed", content: "[test] teammate", finalized_at: new Date().toISOString() });
      check("A same-org teammate cannot INSERT a message into another member's thread (author-match trigger)", !!crossAuthorError);

      const { data: userMsg, error: userMsgError } = await clientA
        .from("assistant_messages")
        .insert({ thread_id: threadA.id, role: "user", status: "completed", content: "[test] hello", finalized_at: new Date().toISOString() })
        .select("id")
        .single();
      check("The author CAN write a user message (born completed)", !userMsgError && !!userMsg);
      const { data: userMsgUpdate } = await clientA.from("assistant_messages").update({ content: "[test] edited" }).eq("id", userMsg!.id).select("id");
      check("A completed message cannot be updated by anyone (update policy reaches only running rows)", (userMsgUpdate?.length ?? 0) === 0);

      const { error: noProviderError } = await clientA
        .from("assistant_messages")
        .insert({ thread_id: threadA.id, role: "assistant", status: "running" });
      check("An assistant message that names no provider and model cannot be born (check constraint)", !!noProviderError);
      const { error: bornDoneError } = await clientA
        .from("assistant_messages")
        .insert({ thread_id: threadA.id, role: "assistant", status: "completed", provider: "meta-model-api", model: "m", finalized_at: new Date().toISOString() });
      check("An assistant message cannot be born already completed (insert policy admits running only)", !!bornDoneError);

      const newRunning = async () => {
        const { data, error } = await clientA
          .from("assistant_messages")
          .insert({ thread_id: threadA.id, role: "assistant", status: "running", provider: "meta-model-api", model: "muse-spark-1.1" })
          .select("id")
          .single();
        if (error || !data) throw new Error(`Org A running assistant message insert failed: ${error?.message}`);
        return data.id as string;
      };
      const runningA = await newRunning();
      const { data: msgReadB } = await clientB.from("assistant_messages").select("id").eq("id", runningA);
      check("Org B cannot SELECT Org A's assistant_messages row by id", (msgReadB?.length ?? 0) === 0);
      const { data: msgUpdateB } = await clientB.from("assistant_messages").update({ status: "failed", finalized_at: new Date().toISOString() }).eq("id", runningA).select("id");
      check("Org B's UPDATE of Org A's running message affects 0 rows", (msgUpdateB?.length ?? 0) === 0);

      const { error: pinError } = await clientA
        .from("assistant_messages")
        .update({ model: "something-else", status: "completed", finalized_at: new Date().toISOString() })
        .eq("id", runningA);
      check("A finalization cannot rewrite the model the turn was addressed to (birth columns pinned by trigger)", !!pinError);
      const { error: stayRunningError } = await clientA.from("assistant_messages").update({ content: "[test] still running" }).eq("id", runningA);
      check("An update that does not write a terminal status is refused (running -> terminal is the only transition)", !!stayRunningError);

      const { data: finalized, error: finalizeError } = await clientA
        .from("assistant_messages")
        .update({ status: "completed", content: "[test] answer", finalized_at: new Date().toISOString(), input_tokens: 10, output_tokens: 2 })
        .eq("id", runningA)
        .select("id");
      check("The author CAN finalize their running message once", !finalizeError && (finalized?.length ?? 0) === 1);
      const { data: refinalized } = await clientA.from("assistant_messages").update({ status: "failed", finalized_at: new Date().toISOString() }).eq("id", runningA).select("id");
      check("A finalized message cannot be finalized again through a session (policy)", (refinalized?.length ?? 0) === 0);
      const { error: adminRewriteError } = await admin.from("assistant_messages").update({ content: "[test] rewritten" }).eq("id", runningA);
      check("... nor by the service role (terminal-once trigger holds for every role)", !!adminRewriteError);
      const { data: msgDelete } = await clientA.from("assistant_messages").delete().eq("id", runningA).select("id");
      check("assistant_messages has no delete policy -- even the author's DELETE affects 0 rows", (msgDelete?.length ?? 0) === 0);

      // Proposals.
      const runningForProposals = await newRunning();
      const propBase = {
        thread_id: threadA.id,
        message_id: runningForProposals,
        action_key: "log_prospect_interaction",
        payload: { prospect_id: prospectA.id, subject_name: "[test]", kind: "call", summary: "[test]", occurred_at: "2026-09-01" },
        subject_table: "prospects",
        subject_id: prospectA.id,
        summary: "[test] Log a call",
      };
      const { data: propA, error: propAError } = await clientA.from("assistant_proposals").insert(propBase).select("id, status, expires_at, claimed_at").single();
      check("The author CAN record a pending proposal (defaults: pending, unclaimed, expires in the future)", !propAError && !!propA && propA.status === "pending" && propA.claimed_at === null && new Date(propA.expires_at as string).getTime() > Date.now());

      const { data: propReadB } = await clientB.from("assistant_proposals").select("id").eq("id", propA!.id);
      check("Org B cannot SELECT Org A's assistant_proposals row by id", (propReadB?.length ?? 0) === 0);
      const { data: propReadA2 } = await clientA2.from("assistant_proposals").select("id").eq("id", propA!.id);
      check("A same-org teammate cannot SELECT another member's proposal", (propReadA2?.length ?? 0) === 0);
      const { data: propUpdateB } = await clientB.from("assistant_proposals").update({ status: "dismissed", decided_at: new Date().toISOString() }).eq("id", propA!.id).select("id");
      check("Org B's UPDATE of Org A's proposal affects 0 rows", (propUpdateB?.length ?? 0) === 0);
      const { data: propUpdateA2 } = await clientA2.from("assistant_proposals").update({ claimed_at: new Date().toISOString() }).eq("id", propA!.id).select("id");
      check("A same-org teammate cannot claim another member's proposal (affects 0 rows)", (propUpdateA2?.length ?? 0) === 0);

      const { error: crossPropError } = await clientB.from("assistant_proposals").insert(propBase);
      check("Org B cannot INSERT a proposal against Org A's thread and message (org-match trigger)", !!crossPropError);
      const { error: bornExecutedError } = await clientA.from("assistant_proposals").insert({ ...propBase, status: "executed", decided_at: new Date().toISOString(), claimed_at: new Date().toISOString() });
      check("A proposal cannot be born already executed (insert policy admits pending and unclaimed only)", !!bornExecutedError);
      const { error: bornClaimedError } = await clientA.from("assistant_proposals").insert({ ...propBase, claimed_at: new Date().toISOString() });
      check("A proposal cannot be born already claimed", !!bornClaimedError);
      const { error: badActionError } = await clientA.from("assistant_proposals").insert({ ...propBase, action_key: "send_email" });
      check("An action outside the closed list cannot be stored (check constraint)", !!badActionError);
      const { error: badSubjectError } = await clientA.from("assistant_proposals").insert({ ...propBase, subject_table: "supporters" });
      check("An action and a subject table that do not belong together cannot be stored (check constraint)", !!badSubjectError);
      const { error: doneMessageError } = await clientA.from("assistant_proposals").insert({ ...propBase, message_id: runningA });
      check("A proposal cannot be attached to a message whose turn has finished (running-turn trigger)", !!doneMessageError);

      // What was proposed is fixed at birth.
      const { error: payloadError } = await clientA.from("assistant_proposals").update({ payload: { prospect_id: prospectA.id, kind: "note" } }).eq("id", propA!.id);
      check("A proposal's payload cannot be rewritten after birth (trigger)", !!payloadError);
      const { error: summaryError } = await clientA.from("assistant_proposals").update({ summary: "[test] a different summary" }).eq("id", propA!.id);
      check("A proposal's summary cannot be rewritten after birth (trigger)", !!summaryError);
      const { error: expiryError } = await clientA
        .from("assistant_proposals")
        .update({ expires_at: new Date(Date.now() + 7 * 86400000).toISOString() })
        .eq("id", propA!.id);
      check("A proposal's expiry cannot be extended after birth (trigger)", !!expiryError);
      const { error: executeUnclaimedError } = await clientA
        .from("assistant_proposals")
        .update({ status: "executed", decided_at: new Date().toISOString() })
        .eq("id", propA!.id);
      check("A proposal cannot be marked executed without its approval being claimed first (trigger + check)", !!executeUnclaimedError);
      const { error: expireEarlyError } = await clientA
        .from("assistant_proposals")
        .update({ status: "expired", decided_at: new Date().toISOString() })
        .eq("id", propA!.id);
      check("A proposal cannot be marked expired before its expiry (trigger)", !!expireEarlyError);

      // Claim, then decide -- each once.
      const { data: claimedRows, error: claimError } = await clientA
        .from("assistant_proposals")
        .update({ claimed_at: new Date().toISOString() })
        .eq("id", propA!.id)
        .eq("status", "pending")
        .is("claimed_at", null)
        .select("id");
      check("The author CAN claim a pending, unclaimed proposal's approval (exactly one row)", !claimError && (claimedRows?.length ?? 0) === 1);
      const { data: reclaimRows } = await clientA
        .from("assistant_proposals")
        .update({ claimed_at: new Date().toISOString() })
        .eq("id", propA!.id)
        .eq("status", "pending")
        .is("claimed_at", null)
        .select("id");
      check("A second claim of the same proposal wins nothing (the WHERE the approve action uses matches 0 rows)", (reclaimRows?.length ?? 0) === 0);
      const { error: dismissClaimedError } = await clientA
        .from("assistant_proposals")
        .update({ status: "dismissed", decided_at: new Date().toISOString() })
        .eq("id", propA!.id);
      check("A proposal whose approval has started cannot be dismissed (trigger + check)", !!dismissClaimedError);
      const { data: executedRows, error: executedError } = await clientA
        .from("assistant_proposals")
        .update({ status: "executed", decided_at: new Date().toISOString(), result: { entryPoint: "logInteraction" } })
        .eq("id", propA!.id)
        .eq("status", "pending")
        .select("id");
      check("The author CAN record a claimed proposal as executed, once", !executedError && (executedRows?.length ?? 0) === 1);
      const { data: againRows } = await clientA
        .from("assistant_proposals")
        .update({ status: "failed", decided_at: new Date().toISOString(), error_note: "[test]" })
        .eq("id", propA!.id)
        .eq("status", "pending")
        .select("id");
      check("An executed proposal cannot be decided again through a session (policy reaches pending only)", (againRows?.length ?? 0) === 0);
      const { error: adminDecidedError } = await admin.from("assistant_proposals").update({ status: "failed", error_note: "[test] rewritten" }).eq("id", propA!.id);
      check("... nor by the service role (decided-once trigger holds for every role)", !!adminDecidedError);

      // The dismiss path on a fresh proposal.
      const { data: propD } = await clientA.from("assistant_proposals").insert(propBase).select("id").single();
      const { data: dismissedRows, error: dismissError } = await clientA
        .from("assistant_proposals")
        .update({ status: "dismissed", decided_at: new Date().toISOString() })
        .eq("id", propD!.id)
        .eq("status", "pending")
        .is("claimed_at", null)
        .select("id");
      check("The author CAN dismiss an unclaimed pending proposal", !dismissError && (dismissedRows?.length ?? 0) === 1);
      const { error: executeDismissedError } = await admin
        .from("assistant_proposals")
        .update({ status: "executed", claimed_at: new Date().toISOString(), decided_at: new Date().toISOString() })
        .eq("id", propD!.id);
      check("A dismissed proposal can never be executed -- not even by the service role", !!executeDismissedError);
      const { data: propDelete } = await clientA.from("assistant_proposals").delete().eq("id", propA!.id).select("id");
      check("assistant_proposals has no delete policy -- even the author's DELETE affects 0 rows", (propDelete?.length ?? 0) === 0);

      // --- Assistant command record (migration 0081, ruling 0038) ---
      // An append-only event log: a `started` row born before a command's
      // effect, a terminal row (executed | failed) after, and a lone `refused`
      // row for a command stopped before its effect. Insert and select only,
      // both scoped by organization AND author; a trigger rejects every
      // update for every role; a second trigger checks the cross-table facts
      // (thread, user message and assistant turn in the same organization and
      // thread, the author owns the thread, a command is recorded only by a
      // RUNNING turn, a terminal row follows its own started row). NOT
      // EVALUATED when the table does not exist. WRITTEN, NOT EXECUTED by the
      // build space: it needs a live database with 0081 applied.
      const { error: commandProbeError } = await admin.from("assistant_command_events").select("id").limit(1);
      if (commandProbeError && (commandProbeError.code === "42P01" || commandProbeError.code === "PGRST205")) {
        notEvaluated.push("assistant_command_events -- migration 0081 is not applied to this database, so its assertions did not run");
        console.log("\nNOT EVALUATED: assistant_command_events (migration 0081 not applied). Apply 0081 and re-run; this is not a pass.\n");
      } else {
        const runningCmd = await newRunning();
        const base = (over: Record<string, unknown> = {}) => ({
          command_id: randomUUID(),
          event: "started",
          origin: "command",
          thread_id: threadA.id,
          user_message_id: userMsg!.id,
          assistant_message_id: runningCmd,
          ability: "set_prospect_ask_amount",
          subject_table: "prospects",
          subject_id: prospectA.id,
          payload: { prospect_id: prospectA.id, ask_amount: 1 },
          quote: "[test] set the ask to one dollar",
          previous: { ask_amount: null },
          ...over,
        });

        const started = base();
        const { data: startedRow, error: startedError } = await clientA.from("assistant_command_events").insert(started).select("id, organization_id, created_by").single();
        check("The author CAN record a `started` command row (organization and author defaulted from the session)", !startedError && !!startedRow);

        const { data: readB } = await clientB.from("assistant_command_events").select("id").eq("id", startedRow!.id);
        check("Org B cannot SELECT Org A's command record by id", (readB?.length ?? 0) === 0);
        const { data: readA2 } = await clientA2.from("assistant_command_events").select("id").eq("id", startedRow!.id);
        check("A same-org teammate cannot SELECT another member's command record (personal, like the thread)", (readA2?.length ?? 0) === 0);
        const { data: readOwn } = await clientA.from("assistant_command_events").select("id").eq("id", startedRow!.id);
        check("The author CAN read their own command record", (readOwn?.length ?? 0) === 1);

        const { error: crossOrgError } = await clientB.from("assistant_command_events").insert(base());
        check("Org B cannot INSERT a command row against Org A's thread and messages (org-match trigger)", !!crossOrgError);
        const { error: crossAuthorError } = await clientA2.from("assistant_command_events").insert(base());
        check("A same-org teammate cannot INSERT a command row into another member's thread (author-match trigger)", !!crossAuthorError);

        // Append-only.
        const { data: updRows } = await clientA.from("assistant_command_events").update({ quote: "[test] rewritten" }).eq("id", startedRow!.id).select("id");
        check("assistant_command_events has no update policy -- even the author's UPDATE affects 0 rows", (updRows?.length ?? 0) === 0);
        const { error: adminUpdateError } = await admin.from("assistant_command_events").update({ quote: "[test] rewritten" }).eq("id", startedRow!.id);
        check("... and the service role's UPDATE is rejected by the append-only trigger", !!adminUpdateError);
        const { data: delRows } = await clientA.from("assistant_command_events").delete().eq("id", startedRow!.id).select("id");
        check("assistant_command_events has no delete policy -- even the author's DELETE affects 0 rows", (delRows?.length ?? 0) === 0);

        // The started/terminal pairing.
        const terminal = (over: Record<string, unknown> = {}) => ({
          ...started,
          event: "executed",
          previous: null,
          result: { prospectId: prospectA.id },
          ...over,
        });
        const { error: executedError } = await clientA.from("assistant_command_events").insert(terminal());
        check("A terminal `executed` row CAN follow its own started row", !executedError);
        const { error: secondTerminalError } = await clientA.from("assistant_command_events").insert(terminal({ event: "failed", result: null, error_note: "[test]" }));
        check("A second terminal row for the same command is refused (one outcome per command)", !!secondTerminalError);
        const { error: secondStartError } = await clientA.from("assistant_command_events").insert(started);
        check("A second `started` row for the same command is refused", !!secondStartError);

        const orphan = base();
        const { error: orphanError } = await clientA.from("assistant_command_events").insert({ ...orphan, event: "executed", previous: null, result: { x: 1 } });
        check("An `executed` row with no started row is refused (trigger)", !!orphanError);
        const { error: refusedAloneError } = await clientA
          .from("assistant_command_events")
          .insert({ ...base(), event: "refused", previous: null, result: { code: "quote_not_found" }, error_note: "[test] the quoted words are not in the message" });
        check("A command refused before its effect is ONE `refused` row, with no started row", !refusedAloneError);

        const mismatch = base();
        await clientA.from("assistant_command_events").insert(mismatch);
        const { error: mismatchError } = await clientA
          .from("assistant_command_events")
          .insert({ ...mismatch, event: "executed", ability: "add_prospect", previous: null, result: { x: 1 } });
        check("A terminal row that names a different ability than its started row is refused (trigger)", !!mismatchError);

        // Shape and vocabulary.
        const { error: badAbilityError } = await clientA.from("assistant_command_events").insert(base({ ability: "send_email" }));
        check("An ability outside the closed list cannot be stored (check constraint)", !!badAbilityError);
        const { error: noQuoteError } = await clientA.from("assistant_command_events").insert(base({ quote: null }));
        check("A command row with no quotation cannot be stored (check constraint)", !!noQuoteError);
        const { error: startedWithResultError } = await clientA.from("assistant_command_events").insert(base({ result: { done: true } }));
        check("A `started` row that already carries an outcome cannot be stored (check constraint)", !!startedWithResultError);
        const { error: failedNoNoteError } = await clientA.from("assistant_command_events").insert(base({ event: "failed", previous: null }));
        check("A `failed` row with no reason cannot be stored (check constraint)", !!failedNoNoteError);
        const { error: clickNoRestoresError } = await clientA
          .from("assistant_command_events")
          .insert(base({ origin: "click", quote: null, ability: "restore_draft_text", subject_table: "drafts", subject_id: randomUUID() }));
        check("A click-driven row that names no command it restores cannot be stored (check constraint)", !!clickNoRestoresError);

        // A command is recorded only by a RUNNING turn.
        const { error: finishedTurnError } = await clientA.from("assistant_command_events").insert(base({ assistant_message_id: runningA }));
        check("A command cannot be recorded against an assistant turn that has finished (running-turn trigger)", !!finishedTurnError);
        // The user message must be a user message.
        const { error: wrongRoleError } = await clientA.from("assistant_command_events").insert(base({ user_message_id: runningCmd }));
        check("The authorizing message must be a USER message (trigger)", !!wrongRoleError);
      }

      // --- External agent delegation (migration 0082, ruling 0039) ---
      // Three tables (agent_tokens, agent_call_log, agent_approval_requests)
      // and one function callable without a session (verify_agent_token). All
      // three tables are scoped by organization AND user; none has a delete
      // policy; the call log is append-only for every role; a signed-in user
      // may update only revoked_at on a token and only used_at on a request.
      // Real authenticated sessions for every isolation assertion; the
      // service role only to prove the triggers hold even for it, and the
      // anon key for the function. NOT EVALUATED when the tables do not exist.
      // WRITTEN, NOT EXECUTED by the build space: it needs a live database
      // with 0082 applied (and 0080, for the same-org teammate above).
      const { error: agentProbeError } = await admin.from("agent_tokens").select("id").limit(1);
      if (agentProbeError && (agentProbeError.code === "42P01" || agentProbeError.code === "PGRST205")) {
        notEvaluated.push("agent_tokens / agent_call_log / agent_approval_requests / verify_agent_token -- migration 0082 is not applied to this database, so their assertions did not run");
        console.log("\nNOT EVALUATED: agent delegation tables (migration 0082 not applied). Apply 0082 and re-run; this is not a pass.\n");
      } else {
        const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
        const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
        const tokenRow = (over: Record<string, unknown> = {}) => ({
          name: "[test] token",
          token_hash: sha(randomUUID()),
          token_prefix: "fai_test",
          scope: "act",
          expires_at: inDays(30),
          ...over,
        });

        // tokens: isolation
        const liveSecret = `fai_${randomUUID()}`;
        const { data: tokA, error: tokAError } = await clientA.from("agent_tokens").insert(tokenRow({ token_hash: sha(liveSecret) })).select("id, organization_id, user_id, revoked_at").single();
        check("A user CAN create their own agent token (organization and user defaulted from the session)", !tokAError && tokA?.organization_id === a.orgId && tokA?.user_id === a.userId && tokA?.revoked_at === null);
        const { data: tokReadB } = await clientB.from("agent_tokens").select("id").eq("id", tokA!.id);
        check("Org B cannot SELECT Org A's agent token by id", (tokReadB?.length ?? 0) === 0);
        const { data: tokReadA2 } = await clientA2.from("agent_tokens").select("id").eq("id", tokA!.id);
        check("A same-org teammate cannot SELECT another member's agent token (personal)", (tokReadA2?.length ?? 0) === 0);
        const { data: tokOwn } = await clientA.from("agent_tokens").select("id").eq("id", tokA!.id);
        check("The owner CAN read their own agent token", (tokOwn?.length ?? 0) === 1);
        const { error: tokForgeUser } = await clientA2.from("agent_tokens").insert(tokenRow({ user_id: a.userId }));
        check("A teammate cannot INSERT a token in another member's name (RLS: user_id = auth.uid())", !!tokForgeUser);
        const { error: tokForgeOrg } = await clientB.from("agent_tokens").insert(tokenRow({ organization_id: a.orgId }));
        check("Org B cannot INSERT a token into Org A (RLS: organization_id = my_organization_id())", !!tokForgeOrg);
        // tokens: birth shape
        const bornBad: [string, Record<string, unknown>][] = [
          ["already revoked", { revoked_at: new Date().toISOString() }],
          ["already used", { last_used_at: new Date().toISOString() }],
          ["already expired", { expires_at: inDays(-1) }],
          ["expiring in over a year", { expires_at: inDays(400) }],
          ["of scope 'admin'", { scope: "admin" }],
          ["with a hash that is not 64 hex characters", { token_hash: "not-a-hash" }],
          ["with a blank name", { name: "   " }],
        ];
        for (const [label, over] of bornBad) {
          const { error } = await clientA.from("agent_tokens").insert(tokenRow(over));
          check(`A token ${label} cannot be created`, !!error);
        }
        // tokens: only revoked_at changes, once, by its owner
        for (const [label, patch] of [["name", { name: "[test] renamed" }], ["scope", { scope: "read" }], ["expiry", { expires_at: inDays(300) }], ["hash", { token_hash: sha("x") }], ["last_used_at", { last_used_at: new Date().toISOString() }]] as [string, Record<string, unknown>][]) {
          const { data, error } = await clientA.from("agent_tokens").update(patch).eq("id", tokA!.id).select("id");
          check(`The owner cannot change a token's ${label} (column grant / trigger)`, !!error || (data?.length ?? 0) === 0);
        }
        const { error: adminHashError } = await admin.from("agent_tokens").update({ token_hash: sha("y") }).eq("id", tokA!.id);
        check("... and not even the service role can change a token's hash (trigger)", !!adminHashError);
        const { data: revokeB } = await clientB.from("agent_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", tokA!.id).select("id");
        const { data: revokeA2 } = await clientA2.from("agent_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", tokA!.id).select("id");
        check("Neither Org B nor a same-org teammate can revoke another user's token (0 rows)", (revokeB?.length ?? 0) === 0 && (revokeA2?.length ?? 0) === 0);
        const { data: tokDelete } = await clientA.from("agent_tokens").delete().eq("id", tokA!.id).select("id");
        check("agent_tokens has no delete policy -- even the owner's DELETE affects 0 rows", (tokDelete?.length ?? 0) === 0);

        // verify_agent_token: callable without a session
        const anon = createClient(supabaseUrl!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data: okRows, error: okError } = await anon.rpc("verify_agent_token", { p_hash: sha(liveSecret) });
        check("verify_agent_token returns the owner, organization and scope for a live token -- with NO session (anon key)", !okError && Array.isArray(okRows) && okRows.length === 1 && okRows[0].user_id === a.userId && okRows[0].organization_id === a.orgId && okRows[0].scope === "act" && okRows[0].token_id === tokA!.id);
        const { data: stamped } = await admin.from("agent_tokens").select("last_used_at").eq("id", tokA!.id).single();
        check("... and it stamps last_used_at", !!stamped?.last_used_at);
        const { data: missRows, error: missError } = await anon.rpc("verify_agent_token", { p_hash: sha(randomUUID()) });
        check("verify_agent_token returns NO row for an unknown hash (and no error that says why)", !missError && Array.isArray(missRows) && missRows.length === 0);
        const { data: anonSelect } = await anon.from("agent_tokens").select("id").limit(5);
        check("the anon role cannot read agent_tokens directly", (anonSelect?.length ?? 0) === 0);
        const { data: anonLog } = await anon.from("agent_call_log").select("id").limit(5);
        check("the anon role cannot read agent_call_log or agent_approval_requests", (anonLog?.length ?? 0) === 0 && ((await anon.from("agent_approval_requests").select("id").limit(5)).data?.length ?? 0) === 0);

        // a read token, a second act token, an about-to-expire token
        const readSecret = `fai_${randomUUID()}`;
        const { data: tokRead } = await clientA.from("agent_tokens").insert(tokenRow({ scope: "read", token_hash: sha(readSecret) })).select("id").single();
        const shortSecret = `fai_${randomUUID()}`;
        const { data: tokShort } = await clientA.from("agent_tokens").insert(tokenRow({ token_hash: sha(shortSecret), expires_at: new Date(Date.now() + 2500).toISOString() })).select("id").single();
        const revokedSecret = `fai_${randomUUID()}`;
        const { data: tokRevoked } = await clientA.from("agent_tokens").insert(tokenRow({ token_hash: sha(revokedSecret) })).select("id").single();
        const { data: revokedRows, error: revokeError } = await clientA.from("agent_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", tokRevoked!.id).select("id");
        check("The owner CAN revoke their own token (revoked_at only)", !revokeError && (revokedRows?.length ?? 0) === 1);
        const { data: unrevoke, error: unrevokeError } = await clientA.from("agent_tokens").update({ revoked_at: null }).eq("id", tokRevoked!.id).select("id");
        check("A revoked token cannot be un-revoked (trigger)", !!unrevokeError || (unrevoke?.length ?? 0) === 0);
        const { data: revokedVerify } = await anon.rpc("verify_agent_token", { p_hash: sha(revokedSecret) });
        check("verify_agent_token returns no row for a REVOKED token -- revocation bites on the very next call", Array.isArray(revokedVerify) && revokedVerify.length === 0);
        const { data: readVerify } = await anon.rpc("verify_agent_token", { p_hash: sha(readSecret) });
        check("verify_agent_token reports a read token's scope as read", Array.isArray(readVerify) && readVerify[0]?.scope === "read");

        // call log
        const callBase = (over: Record<string, unknown> = {}) => ({
          call_id: randomUUID(), token_id: tokA!.id, event: "started", origin: "agent", access: "write", tool: "set_prospect_ask_amount",
          arguments: { prospect_id: prospectA.id, ask_amount: 1 }, agent_statement: "[test] the agent says the owner asked", subject_table: "prospects", subject_id: prospectA.id, previous: { ask_amount: null }, ...over,
        });
        const callStarted = callBase();
        const { data: logRow, error: logError } = await clientA.from("agent_call_log").insert(callStarted).select("id, organization_id, user_id").single();
        check("The owner's session CAN record a `started` agent write (organization and user defaulted)", !logError && logRow?.organization_id === a.orgId && logRow?.user_id === a.userId);
        const { data: logReadB } = await clientB.from("agent_call_log").select("id").eq("id", logRow!.id);
        const { data: logReadA2 } = await clientA2.from("agent_call_log").select("id").eq("id", logRow!.id);
        check("Neither Org B nor a same-org teammate can SELECT another user's call record", (logReadB?.length ?? 0) === 0 && (logReadA2?.length ?? 0) === 0);
        const { error: logCrossOrg } = await clientB.from("agent_call_log").insert(callBase());
        const { error: logCrossUser } = await clientA2.from("agent_call_log").insert(callBase());
        check("Org B / a teammate cannot INSERT a call row that names Org A's / another user's token (RLS + match trigger)", !!logCrossOrg && !!logCrossUser);
        const { data: logUpd } = await clientA.from("agent_call_log").update({ error_note: "[test]" }).eq("id", logRow!.id).select("id");
        const { error: logAdminUpd } = await admin.from("agent_call_log").update({ error_note: "[test]" }).eq("id", logRow!.id);
        check("agent_call_log is append-only: the owner's UPDATE affects 0 rows and the service role's is rejected by the trigger", (logUpd?.length ?? 0) === 0 && !!logAdminUpd);
        const { data: logDel } = await clientA.from("agent_call_log").delete().eq("id", logRow!.id).select("id");
        check("agent_call_log has no delete policy -- even the owner's DELETE affects 0 rows", (logDel?.length ?? 0) === 0);
        const terminalOf = (over: Record<string, unknown> = {}) => ({ ...callStarted, event: "executed", previous: null, result: { summary: "[test]" }, duration_ms: 12, ...over });
        const { error: termError } = await clientA.from("agent_call_log").insert(terminalOf());
        check("A terminal `executed` row CAN follow its own started row (with a duration)", !termError);
        const { error: term2 } = await clientA.from("agent_call_log").insert(terminalOf({ event: "failed", result: null, error_note: "[test]" }));
        const { error: start2 } = await clientA.from("agent_call_log").insert(callStarted);
        check("A second terminal row, or a second `started` row, for the same call is refused", !!term2 && !!start2);
        const { error: orphan } = await clientA.from("agent_call_log").insert(callBase({ event: "executed", previous: null, result: { x: 1 } }));
        check("An `executed` write with no started row is refused (trigger)", !!orphan);
        const { error: refusedAlone } = await clientA.from("agent_call_log").insert(callBase({ event: "refused", previous: null, result: { code: "scope" }, error_note: "[test] refused" }));
        check("A write refused before its effect is ONE `refused` row with no started row", !refusedAlone);
        const { error: readOne } = await clientA.from("agent_call_log").insert(callBase({ access: "read", tool: "whoami", event: "executed", previous: null, result: { bytes: 5 }, subject_table: null, subject_id: null, arguments: {} }));
        check("A read is ONE terminal row", !readOne);
        const { error: readStarted } = await clientA.from("agent_call_log").insert(callBase({ access: "read", tool: "whoami", subject_table: null, subject_id: null, previous: null, arguments: {} }));
        check("A read cannot be `started` (check constraint)", !!readStarted);
        const { error: readTokenWrite } = await clientA.from("agent_call_log").insert(callBase({ token_id: tokRead!.id }));
        check("A READ-scope token cannot start a write -- the database refuses it, whatever the application does", !!readTokenWrite);
        const { error: revokedTokenWrite } = await clientA.from("agent_call_log").insert(callBase({ token_id: tokRevoked!.id }));
        check("A REVOKED token cannot start a write", !!revokedTokenWrite);
        const { error: agentApprove } = await clientA.from("agent_call_log").insert(callBase({ tool: "approve_strategy", subject_table: "strategy_runs" }));
        check("An agent-origin row can never be an approval (check constraint) -- a gate is not decided on an agent's call", !!agentApprove);
        const { error: clickApprove } = await clientA.from("agent_call_log").insert(callBase({ origin: "user_click", tool: "approve_strategy", subject_table: "strategy_runs", agent_statement: null }));
        check("A user's click CAN be recorded as an approval (the record of the owner's decision)", !clickApprove);
        const { error: badTool } = await clientA.from("agent_call_log").insert(callBase({ tool: "send_email" }));
        check("A tool outside the closed list cannot be stored (check constraint)", !!badTool);
        const { error: clickRestoreNoRef } = await clientA.from("agent_call_log").insert(callBase({ origin: "user_click", tool: "restore_draft_text", agent_statement: null }));
        check("A restore that names no call it restores cannot be stored (check constraint)", !!clickRestoreNoRef);

        // approval requests
        const reqBase = (over: Record<string, unknown> = {}) => ({
          token_id: tokA!.id, kind: "strategy", subject_id: randomUUID(), prospect_id: prospectA.id, fingerprint: sha("content"), summary: "[test] approve a strategy", expires_at: inDays(0.0104), ...over,
        });
        const { data: req, error: reqError } = await clientA.from("agent_approval_requests").insert(reqBase()).select("id, organization_id, user_id, used_at").single();
        check("The owner's session CAN create an approval request from an act token (organization and user defaulted, unused)", !reqError && req?.organization_id === a.orgId && req?.user_id === a.userId && req?.used_at === null);
        const { data: reqReadB } = await clientB.from("agent_approval_requests").select("id").eq("id", req!.id);
        const { data: reqReadA2 } = await clientA2.from("agent_approval_requests").select("id").eq("id", req!.id);
        check("Neither Org B nor a same-org teammate can SELECT another user's approval request", (reqReadB?.length ?? 0) === 0 && (reqReadA2?.length ?? 0) === 0);
        const { data: reqUseB } = await clientB.from("agent_approval_requests").update({ used_at: new Date().toISOString() }).eq("id", req!.id).select("id");
        const { data: reqUseA2 } = await clientA2.from("agent_approval_requests").update({ used_at: new Date().toISOString() }).eq("id", req!.id).select("id");
        check("... and cannot consume it (0 rows)", (reqUseB?.length ?? 0) === 0 && (reqUseA2?.length ?? 0) === 0);
        const { error: reqRead } = await clientA.from("agent_approval_requests").insert(reqBase({ token_id: tokRead!.id }));
        check("A READ-scope token cannot be the source of an approval request (trigger)", !!reqRead);
        const { error: reqRevoked } = await clientA.from("agent_approval_requests").insert(reqBase({ token_id: tokRevoked!.id }));
        check("A revoked token cannot ask for an approval link", !!reqRevoked);
        const { error: reqLong } = await clientA.from("agent_approval_requests").insert(reqBase({ expires_at: inDays(2) }));
        const { error: reqPast } = await clientA.from("agent_approval_requests").insert(reqBase({ expires_at: inDays(-1) }));
        check("An approval request cannot outlive the hour or be born expired", !!reqLong && !!reqPast);
        const { error: reqUsedBorn } = await clientA.from("agent_approval_requests").insert(reqBase({ used_at: new Date().toISOString() }));
        check("An approval request cannot be born used", !!reqUsedBorn);
        const { error: reqBadFp } = await clientA.from("agent_approval_requests").insert(reqBase({ fingerprint: "nope" }));
        const { error: reqBadKind } = await clientA.from("agent_approval_requests").insert(reqBase({ kind: "claim" }));
        check("A bad fingerprint or a kind other than strategy|draft cannot be stored", !!reqBadFp && !!reqBadKind);
        const { data: reqEdit, error: reqEditError } = await clientA.from("agent_approval_requests").update({ fingerprint: sha("other") }).eq("id", req!.id).select("id");
        check("The owner cannot change what a request is bound to (column grant / trigger)", !!reqEditError || (reqEdit?.length ?? 0) === 0);
        const { error: reqAdminEdit } = await admin.from("agent_approval_requests").update({ fingerprint: sha("other") }).eq("id", req!.id);
        check("... not even the service role (trigger)", !!reqAdminEdit);
        const { data: reqUsed, error: reqUsedError } = await clientA.from("agent_approval_requests").update({ used_at: new Date().toISOString() }).eq("id", req!.id).is("used_at", null).select("id");
        check("The owner CAN consume their request once (the atomic conditional update)", !reqUsedError && (reqUsed?.length ?? 0) === 1);
        const { data: reqUsedAgain, error: reqUsedAgainError } = await clientA.from("agent_approval_requests").update({ used_at: new Date().toISOString() }).eq("id", req!.id).is("used_at", null).select("id");
        check("A second consume updates 0 rows -- single use, enforced in the database", !reqUsedAgainError && (reqUsedAgain?.length ?? 0) === 0);
        const { error: reqUnuse } = await admin.from("agent_approval_requests").update({ used_at: null }).eq("id", req!.id);
        check("A used request can never be made unused again (trigger, even for the service role)", !!reqUnuse);
        const { data: reqDel } = await clientA.from("agent_approval_requests").delete().eq("id", req!.id).select("id");
        check("agent_approval_requests has no delete policy -- even the owner's DELETE affects 0 rows", (reqDel?.length ?? 0) === 0);

        // time: an expired token and an expired request (a short real wait)
        const { data: shortReq } = await clientA.from("agent_approval_requests").insert(reqBase({ expires_at: new Date(Date.now() + 2500).toISOString() })).select("id").single();
        await new Promise((r) => setTimeout(r, 3200));
        const { data: expiredVerify } = await anon.rpc("verify_agent_token", { p_hash: sha(shortSecret) });
        check("verify_agent_token returns no row once the token has EXPIRED", Array.isArray(expiredVerify) && expiredVerify.length === 0 && !!tokShort);
        const { error: expiredUse } = await clientA.from("agent_approval_requests").update({ used_at: new Date().toISOString() }).eq("id", shortReq!.id);
        check("An expired approval request cannot be consumed (trigger)", !!expiredUse);
      }
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
