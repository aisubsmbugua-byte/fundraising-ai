// Item 114, authorized by ruling 0046 clause 2: tests for the server setup script and the
// two scripts the server runs.
//
// FOR THE OWNER. The setup script runs once, on a server this project cannot reach, so it
// is tested here in every way that does not need that server: it is syntax-checked; its
// --check mode is run and shown to describe the whole job and change nothing; the systemd
// files it would install are written out and checked for the settings that matter
// (restart, the key kept out of them, the timer waiting for the first load); the part
// that stores the key is run for real against a temporary file and shown to store only a
// key that starts sb_secret_, with mode 600, and never to print it. What this CANNOT show
// is how Ubuntu, apt and systemd actually behave: that is listed as not verified in the
// build report.
//
// Usage: npx tsx scripts/test-server-setup.ts

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERVISOR_RUN_ID, pgliteRunStore } from "../lib/funder-reference/run-store";
import { openReferenceDb } from "./funder-reference-support";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

const root = join(__dirname, "..");
const SETUP = join(root, "scripts/server/setup-funder-loader.sh");
const RUN = join(root, "scripts/server/funder-loader-run.sh");
const STATUS = join(root, "scripts/server/funder-loader-status.sh");
const setupText = readFileSync(SETUP, "utf8");
const runText = readFileSync(RUN, "utf8");
const bash = (args: string[], opts: { input?: string; env?: Record<string, string>; cwd?: string } = {}) => {
  const r = spawnSync("bash", args, { encoding: "utf8", input: opts.input, cwd: opts.cwd ?? root, env: { ...process.env, ...(opts.env ?? {}) } });
  return { code: r.status, out: String(r.stdout) + String(r.stderr) };
};

