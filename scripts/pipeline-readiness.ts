// The only question the Research Agent exists to answer: how many prospects
// has it actually delivered into the pipeline, accurately researched?
//
// Every other diagnostic in this directory looks at ONE run and asks whether
// a mechanism worked -- did the entity gate classify correctly, did evidence
// reach extraction, was a claim's citation exact. Each is necessary and none
// of them answers the product question, because a run can pass all of those
// checks and still leave a fundraiser with nothing they can use. This script
// deliberately measures the outcome instead of the mechanism, across the
// whole book of prospects, so "is the strategy working" stops being a
// judgement call.
//
// The funnel is ordered by what blocks what. A prospect cannot be researched
// before it exists; research cannot be trusted before the operating identity
// is settled; claims cannot go downstream before a person has approved them.
// Reporting the FIRST gate a prospect fails is the point -- a prospect stuck
// on identity tells you nothing about review burden, and counting it in both
// buckets would double-count the same blockage and flatter whichever fix
// was built most recently.
//
// Cost is reported per delivered prospect, not per run. Runs are what we
// spend; delivered prospects are what we buy. A pipeline that produces
// excellent research nobody can use costs infinity per unit.
//
// Usage: npx tsx --env-file=.env.local scripts/pipeline-readiness.ts [--detail]

import { createClient } from "@supabase/supabase-js";
import { APPROVED_FOR_DOWNSTREAM } from "../lib/research";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const detail = process.argv.includes("--detail");

// "How is the platform performing right now" is a different question from
// "what is in the pipeline", and mixing them produces a number that answers
// neither. A prospect that arrived before the capture contract carries no
// opportunity_name, source_domain or website -- so a resolver failure on it
// says nothing about the resolver, only that it was handed nothing to
// resolve with. Grading current behaviour on those inputs understates it;
// grading it on the whole book hides it entirely.
//
// The cut is deliberately a property of the ROW, not a date. "Did this
// prospect arrive with capture provenance" is the thing that actually
// changes what the resolver sees; a cutoff date is a proxy for it that goes
// wrong the moment a legacy row gets backfilled.
const CURRENT_ONLY = process.argv.includes("--current");
const arrivedThroughCurrentPipeline = (p: { source_domain: string | null; opportunity_name: string | null }) =>
  Boolean(p.source_domain || p.opportunity_name);

// The first gate a prospect fails, in blocking order. Named for what a
// person would have to do next, not for the internal state -- "blocked on a
// question only the user can answer" is actionable; "operating_identity_method
// = unresolved" is a field value.
const GATES = [
  "never researched",
  "research errored / never completed",
  "identity unresolved -- asks the user",
  "identity resolved, no claims extracted",
  "claims extracted, none reviewed",
  "reviewed, nothing approved for downstream",
  "DELIVERED",
] as const;
type Gate = (typeof GATES)[number];

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

