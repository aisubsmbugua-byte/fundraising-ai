// Tests for scripts/ledger-check.ts -- the script that enforces the ledger
// protocol between the decision space and the build space.
//
//   npx tsx scripts/test-ledger-check.ts
//
// Every rule the check enforces gets a case that FAILS and a case that passes.
// A check nobody has seen fail is a check nobody knows works: ruling 0010 asks
// for one failing example per rule, and these are them, executable.
//
// Each case builds a throwaway ledger under the OS temp directory -- a real
// docs/ledger tree with real rulings, a real STATE.md and real migrations --
// and runs the same functions the CLI runs. git is injected, so no case needs a
// repository and none of them can touch this one.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLedger,
  realGit,
  sealRulings,
  addBaselineExemptions,
  additiveViolations,
  namesEvidence,
  citedMigrationNumbers,
  parseOpenItems,
  openItemRows,
  collectCitations,
  citationDocs,
  rulingFiles,
  summaryCounts,
  summaryLines,
  MIGRATIONS_AHEAD_CMD,
  DEPLOYED_BRANCH,
  type GitPort,
} from "./ledger-check";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function expectViolation(name: string, violations: string[], needle: string) {
  const hit = violations.find((v) => v.includes(needle));
  check(name, Boolean(hit), `no violation containing "${needle}". Got:\n      ${violations.join("\n      ") || "(none)"}`);
  return hit;
}

function expectNoViolation(name: string, violations: string[], needle: string) {
  const hit = violations.find((v) => v.includes(needle));
  check(name, !hit, `unexpected violation: ${hit}`);
}

/** A collecting Sink for driving parseOpenItems directly (ruling 0023). */
function collectSink() {
  const failed: string[] = [];
  return { failed, out: { fail: (m: string) => failed.push(m), warn: () => {} } };
}

// --- fixture ---------------------------------------------------------------

type Fixture = {
  root: string;
  write(rel: string, body: string): void;
  ruling(id: string, opts?: { provenance?: string; status?: string; body?: string }): void;
  state(opts: { authorized?: string; items?: string[] }): void;
  run(git?: Partial<GitPort>): ReturnType<typeof runLedger>;
  cleanup(): void;
};

