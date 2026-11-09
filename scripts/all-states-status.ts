// Item 114 (ruling 0046 clause 5): print the last thing the all-states command did,
// read from the run table, so it can be seen without the server's logs.
//
// FOR THE OWNER. Shows whether the loader is running, finished, stopped or failed;
// when it last wrote; and for every state its status and the one-line reason. Read-only.
//
// Usage: npx tsx scripts/all-states-status.ts --target supabase|pglite:<dir>
// (with supabase the key is read from SUPABASE_SERVICE_ROLE_KEY in the environment; it
// is used for one read and never printed)

import { resolve } from "node:path";
import { SUPERVISOR_RUN_ID, pgliteRunStore, supabaseRunStore } from "../lib/funder-reference/run-store";
import { annotationOf, type StateReport } from "../lib/funder-reference/supervisor";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const target = arg("target");
  if (!target) {
    console.error("usage: --target supabase|pglite:<dir>");
    process.exit(2);
  }
  let store;
  if (target === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
      process.exit(2);
    }
    const { createClient } = await import("@supabase/supabase-js");
    store = supabaseRunStore(createClient(url!, key!, { auth: { persistSession: false } }) as never);
  } else if (target.startsWith("pglite:")) {
    const { openReferenceDb } = await import("./funder-reference-support");
    const dir = resolve(target.slice(7));
    store = pgliteRunStore(async () => (await openReferenceDb(dir)).db as never, target);
  } else {
    console.error(`unknown --target ${target}`);
    process.exit(2);
  }
  const row = await store.getRun(SUPERVISOR_RUN_ID);
  if (!row) {
    console.log("The all-states command has never run against this database (no standing row).");
    await store.release();
    return;
  }
  const c = row.counts as { states?: Record<string, StateReport>; halted?: { state: string; reason: string } | null; updated_at?: string };
  console.log(`status:      ${row.status.toUpperCase()}`);
  console.log(`started:     ${row.started_at}`);
  console.log(`finished:    ${row.finished_at ?? "(not finished: running now, or stopped without a note; compare 'last wrote' with the clock)"}`);
  console.log(`last wrote:  ${c.updated_at ?? "?"}`);
  console.log(`last note:   ${row.notes ?? ""}`);
  if (c.halted) console.log(`\nSTOPPED at ${c.halted.state}: ${c.halted.reason}`);
  const states = c.states ?? {};
  const names = Object.keys(states);
  const tally: Record<string, number> = {};
  for (const s of names) tally[states[s].status] = (tally[states[s].status] ?? 0) + 1;
  console.log(`\n${names.length} state(s): ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`);
  console.log("state  status            run                                   note");
  for (const s of names) console.log(`${s.padEnd(6)} ${states[s].status.padEnd(17)} ${(states[s].run_id ?? "").padEnd(37)} ${(states[s].note ?? "").slice(0, 110)}`);
  // for the states that finished, what the sample found
  const done = [];
  for (const s of names) {
    const id = states[s].run_id;
    if (!id) continue;
    const r = await store.getRun(id);
    const a = annotationOf(r);
    if (a?.verification) done.push(`${s}: ${a.verification.funders_checked} of ${a.verification.funders_in_state} funders checked, ${a.verification.compared} values compared, ${a.verification.mismatches} difference(s), ${a.verification.unexplained} unexplained${a.peak_rss_mb ? `, peak memory ${a.peak_rss_mb} MB` : ""}`);
  }
  if (done.length) console.log(`\nverified samples:\n  ${done.join("\n  ")}`);
  await store.release();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
