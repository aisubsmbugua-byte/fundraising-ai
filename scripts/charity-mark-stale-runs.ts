// Item 116, decision 0014: the national charity run is a single process under one systemd unit. When it is
// killed (a crash, an out-of-memory kill, a reboot, a deliberate stop) the load it was in the middle of is
// left recorded as 'running', and the loader's own guard then refuses every write until someone clears it.
// Called once at the start of charity-run-all.sh: any public-charity run still recorded as running at that
// moment belongs to a process that no longer exists, so it is recorded as 'interrupted'. It touches only
// that kind of run, only rows with status 'running', and never a verification-only row.
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment."); process.exit(2); }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.from("funder_reference_runs").select("id, parameters, notes").eq("status", "running");
  if (error) { console.error(`could not read runs: ${error.message}`); process.exit(3); }
  const stale = (data ?? []).filter((r) => (r.parameters as { kind?: string } | null)?.kind === "public_charity_and_daf_sponsor");
  for (const r of stale) {
    const note = `${r.notes ? `${r.notes}\n` : ""}Recorded as interrupted ${new Date().toISOString()}: the process that was running it ended without finishing (found at the start of the next run). Safe to repeat: every write is idempotent.`;
    const { error: e } = await db.from("funder_reference_runs").update({ status: "interrupted", finished_at: new Date().toISOString(), notes: note }).eq("id", r.id).eq("status", "running");
    if (e) { console.error(`could not mark run ${r.id} interrupted: ${e.message}`); process.exit(3); }
    console.log(`marked run ${r.id} (${(r.parameters as { state?: string }).state ?? "?"}) interrupted`);
  }
  console.log(stale.length ? `${stale.length} stale run(s) cleared` : "no stale run");
}
main().catch((e) => { console.error(e); process.exit(3); });
