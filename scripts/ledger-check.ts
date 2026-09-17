// Verifies the decision/build ledger protocol.
//
// The protocol exists because a rule held only in a prompt drifts, silently.
// Measured prompt-only compliance on this codebase is 52-80%, which is why the
// Research Agent selects evidence_ids instead of writing quotes. The same logic
// applies to a working agreement between two sessions: if nothing checks it,
// it degrades to a suggestion, and it degrades exactly when the work is
// interesting enough that someone wants to skip the step.
//
// The headline check is the last one: code changed in a governed area with no
// ruling authorizing it. That is the governing rule -- translate the failure
// into a general invariant BEFORE changing code -- made mechanical.
//
//   npx tsx scripts/ledger-check.ts          check, exit 1 on violation
//   npx tsx scripts/ledger-check.ts --quiet   print only on violation (hook use)
//   npx tsx scripts/ledger-check.ts --seal    record settled hashes + baseline

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "docs", "ledger");
const RULINGS = join(LEDGER, "rulings");
const SEAL_FILE = join(RULINGS, ".settled.json");
const BASELINE_FILE = join(LEDGER, ".baseline.json");

const quiet = process.argv.includes("--quiet");
const seal = process.argv.includes("--seal");

const violations: string[] = [];
const warnings: string[] = [];
const fail = (m: string) => violations.push(m);
const warn = (m: string) => warnings.push(m);

