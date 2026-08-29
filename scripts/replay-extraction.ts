// Replays a completed run's FROZEN evidence through the extraction step, so
// extraction can be measured without web-search variance in the way.
//
// Why this exists. Six identical-input runs of one prospect produced between
// 50 and 80 facts, with two byte-identical configurations returning 62 and
// 78. That noise is larger than most differences worth testing, so a
// single-run A/B comparison of an extraction change cannot support a
// decision. Freezing the evidence removes the noisy half of the pipeline:
// every configuration sees exactly the same fragments in the same order, so
// a difference in the result is attributable to extraction.
//
// It reads the stored ledger and never writes -- replays do not become runs,
// so evaluating a model does not pollute the run history it is measured
// against.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/replay-extraction.ts <prospect> <version> [options]
//     --model=claude-haiku-4-5   extraction model (default: the configured one)
//     --depth=screen|dossier     which claim vocabulary to ask for
//     --repeat=3                 run N times to measure extraction's own variance
//     --dry-run                  rebuild and inspect the frozen evidence only,
//                                no model call and no cost
//
// Requires ANTHROPIC_API_KEY in .env.local (this makes real extraction calls).

import { createClient } from "@supabase/supabase-js";
import { extractResearchClaims, EXCLUDED_ENTITY_STATUSES, type EvidenceFragment } from "../lib/ai/research-extract";
import { claimKeysForDepth, hasStatedPeriod, isFinancialClaimKey, NO_REPORTING_PERIOD, type ResearchDepth, type ResearchEntityValidationStatus } from "../lib/research";
import { estimateCostUsd } from "../lib/ai/model-select";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const DRY_RUN = process.argv.includes("--dry-run");
if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY -- this script makes real extraction calls. Add it to .env.local, or pass --dry-run to inspect the frozen evidence without calling the model.");
  process.exit(1);
}
const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

// Rebuilds the exact fragment list extraction was given: every stored
// fragment, tagged with its source's entity verdict, minus the statuses that
// are withheld in code. Ordered deterministically so repeated replays and
// different configurations index identically.
async function freezeEvidence(runId: string) {
  const [{ data: evidence }, { data: sources }] = await Promise.all([
    admin.from("research_evidence").select("id, source_id, url, kind, exact_text, created_at").eq("research_run_id", runId),
    admin.from("research_sources").select("id, title, entity_validation_status").eq("research_run_id", runId),
  ]);
  const sourceById = new Map((sources ?? []).map((s) => [s.id as string, s]));

  const all = (evidence ?? [])
    .map((e) => {
      const src = sourceById.get(e.source_id as string);
      return {
        url: e.url as string,
        title: (src?.title as string | null) ?? null,
        kind: e.kind as EvidenceFragment["kind"],
        exactText: e.exact_text as string,
        entityStatus: ((src?.entity_validation_status as ResearchEntityValidationStatus | null) ?? "identity_unresolved") as ResearchEntityValidationStatus,
        _sort: `${e.created_at}|${e.url}|${e.id}`,
      };
    })
    .sort((a, b) => a._sort.localeCompare(b._sort));

  const usable = all.filter((f) => !EXCLUDED_ENTITY_STATUSES.has(f.entityStatus)).map(({ _sort, ...f }) => f);
  return { total: all.length, usable };
}

const FINANCIAL = /total_|disburse|grant_count|grant_size|median|annual_giving/;