const roots: string[] = [];

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ledger-test-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "ledger", "rulings"), { recursive: true });

  const write = (rel: string, body: string) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };

  const f: Fixture = {
    root,
    write,
    ruling(id, opts = {}) {
      const body = opts.body ?? `## The ruling\n\nRuling ${id}.\n`;
      write(
        `docs/ledger/rulings/${id}-fixture.md`,
        `---\nid: ${id}\ntitle: fixture ruling ${id}\nstatus: ${opts.status ?? "settled"}\nprovenance: ${opts.provenance ?? "verbatim"}\nsupersedes:\ndate: 2026-09-17\n---\n\n${body}`,
      );
    },
    state({ authorized = "0001", items = [] }) {
      write(
        "docs/ledger/STATE.md",
        `# STATE\n\n## Authorized now\n\n- ruling: ${authorized}\n\n## Open items\n\n` +
          `| id | owner | status | subject | opened |\n|----|-------|--------|---------|--------|\n` +
          items.join("\n") +
          `\n\n## Closed items\n\nnone\n`,
      );
    },
    run(git = {}) {
      const port: GitPort = {
        dirtyPaths: () => [],
        migrationsAheadOfDeployed: () => [],
        existsOnDeployed: () => true,
        isAncestorOfDeployed: () => true,
        ...git,
      };
      return runLedger(root, port);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  f.ruling("0001");
  f.state({ items: [] });
  return f;
}

// ===========================================================================
// Ruling 0014 — sealing and baselining are separate commands
// ===========================================================================

{
  const f = fixture();
  const baselinePath = join(f.root, "docs", "ledger", ".baseline.json");
  f.write(
    "docs/ledger/.baseline.json",
    JSON.stringify(
      {
        grandfathered: { note: "ledger creation", date: "2026-09-16", paths: ["lib/old.ts"] },
        exempted: [],
      },
      null,
      2,
    ) + "\n",
  );
  const before = readFileSync(baselinePath);

  // 0014's own test of compliance: seal with a dirty tree containing a governed
  // path that is not in the baseline. Under the pre-0014 script this call
  // replaced the grandfather list with ["lib/dirty.ts"].
  sealRulings(f.root);
  const after = readFileSync(baselinePath);
  check("0014 --seal leaves .baseline.json byte-identical", before.equals(after),
    `before ${before.length}B, after ${after.length}B`);

  // ...and it does not touch .confirmed.json either (ruling 0012).
  f.write("docs/ledger/rulings/.confirmed.json", `{\n  "0001": { "verdict": "unconfirmed" }\n}\n`);
  const confBefore = readFileSync(join(f.root, "docs", "ledger", "rulings", ".confirmed.json"));
  sealRulings(f.root);
  const confAfter = readFileSync(join(f.root, "docs", "ledger", "rulings", ".confirmed.json"));
  check("0014 --seal leaves .confirmed.json byte-identical", confBefore.equals(confAfter));

  // FAILING EXAMPLE: --baseline with no reason is refused outright.
  let refused = false;
  try {
    addBaselineExemptions(f.root, "", { dirtyPaths: () => ["lib/dirty.ts"] } as GitPort);
  } catch (e) {
    refused = /--reason/.test((e as Error).message);
  }
  check("0014 --baseline without --reason is refused", refused);

  // A real exemption is dated and justified, and leaves grandfathered alone.
  const git: GitPort = {
    dirtyPaths: () => ["lib/dirty.ts", "docs/notes.md"],
    migrationsAheadOfDeployed: () => [],
    existsOnDeployed: () => true,
    isAncestorOfDeployed: () => true,
  };
  const { added } = addBaselineExemptions(f.root, "vendored file, tracked upstream", git, "2026-09-17");
  const written = JSON.parse(readFileSync(baselinePath, "utf8"));
  check("0014 --baseline exempts only governed paths", added.length === 1 && added[0] === "lib/dirty.ts",
    JSON.stringify(added));
  check("0014 grandfathered list survives --baseline",
    JSON.stringify(written.grandfathered.paths) === JSON.stringify(["lib/old.ts"]));
  check("0014 a later exemption is distinguishable by reading the file alone",
    written.exempted.length === 1 &&
      written.exempted[0].date === "2026-09-17" &&
      written.exempted[0].reason === "vendored file, tracked upstream");

  // FAILING EXAMPLE: an exemption with no date/reason is rejected on read.
  f.write(
    "docs/ledger/.baseline.json",
    JSON.stringify({ grandfathered: { note: "", paths: [] }, exempted: [{ path: "lib/x.ts" }] }, null, 2),
  );
  expectViolation("0014 undated exemption fails", f.run().violations, "has no ISO date");
  expectViolation("0014 unjustified exemption fails", f.run().violations, "names no reason");

  // The pre-0014 flat schema still guards the same paths, and says it is legacy.
  f.write("docs/ledger/.baseline.json", JSON.stringify({ note: "old", paths: ["lib/old.ts"] }, null, 2));
  const legacy = f.run();
  check("0014 legacy flat baseline warns", legacy.warnings.some((w) => w.includes("pre-0014 flat schema")));

  f.cleanup();
}

// ===========================================================================
// Ruling 0012 — provenance and confirmation are two facts
// ===========================================================================

{
  const f = fixture();
  f.ruling("0002", { provenance: "reconstructed" });
  f.state({ items: [] });

  // FAILING EXAMPLE (warning half): remove the confirmation entry and the
  // warning returns. This is 0012's stated test of compliance.
  let r = f.run();
  check("0012 reconstructed + unconfirmed warns",
    r.warnings.some((w) => w.includes("ruling 0002 is reconstructed and unconfirmed")));

  f.write(
    "docs/ledger/rulings/.confirmed.json",
    JSON.stringify({ "0002": { verdict: "confirmed", checked_against: "lib/qualification.ts:235", date: "2026-09-16" } }, null, 2),
  );
  r = f.run();
  check("0012 a confirmed ruling stops warning",
    !r.warnings.some((w) => w.includes("ruling 0002 is reconstructed")));

  // FAILING EXAMPLE: refuted fails rather than warns.
  f.write(
    "docs/ledger/rulings/.confirmed.json",
    JSON.stringify({ "0002": { verdict: "refuted", checked_against: "transcript 2026-09-16", date: "2026-09-17" } }, null, 2),
  );
  r = f.run();
  expectViolation("0012 a refuted ruling fails", r.violations, "ruling 0002 is REFUTED");
  check("0012 a refuted ruling does not merely warn",
    !r.warnings.some((w) => w.includes("ruling 0002 is reconstructed")));

  // A refuted VERBATIM ruling fails too — the verdict is about truth, not provenance.
  f.write(
    "docs/ledger/rulings/.confirmed.json",
    JSON.stringify({ "0001": { verdict: "refuted", checked_against: "main:lib/x.ts" } }, null, 2),
  );
  expectViolation("0012 refuted applies to verbatim rulings too", f.run().violations, "ruling 0001 is REFUTED");

  // FAILING EXAMPLE: a verdict with no artifact behind it.
  f.write("docs/ledger/rulings/.confirmed.json", JSON.stringify({ "0001": { verdict: "confirmed" } }, null, 2));
  expectViolation("0012 a verdict with no artifact fails", f.run().violations, "names no artifact");

  // FAILING EXAMPLE: outside the three-valued vocabulary.
  f.write("docs/ledger/rulings/.confirmed.json", JSON.stringify({ "0001": { verdict: "true" } }, null, 2));
  expectViolation("0012 a two-valued verdict fails", f.run().violations, `verdict "true" is not`);

  // FAILING EXAMPLE: a confirmation for a ruling that does not exist.
  f.write("docs/ledger/rulings/.confirmed.json", JSON.stringify({ "0099": { verdict: "confirmed", checked_against: "x" } }, null, 2));
  expectViolation("0012 a confirmation for an unknown ruling fails", f.run().violations, "names a ruling that does not exist");

  f.cleanup();
}

// ===========================================================================
// Ruling 0015 — six states, not interchangeable
// ===========================================================================

{
  const f = fixture();
  const row = (id: string, owner: string, status: string, subject: string) =>
    `| ${id} | ${owner} | ${status} | ${subject} | 2026-09-17 |`;

  check("0015 the open-items table parses to five columns",
    (() => {
      const { failed, out } = collectSink();
      const items = parseOpenItems(`| id | owner | status | subject | opened |\n|--|--|--|--|--|\n${row("7", "build", "tested", "ran `scripts/test-availability.ts`, 37 passing")}`, out);
      return items.length === 1 && items[0].status === "tested" && items[0].opened === "2026-09-17" && failed.length === 0;
    })());

  // FAILING EXAMPLE: a state outside the vocabulary.
  f.state({ items: [row("1", "build", "done", "finished it")] });
  expectViolation("0015 a state outside the six fails", f.run().violations, `status "done" is not one of`);

  // FAILING EXAMPLE: a work state on a decision-owned item.
  f.state({ items: [row("2", "decision", "implemented", "wrote the code")] });
  expectViolation("0015 a work state on a decision item fails", f.run().violations,
    "a decision-owned item cannot be \"implemented\"");

  // FAILING EXAMPLE: tested with nothing cited.
  f.state({ items: [row("3", "build", "tested", "all the acceptance checks pass")] });
  expectViolation("0015 tested with no evidence fails", f.run().violations, "names no evidence");

  // ...and the same row with evidence passes.
  f.state({ items: [row("3", "build", "tested", "`scripts/test-availability.ts` 29 → 37 passing")] });
  expectNoViolation("0015 tested with evidence passes", f.run().violations, "names no evidence");

  check("0015 evidence recognises a test count", namesEvidence("29 → 37 passing"));
  check("0015 evidence recognises a migration range", namesEvidence("Migrations 0063–0065 are applied"));
  check("0015 evidence recognises a file path", namesEvidence("see `lib/availability.ts`"));
  check("0015 prose is not evidence", !namesEvidence("everything works and the team agrees"));

  // FAILING EXAMPLE: released from a feature branch. The file exists here and
  // is absent from the deployed branch -- ruling 0015's stated catch.
  f.write("lib/availability.ts", "export const x = 1;\n");
  f.state({ items: [row("4", "build", "released", "shipped `lib/availability.ts`")] });
  expectViolation("0015 released from a feature branch fails",
    f.run({ existsOnDeployed: () => false }).violations,
    `is not on ${DEPLOYED_BRANCH}`);

  // ...and passes once the same file is on the deployed branch.
  expectNoViolation("0015 released passes when the file is on the deployed branch",
    f.run({ existsOnDeployed: () => true }).violations, `is not on ${DEPLOYED_BRANCH}`);

  // FAILING EXAMPLE: released citing nothing checkable.
  f.state({ items: [row("5", "build", "released", "it went out, 12 tests passing")] });
  expectViolation("0015 released with nothing checkable fails", f.run().violations, "cites nothing checkable");

  // The live-database half of `released` (ruling 0015's second clause): a
  // migration ahead of its code is released only while it stays additive
  // (ruling 0020 clause 3).
  f.write("supabase/migrations/0063_ok.sql", "alter table t add column a text not null default 'x';\n");
  f.state({ items: [row("6", "build", "released", "Migrations 0063 applied to the live database")] });
  expectNoViolation("0015 an additive migration applied ahead of its code is released",
    f.run({ existsOnDeployed: () => false }).violations, "item 6");

  f.write("supabase/migrations/0063_ok.sql", "alter table t add column a text not null;\n");
  expectViolation("0015 a non-additive migration cannot claim released",
    f.run({ existsOnDeployed: () => false }).violations, "is not additive");

  check("0015 migration ranges expand", JSON.stringify(citedMigrationNumbers("Migrations 0063–0065 are applied")) ===
    JSON.stringify(["0063", "0064", "0065"]));

  f.cleanup();
}

// ===========================================================================
// Ruling 0018 — a finding cites the artifact it read
// ===========================================================================

{
  const f = fixture();
  f.write("lib/real.ts", "export const real = 1;\n");

  // FAILING EXAMPLE: a doc citing a path that is not there.
  f.write("docs/notes/finding.md", "The rule lives in `lib/imaginary.ts` and is enforced there.\n");
  expectViolation("0018 a doc citing a non-existent path fails", f.run().violations,
    "cites `lib/imaginary.ts`, which does not exist");

  // ...and the same sentence against a real file passes.
  f.write("docs/notes/finding.md", "The rule lives in `lib/real.ts` and is enforced there.\n");
  expectNoViolation("0018 a doc citing a real path passes", f.run().violations, "does not exist");

  // Line references resolve to the file.
  f.write("docs/notes/finding.md", "See `lib/real.ts:1`.\n");
  expectNoViolation("0018 a path:line citation resolves", f.run().violations, "does not exist");

  // Things that are not repo paths are not treated as repo paths.
  f.write(
    "docs/notes/shapes.md",
    "Route `/login`, glob `docs/reviews/NNNN-*.md`, plan dir `.claude/plans/`, extension `.ts`, and `lib/real.ts`.\n",
  );
  expectNoViolation("0018 routes, globs, dot-dirs and bare extensions are not paths",
    f.run().violations, "does not exist");
  check("0018 only path-shaped tokens are collected",
    collectCitations(f.root).every((c) => !c.token.startsWith("/") && !c.token.includes("*")));

  // A fenced block is quoted output, not the document asserting a file exists.
  f.write(
    "docs/notes/finding.md",
    "Output of the run:\n\n```\nFAIL  x cites `lib/imaginary.ts`, which does not exist\n```\n\nAnd `lib/real.ts` is fine.\n",
  );
  expectNoViolation("0018 a path quoted inside a fenced block is not a citation",
    f.run().violations, "does not exist");
  f.write(
    "docs/notes/finding.md",
    "```\nfenced\n```\n\nBut in prose, `lib/imaginary.ts` still fails.\n",
  );
  expectViolation("0018 prose after a fenced block is still checked", f.run().violations,
    "cites `lib/imaginary.ts`");

  // A sibling document cited by bare name resolves against its own directory.
  f.write("docs/notes/other.md", "x\n");
  f.write("docs/notes/finding.md", "See `other.md`.\n");
  expectNoViolation("0018 a sibling doc cited by bare name resolves", f.run().violations, "does not exist");

  // A numbered document cited by its number resolves.
  f.write("docs/decisions/0002-research-agent.md", "x\n");
  f.write("docs/notes/finding.md", "See `docs/decisions/0002`.\n");
  expectNoViolation("0018 a numbered doc cited by number resolves", f.run().violations, "does not exist");

  f.cleanup();
}

// ===========================================================================
// Ruling 0020 — only an additive migration may run ahead of its code
// ===========================================================================

{
  const cases: [string, string, boolean][] = [
    ["adds a nullable column", "alter table t add column a text;", true],
    ["adds a not-null column with a default", "alter table t add column a text not null default 'x';", true],
    ["adds several columns at once", "alter table t add column a text, add column b integer not null default 0;", true],
    ["creates a table with not-null columns", "create table q (id uuid primary key, tier text not null, result jsonb not null);", true],
    ["adds a constraint", "alter table t add constraint t_chk check (a in ('x'));", true],
    ["adds an index", "create unique index t_idx on t (a, b);", true],
    ["drops a column", "alter table t drop column a;", false],
    ["drops a table", "drop table t;", false],
    ["renames", "alter table t rename column a to b;", false],
    ["re-types a column", "alter table t alter column a type integer;", false],
    ["adds not null with no default", "alter table t add column a text not null;", false],
  ];
  for (const [name, sql, shouldPass] of cases) {
    const bad = additiveViolations(sql);
    check(`0020 ${name} ${shouldPass ? "is additive" : "is rejected"}`,
      shouldPass ? bad.length === 0 : bad.length > 0, bad.join("; "));
  }

  // The declaration is not trusted: a comment or a string literal claiming to
  // be additive, or containing the word, does not change the verdict either way.
  check("0020 a comment claiming additive does not excuse a drop",
    additiveViolations("-- Additive.\nalter table t drop column a;\n").length > 0);
  check("0020 the word 'drop column' inside a comment is not a violation",
    additiveViolations("-- never drop column a here\nalter table t add column a text;\n").length === 0);
  check("0020 the word 'rename' inside a string literal is not a violation",
    additiveViolations("comment on column t.a is 'we did not rename anything';\n").length === 0);
  check("0020 a plpgsql body is not scanned as DDL",
    additiveViolations("create or replace function f() returns trigger as $$ begin raise exception 'drop table'; end; $$ language plpgsql;").length === 0);

  // FAILING EXAMPLE, end to end: a migration ahead of the deployed branch.
  const f = fixture();
  f.write("supabase/migrations/0066_bad.sql", "-- Additive.\nalter table prospects drop column source_url;\n");
  expectViolation("0020 a non-additive migration ahead of the deployed branch fails",
    f.run({ migrationsAheadOfDeployed: () => ["supabase/migrations/0066_bad.sql"] }).violations,
    "is not additive");

  f.write("supabase/migrations/0066_bad.sql", "alter table prospects add column source_url text;\n");
  expectNoViolation("0020 an additive migration ahead of the deployed branch passes",
    f.run({ migrationsAheadOfDeployed: () => ["supabase/migrations/0066_bad.sql"] }).violations,
    "is not additive");
  f.cleanup();
}

// ===========================================================================
// Ruling 0021 — a count names the set it ranged over
//
// The subject here is the script's own output, not a check it runs on anything
// else. There is no failing example to write, because nothing fails: the rule
// is that a bare count is never printed, so the tests assert the shape of the
// summary and then reproduce each population the way a reader would.
// ===========================================================================

{
  const f = fixture();
  f.write("docs/notes/a.md", "cites `lib/real.ts`.\n");
  f.write("lib/real.ts", "export const real = 1;\n");

  // --- every count on the summary carries a population ---------------------

  check("0021 every printed count names a non-empty population",
    summaryCounts(f.run()).every((c) => c.over.trim().length > 0),
    JSON.stringify(summaryCounts(f.run()).filter((c) => !c.over.trim())));

  check("0021 every printed count names its unit",
    summaryCounts(f.run()).every((c) => c.label.trim().length > 0));

  check("0021 the four counts on the summary are rulings, open items, citations and migrations",
    JSON.stringify(summaryCounts(f.run()).map((c) => c.label)) ===
      JSON.stringify(["rulings", "open items", "doc citations", `migrations ahead of ${DEPLOYED_BRANCH}`]));

  // The pre-0021 line — four counts, no populations — must not come back.
  check("0021 the summary no longer prints the bare 'N doc citation(s)' shape",
    !summaryLines(f.run()).some((l) => /\d+ doc citation\(s\)/.test(l)),
    summaryLines(f.run()).join(" / "));

  // --- citations: the population moves when the file set moves -------------
  // This is the finding that produced the ruling, executable. "407 citations"
  // was 337 taken over a docs/ tree carrying 17 duplicate `* 2.md` files, and
  // nothing in the output could have shown it.

  const before = f.run();
  const beforeDocs = citationDocs(f.root);
  check("0021 the citation population is the .md files citationDocs walks",
    before.citationDocCount === beforeDocs.length,
    `printed ${before.citationDocCount}, walked ${beforeDocs.length}`);
  check("0021 the citation population is every .md under docs/, subdirectories included",
    ["docs/ledger/STATE.md", "docs/ledger/rulings/0001-fixture.md", "docs/notes/a.md"]
      .every((p) => beforeDocs.includes(p)),
    beforeDocs.join(", "));

  f.write("docs/notes/a 2.md", "cites `lib/real.ts` twice: `lib/real.ts`.\n");
  const after = f.run();
  check("0021 a duplicate doc moves the citation count",
    after.citationsChecked > before.citationsChecked,
    `${before.citationsChecked} → ${after.citationsChecked}`);
  check("0021 a duplicate doc also moves the stated population",
    after.citationDocCount === before.citationDocCount + 1,
    `${before.citationDocCount} → ${after.citationDocCount}`);
  check("0021 the stated population is reproducible from the summary text",
    summaryLines(after).some((l) => l.includes(`${after.citationDocCount} file(s)`) &&
      l.includes(`find docs -name "*.md" -type f`)),
    summaryLines(after).join(" / "));

  // --- open items: the denominator holds when a row stops parsing ----------
  // Ruling 0021's shape applied to STATE.md item 31: a malformed id used to be
  // dropped silently, showing only as the item count falling. The row count
  // printed beside it makes the drop legible as an exclusion — and since
  // ruling 0023 the excluded data row also fails the run (tested in its own
  // section below).

  const rows = (ids: string[]) =>
    `| id | owner | status | subject | opened |\n|--|--|--|--|--|\n` +
    ids.map((id) => `| ${id} | build | proposed | thing | 2026-09-18 |`).join("\n");
  const parse = (ids: string[]) => parseOpenItems(rows(ids), collectSink().out);

  check("0021 the open-item population counts header and separator rows too",
    openItemRows(rows(["1", "2"])) === 4 && parse(["1", "2"]).length === 2,
    `${openItemRows(rows(["1", "2"]))} rows, ${parse(["1", "2"]).length} items`);
  check("0021 a malformed item id lowers the count while the population holds",
    openItemRows(rows(["1", "2a"])) === 4 && parse(["1", "2a"]).length === 1,
    `${openItemRows(rows(["1", "2a"]))} rows, ${parse(["1", "2a"]).length} items`);

  // --- rulings: count is parsed rulings, population is the files ------------

  check("0021 the ruling population is the .md files in the rulings directory",
    rulingFiles(join(f.root, "docs", "ledger", "rulings")).length === f.run().rulingFileCount);

  f.write("docs/ledger/rulings/0003-broken.md", "no front matter here\n");
  const broken = f.run();
  check("0021 an unparseable ruling shows as count below population",
    broken.rulingCount === broken.rulingFileCount - 1,
    `${broken.rulingCount} of ${broken.rulingFileCount}`);

  f.cleanup();
}

{
  // --- migrations ahead: the printed command is the one that was run --------
  // Run against this repository, because the claim under test is that a reader
  // who types the printed command gets the number the summary printed. A
  // fixture cannot establish that; only a real git tree can.
  const here = join(import.meta.dirname ?? ".", "..");
  const fromPort = realGit(here).migrationsAheadOfDeployed();
  let fromPrintedCommand: string[] = [];
  let ran = false;
  try {
    const [, ...args] = MIGRATIONS_AHEAD_CMD.split(" ");
    fromPrintedCommand = execFileSync("git", args, { cwd: here, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    ran = true;
  } catch {
    ran = false;
  }
  check("0021 the migrations-ahead command in the summary runs as printed", ran);
  check("0021 running the printed command reproduces the printed count",
    JSON.stringify(fromPrintedCommand) === JSON.stringify(fromPort),
    `printed-command ${fromPrintedCommand.length}, port ${fromPort.length}`);
}

// ===========================================================================
// Ruling 0023 — a row that does not parse is a violation, not a skip
// ===========================================================================

{
  const f = fixture();

  // FAILING EXAMPLE: ruling 0023's own test of compliance. Adding this row to
  // an otherwise-valid open-items table fails the check, naming the row.
  // Before 0023 this row was dropped under a comment reading "header and
  // separator rows", and every ruling-0015 obligation silently fell away with
  // it.
  const badRow = "| 4a | build | tested | anything | 2026-09-19 |";
  f.state({ items: ["| 1 | build | proposed | thing | 2026-09-19 |", badRow] });
  const hit = expectViolation("0023 a data row with a non-numeric id fails the run",
    f.run().violations, `id "4a"`);
  check("0023 the failure names the row's content", Boolean(hit && hit.includes(badRow)),
    `violation does not contain the row: ${hit}`);

  // ...and the well-formed row beside it still parses: the violation is a
  // failure of the run, not a corruption of the parse.
  check("0023 the well-formed rows beside a malformed one still parse",
    f.run().openItemCount === 1);

  // The header and separator continue to pass, identified by what they are —
  // the header by its literal "id" cell, the separator by its dash cells —
  // not by failing a numeric test.
  f.state({ items: ["| 1 | build | proposed | thing | 2026-09-19 |"] });
  expectNoViolation("0023 the header and separator are not violations",
    f.run().violations, "not numeric");

  // A separator with alignment colons is still structurally a separator.
  {
    const { failed, out } = collectSink();
    const items = parseOpenItems(
      `| id | owner | status | subject | opened |\n|:--|:--:|---:|---|---|\n| 3 | build | proposed | thing | 2026-09-19 |`,
      out,
    );
    check("0023 an alignment-colon separator is structurally a separator",
      items.length === 1 && failed.length === 0,
      `${items.length} items, failures: ${failed.join("; ")}`);
  }

  // No well-formed row's parse changed: same fields, same values as before.
  {
    const { failed, out } = collectSink();
    const items = parseOpenItems(
      `| id | owner | status | subject | opened |\n|--|--|--|--|--|\n| 9 | build | tested | ran \`scripts/x.ts\` | 2026-09-18 |`,
      out,
    );
    check("0023 a well-formed table parses identically to before",
      items.length === 1 && failed.length === 0 &&
        items[0].id === "9" && items[0].owner === "build" && items[0].status === "tested" &&
        items[0].subject === "ran `scripts/x.ts`" && items[0].opened === "2026-09-18",
      JSON.stringify({ items, failed }));
  }

  f.cleanup();
}

// ===========================================================================
// The real repository's own migrations, checked against 0020.
// ===========================================================================

{
  const here = join(import.meta.dirname ?? ".", "..");
  for (const name of ["0063_faith_affiliation.sql", "0064_qualification_pipeline.sql", "0065_discovery_handoff.sql"]) {
    const path = join(here, "supabase", "migrations", name);
    let sql = "";
    try {
      sql = readFileSync(path, "utf8");
    } catch {
      check(`0020 ${name} is readable`, false, `missing at ${path}`);
      continue;
    }
    const bad = additiveViolations(sql);
    check(`0020 ${name} is additive`, bad.length === 0, bad.join("; "));
  }
}

// --- report ----------------------------------------------------------------

for (const root of roots) rmSync(root, { recursive: true, force: true });

const total = passed + failures.length;
if (failures.length) {
  console.log(`\n${failures.length} of ${total} checks FAILED:\n`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`\nledger-check: ${passed} of ${total} checks passing`);
