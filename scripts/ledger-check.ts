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
//   npx tsx scripts/ledger-check.ts                    check, exit 1 on violation
//   npx tsx scripts/ledger-check.ts --quiet            print only on violation (hook use)
//   npx tsx scripts/ledger-check.ts --seal             record settled ruling hashes, and nothing else
//   npx tsx scripts/ledger-check.ts --baseline --reason "..."
//                                                      exempt today's dirty governed paths, dated and justified
//
// --seal and --baseline are both decision-space-only. They are two commands
// because ruling 0014 found that one command doing both silently discarded the
// grandfather list every time a ruling was settled.
//
// Rules enforced here, and the ruling each comes from:
//
//   0012  rulings/.confirmed.json is a separate three-valued register;
//         `reconstructed` + `unconfirmed` warns, `refuted` fails, --seal never
//         touches it.
//   0014  --seal records ruling hashes only; --baseline carries a date and a
//         reason; .baseline.json distinguishes grandfathered from exempted.
//   0015  STATE.md's status column is one of six, decision items may only use
//         the first two, anything past `implemented` names its evidence, and
//         `released` is checked against the deployed branch.
//   0018  every repo path cited in docs/** exists.
//   0020  every migration ahead of the deployed branch is additive, checked
//         statically rather than trusted from a comment.
//
// The module exports its checks so scripts/test-ledger-check.ts can drive them
// against fixtures. Nothing here runs on import.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, dirname, basename, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The branch Vercel deploys. Ruling 0020: "landed" means present here, not
// present in the working tree.
export const DEPLOYED_BRANCH = "main";

export const WORK_STATES = [
  "proposed",
  "approved",
  "implemented",
  "tested",
  "released",
  "verified",
] as const;
export type WorkState = (typeof WORK_STATES)[number];

// Decision items describe a direction, not code, so the code states do not
// apply to them (ruling 0015).
export const DECISION_STATES: string[] = ["proposed", "approved"];

export const VERDICTS = ["unconfirmed", "confirmed", "refuted"] as const;
export type Verdict = (typeof VERDICTS)[number];

