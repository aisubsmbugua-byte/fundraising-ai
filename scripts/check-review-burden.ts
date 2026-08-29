// What a person is actually being asked to decide, and why.
//
// The Research tab shows one "needs a decision" pile. That pile has two
// completely different populations in it, and the UI cannot tell them apart:
//
//   1. Claims we never checked, BY DESIGN -- verifyRunClaims only verifies
//      the 21 material claim keys, so a funder-type or key-contact claim can
//      never carry a verdict no matter how good its evidence is. It lands in
//      the pile because it is unverified, not because it is doubtful.
//   2. Claims we DID check and the evidence did not fully support.
//
// Only the second group is a research quality signal. Conflating them
// inflates the apparent review burden and, worse, trains a reviewer to click
// through a queue where most items carry no information. This script
// measures the split so the question "where should the human gate sit" is
// answered from data rather than from the size of the pile.
//
// Runs across every prospect with finished research by default, because one
// funder is an anecdote.
//
// Usage: npx tsx --env-file=.env.local scripts/check-review-burden.ts ["prospect name"]

import { createClient } from "@supabase/supabase-js";
import { isMaterialClaimKey } from "../lib/research";
import { APPROVED_FOR_DOWNSTREAM } from "../lib/research";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Why a claim is sitting in the review queue. The first is the one the
// product treats as a finding and this script exists to separate out.
type Cause =
  | "never_checked_by_design" // non-material key -- verification does not cover it
  | "never_checked_unexpected" // material but no verdict -- verification skipped or failed
  | "checked_partial"
  | "checked_unsupported"
  | "checked_contradicted";

const CAUSE_LABEL: Record<Cause, string> = {
  never_checked_by_design: "never checked (non-material key -- by design)",
  never_checked_unexpected: "never checked (material key -- verification skipped/failed)",
  checked_partial: "checked: partially supported",
  checked_unsupported: "checked: unsupported",
  checked_contradicted: "checked: contradicted",
};

type RunReport = {
  prospect: string;
  version: number;
  total: number;
  material: number;
  decided: number;
  supportedUndecided: number; // the bulk-approvable ones, not exceptions
  causes: Record<Cause, number>;
};

async function reportRun(runId: string, prospectName: string, version: number): Promise<RunReport> {
  const [{ data: claims }, { data: verifications }, { data: approvals }] = await Promise.all([
    admin.from("research_claims").select("id, claim_key").eq("research_run_id", runId),
    admin
      .from("research_claim_verifications")
      .select("claim_id, verdict, created_at")
      .eq("research_run_id", runId)
      .order("created_at", { ascending: false }),
    admin.from("research_claim_approvals").select("claim_id, decision, created_at").eq("research_run_id", runId).order("created_at", { ascending: false }),
  ]);

  // Latest per claim, matching how the UI reads both tables.
  const verdict = new Map<string, string>();
  for (const v of verifications ?? []) if (!verdict.has(v.claim_id as string)) verdict.set(v.claim_id as string, v.verdict as string);
  const decision = new Map<string, string>();
  for (const a of approvals ?? []) if (!decision.has(a.claim_id as string)) decision.set(a.claim_id as string, a.decision as string);

  const causes: Record<Cause, number> = {
    never_checked_by_design: 0,
    never_checked_unexpected: 0,
    checked_partial: 0,
    checked_unsupported: 0,
    checked_contradicted: 0,
  };
  let decided = 0;
  let supportedUndecided = 0;
  let material = 0;

  for (const c of claims ?? []) {
    const isMaterial = isMaterialClaimKey(c.claim_key as string);
    if (isMaterial) material++;

    if (decision.has(c.id as string)) {
      decided++;
      continue;
    }

    const v = verdict.get(c.id as string);
    if (v === "supported") {
      supportedUndecided++;
      continue;
    }
    if (!v) {
      causes[isMaterial ? "never_checked_unexpected" : "never_checked_by_design"]++;
    } else if (v === "partially_supported") {
      causes.checked_partial++;
    } else if (v === "contradicted") {
      causes.checked_contradicted++;
    } else {
      causes.checked_unsupported++;
    }
  }

  return { prospect: prospectName, version, total: (claims ?? []).length, material, decided, supportedUndecided, causes };
}

function queueSize(r: RunReport) {
  return Object.values(r.causes).reduce((a, b) => a + b, 0);
}

async function main() {
  const nameQuery = process.argv[2];

  let query = admin
    .from("research_runs")
    .select("id, version, status, prospect_id, prospects(name)")
    .eq("status", "ready")
    .order("version", { ascending: false });
  const { data: runs } = await query;
  if (!runs?.length) throw new Error("No completed research runs found.");

  // Latest ready run per prospect only -- older versions are superseded and
  // counting them would double-count the same funder's review burden.
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latest.has(r.prospect_id as string)) latest.set(r.prospect_id as string, r);

  let selected = [...latest.values()];
  if (nameQuery) {
    selected = selected.filter((r) => {
      const p = (Array.isArray(r.prospects) ? r.prospects[0] : r.prospects) as { name: string } | undefined;
      return p?.name.toLowerCase().includes(nameQuery.toLowerCase());
    });
    if (!selected.length) throw new Error(`No completed research run for a prospect matching "${nameQuery}".`);
  }

  const reports: RunReport[] = [];
  for (const r of selected) {
    const p = (Array.isArray(r.prospects) ? r.prospects[0] : r.prospects) as { name: string } | undefined;
    reports.push(await reportRun(r.id as string, p?.name ?? "(unknown)", r.version as number));
  }

  for (const rep of reports) {
    console.log(`\n${rep.prospect} — v${rep.version}`);
    console.log(`  ${rep.total} claims (${rep.material} material, ${rep.total - rep.material} not)`);
    console.log(`  already decided: ${rep.decided}`);
    console.log(`  verified and awaiting bulk approval: ${rep.supportedUndecided}`);
    console.log(`  needing an individual decision: ${queueSize(rep)}`);
    for (const [cause, n] of Object.entries(rep.causes)) {
      if (n > 0) console.log(`      ${n}  ${CAUSE_LABEL[cause as Cause]}`);
    }
  }

  if (reports.length > 1) {
    const sum = (f: (r: RunReport) => number) => reports.reduce((a, r) => a + f(r), 0);
    const queue = sum(queueSize);
    const byDesign = sum((r) => r.causes.never_checked_by_design);
    const unexpected = sum((r) => r.causes.never_checked_unexpected);
    const genuine = queue - byDesign - unexpected;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`ACROSS ${reports.length} PROSPECTS`);
    console.log(`  claims: ${sum((r) => r.total)} (${sum((r) => r.material)} material)`);
    console.log(`  individual decisions outstanding: ${queue}`);
    console.log(`    never checked, by design:  ${byDesign}${queue ? `  (${Math.round((byDesign / queue) * 100)}%)` : ""}`);
    console.log(`    never checked, unexpected: ${unexpected}${queue ? `  (${Math.round((unexpected / queue) * 100)}%)` : ""}`);
    console.log(`    checked, not supported:    ${genuine}${queue ? `  (${Math.round((genuine / queue) * 100)}%)` : ""}`);
    console.log(
      `\n  The last line is the only one that reflects research quality. The`
    );
    console.log(`  first is a coverage decision we made, showing up as reviewer work.`);
    console.log(`\n  Decisions that count as approval downstream: ${[...APPROVED_FOR_DOWNSTREAM].join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
