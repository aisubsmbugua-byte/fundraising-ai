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
// Reads only. A replay is not a run: it must never write a research_runs row,
// never update a prospect, and never pollute the history it is measured
// against.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/replay-resolution.ts            # every run
//   npx tsx --env-file=.env.local scripts/replay-resolution.ts "Stewardship"
//   npx tsx --env-file=.env.local scripts/replay-resolution.ts --verbose  # with evidence

import { createClient } from "@supabase/supabase-js";
import {
  buildEntityCandidates,
  scoreEntityCandidates,
  deriveEntityNameToken,
  contactEmailDomain,
} from "../lib/research";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const filter = args.find((a) => !a.startsWith("--")) ?? null;

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  let q = admin
    .from("research_runs")
    .select(
      "id, version, prospect_id, prospects(id, name, legal_name, opportunity_name, source_domain, location, website, contact_email)"
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
  const rows: string[] = [];

  for (const run of selected) {
    const p = run.prospects as unknown as {
      id: string;
      name: string;
      legal_name: string | null;
      opportunity_name: string | null;
      source_domain: string | null;
      location: string | null;
      website: string | null;
      contact_email: string | null;
    };

    const { data: sources } = await admin
      .from("research_sources")
      .select("id, url, title, source_ein, entity_validation_status")
      .eq("research_run_id", run.id);
    const { data: evidence } = await admin
      .from("research_evidence")
      .select("source_id, exact_text")
      .eq("research_run_id", run.id);

    const textsBySource = new Map<string, string[]>();
    for (const e of evidence ?? []) {
      const list = textsBySource.get(e.source_id as string) ?? [];
      list.push(e.exact_text as string);
      textsBySource.set(e.source_id as string, list);
    }

    // Exactly the inference the live path uses, so a replay cannot flatter the
    // resolver by handing it a signal production would not have.
    const website =
      p.website ?? (contactEmailDomain(p.contact_email) ? `https://${contactEmailDomain(p.contact_email)}` : null);

    const candidates = buildEntityCandidates({
      sources: (sources ?? []).map((s) => ({
        url: s.url as string,
        title: (s.title as string | null) ?? null,
        sourceEin: (s.source_ein as string | null) ?? null,
        status: (s.entity_validation_status as string | null) ?? null,
        texts: textsBySource.get(s.id as string) ?? [],
      })),
      nameToken: deriveEntityNameToken(p.name),
      prospectLocation: p.location,
      prospectWebsite: website,
      funderName: p.legal_name,
      opportunityName: p.opportunity_name,
      captureDomain: p.source_domain,
    });

    const ranking = scoreEntityCandidates(candidates, {
      prospectName: p.name,
      funderName: p.legal_name,
      opportunityName: p.opportunity_name,
      prospectWebsite: website,
      prospectLocation: p.location,
      captureDomain: p.source_domain,
    });

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
  console.log(dim("L = candidates keyed by EIN, O = candidates keyed by the organization's own domain.\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