// Paths the ledger does not govern. Writing a ruling is never itself an
// unauthorized change, and neither is reporting on work already done.
const UNGOVERNED = [/^docs\//, /^README/, /^\.claude\//, /^scripts\/ledger-check\.ts$/];
export const isGoverned = (p: string) => !UNGOVERNED.some((r) => r.test(p));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const today = () => new Date().toISOString().slice(0, 10);

// --- git ------------------------------------------------------------------
// Isolated behind a port so the checks can be driven against fixtures that are
// not git repositories.

export type GitPort = {
  /** Uncommitted paths, or null when this is not a git repository. */
  dirtyPaths(): string[] | null;
  /** Migration files present here and absent from the deployed branch. */
  migrationsAheadOfDeployed(): string[];
  existsOnDeployed(path: string): boolean;
  isAncestorOfDeployed(sha: string): boolean;
};

export function realGit(root: string): GitPort {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    dirtyPaths() {
      try {
        return git(["status", "--porcelain"])
          .split("\n")
          .map((l) => l.slice(3).trim())
          .filter(Boolean);
      } catch {
        return null;
      }
    },
    migrationsAheadOfDeployed() {
      try {
        return git([
          "diff",
          "--name-only",
          `${DEPLOYED_BRANCH}...HEAD`,
          "--",
          "supabase/migrations/",
        ])
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    existsOnDeployed(path) {
      try {
        git(["cat-file", "-e", `${DEPLOYED_BRANCH}:${path}`]);
        return true;
      } catch {
        return false;
      }
    },
    isAncestorOfDeployed(sha) {
      try {
        git(["merge-base", "--is-ancestor", sha, DEPLOYED_BRANCH]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// --- rulings ---------------------------------------------------------------

export type Ruling = {
  file: string;
  id: string;
  title: string;
  status: string;
  provenance: string;
  supersedes: string;
  body: string;
};

type Sink = { fail(m: string): void; warn(m: string): void };

function parseRuling(rulingsDir: string, file: string, out: Sink): Ruling | null {
  const raw = readFileSync(join(rulingsDir, file), "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) {
    out.fail(`rulings/${file}: no front matter block`);
    return null;
  }
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  for (const k of ["id", "title", "status", "provenance"]) {
    if (!meta[k]) out.fail(`rulings/${file}: front matter missing "${k}"`);
  }
  if (meta.status && !["proposed", "settled", "superseded"].includes(meta.status)) {
    out.fail(`rulings/${file}: status "${meta.status}" is not proposed | settled | superseded`);
  }
  if (meta.provenance && !["verbatim", "reconstructed"].includes(meta.provenance)) {
    out.fail(`rulings/${file}: provenance "${meta.provenance}" is not verbatim | reconstructed`);
  }
  if (meta.id && !file.startsWith(meta.id)) {
    out.fail(`rulings/${file}: id ${meta.id} does not match its filename`);
  }
  return {
    file,
    body: m[2],
    id: meta.id ?? "",
    title: meta.title ?? "",
    status: meta.status ?? "",
    provenance: meta.provenance ?? "",
    supersedes: meta.supersedes ?? "",
  };
}

export function readRulings(rulingsDir: string, out: Sink): Ruling[] {
  if (!existsSync(rulingsDir)) return [];
  return readdirSync(rulingsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseRuling(rulingsDir, f, out))
    .filter((r): r is Ruling => r !== null);
}

// --- .baseline.json (ruling 0014) ------------------------------------------
//
// Two kinds of entry, and they are not the same fact:
//
//   grandfathered  uncommitted governed paths that predate the protocol. Frozen
//                  at ledger creation; never re-derived by any command.
//   exempted       anything exempted since, each carrying the date it was
//                  exempted and the reason. Written only by --baseline.
//
// The old schema was a flat { note, paths } list, which could not tell the two
// apart -- and --seal rewrote it wholesale every time a ruling was settled.

export type BaselineFile = {
  grandfathered: { note: string; date?: string; paths: string[] };
  exempted: { path: string; date: string; reason: string }[];
};

export type BaselineRead = { exempt: Set<string>; legacy: boolean; file: BaselineFile | null };

export function readBaseline(baselinePath: string, out?: Sink): BaselineRead {
  if (!existsSync(baselinePath)) return { exempt: new Set(), legacy: false, file: null };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (e) {
    out?.fail(`.baseline.json is not valid JSON: ${(e as Error).message}`);
    return { exempt: new Set(), legacy: false, file: null };
  }

  // Legacy flat schema, kept readable so an un-migrated checkout still guards
  // the same paths rather than silently guarding none.
  if (Array.isArray(parsed?.paths) && !parsed.grandfathered) {
    out?.warn(
      `.baseline.json is in the pre-0014 flat schema — a path grandfathered at ledger creation cannot be told from one exempted later. Migrate it to { grandfathered, exempted }.`,
    );
    return { exempt: new Set(parsed.paths as string[]), legacy: true, file: null };
  }

  const file: BaselineFile = {
    grandfathered: {
      note: parsed?.grandfathered?.note ?? "",
      date: parsed?.grandfathered?.date,
      paths: Array.isArray(parsed?.grandfathered?.paths) ? parsed.grandfathered.paths : [],
    },
    exempted: Array.isArray(parsed?.exempted) ? parsed.exempted : [],
  };

  const exempt = new Set<string>(file.grandfathered.paths);
  for (const e of file.exempted) {
    if (!e || typeof e.path !== "string" || !e.path) {
      out?.fail(`.baseline.json: an "exempted" entry has no path`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "")) {
      out?.fail(`.baseline.json: exemption for ${e.path} has no ISO date — ruling 0014 requires one`);
    }
    if (!e.reason || !String(e.reason).trim()) {
      out?.fail(`.baseline.json: exemption for ${e.path} names no reason — ruling 0014 requires one`);
    }
    exempt.add(e.path);
  }
  return { exempt, legacy: false, file };
}

// --- rulings/.confirmed.json (ruling 0012) ---------------------------------
//
// Keyed by ruling id. Flat, so the file reads as "what do we know about each
// ruling" with nothing else in it:
//
//   { "0005": { "verdict": "unconfirmed", "checked_against": null, "date": null } }
//
// provenance says how a ruling was written and never changes; this says whether
// anybody has since checked it against an artifact. One field cannot carry both.
// Written only by the decision space -- no command in this script writes it.

export type Confirmation = {
  verdict: string;
  checked_against?: string | null;
  date?: string | null;
};

export function readConfirmations(
  confirmedPath: string,
  knownIds: Set<string>,
  out: Sink,
): Map<string, Confirmation> {
  const map = new Map<string, Confirmation>();
  if (!existsSync(confirmedPath)) return map;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(confirmedPath, "utf8"));
  } catch (e) {
    out.fail(`rulings/.confirmed.json is not valid JSON: ${(e as Error).message}`);
    return map;
  }
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (!/^\d{4}$/.test(key)) {
      out.fail(`rulings/.confirmed.json: key "${key}" is not a ruling id`);
      continue;
    }
    if (!knownIds.has(key)) {
      out.fail(`rulings/.confirmed.json: entry ${key} names a ruling that does not exist`);
      continue;
    }
    const entry = value as Confirmation;
    if (!entry || typeof entry !== "object" || typeof entry.verdict !== "string") {
      out.fail(`rulings/.confirmed.json: entry ${key} has no verdict`);
      continue;
    }
    if (!(VERDICTS as readonly string[]).includes(entry.verdict)) {
      out.fail(
        `rulings/.confirmed.json: entry ${key} verdict "${entry.verdict}" is not ${VERDICTS.join(" | ")}`,
      );
      continue;
    }
    if (entry.verdict !== "unconfirmed" && !String(entry.checked_against ?? "").trim()) {
      out.fail(
        `rulings/.confirmed.json: entry ${key} is "${entry.verdict}" but names no artifact it was checked against — a verdict without an artifact is an opinion (ruling 0018)`,
      );
    }
    map.set(key, entry);
  }
  return map;
}

// --- repo index, for citation resolution -----------------------------------

const WALK_SKIP = new Set(["node_modules", ".git", ".next", ".vercel", "out", "dist"]);

function walk(dir: string, onFile: (abs: string) => void, onDir?: (abs: string) => void) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (WALK_SKIP.has(e)) continue;
    const abs = join(dir, e);
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      onDir?.(abs);
      walk(abs, onFile, onDir);
    } else onFile(abs);
  }
}

// --- 0018: every repo path cited in docs/** exists -------------------------
//
// Scope, stated so the report does not overclaim: this checks *paths*. Table
// names and code symbols are not checked -- see the build report for the
// measurement that says why, and the STATE item raised on it.
//
// A citation is a backticked token that looks like a repo path. Deliberately
// conservative, because this runs on a Stop hook every turn and a check that
// cries wolf stops being read:
//
//   skipped  URL routes (`/login`), globs and placeholders (`NNNN-*.md`),
//            dot-directories (`.claude/plans/` — local tooling state, and the
//            doc citing it says so), and a bare extension (`.ts`).
//
// Fenced code blocks are skipped too. A fence holds quoted output, a sample, or
// a command someone ran -- it is a transcript, not the document asserting that
// a file is there. Inline backticks in prose are the assertion, and those are
// what gets checked.
//
// Resolution ladder, any hit counts: repo root, the citing document's own
// directory, docs/, any file or directory with that basename anywhere in the
// repo, and a numeric-prefix reference (`decisions/0002`).

const DOC_EXT = /\.(ts|tsx|sql|md|json|mjs|js|jsx|css|py|sh|yml|yaml)$/;
const TOKEN_CHARS = /^[A-Za-z0-9_@.\-/()[\]]+$/;

export type Citation = { doc: string; line: number; token: string };

export function collectCitations(root: string): Citation[] {
  const docsDir = join(root, "docs");
  if (!existsSync(docsDir)) return [];
  const out: Citation[] = [];
  walk(docsDir, (abs) => {
    if (!abs.endsWith(".md")) return;
    const rel = relative(root, abs);
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    let fenced = false;
    lines.forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      for (const m of ln.matchAll(/`([^`\n]+)`/g)) {
        const token = m[1];
        if (!TOKEN_CHARS.test(token)) continue;
        if (token.startsWith("/")) continue; // a URL route, not a file
        if (/[*<>]/.test(token) || token.includes("NNNN")) continue; // glob or placeholder
        if (/^\.[A-Za-z0-9_-]+\//.test(token)) continue; // .claude/ and friends
        if (/^\.[a-z]+$/.test(token)) continue; // a bare extension
        if (!(token.includes("/") || DOC_EXT.test(token))) continue;
        out.push({ doc: rel, line: i + 1, token });
      }
    });
  });
  return out;
}

export function checkCitations(root: string, out: Sink): { checked: number; unresolved: Citation[] } {
  const citations = collectCitations(root);
  if (citations.length === 0) return { checked: 0, unresolved: [] };

  const byBase = new Map<string, string[]>();
  const record = (abs: string) => {
    const rel = relative(root, abs);
    const b = basename(rel);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b)!.push(rel);
  };
  walk(root, record, record);

  const unresolved: Citation[] = [];
  for (const c of citations) {
    const bare = c.token.replace(/:\d+(?:-\d+)?$/, "").replace(/\/+$/, "");
    if (!bare) continue;
    const candidates = [
      join(root, bare),
      join(root, dirname(c.doc), bare),
      join(root, "docs", bare),
    ];
    if (candidates.some((p) => existsSync(p))) continue;
    if (byBase.has(basename(bare))) continue;

    // `decisions/0002` — a numbered document referenced by its number.
    const numbered = bare.match(/^(.*)\/(\d{4})$/);
    if (numbered) {
      const [, dir, num] = numbered;
      const dirs = [join(root, dir), join(root, dirname(c.doc), dir), join(root, "docs", dir)];
      const hit = dirs.some((d) => {
        try {
          return readdirSync(d).some((f) => f.startsWith(`${num}-`) || f.startsWith(`${num}_`));
        } catch {
          return false;
        }
      });
      if (hit) continue;
    }
    unresolved.push(c);
  }

  for (const c of unresolved) {
    out.fail(
      `${c.doc}:${c.line} cites \`${c.token}\`, which does not exist. Ruling 0018: a name is not evidence — cite the artifact you opened, or say "not checked".`,
    );
  }
  return { checked: citations.length, unresolved };
}

// --- 0020: a migration ahead of the deployed branch must be additive -------
//
// Checked statically. The ruling is explicit that a comment claiming a
// migration is additive is not evidence that it is.

/** Strip -- comments, /* *​/ comments, '...' literals and $$...$$ bodies. */
export function stripSql(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/\s+/g, " ");
}

