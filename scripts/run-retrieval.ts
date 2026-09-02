// What a run actually retrieved, and what it could not.
//
// Coverage answers "which facts are missing". This answers the question that
// comes next and has different fixes behind it: was the page never found, found
// and not read, read and not cited, or read and excluded as the wrong entity?
//
// Written because the same question came up four times in one evening -- a
// targeted follow-up aimed at a 990 grant schedule, failed 3 of 6 fetches, and
// still reported the schedule as unread, and nothing could say whether the
// filing was unreachable, the wrong content type, or too large for the content
// budget. Those need completely different fixes, and "3 of 6 failed" chooses
// none of them.
//
// Reads only. Safe on a run still in flight -- it says so rather than
// pretending the numbers are final.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/run-retrieval.ts "Stewardship"
//   npx tsx --env-file=.env.local scripts/run-retrieval.ts "Stewardship" 2

import { createClient } from "@supabase/supabase-js";
import { RESEARCH_SOURCE_CLASSES } from "../lib/research";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  const query = process.argv[2];
  const wanted = process.argv[3] ? Number(process.argv[3]) : null;
  if (!query) {
    console.error('Usage: run-retrieval.ts "<prospect name>" [version]');
    process.exit(1);
  }

  const { data: prospects } = await admin.from("prospects").select("id, name").ilike("name", `%${query}%`);
  if (!prospects?.length) throw new Error(`No prospect matching "${query}".`);
  if (prospects.length > 1) {
    console.error(`Ambiguous -- ${prospects.length} match:`);
    for (const p of prospects) console.error(`  ${p.name}`);
    process.exit(1);
  }
  const p = prospects[0];

  let q = admin
    .from("research_runs")
    .select(
      "id, version, status, status_message, depth, research_focus, searches_used, fetch_attempts, fetch_failures, fetch_failure_reasons, missing_source_classes, missing_information, official_site_fetched, filing_fetched, captured_chars, cost_usd, latency_ms, verification_state"
    )
    .eq("prospect_id", p.id as string)
    .order("version", { ascending: false })
    .limit(1);
  if (wanted !== null) q = admin.from("research_runs").select("*").eq("prospect_id", p.id as string).eq("version", wanted).limit(1);
  const { data: runs } = await q;
  const run = runs?.[0];
  if (!run) throw new Error("No such run.");

  console.log(`\n=== ${p.name} — v${run.version} (${run.status}) ===\n`);
  if (run.status !== "ready") {
    console.log(`  ${run.status_message ?? "in flight"}`);
    console.log(dim("  Retrieval numbers are written when the run completes; nothing below is final yet.\n"));
    return;
  }

  console.log(`  depth        ${run.depth}`);
  console.log(`  focus        ${run.research_focus ? JSON.stringify(run.research_focus) : dim("none — not a targeted follow-up")}`);
  console.log(`  searches     ${run.searches_used}`);
  console.log(
    `  fetches      ${run.fetch_attempts} attempted, ${run.fetch_failures} failed${
      (run.fetch_failures ?? 0) > 0 && !run.fetch_failure_reasons ? dim("  (reasons not recorded — run predates 0062)") : ""
    }`
  );
  for (const reason of (run.fetch_failure_reasons as string[] | null) ?? []) console.log(`     ${red("×")} ${reason}`);
  console.log(`  cost         $${Number(run.cost_usd ?? 0).toFixed(3)}   latency ${Math.round((run.latency_ms ?? 0) / 1000)}s`);

  // Source classes are the bridge between "we fetched N pages" and "a category
  // is empty": a class listed here appeared in the results and was never read.
  const missingClasses = (run.missing_source_classes as string[] | null) ?? [];
  console.log(`\n  SOURCE CLASSES`);
  for (const cls of RESEARCH_SOURCE_CLASSES) {
    const missed = missingClasses.includes(cls);
    console.log(`    ${missed ? red("not read") : "  read  "}  ${cls}`);
  }
  console.log(`    ${run.official_site_fetched ? "  yes   " : red("   no   ")}  official site fetched`);
  console.log(`    ${run.filing_fetched ? "  yes   " : red("   no   ")}  filing fetched`);

  const { data: sources } = await admin
    .from("research_sources")
    .select("url, entity_validation_status")
    .eq("research_run_id", run.id as string);
  const byStatus = new Map<string, number>();
  for (const s of sources ?? []) {
    const k = (s.entity_validation_status as string | null) ?? "(unclassified)";
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  console.log(`\n  SOURCES CAPTURED  ${sources?.length ?? 0}`);
  for (const [k, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${k}`);
  }

  const missingInfo = (run.missing_information as string[] | null) ?? [];
  console.log(`\n  STILL MISSING  ${missingInfo.length ? missingInfo.join(", ") : dim("nothing")}`);
  if (missingInfo.length && missingClasses.length) {
    console.log(dim("  A missing class beside a missing category is usually the cause, not a coincidence."));
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