async function main() {
  section("1. the scripts are well formed");
  for (const f of [SETUP, RUN, STATUS]) ok(`bash accepts the syntax of ${f.slice(root.length + 1)}`, bash(["-n", f]).code === 0, bash(["-n", f]).out);
  ok("the setup script is executable, with a bash shebang", (statSync(SETUP).mode & 0o100) !== 0 && /^#!\/usr\/bin\/env bash/.test(setupText));
  ok("each script stops at the first error (set -e) and refuses unset variables or says why not", /set -euo pipefail/.test(setupText) && /set -euo pipefail/.test(runText));
  ok("the setup script never turns on tracing (a trace would print the key)", /set \+x/.test(setupText) && !/set -[a-z]*x/.test(setupText) && !/bash -x/.test(setupText));

  section("2. --check describes the whole job and changes nothing");
  {
    const scratch = mkdtempSync(join(tmpdir(), "fr-setup-check-"));
    const before = ["/etc/funder-loader.env", "/opt/funder-loader", "/var/lib/funder-loader", "/swapfile", "/etc/systemd/system/funder-loader.service"].map((p) => existsSync(p));
    const r = bash([SETUP, "--check"], { env: { TMPDIR: scratch } });
    const after = ["/etc/funder-loader.env", "/opt/funder-loader", "/var/lib/funder-loader", "/swapfile", "/etc/systemd/system/funder-loader.service"].map((p) => existsSync(p));
    ok("--check exits 0", r.code === 0, r.out.slice(-400));
    ok("--check says it is a check and changes nothing", /CHECK MODE: nothing below is changed/.test(r.out) && /That was a check only: nothing was changed/.test(r.out));
    ok("it creates none of the places it would create", JSON.stringify(before) === JSON.stringify(after));
    ok("and writes nothing into the temporary folder", readdirSync(scratch).length === 0, readdirSync(scratch).join());
    for (const [label, re] of [
      ["the machine check, with the 60 GB free-disk refusal", /free disk where the IRS files will live: .* \(needs at least 60 GB\)/],
      ["Node.js 22", /Node\.js 22/],
      ["a 4 GB swap file", /fallocate -l 4G \/swapfile/],
      ["the dedicated user with no login", /useradd --system .* --shell \/usr\/sbin\/nologin funder-loader/],
      ["the deploy key and where in GitHub to paste it", /Settings -> Deploy keys -> Add deploy key/],
      ["read-only: 'Allow write access' left unchecked", /Leave 'Allow write access' UNCHECKED/],
      ["the clone of the private repository over SSH", /git clone git@github\.com:aisubsmbugua-byte\/fundraising-ai\.git/],
      ["the hidden key prompt, sb_secret_, root-only file, URL and memory setting", /typing hidden.*sb_secret_.*\/etc\/funder-loader\.env \(owner root, mode 600\)[\s\S]*NEXT_PUBLIC_SUPABASE_URL=https:\/\/mbsxeyoxojcqetrmwgba\.supabase\.co.*NODE_OPTIONS=--max-old-space-size=1536/],
      ["the IRS download", /the IRS bulk files \(about 19 GB; resumable\)/],
      ["the service and timer, with the service NOT started", /The service itself is NOT started/],
    ] as Array<[string, RegExp]>)
      ok(`--check mentions ${label}`, re.test(r.out), r.out.slice(0, 200));
    ok("it ends by printing the command that starts the first load, and the three for afterwards (follow, status, stop)", /sudo systemctl start funder-loader/.test(r.out) && /journalctl -u funder-loader -f/.test(r.out) && /funder-loader-status\.sh/.test(r.out) && /sudo systemctl stop funder-loader/.test(r.out));
    ok("--check did not ask for anything (it ran to the end with no input)", /done/.test(r.out));
    rmSync(scratch, { recursive: true, force: true });
    ok("an unknown option is refused", bash([SETUP, "--nonsense"]).code === 2);
  }

  section("3. the free-disk guard comes before anything is installed or downloaded");
  {
    const guard = setupText.indexOf("Not enough free disk");
    const firstInstall = setupText.indexOf("apt-get update");
    ok("the refusal for less than 60 GB free is written before the first apt-get", guard > 0 && firstInstall > guard);
    ok("the minimum is 60 GB", /MIN_FREE_GB="60"/.test(setupText));
    ok("the download step checks again before it fetches", /Only \$FREE GB free; need \$MIN_FREE_GB GB\. Not downloading/.test(setupText));
  }

  section("4. the systemd files");
  {
    const dir = mkdtempSync(join(tmpdir(), "fr-units-"));
    const r = bash([SETUP, "--print-units", dir]);
    ok("--print-units writes the three unit files", r.code === 0 && readdirSync(dir).sort().join() === "funder-loader-refresh.service,funder-loader-refresh.timer,funder-loader.service", r.out);
    const svc = readFileSync(join(dir, "funder-loader.service"), "utf8");
    const refresh = readFileSync(join(dir, "funder-loader-refresh.service"), "utf8");
    const timer = readFileSync(join(dir, "funder-loader-refresh.timer"), "utf8");
    const parse = (text: string) => {
      const sections: Record<string, string[]> = {};
      let cur = "";
      for (const l of text.split("\n")) {
        if (!l.trim() || l.startsWith("#")) continue;
        const m = /^\[(\w+)\]$/.exec(l);
        if (m) {
          cur = m[1];
          sections[cur] = [];
        } else sections[cur].push(l);
      }
      return sections;
    };
    const allowed: Record<string, string[]> = {
      Unit: ["Description", "Documentation", "After", "Wants", "StartLimitIntervalSec", "StartLimitBurst", "ConditionPathExists"],
      Service: ["Type", "User", "Group", "WorkingDirectory", "EnvironmentFile", "Environment", "ExecStart", "Restart", "RestartSec", "RestartPreventExitStatus", "SuccessExitStatus", "TimeoutStopSec", "KillMode", "MemoryMax", "Nice", "NoNewPrivileges", "PrivateTmp", "ProtectSystem", "ProtectHome", "ReadWritePaths"],
      Timer: ["OnCalendar", "RandomizedDelaySec", "Persistent"],
      Install: ["WantedBy"],
    };
    for (const [name, text] of [["funder-loader.service", svc], ["funder-loader-refresh.service", refresh], ["funder-loader-refresh.timer", timer]] as const) {
      const s = parse(text);
      const bad = Object.entries(s).flatMap(([sec, lines]) => lines.filter((l) => !(allowed[sec] ?? []).includes(l.split("=")[0])).map((l) => `[${sec}] ${l}`));
      ok(`${name}: only known sections and settings (no typo systemd would silently ignore)`, bad.length === 0 && Object.keys(s).every((k) => k in allowed), bad.join("; "));
    }
    ok("the service runs as the dedicated user, not root", /^User=funder-loader$/m.test(svc) && /^Group=funder-loader$/m.test(svc));
    ok("the service restarts after a crash or reboot (Restart=on-failure)", /^Restart=on-failure$/m.test(svc));
    ok("it does NOT restart after a deliberate stop: exit codes 1, 2, 3 and 4 wait for a person", /^RestartPreventExitStatus=1 2 3 4$/m.test(svc));
    ok("it has a start limit, so a crash loop ends", /^StartLimitBurst=\d+$/m.test(svc) && /^StartLimitIntervalSec=\d+$/m.test(svc));
    ok("the key comes from the root-only file, and is not in the unit", /^EnvironmentFile=\/etc\/funder-loader\.env$/m.test(svc) && !/sb_secret|SERVICE_ROLE|eyJ/.test(svc + refresh + timer));
    ok("it runs the wrapper script that fetches then loads", /^ExecStart=\/opt\/funder-loader\/app\/scripts\/server\/funder-loader-run\.sh$/m.test(svc));
    ok("a memory cap protects the rest of the machine", /^MemoryMax=\d+M$/m.test(svc));
    ok("a stop gets time to be recorded", /^TimeoutStopSec=\d+$/m.test(svc));
    ok("the unit is sandboxed to its own folder", /^NoNewPrivileges=true$/m.test(svc) && /^ReadWritePaths=\/var\/lib\/funder-loader$/m.test(svc));
    ok("the timer is monthly, persistent, and installed into timers.target", /^OnCalendar=\*-\*-\d+ \d\d:\d\d:\d\d$/m.test(timer) && /^Persistent=true$/m.test(timer) && /^WantedBy=timers\.target$/m.test(timer));
    ok("the timer starts the refresh unit, which starts the SAME service as the first load", /ExecStart=\/usr\/bin\/systemctl start --no-block funder-loader\.service/.test(refresh));
    ok("and only once a person has started the first load (it waits for the run's manifest)", /^ConditionPathExists=\/var\/lib\/funder-loader\/work\/all-states-manifest\.json$/m.test(refresh));
    rmSync(dir, { recursive: true, force: true });
  }

  section("5. the key: stored for root alone, only if it starts sb_secret_, never shown");
  {
    const dir = mkdtempSync(join(tmpdir(), "fr-env-"));
    const env = join(dir, "funder-loader.env");
    const KEY = "sb_secret_TestKey_0123456789-abcdef";
    const run = (input: string, extra: string[] = []) => bash([SETUP, "--only", "env", "--key-from-stdin", "--env-file", env, ...extra], { input, env: { FUNDER_SETUP_ALLOW_NON_ROOT: "1" } });
    const bad1 = run("eyJhbGciOiJIUzI1NiJ9.legacy.jwt\n");
    ok("a legacy eyJ key is refused (exit 2) and nothing is stored", bad1.code === 2 && !existsSync(env), bad1.out);
    ok("the refusal does not repeat the value", !bad1.out.includes("eyJhbGci"));
    const bad2 = run("sb_secret_has space\n");
    ok("a key with characters a key never has is refused", bad2.code === 2 && !existsSync(env));
    const bad3 = run("\n");
    ok("an empty answer on a first run is refused", bad3.code === 2 && !existsSync(env));
    const good = run(`${KEY}\n`);
    ok("a key starting sb_secret_ is stored", good.code === 0 && existsSync(env), good.out);
    ok("the key is NOT in anything the script printed", !good.out.includes(KEY) && !good.out.includes("TestKey_0123"), good.out);
    ok("the file is mode 600", (statSync(env).mode & 0o777) === 0o600, (statSync(env).mode & 0o777).toString(8));
    const lines = readFileSync(env, "utf8").trimEnd().split("\n");
    ok("it holds exactly the URL, the key and the memory setting", lines.length === 3 && lines[0] === "NEXT_PUBLIC_SUPABASE_URL=https://mbsxeyoxojcqetrmwgba.supabase.co" && lines[1] === `SUPABASE_SERVICE_ROLE_KEY=${KEY}` && lines[2] === "NODE_OPTIONS=--max-old-space-size=1536", lines.join(" | ").replace(KEY, "<key>"));
    ok("no temporary copy of the file is left behind", readdirSync(dir).join() === "funder-loader.env", readdirSync(dir).join());
    const keep = run("\n");
    ok("run again, an empty answer keeps the stored key (re-running the script is safe)", keep.code === 0 && readFileSync(env, "utf8").includes(KEY), keep.out);
    const KEY2 = "sb_secret_Second_Key_999";
    const swap = run(`${KEY2}\n`);
    ok("a new key replaces the old one, and the old one is gone", swap.code === 0 && readFileSync(env, "utf8").includes(KEY2) && !readFileSync(env, "utf8").includes(KEY) && (statSync(env).mode & 0o777) === 0o600);
    writeFileSync(env, `NEXT_PUBLIC_SUPABASE_URL=x\nSUPABASE_SERVICE_ROLE_KEY=${KEY}\nNODE_OPTIONS=--max-old-space-size=4096\n`);
    run("\n");
    ok("a kept file is brought to the current memory setting without touching the key", /NODE_OPTIONS=--max-old-space-size=1536/.test(readFileSync(env, "utf8")) && readFileSync(env, "utf8").includes(KEY));
    rmSync(dir, { recursive: true, force: true });

    // reading of the source: the key goes nowhere but the file
    const keyLines = setupText.split("\n").filter((l) => /\$\{?newkey\}?/.test(l) && !/^\s*#/.test(l));
    const leaks = keyLines.filter((l) => /\b(echo|say|cat|tee)\b[^;|]*\$\{?newkey/.test(l));
    ok("in the setup script the key variable is never passed to echo, say, cat or tee", leaks.length === 0, leaks.join("\n"));
    ok("the prompt is hidden (read -r -s) and reads from the terminal", /read -r -s -p .* newkey <\/dev\/tty/.test(setupText));
    ok("the key is written with printf builtin, never on a command line another user could list", /printf 'SUPABASE_SERVICE_ROLE_KEY=%s\\n' "\$newkey"/.test(setupText) && !/(--key|-k) *["']?\$newkey/.test(setupText));
    ok("the file is created under umask 077 and chmod 600, owned by root", /umask 077/.test(setupText) && /chmod 600 "\$tmp"/.test(setupText) && /chown root:root "\$tmp"/.test(setupText));
  }

  section("6. no token, no pipe-to-shell, nothing started by itself");
  {
    ok("no GitHub token is asked for, embedded or used", !/ghp_|github_pat_|GITHUB_TOKEN|x-access-token|https:\/\/[^ ]*@github\.com/.test(setupText));
    ok("the clone is over SSH with the generated deploy key", /git@github\.com:aisubsmbugua-byte\/fundraising-ai\.git/.test(setupText) && /ssh-keygen -q -t ed25519/.test(setupText) && /IdentitiesOnly=yes/.test(setupText));
    ok("GitHub's SSH host key is pinned, not trusted on first use", /GITHUB_HOSTKEY="github\.com ssh-ed25519 AAAA/.test(setupText) && /StrictHostKeyChecking=yes/.test(setupText) && !/StrictHostKeyChecking=no/.test(setupText) && !/ssh-keyscan/.test(setupText));
    ok("no download is piped into a shell", !/curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(setupText));
    ok("the deploy key flow tells the owner exactly where in GitHub and to leave write access off", /Settings\s+->\s+Deploy keys\s+->\s+Add deploy key/.test(setupText) && /Allow write access' UNCHECKED/.test(setupText));
    const executed = setupText.split("\n").filter((l) => /^\s*(act |as_svc )?systemctl (start|restart|enable --now)/.test(l));
    ok("the only systemctl start the script executes is the TIMER's; the loader service is never started by it", executed.every((l) => /funder-loader-refresh\.timer/.test(l)) && executed.length === 1, executed.join("\n"));
    ok("Node 22, a long-term-support line that this code ran on, is what is installed", /NODE_MAJOR="22"/.test(setupText));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { engines?: { node?: string } };
    ok("the repository declares no Node engine range that excludes it", !pkg.engines?.node || /^>=?\s*(1[89]|2\d)/.test(pkg.engines.node), String(pkg.engines?.node));
    ok("a 4 GB swap file is added", /SWAP_GB="4"/.test(setupText) && /swapon/.test(setupText) && /\/etc\/fstab/.test(setupText));
    ok("the wrapper uses only flags the scripts it calls really have", ["--index-only", "--zips-only", "--parallel", "--out"].every((f) => readFileSync(join(root, "scripts/fetch-funder-reference-sources.ts"), "utf8").includes(f)) && ["--work-dir", "--index-dir", "--archives-dir", "--target", "--confirm-write-to-supabase"].every((f) => readFileSync(join(root, "scripts/load-all-states.ts"), "utf8").includes(f)));
    ok("the fetch script replaces an index file whole and does not trust a HEAD size for it (the IRS reported 21,699,229 for a 72,228,246-byte file on 2026-11-09)", (() => { const f = readFileSync(join(root, "scripts/fetch-funder-reference-sources.ts"), "utf8"); return /async function fetchIndex/.test(f) && /unlinkSync\(dest\)/.test(f) && /if \(dest\.endsWith\("\.csv"\)\) return fetchIndex/.test(f) && /"accept-encoding": "identity"/.test(f) && /does not end at the end of a line/.test(f); })());
    ok("the wrapper replaces the index files whole (staged, then moved), never appends to them", /staging/.test(runText) && /mv -f/.test(runText));
    ok("a failed download exits 5 so that systemd, and only for that, retries by itself", (runText.match(/exit 5/g) ?? []).length >= 3);
    ok("the memory setting the service uses is the one the memory suite proves", /NODE_HEAP_MB="1536"/.test(setupText) && /max-old-space-size=1536/.test(readFileSync(join(root, "scripts/test-funder-reference-memory.ts"), "utf8")));
  }

  section("7. the status command reads the run table");
  {
    const dir = mkdtempSync(join(tmpdir(), "fr-status-"));
    const store = pgliteRunStore(async () => (await openReferenceDb(join(dir, "db"))).db as never);
    const none = spawnSync(process.execPath, [...process.execArgv, join(root, "scripts/all-states-status.ts"), "--target", `pglite:${join(dir, "db")}`], { encoding: "utf8", cwd: root });
    ok("before anything has run it says so", none.status === 0 && /never run/.test(String(none.stdout)), String(none.stdout) + String(none.stderr));
    await store.writeSupervisor({
      status: "failed",
      counts: { states: { NY: { status: "complete", note: "150 of 5000 funders verified", updated_at: "t" }, TX: { status: "not_verified", note: "1 unexplained mismatch(es) in the sample", updated_at: "t" }, CA: { status: "not_reached", updated_at: "t" } }, halted: { state: "TX", reason: "1 unexplained mismatch(es) in the sample" }, updated_at: "2026-11-10T00:00:00Z" },
      notes: "HALTED at TX: 1 unexplained mismatch(es) in the sample",
      parameters: { kind: "all_states_supervisor" },
      begin: true,
    });
    await store.release();
    const shown = spawnSync(process.execPath, [...process.execArgv, join(root, "scripts/all-states-status.ts"), "--target", `pglite:${join(dir, "db")}`], { encoding: "utf8", cwd: root });
    const out = String(shown.stdout);
    ok("it shows FAILED, where it stopped and why, and every state with its status", shown.status === 0 && /status:\s+FAILED/.test(out) && /STOPPED at TX/.test(out) && /NY\s+complete/.test(out) && /TX\s+not_verified/.test(out) && /CA\s+not_reached/.test(out), out);
    ok("it names the standing row it read", SUPERVISOR_RUN_ID.length === 36);
    const noKey = spawnSync(process.execPath, [...process.execArgv, join(root, "scripts/all-states-status.ts"), "--target", "supabase"], { encoding: "utf8", cwd: root, env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: "", NEXT_PUBLIC_SUPABASE_URL: "" } });
    ok("against the hosted database without a key it stops with a plain message", noKey.status === 2 && /Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/.test(String(noKey.stderr)));
    const st = readFileSync(STATUS, "utf8");
    ok("the status wrapper reads the key file only to hand it to the one command, and prints nothing from it", /\. "\$ENV_FILE"/.test(st) && !/\b(echo|printf|cat)\b[^\n]*(\$\{?SUPABASE_SERVICE_ROLE_KEY|\bcat\b[^\n]*ENV_FILE)/.test(st));
    ok("it needs the key file to be readable and says to use sudo when it is not", /cannot read \$ENV_FILE \(run this with sudo\)/.test(st));
    mkdirSync(join(dir, "x"), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
