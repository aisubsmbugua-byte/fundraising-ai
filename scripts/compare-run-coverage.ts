// Diagnoses WHY a claim key found in one run is missing from another, using
// only stored data -- no web rerun, no model call, no cost.
//
// Coverage moving between runs is easy to observe and hard to explain, and
// the explanations have very different consequences:
//
//   retrieval    the page was never fetched this time      -> search variance
//   withheld     the page was fetched but entity-excluded  -> entity discipline
//   extraction   the evidence was present and not cited    -> extraction miss
//   unsupported  the EARLIER claim's evidence doesn't       -> the old coverage
//                actually mention the subject                 was false
//
// That last one matters most: a key can "regress" because the earlier run
// was wrong, in which case losing it is an improvement, not a loss.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/compare-run-coverage.ts <prospect> <fromVersion> <toVersion>
//   e.g. ... compare-run-coverage.ts Maclellan 21 25

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const EXCLUDED = new Set(["entity_mismatch", "unrelated_excluded", "different_entity_unverified_relation", "affiliate_related_entity"]);

// Longest shared run of words, as a fraction of the shorter text. Word-level
// rather than character-level so trivial punctuation/whitespace differences
// between two captures of the same passage don't hide a real match.
function sharedPassage(a: string, b: string): number {
  const wa = a.toLowerCase().split(/\W+/).filter(Boolean);
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wa.length === 0) return 0;
  let best = 0;
  let run = 0;
  for (const w of wa) {
    if (wb.has(w)) best = Math.max(best, ++run);
    else run = 0;
  }
  return best / Math.min(wa.length, 40);
}

async function loadRun(prospectId: string, version: number) {
  const { data: run } = await admin.from("research_runs").select("*").eq("prospect_id", prospectId).eq("version", version).single();
  if (!run) throw new Error(`No run v${version}`);
  const [{ data: coverage }, { data: claims }, { data: sources }, { data: evidence }, { data: links }] = await Promise.all([
    admin.from("research_key_coverage").select("claim_key, status, notes").eq("research_run_id", run.id),
    admin.from("research_claims").select("id, claim_key, claim").eq("research_run_id", run.id),
    admin.from("research_sources").select("id, url, title, entity_validation_status").eq("research_run_id", run.id),
    admin.from("research_evidence").select("id, source_id, exact_text").eq("research_run_id", run.id),
    admin.from("research_claim_sources").select("claim_id, source_id, evidence_id, cited_text").eq("research_run_id", run.id),
  ]);
  return { run, coverage: coverage ?? [], claims: claims ?? [], sources: sources ?? [], evidence: evidence ?? [], links: links ?? [] };
}

async function main() {
  const [nameArg, fromArg, toArg] = process.argv.slice(2);
  if (!nameArg || !fromArg || !toArg) {
    console.error("Usage: compare-run-coverage.ts <prospect> <fromVersion> <toVersion>");
    process.exit(1);
  }
  const { data: prospect } = await admin.from("prospects").select("id, name").ilike("name", `%${nameArg}%`).limit(1).single();
  if (!prospect) throw new Error(`No prospect matching "${nameArg}"`);

  const from = await loadRun(prospect.id, Number(fromArg));
  const to = await loadRun(prospect.id, Number(toArg));

  const foundIn = (r: Awaited<ReturnType<typeof loadRun>>) => new Set(r.coverage.filter((c) => c.status === "found").map((c) => c.claim_key));
  const lost = [...foundIn(from)].filter((k) => !foundIn(to).has(k));

  console.log(`${prospect.name}: v${fromArg} -> v${toArg}`);
  console.log(`  v${fromArg}: ${foundIn(from).size} keys found | v${toArg}: ${foundIn(to).size} keys found`);
  console.log(`  lost: ${lost.length ? lost.join(", ") : "(none)"}\n`);
  if (lost.length === 0) return;

  const toSourceByUrl = new Map(to.sources.map((s) => [s.url, s]));
  const toEvidenceBySource = new Map<string, string[]>();
  for (const e of to.evidence) {
    toEvidenceBySource.set(e.source_id as string, [...(toEvidenceBySource.get(e.source_id as string) ?? []), e.exact_text]);
  }
  const fromSourceById = new Map(from.sources.map((s) => [s.id, s]));

  const verdicts: Record<string, number> = {};

  for (const claimKey of lost) {
    console.log(`── ${claimKey}`);
    const claims = from.claims.filter((c) => c.claim_key === claimKey);
    const toNote = to.coverage.find((c) => c.claim_key === claimKey);
    console.log(`   v${toArg} recorded: ${toNote?.status ?? "(no entry)"}${toNote?.notes ? ` -- ${toNote.notes.slice(0, 90)}` : ""}`);

    for (const claim of claims) {
      console.log(`   v${fromArg} claimed: ${claim.claim.slice(0, 110)}`);
      const claimLinks = from.links.filter((l) => l.claim_id === claim.id);
      if (claimLinks.length === 0) {
        console.log(`     [unsupported] the earlier claim cited NO evidence -- this coverage was never real`);
        verdicts.unsupported = (verdicts.unsupported ?? 0) + 1;
        continue;
      }
      for (const link of claimLinks) {
        const src = fromSourceById.get(link.source_id as string);
        const citedText = link.cited_text ?? "";
        const inTo = src ? toSourceByUrl.get(src.url) : undefined;

        // Did the earlier evidence actually mention this claim's subject? A
        // page title alone almost never supports an application-rules claim.
        const subject = claimKey.split(".")[1]?.replace(/_/g, " ") ?? "";
        const subjectWords = subject.split(" ").filter((w: string) => w.length > 4);
        const evidenceMentionsSubject = subjectWords.some((w: string) => citedText.toLowerCase().includes(w.toLowerCase()));

        let verdict: string;
        let detail = "";
        if (!inTo) {
          verdict = "retrieval";
          detail = `source not retrieved in v${toArg}`;
        } else if (EXCLUDED.has(inTo.entity_validation_status ?? "")) {
          verdict = "withheld";
          detail = `source retrieved but entity-excluded (${inTo.entity_validation_status})`;
        } else {
          const candidates = toEvidenceBySource.get(inTo.id as string) ?? [];
          const best = candidates.reduce((m, t) => Math.max(m, sharedPassage(citedText, t)), 0);
          if (best >= 0.5) {
            verdict = "extraction";
            detail = `equivalent evidence present in v${toArg} (passage overlap ${(best * 100).toFixed(0)}%) but not cited`;
          } else {
            verdict = "retrieval";
            detail = `source retrieved in v${toArg} but this passage was not captured (best overlap ${(best * 100).toFixed(0)}%)`;
          }
        }
        if (!evidenceMentionsSubject && citedText.length < 200) {
          verdict = "unsupported";
          detail = `earlier evidence never mentions "${subject}" -- ${JSON.stringify(citedText.slice(0, 70))}`;
        }

        verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
        console.log(`     [${verdict}] ${detail}`);
        console.log(`       src: ${(src?.url ?? "?").slice(0, 88)}`);
      }
    }
    console.log("");
  }

  console.log("VERDICTS:", JSON.stringify(verdicts));
  console.log(
    "\nretrieval = search variance | withheld = entity discipline | extraction = model missed cited-able evidence | unsupported = the earlier coverage was false"
  );
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