// Paths the ledger does not govern. Writing a ruling is never itself an
// unauthorized change, and neither is reporting on work already done.
const UNGOVERNED = [/^docs\//, /^README/, /^\.claude\//, /^scripts\/ledger-check\.ts$/];
const isGoverned = (p: string) => !UNGOVERNED.some((r) => r.test(p));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// --- rulings ---------------------------------------------------------------

type Ruling = {
  file: string;
  id: string;
  title: string;
  status: string;
  provenance: string;
  supersedes: string;
  body: string;
};

function parseRuling(file: string): Ruling | null {
  const raw = readFileSync(join(RULINGS, file), "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) {
    fail(`rulings/${file}: no front matter block`);
    return null;
  }
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  for (const k of ["id", "title", "status", "provenance"]) {
    if (!meta[k]) fail(`rulings/${file}: front matter missing "${k}"`);
  }
  if (meta.status && !["proposed", "settled", "superseded"].includes(meta.status)) {
    fail(`rulings/${file}: status "${meta.status}" is not proposed | settled | superseded`);
  }
  if (meta.provenance && !["verbatim", "reconstructed"].includes(meta.provenance)) {
    fail(`rulings/${file}: provenance "${meta.provenance}" is not verbatim | reconstructed`);
  }
  if (meta.id && !file.startsWith(meta.id)) {
    fail(`rulings/${file}: id ${meta.id} does not match its filename`);
  }
  return {
    file, body: m[2],
    id: meta.id ?? "", title: meta.title ?? "", status: meta.status ?? "",
    provenance: meta.provenance ?? "", supersedes: meta.supersedes ?? "",
  };
}

if (!existsSync(RULINGS)) {
  fail("docs/ledger/rulings/ does not exist");
}

const rulings = existsSync(RULINGS)
  ? readdirSync(RULINGS).filter((f) => f.endsWith(".md")).sort()
      .map(parseRuling).filter((r): r is Ruling => r !== null)
  : [];

const byId = new Map<string, Ruling>();
for (const r of rulings) {
  if (byId.has(r.id)) fail(`ruling id ${r.id} is used by both ${byId.get(r.id)!.file} and ${r.file}`);
  byId.set(r.id, r);
}

// A ruling changes by being superseded, never by being rewritten -- so a
// superseding ruling must point at one that exists and must actually retire it.
for (const r of rulings) {
  if (!r.supersedes) continue;
  const target = byId.get(r.supersedes);
  if (!target) fail(`rulings/${r.file}: supersedes ${r.supersedes}, which does not exist`);
  else if (target.status !== "superseded") {
    fail(`rulings/${r.file} supersedes ${r.supersedes}, but ${target.file} is still "${target.status}"`);
  }
}

// --- immutability ----------------------------------------------------------
// Once settled, a ruling's text is fixed. An edit after the fact rewrites what
// was decided, which is the failure mode this whole structure exists to stop.

const sealed: Record<string, string> = existsSync(SEAL_FILE)
  ? JSON.parse(readFileSync(SEAL_FILE, "utf8"))
  : {};

if (seal) {
  const next: Record<string, string> = {};
  for (const r of rulings) if (r.status === "settled") next[r.id] = sha(r.body);
  writeFileSync(SEAL_FILE, JSON.stringify(next, null, 2) + "\n");

  let changed: string[] = [];
  try {
    changed = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((l) => l.slice(3).trim()).filter(Boolean).filter(isGoverned);
  } catch { /* not a git repo */ }
  writeFileSync(BASELINE_FILE, JSON.stringify({ note: "Uncommitted governed paths at ledger creation. Grandfathered -- predates the protocol.", paths: changed.sort() }, null, 2) + "\n");

  console.log(`sealed ${Object.keys(next).length} settled ruling(s); baselined ${changed.length} pre-existing path(s)`);
  process.exit(0);
}

for (const r of rulings) {
  if (r.status !== "settled") continue;
  const recorded = sealed[r.id];
  if (!recorded) warn(`ruling ${r.id} is settled but unsealed — run ledger-check --seal`);
  else if (recorded !== sha(r.body)) {
    fail(`ruling ${r.id} (${r.file}) was EDITED after being settled. A settled ruling is immutable — supersede it with a new one instead.`);
  }
  if (r.provenance === "reconstructed") {
    warn(`ruling ${r.id} is reconstructed, not verbatim — confirm it in the decision space before relying on it`);
  }
}

// --- STATE.md --------------------------------------------------------------

const statePath = join(LEDGER, "STATE.md");
let authorizedRuling = "none";
let openItems: { id: string; owner: string }[] = [];

if (!existsSync(statePath)) {
  fail("docs/ledger/STATE.md does not exist — there is no handoff file");
} else {
  const state = readFileSync(statePath, "utf8");

  const authBlock = state.match(/##\s*Authorized now\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
  if (!authBlock) fail("STATE.md has no '## Authorized now' section");
  else {
    const rm = authBlock[1].match(/^-\s*ruling:\s*(.+)$/m);
    if (!rm) fail("STATE.md '## Authorized now' has no '- ruling:' line");
    else {
      authorizedRuling = rm[1].trim();
      if (authorizedRuling !== "none" && !byId.has(authorizedRuling)) {
        fail(`STATE.md authorizes ruling ${authorizedRuling}, which does not exist`);
      } else if (authorizedRuling !== "none" && byId.get(authorizedRuling)!.status === "proposed") {
        fail(`STATE.md authorizes ruling ${authorizedRuling}, which is still "proposed" — a proposal does not authorize work`);
      }
    }
  }

  const openBlock = state.match(/##\s*Open items\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
  if (!openBlock) fail("STATE.md has no '## Open items' section");
  else {
    for (const line of openBlock[1].split(/\r?\n/)) {
      const cells = line.split("|").map((c) => c.trim());
      // id | owner | subject | opened  -> leading and trailing empties from the pipes
      if (cells.length < 5) continue;
      const [, id, owner] = cells;
      if (!/^\d+$/.test(id)) continue; // header and separator rows
      openItems.push({ id, owner });
      if (!["decision", "build"].includes(owner)) {
        fail(`STATE.md item ${id}: owner "${owner}" is not decision | build. An unowned item is one both spaces think the other is doing.`);
      }
    }
    if (openItems.length === 0) warn("STATE.md has no open items — verify that is actually true");
  }
}

// --- the check with teeth --------------------------------------------------
// Code changed in a governed area, with nothing authorizing it.

const baseline: string[] = existsSync(BASELINE_FILE)
  ? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")).paths ?? [])
  : [];

let unauthorized: string[] = [];
try {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  unauthorized = dirty.filter(isGoverned).filter((p) => !baseline.includes(p));
} catch {
  warn("not a git repository — cannot check for unauthorized code changes");
}

if (unauthorized.length && authorizedRuling === "none") {
  fail(
    `${unauthorized.length} governed path(s) changed with no ruling authorizing it:\n` +
    unauthorized.map((p) => `        ${p}`).join("\n") +
    `\n      Set '- ruling:' in STATE.md '## Authorized now', or revert. ` +
    `A code change without a ruling is the case-by-case patching that ruling 0001 exists to stop.`
  );
}

// --- report ----------------------------------------------------------------

const clean = violations.length === 0;
if (!(quiet && clean && warnings.length === 0)) {
  if (!quiet || !clean) {
    console.log(`\nledger: ${rulings.length} ruling(s), ${openItems.length} open item(s), authorized: ${authorizedRuling}`);
  }
  for (const w of warnings) console.log(`  warn  ${w}`);
  for (const v of violations) console.log(`  FAIL  ${v}`);
  if (clean) console.log(`\n  ok    protocol intact`);
  else console.log(`\n${violations.length} violation(s)`);
}

process.exit(clean ? 0 : 1);
