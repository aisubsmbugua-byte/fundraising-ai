// Replays identity resolution over every run's FROZEN sources, so a resolver
// change can be judged against everything we have ever captured -- instantly,
// deterministically, and for nothing.
//
// Why this exists. The only way to test a resolver change was to re-run
// research against the live web. That is slow, costs money per attempt, and is
// not a controlled comparison: the web moves between runs, so a difference
// between attempt 28 and attempt 29 could be the change or could be the search
// engine. Maclellan was re-run 29 times and Servants Heart 14, which is 96% of
// all research spend, because paying was the only way to ask "did that help?".
//
// This is scripts/replay-extraction.ts applied one stage upstream. That file
// froze evidence to take web-search variance out of EXTRACTION measurement,
// for exactly the same reason, and its reasoning is the precedent for this
// one. Resolution is a pure function of stored sources, so replaying it needs
// no model call at all -- there is not even an API key to spend.
//
// Reads only, unless --write is passed -- and then it writes exactly one
// thing: the display cache described above. A replay is still not a run. It
// must never create a research_runs row, never touch a claim or a prospect,
// and never pollute the history it is measured against.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/replay-resolution.ts            # every run
//   npx tsx --env-file=.env.local scripts/replay-resolution.ts "Stewardship"
//   npx tsx --env-file=.env.local scripts/replay-resolution.ts --verbose  # with evidence
//   npx tsx --env-file=.env.local scripts/replay-resolution.ts --write    # re-materialize
//
// --write is the counterpart to the ranking cache on research_runs. The page
// recomputes any run whose stored ENTITY_RANKING_VERSION is behind, which is
// correct but slow -- so after changing the resolver, bump the version and run
// this once to bring every stored ranking forward. It writes only that cache:
// never a claim, never a prospect, never an identity decision.

import { createClient } from "@supabase/supabase-js";
import { replayIdentity, IDENTITY_REPLAY_PROSPECT_COLUMNS, type IdentityReplayProspect } from "../lib/identity-replay";
import { toStoredRanking, ENTITY_RANKING_VERSION } from "../lib/research";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const write = args.includes("--write");
const filter = args.find((a) => !a.startsWith("--")) ?? null;

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  let q = admin
    .from("research_runs")
    .select(
      `id, version, prospect_id, prospects(id, ${IDENTITY_REPLAY_PROSPECT_COLUMNS})`
    )
    .eq("status", "ready")
    .order("version", { ascending: true });
  const { data: runs, error } = await q;
  if (error) throw error;

  const selected = (runs ?? []).filter((r) => {
    const p = r.prospects as unknown as { name: string } | null;
    return p && (!filter || p.name.toLowerCase().includes(filter.toLowerCase()));
  });
  if (!selected.length) {
    console.log(filter ? `No completed run matching "${filter}".` : "No completed runs.");
    return;
  }

  console.log(`\nReplaying identity resolution over ${selected.length} stored run(s). No API calls, no writes.\n`);

  let resolved = 0;
  let operatingWins = 0;
  let written = 0;
  const rows: string[] = [];

  for (const run of selected) {
    const p = run.prospects as unknown as IdentityReplayProspect;

    const ranking = await replayIdentity(admin, run.id as string, p);
    const candidates = ranking.ranked;

    if (write) {
      const { error: writeError } = await admin
        .from("research_runs")
        .update({ entity_ranking: toStoredRanking(ranking), entity_ranking_version: ENTITY_RANKING_VERSION })
        .eq("id", run.id as string);
      if (writeError) throw new Error(`writing ranking for run ${run.id}: ${writeError.message}`);
      written++;
    }

    const label = `${p.name.slice(0, 44).padEnd(46)} v${String(run.version).padEnd(3)}`;
    const nLegal = candidates.filter((c) => c.layer === "legal").length;
    const nOperating = candidates.filter((c) => c.layer === "operating").length;
    const counts = dim(`${String(nLegal).padStart(2)}L/${String(nOperating).padStart(2)}O`);

    if (ranking.confident && ranking.leader) {
      resolved++;
      if (ranking.leader.layer === "operating") operatingWins++;
      const id = ranking.leader.layer === "operating" ? ranking.leader.domain : ranking.leader.ein;
      const pct = Math.round((ranking.leader.score / (ranking.achievable || 1)) * 100);
      rows.push(
        `  ${green("RESOLVED")} ${label} ${counts}  ${(ranking.leader.name ?? "(unnamed)").slice(0, 42)} ${dim(`[${ranking.leader.layer}: ${id}] ${pct}%`)}`
      );
      if (verbose) for (const e of ranking.leader.evidence) rows.push(dim(`             - ${e}`));
    } else {
      rows.push(`  ${red("ABSTAIN ")} ${label} ${counts}  ${dim(ranking.abstainReasons[0] ?? "")}`);
      if (verbose) for (const r of ranking.abstainReasons.slice(1)) rows.push(dim(`             ${r}`));
    }
  }

  for (const r of rows) console.log(r);

  console.log(
    `\n${resolved}/${selected.length} runs resolve an operating identity from stored evidence alone` +
      (operatingWins ? ` (${operatingWins} won by the funder's own domain)` : "") +
      "."
  );
  if (write) console.log(`Re-materialized ${written} stored ranking(s) at version ${ENTITY_RANKING_VERSION}.`);
  console.log(dim("L = candidates keyed by EIN, O = candidates keyed by the organization's own domain.\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