export function additiveViolations(sql: string): string[] {
  const s = stripSql(sql).toLowerCase();
  const found: string[] = [];
  if (/\bdrop\s+column\b/.test(s)) found.push("drop column");
  if (/\bdrop\s+table\b/.test(s)) found.push("drop table");
  if (/\brename\b/.test(s)) found.push("rename");
  if (/\balter\s+column\s+[a-z0-9_"]+\s+(?:set\s+data\s+)?type\b/.test(s)) found.push("alter column … type");
  if (/\balter\s+[a-z0-9_"]+\s+type\b/.test(s)) found.push("alter column … type");

  // A new column on an EXISTING table must be nullable or carry a default.
  // Columns inside `create table` are exempt: a brand-new table has no existing
  // rows for a not-null to break (this is why qualification_stages passes).
  for (const m of s.matchAll(/\badd\s+column\b(.*?)(?=,\s*add\s+column\b|;|$)/g)) {
    const frag = m[1];
    if (/\bnot\s+null\b/.test(frag) && !/\bdefault\b/.test(frag)) {
      const name = frag.trim().replace(/^if\s+not\s+exists\s+/, "").split(/\s+/)[0] ?? "?";
      found.push(`not null without default on new column "${name}"`);
    }
  }
  return [...new Set(found)];
}

export function checkMigrations(root: string, git: GitPort, out: Sink): { ahead: string[] } {
  const ahead = git.migrationsAheadOfDeployed();
  for (const rel of ahead) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue; // deleted here; nothing to run
    const bad = additiveViolations(readFileSync(abs, "utf8"));
    if (bad.length) {
      out.fail(
        `${rel} is ahead of ${DEPLOYED_BRANCH} and is not additive: ${bad.join("; ")}. Ruling 0020 clause 3 — a non-additive migration is not applied until its code is on the deployed branch.`,
      );
    }
  }
  return { ahead };
}

// --- STATE.md open items (ruling 0015) -------------------------------------

export type OpenItem = {
  id: string;
  owner: string;
  status: string;
  subject: string;
  opened: string;
};

export function parseOpenItems(block: string): OpenItem[] {
  const items: OpenItem[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 7) continue;
    const [, id, owner, status] = cells;
    if (!/^\d+$/.test(id)) continue; // header and separator rows
    const opened = cells[cells.length - 2];
    const subject = cells.slice(4, cells.length - 2).join("|");
    items.push({ id, owner, status, subject, opened });
  }
  return items;
}

const REPO_PATH_RE = /\b[\w@.\-/()[\]]*[\w)\]]\.(?:ts|tsx|sql|mjs|js|jsx|json|md|py|sh)\b/g;
const SHA_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/** Anything past `implemented` names what was run, merged or observed. */
export function namesEvidence(subject: string): boolean {
  if (REPO_PATH_RE.test(subject)) {
    REPO_PATH_RE.lastIndex = 0;
    return true;
  }
  REPO_PATH_RE.lastIndex = 0;
  if (/\bmigrations?\s+\d{4}\b/i.test(subject)) return true;
  if (/\b\d+\s*(?:→|->|to)\s*\d+\s+(?:passing|tests?)\b/i.test(subject)) return true;
  if (/\b\d+\s+(?:passing|tests?|of\s+\d+)\b/i.test(subject)) return true;
  const shas = subject.match(SHA_RE);
  if (shas && shas.length) return true;
  return false;
}