async function main() {
  const { data: allProspects, error: pErr } = await admin
    .from("prospects")
    .select("id, name, ein, website, opportunity_name, source_domain, created_at")
    .order("created_at", { ascending: true });
  if (pErr) throw pErr;
  if (!allProspects?.length) {
    console.log("No prospects.");
    return;
  }

  const current = allProspects.filter((p) =>
    arrivedThroughCurrentPipeline(p as { source_domain: string | null; opportunity_name: string | null })
  );
  const prospects = CURRENT_ONLY ? current : allProspects;
  console.log(
    `\n${current.length} of ${allProspects.length} prospects arrived with capture provenance (current pipeline).` +
      (CURRENT_ONLY ? " Reporting on those only." : " Reporting on all -- pass --current to isolate them.")
  );
  if (prospects.length === 0) {
    console.log(
      "\nNo prospect has yet been through the current pipeline end to end, so the platform's\n" +
        "present performance is UNMEASURED. Past runs cannot stand in for it: they were handed\n" +
        "inputs the current resolver was not designed around.\n"
    );
    return;
  }

  const { data: runs, error: rErr } = await admin
    .from("research_runs")
    .select(
      "id, prospect_id, version, status, cost_usd, confirmed_ein, entity_resolution_method, operating_identity_name, operating_identity_method, verification_state, completion_state"
    )
    .order("version", { ascending: true });
  if (rErr) throw rErr;

  const { data: claims, error: cErr } = await admin
    .from("research_claims")
    .select("id, research_run_id, verification_status");
  if (cErr) throw cErr;

  const { data: approvals, error: aErr } = await admin
    .from("research_claim_approvals")
    .select("claim_id, research_run_id, decision");
  if (aErr) throw aErr;

  const runsByProspect = new Map<string, typeof runs>();
  for (const r of runs ?? []) {
    const list = runsByProspect.get(r.prospect_id as string) ?? [];
    list.push(r);
    runsByProspect.set(r.prospect_id as string, list as typeof runs);
  }
  const claimsByRun = new Map<string, typeof claims>();
  for (const c of claims ?? []) {
    const list = claimsByRun.get(c.research_run_id as string) ?? [];
    list.push(c);
    claimsByRun.set(c.research_run_id as string, list as typeof claims);
  }
  const approvalsByRun = new Map<string, typeof approvals>();
  for (const a of approvals ?? []) {
    const list = approvalsByRun.get(a.research_run_id as string) ?? [];
    list.push(a);
    approvalsByRun.set(a.research_run_id as string, list as typeof approvals);
  }

  const tally = new Map<Gate, string[]>(GATES.map((g) => [g, [] as string[]]));
  let totalSpend = 0;
  let totalRuns = 0;
  const rows: Array<{ name: string; gate: Gate; note: string; spend: number; runCount: number; ageDays: number }> = [];

  // How long a prospect has been sitting at its gate. Without this, a
  // backlog of prospects accepted yesterday and a prospect abandoned three
  // months ago are the same row, and "never researched" reads as neglect
  // when it may only mean "arrived last night".
  const ageOf = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));

  for (const p of prospects) {
    const mine = (runsByProspect.get(p.id as string) ?? []) as NonNullable<typeof runs>;
    const spend = mine.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    totalSpend += spend;
    totalRuns += mine.length;

    const ready = [...mine].reverse().find((r) => r.status === "ready");
    let gate: Gate;
    let note = "";

    if (mine.length === 0) {
      gate = "never researched";
    } else if (!ready) {
      gate = "research errored / never completed";
      note = mine.map((r) => `v${r.version}:${r.status}`).join(" ");
    } else {
      // Operating identity is what decides whether the research describes the
      // right organization. Legal EIN deliberately does NOT gate here -- a
      // resolved operating identity with a pending EIN is a usable prospect
      // with some claims withheld, not a blocked one.
      const operatingResolved =
        (ready.operating_identity_method && ready.operating_identity_method !== "unresolved") ||
        Boolean(ready.confirmed_ein);
      const runClaims = claimsByRun.get(ready.id as string) ?? [];
      const runApprovals = approvalsByRun.get(ready.id as string) ?? [];
      const downstream = runApprovals.filter((a) => APPROVED_FOR_DOWNSTREAM.has(a.decision as never));

      if (!operatingResolved) {
        gate = "identity unresolved -- asks the user";
        note = `legal=${ready.entity_resolution_method ?? "-"} operating=${ready.operating_identity_method ?? "-"}`;
      } else if (runClaims.length === 0) {
        gate = "identity resolved, no claims extracted";
      } else if (runApprovals.length === 0) {
        gate = "claims extracted, none reviewed";
        note = `${runClaims.length} claims waiting`;
      } else if (downstream.length === 0) {
        gate = "reviewed, nothing approved for downstream";
        note = `${runApprovals.length} decisions, 0 usable`;
      } else {
        gate = "DELIVERED";
        note = `${downstream.length}/${runClaims.length} claims usable${ready.confirmed_ein ? "" : ", EIN pending"}`;
      }
    }

    tally.get(gate)!.push(p.name as string);
    rows.push({ name: p.name as string, gate, note, spend, runCount: mine.length, ageDays: ageOf(p.created_at as string) });
  }

  console.log(`\n=== PIPELINE READINESS -- ${prospects.length} prospects, ${totalRuns} research runs ===\n`);
  console.log("Where prospects stop (first blocking gate):");
  let remaining = prospects.length;
  for (const g of GATES) {
    const names = tally.get(g)!;
    if (g !== "DELIVERED") {
      const bar = "#".repeat(Math.min(40, names.length));
      const label = names.length ? red(String(names.length).padStart(4)) : dim("   0");
      console.log(`  ${label}  ${g.padEnd(44)} ${dim(bar)}`);
      remaining -= names.length;
    } else {
      console.log(`  ${green(String(names.length).padStart(4))}  ${g.padEnd(44)} ${green("#".repeat(Math.min(40, names.length)))}`);
    }
  }

  const delivered = tally.get("DELIVERED")!.length;
  console.log(`\nDELIVERY RATE  ${delivered}/${prospects.length} (${((delivered / prospects.length) * 100).toFixed(0)}%)`);
  console.log(`TOTAL SPEND    $${totalSpend.toFixed(2)} across ${totalRuns} runs`);
  console.log(
    `COST PER DELIVERED PROSPECT  ${delivered ? `$${(totalSpend / delivered).toFixed(2)}` : red("undefined -- nothing delivered")}`
  );

  // Age at the gate, per gate. A gate holding only new arrivals is a queue;
  // a gate holding month-old prospects is a blockage. The report must not
  // let those look alike.
  console.log("\nHOW LONG PROSPECTS HAVE WAITED AT THEIR GATE (days)");
  for (const g of GATES) {
    const at = rows.filter((r) => r.gate === g);
    if (!at.length) continue;
    const ages = at.map((r) => r.ageDays).sort((a, b) => a - b);
    console.log(
      `  ${g.padEnd(44)} n=${String(at.length).padStart(3)}  newest ${String(ages[0]).padStart(3)}d  median ${String(ages[Math.floor(ages.length / 2)]).padStart(3)}d  oldest ${String(ages[ages.length - 1]).padStart(3)}d`
    );
  }

  const reruns = rows.filter((r) => r.runCount > 1);
  if (reruns.length) {
    // NOT presented as waste. A heavily re-run prospect is usually a test
    // fixture -- the way a change to the pipeline gets validated. That is a
    // deliberate method, and reading it as failed retries would both slander
    // the method and inflate the apparent cost of production research.
    // What the number actually measures is how much of our validation loop
    // is paid, live and non-deterministic rather than replayed from stored
    // evidence (cf. scripts/replay-extraction.ts).
    const onFixtures = reruns.reduce((s, r) => s + r.spend, 0);
    console.log(
      `\nRE-RUN PROSPECTS  ${reruns.length} researched more than once -- $${onFixtures.toFixed(2)} (${((onFixtures / totalSpend) * 100).toFixed(0)}% of spend).`
    );
    console.log(dim("  Mostly test fixtures. This is the cost of validating changes against the live web"));
    console.log(dim("  instead of against stored evidence -- the gap replay tooling closes."));
    for (const r of reruns.slice(0, 10)) {
      console.log(`  ${String(r.runCount).padStart(2)} runs  $${r.spend.toFixed(2).padStart(6)}  ${r.name.slice(0, 60)}`);
    }
  }

  if (detail) {
    console.log("\nPER PROSPECT");
    for (const r of rows) {
      const mark = r.gate === "DELIVERED" ? green("OK  ") : red("STOP");
      console.log(`  ${mark} ${r.name.slice(0, 58).padEnd(60)} ${r.gate.padEnd(44)} ${dim(r.note)}`);
    }
  } else {
    console.log("\n(--detail lists every prospect)");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