async function main() {
  const [nameArg, versionArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!nameArg || !versionArg) {
    console.error("Usage: replay-extraction.ts <prospect> <version> [--model=] [--depth=] [--repeat=]");
    process.exit(1);
  }
  const depth = (arg("depth") as ResearchDepth) ?? "dossier";
  const repeat = Number(arg("repeat") ?? 1);
  const modelOverride = arg("model");

  const { data: prospect } = await admin.from("prospects").select("id, name").ilike("name", `%${nameArg}%`).limit(1).single();
  if (!prospect) throw new Error(`No prospect matching "${nameArg}"`);
  const { data: run } = await admin
    .from("research_runs")
    .select("id, version, findings, model, depth")
    .eq("prospect_id", prospect.id)
    .eq("version", Number(versionArg))
    .single();
  if (!run) throw new Error(`No run v${versionArg}`);

  const { total, usable } = await freezeEvidence(run.id as string);
  const keys = claimKeysForDepth(depth);

  console.log(`Frozen evidence from ${prospect.name} v${run.version} (ran on ${run.model}, depth ${run.depth ?? "pre-tiering"})`);
  console.log(`  ${usable.length} usable fragments of ${total} stored | ${keys.length} claim keys at depth "${depth}"`);
  console.log(`  replaying on ${modelOverride ?? "the configured research model"} x${repeat}\n`);

  if (DRY_RUN) {
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const f of usable) {
      byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      byStatus[f.entityStatus] = (byStatus[f.entityStatus] ?? 0) + 1;
    }
    const chars = usable.reduce((n, f) => n + f.exactText.length, 0);
    console.log("  DRY RUN -- frozen evidence that would be sent:");
    console.log("    by kind:  ", JSON.stringify(byKind));
    console.log("    by entity:", JSON.stringify(byStatus));
    console.log(`    ${chars.toLocaleString()} chars (~${Math.round(chars / 4).toLocaleString()} tokens), longest ${Math.max(...usable.map((f) => f.exactText.length))}`);
    console.log(`    withheld from extraction: ${total - usable.length} of ${total} stored fragments`);
    console.log(`\n    findings: ${((run.findings as string) ?? "").length.toLocaleString()} chars`);
    console.log("    first 3 fragments:");
    usable.slice(0, 3).forEach((f, i) => console.log(`      [${i}] (${f.entityStatus}, ${f.kind}) ${f.url.slice(0, 60)}: ${JSON.stringify(f.exactText.slice(0, 70))}`));
    return;
  }

  const rows: { claims: number; found: number; high: number; dated: string; badIds: number; cost: number; undatedButTrusted: number; wronglyTimeless: number }[] = [];

  for (let i = 0; i < repeat; i++) {
    const result = await extractResearchClaims({
      prospectName: prospect.name,
      findings: (run.findings as string) ?? "",
      evidence: usable,
      claimKeys: keys,
      modelOverride,
    });

    // Structural check: every cited id must resolve to a real frozen
    // fragment. Guaranteed by construction in production -- asserted here so
    // a cheaper model that starts inventing indices is caught immediately.
    const badIds = result.claims.reduce(
      (n, c) => n + c.evidence_ids.filter((id) => id < 0 || id >= usable.length).length,
      0
    );
    const financial = result.claims.filter((c) => isFinancialClaimKey(c.claim_key));
    // The guarantee that matters is not that every figure is dated -- some
    // evidence genuinely states no year -- but that an UNDATED financial
    // figure can never be presented as trustworthy.
    const undatedButTrusted = financial.filter((c) => !hasStatedPeriod(c.reporting_period) && c.confidence !== "low").length;
    // A financial figure can never legitimately be "no period applies".
    const wronglyTimeless = financial.filter((c) => c.reporting_period === NO_REPORTING_PERIOD).length;
    const dated = financial.filter((c) => hasStatedPeriod(c.reporting_period)).length;
    const high = result.claims.filter((c) => c.confidence === "high").length;
    const cost = estimateCostUsd(result.model, result.usage.inputTokens, result.usage.outputTokens);

    rows.push({
      undatedButTrusted,
      wronglyTimeless,
      claims: result.claims.length,
      found: result.coverage.filter((c) => c.status === "found").length,
      high,
      dated: `${dated}/${financial.length}`,
      badIds,
      cost,
    });

    console.log(
      `  [${i + 1}] ${result.claims.length} claims | ${high} high | coverage found ${rows[i].found} | financial dated ${rows[i].dated} | ` +
        `undated-but-trusted ${undatedButTrusted} | invalid ids ${badIds} | $${cost.toFixed(4)}${result.truncated ? " | TRUNCATED" : ""}`
    );
  }

  if (repeat > 1) {
    const counts = rows.map((r) => r.claims);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    console.log(
      `\n  extraction-only spread: ${min}-${max} claims (mean ${mean.toFixed(1)}, ` +
        `${(((max - min) / mean) * 100).toFixed(0)}% of mean) on IDENTICAL evidence`
    );
    console.log("  -- any spread beyond this in a full run is retrieval variance, not extraction");
  }

  const totalBad = rows.reduce((n, r) => n + r.badIds, 0);
  const totalUndatedTrusted = rows.reduce((n, r) => n + r.undatedButTrusted, 0);
  const totalWronglyTimeless = rows.reduce((n, r) => n + r.wronglyTimeless, 0);
  console.log(`\n  ${totalBad === 0 ? "PASS" : "FAIL"}: every cited evidence_id resolved to a real fragment (${totalBad} invalid)`);
  console.log(`  ${totalUndatedTrusted === 0 ? "PASS" : "FAIL"}: no undated financial figure above low confidence (${totalUndatedTrusted} violations)`);
  console.log(`  ${totalWronglyTimeless === 0 ? "PASS" : "FAIL"}: no financial figure labelled "not_time_bound" (${totalWronglyTimeless} violations)`);
  console.log(`  mean cost $${(rows.reduce((a, r) => a + r.cost, 0) / rows.length).toFixed(4)} per extraction`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