export function citedMigrationNumbers(subject: string): string[] {
  const nums = new Set<string>();
  for (const m of subject.matchAll(/\bmigrations?\s+(\d{4})\s*[–—-]\s*(\d{4})\b/gi)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    for (let n = a; n <= b && n - a < 50; n++) nums.add(String(n).padStart(4, "0"));
  }
  for (const m of subject.matchAll(/\bmigrations?\s+(\d{4})\b/gi)) nums.add(m[1]);
  return [...nums];
}

// --- the whole check -------------------------------------------------------

export type LedgerResult = {
  violations: string[];
  warnings: string[];
  rulingCount: number;
  openItemCount: number;
  authorizedRuling: string;
  citationsChecked: number;
  migrationsAhead: number;
};

export function runLedger(root: string, git: GitPort): LedgerResult {
  const LEDGER = join(root, "docs", "ledger");
  const RULINGS = join(LEDGER, "rulings");
  const SEAL_FILE = join(RULINGS, ".settled.json");
  const CONFIRMED_FILE = join(RULINGS, ".confirmed.json");
  const BASELINE_FILE = join(LEDGER, ".baseline.json");

  const violations: string[] = [];
  const warnings: string[] = [];
  const out: Sink = {
    fail: (m) => violations.push(m),
    warn: (m) => warnings.push(m),
  };

  if (!existsSync(RULINGS)) out.fail("docs/ledger/rulings/ does not exist");
  const rulings = readRulings(RULINGS, out);

  const byId = new Map<string, Ruling>();
  for (const r of rulings) {
    if (byId.has(r.id)) {
      out.fail(`ruling id ${r.id} is used by both ${byId.get(r.id)!.file} and ${r.file}`);
    }
    byId.set(r.id, r);
  }

  // A ruling changes by being superseded, never by being rewritten -- so a
  // superseding ruling must point at one that exists and must actually retire it.
  for (const r of rulings) {
    if (!r.supersedes) continue;
    const target = byId.get(r.supersedes);
    if (!target) out.fail(`rulings/${r.file}: supersedes ${r.supersedes}, which does not exist`);
    else if (target.status !== "superseded") {
      out.fail(
        `rulings/${r.file} supersedes ${r.supersedes}, but ${target.file} is still "${target.status}"`,
      );
    }
  }

  // --- immutability + confirmation (rulings 0012) --------------------------
  // Once settled, a ruling's text is fixed. An edit after the fact rewrites what
  // was decided, which is the failure mode this whole structure exists to stop.
  const sealed: Record<string, string> = existsSync(SEAL_FILE)
    ? JSON.parse(readFileSync(SEAL_FILE, "utf8"))
    : {};
  const confirmations = readConfirmations(CONFIRMED_FILE, new Set(byId.keys()), out);

  for (const r of rulings) {
    if (r.status !== "settled") continue;
    const recorded = sealed[r.id];
    if (!recorded) out.warn(`ruling ${r.id} is settled but unsealed — run ledger-check --seal`);
    else if (recorded !== sha256(r.body)) {
      out.fail(
        `ruling ${r.id} (${r.file}) was EDITED after being settled. A settled ruling is immutable — supersede it with a new one instead.`,
      );
    }

    const conf = confirmations.get(r.id);
    const verdict: Verdict = (conf?.verdict as Verdict) ?? "unconfirmed";

    // A refuted ruling is the urgent case and must not sit behind the quieter
    // one. It fails whatever its provenance, and is closed by a superseding
    // ruling rather than by an edit.
    if (verdict === "refuted") {
      out.fail(
        `ruling ${r.id} is REFUTED — checked against ${conf?.checked_against} and found to misstate what was decided. Supersede it; do not edit it, and do not rely on it meanwhile.`,
      );
    } else if (r.provenance === "reconstructed" && verdict === "unconfirmed") {
      out.warn(
        `ruling ${r.id} is reconstructed and unconfirmed — confirm it against an artifact and record the verdict in rulings/.confirmed.json`,
      );
    }
  }

  // --- STATE.md ------------------------------------------------------------

  const statePath = join(LEDGER, "STATE.md");
  let authorizedRuling = "none";
  let openItems: OpenItem[] = [];

  if (!existsSync(statePath)) {
    out.fail("docs/ledger/STATE.md does not exist — there is no handoff file");
  } else {
    const state = readFileSync(statePath, "utf8");

    const authBlock = state.match(/##\s*Authorized now\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
    if (!authBlock) out.fail("STATE.md has no '## Authorized now' section");
    else {
      const rm = authBlock[1].match(/^-\s*ruling:\s*(.+)$/m);
      if (!rm) out.fail("STATE.md '## Authorized now' has no '- ruling:' line");
      else {
        authorizedRuling = rm[1].trim();
        if (authorizedRuling !== "none" && !byId.has(authorizedRuling)) {
          out.fail(`STATE.md authorizes ruling ${authorizedRuling}, which does not exist`);
        } else if (
          authorizedRuling !== "none" &&
          byId.get(authorizedRuling)!.status === "proposed"
        ) {
          out.fail(
            `STATE.md authorizes ruling ${authorizedRuling}, which is still "proposed" — a proposal does not authorize work`,
          );
        }
      }
    }

    const openBlock = state.match(/##\s*Open items\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
    if (!openBlock) out.fail("STATE.md has no '## Open items' section");
    else {
      openItems = parseOpenItems(openBlock[1]);
      for (const item of openItems) {
        if (!["decision", "build"].includes(item.owner)) {
          out.fail(
            `STATE.md item ${item.id}: owner "${item.owner}" is not decision | build. An unowned item is one both spaces think the other is doing.`,
          );
        }
        checkItemStatus(item, root, git, out);
      }
      if (openItems.length === 0) out.warn("STATE.md has no open items — verify that is actually true");
    }
  }

  // --- 0018: citations -----------------------------------------------------
  const { checked: citationsChecked } = checkCitations(root, out);

  // --- 0020: migrations ahead of the deployed branch -----------------------
  const { ahead } = checkMigrations(root, git, out);

  // --- the check with teeth ------------------------------------------------
  // Code changed in a governed area, with nothing authorizing it.

  const { exempt } = readBaseline(BASELINE_FILE, out);
  const dirty = git.dirtyPaths();
  if (dirty === null) {
    out.warn("not a git repository — cannot check for unauthorized code changes");
  } else {
    const unauthorized = dirty.filter(isGoverned).filter((p) => !exempt.has(p));
    if (unauthorized.length && authorizedRuling === "none") {
      out.fail(
        `${unauthorized.length} governed path(s) changed with no ruling authorizing it:\n` +
          unauthorized.map((p) => `        ${p}`).join("\n") +
          `\n      Set '- ruling:' in STATE.md '## Authorized now', or revert. ` +
          `A code change without a ruling is the case-by-case patching that ruling 0001 exists to stop.`,
      );
    }
  }

  return {
    violations,
    warnings,
    rulingCount: rulings.length,
    openItemCount: openItems.length,
    authorizedRuling,
    citationsChecked,
    migrationsAhead: ahead.length,
  };
}

/** Ruling 0015, applied to one row of the open-items table. */
function checkItemStatus(item: OpenItem, root: string, git: GitPort, out: Sink) {
  const { id, owner, status, subject } = item;

  if (!(WORK_STATES as readonly string[]).includes(status)) {
    out.fail(
      `STATE.md item ${id}: status "${status}" is not one of ${WORK_STATES.join(" | ")} (ruling 0015)`,
    );
    return;
  }
  if (owner === "decision" && !DECISION_STATES.includes(status)) {
    out.fail(
      `STATE.md item ${id}: a decision-owned item cannot be "${status}" — the code states describe work, not direction (ruling 0015). Either it is build's, or it is ${DECISION_STATES.join(" | ")}.`,
    );
    return;
  }

  const rank = WORK_STATES.indexOf(status as WorkState);
  if (rank < WORK_STATES.indexOf("tested")) return;

  if (!namesEvidence(subject)) {
    out.fail(
      `STATE.md item ${id} claims "${status}" but its row names no evidence — no file, migration, commit or test result. An uncited state claim is "implemented" with a stronger adjective (ruling 0015).`,
    );
  }

  if (status !== "released") return;

  // Ruling 0015: released means merged to the deployed branch, OR applied to
  // the live database. The second is only legitimate for an additive migration
  // (ruling 0020 clause 3), and that is statically checkable, so both halves
  // are checked rather than taken on trust.
  let verifiable = 0;

  for (const num of citedMigrationNumbers(subject)) {
    const dir = join(root, "supabase", "migrations");
    let file: string | undefined;
    try {
      file = readdirSync(dir).find((f) => f.startsWith(`${num}_`) || f.startsWith(`${num}-`));
    } catch {
      /* no migrations directory */
    }
    if (!file) {
      out.fail(`STATE.md item ${id} claims "released" citing migration ${num}, which is not in supabase/migrations/`);
      continue;
    }
    verifiable++;
    const rel = `supabase/migrations/${file}`;
    if (git.existsOnDeployed(rel)) continue;
    const bad = additiveViolations(readFileSync(join(root, rel), "utf8"));
    if (bad.length) {
      out.fail(
        `STATE.md item ${id} claims "released" for ${rel}, which is not on ${DEPLOYED_BRANCH} and is not additive (${bad.join("; ")}). Ruling 0020 clause 3.`,
      );
    }
  }

  const paths = (subject.match(REPO_PATH_RE) ?? []).filter(
    (p) => !p.startsWith("supabase/migrations/") && existsSync(join(root, p)),
  );
  for (const p of paths) {
    verifiable++;
    if (!git.existsOnDeployed(p)) {
      out.fail(
        `STATE.md item ${id} claims "released" but ${p} is not on ${DEPLOYED_BRANCH} — it is on a feature branch. Ruling 0020 clause 1: landed means present on the deployed branch; this is "tested".`,
      );
    }
  }

  for (const s of subject.match(SHA_RE) ?? []) {
    verifiable++;
    if (!git.isAncestorOfDeployed(s)) {
      out.fail(
        `STATE.md item ${id} claims "released" citing commit ${s}, which is not an ancestor of ${DEPLOYED_BRANCH}.`,
      );
    }
  }

  if (verifiable === 0) {
    out.fail(
      `STATE.md item ${id} claims "released" but cites nothing checkable against ${DEPLOYED_BRANCH} — name the migration, the file or the commit (ruling 0015).`,
    );
  }
}

// --- the two decision-space commands ---------------------------------------

/**
 * Ruling 0014. Records the hash of every settled ruling. That is all it does --
 * it does not read, write or re-derive .baseline.json, and it does not touch
 * .confirmed.json (ruling 0012: sealing records what a ruling says, confirmation
 * records whether it is true, and one command must not do both).
 */
export function sealRulings(root: string): { sealed: number } {
  const RULINGS = join(root, "docs", "ledger", "rulings");
  const out: Sink = { fail: () => {}, warn: () => {} };
  const rulings = readRulings(RULINGS, out);
  const next: Record<string, string> = {};
  for (const r of rulings) if (r.status === "settled") next[r.id] = sha256(r.body);
  writeFileSync(join(RULINGS, ".settled.json"), JSON.stringify(next, null, 2) + "\n");
  return { sealed: Object.keys(next).length };
}

/**
 * Ruling 0014. The escape hatch, now behind its own flag and required to say
 * why. Appends today's dirty governed paths to `exempted`, each with a date and
 * a reason. Never rewrites `grandfathered`.
 */
export function addBaselineExemptions(
  root: string,
  reason: string,
  git: GitPort,
  when = today(),
): { added: string[]; alreadyExempt: string[] } {
  const BASELINE_FILE = join(root, "docs", "ledger", ".baseline.json");
  if (!reason || !reason.trim()) {
    throw new Error("--baseline requires --reason \"why this path is exempt\" (ruling 0014)");
  }
  const read = readBaseline(BASELINE_FILE);
  const file: BaselineFile = read.file ?? {
    grandfathered: { note: "", paths: [] },
    exempted: [],
  };
  const dirty = (git.dirtyPaths() ?? []).filter(isGoverned);
  const added: string[] = [];
  const alreadyExempt: string[] = [];
  for (const p of dirty) {
    if (read.exempt.has(p)) alreadyExempt.push(p);
    else {
      file.exempted.push({ path: p, date: when, reason: reason.trim() });
      added.push(p);
    }
  }
  file.exempted.sort((a, b) => (a.date === b.date ? a.path.localeCompare(b.path) : a.date.localeCompare(b.date)));
  writeFileSync(BASELINE_FILE, JSON.stringify(file, null, 2) + "\n");
  return { added, alreadyExempt };
}

// --- CLI -------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const quiet = process.argv.includes("--quiet");
  const git = realGit(ROOT);

  if (process.argv.includes("--seal")) {
    const { sealed } = sealRulings(ROOT);
    console.log(`sealed ${sealed} settled ruling(s). .baseline.json and .confirmed.json untouched.`);
    process.exit(0);
  }

  if (process.argv.includes("--baseline")) {
    const reason = argValue("--reason");
    if (!reason) {
      console.log(
        `\n  FAIL  --baseline requires --reason "why". Ruling 0014: every exemption writes a dated reason naming what was exempted and why.\n`,
      );
      process.exit(1);
    }
    const { added, alreadyExempt } = addBaselineExemptions(ROOT, reason, git);
    console.log(
      `exempted ${added.length} path(s), ${alreadyExempt.length} already exempt:\n` +
        added.map((p) => `  + ${p}`).join("\n"),
    );
    process.exit(0);
  }

  const r = runLedger(ROOT, git);
  const clean = r.violations.length === 0;
  if (!(quiet && clean && r.warnings.length === 0)) {
    if (!quiet || !clean) {
      console.log(
        `\nledger: ${r.rulingCount} ruling(s), ${r.openItemCount} open item(s), ` +
          `${r.citationsChecked} doc citation(s), ${r.migrationsAhead} migration(s) ahead of ${DEPLOYED_BRANCH}, ` +
          `authorized: ${r.authorizedRuling}`,
      );
    }
    for (const w of r.warnings) console.log(`  warn  ${w}`);
    for (const v of r.violations) console.log(`  FAIL  ${v}`);
    if (clean) console.log(`\n  ok    protocol intact`);
    else console.log(`\n${r.violations.length} violation(s)`);
  }
  process.exit(clean ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
