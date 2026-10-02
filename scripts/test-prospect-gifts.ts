// STATE item 83, ruling 0035 -- a prospect's actual giving history. The
// institutional-funder half of the same append-only pattern ruling 0034
// already settled for supporters (scripts/test-supporters.ts). This file
// asserts three things, all offline (no DB, no API key):
//
//   1. Migration 0079 encodes ruling 0035 in the schema: additive-only
//      (ruling 0020); prospect_gifts has NO update policy and NO delete
//      policy at all (ruling 0035 clause 1 -- a correction is a new row,
//      never a silent edit); the org-match trigger is SECURITY DEFINER with
//      search_path = public (0066/0078's pattern, closing the known
//      FK-bypasses-RLS hole at birth rather than inheriting it); amount has
//      a positive check constraint; prospect_id cascades from prospects.
//
//   2. The CSV parser's full matching/error-reason discipline
//      (parseProspectGiftCsvRow, lib/prospects.ts) mirrors
//      parseGiftCsvRow's (lib/supporters.ts) exactly: identifier columns
//      prospect_name/prospect_email, matched against contact_email (NOT a
//      plain email column -- prospects don't have one, see lib/prospects.ts's
//      Prospect type); email tried first, name only as a fallback when email
//      finds nothing; an email or name matching TWO existing prospects is
//      "ambiguous match", never guessed -- proven with an explicit
//      two-same-named-prospects fixture, not hypothesized; zero matches is
//      "no match", never a newly created prospect; invalid amount (zero,
//      negative, non-numeric, blank) and invalid date are their own named
//      reasons, every reason kept distinguishable in the counts (ruling
//      0021). importProspectGiftsCsv itself
//      (app/(dashboard)/prospects/actions.ts) touches the database and is
//      not exercised here, matching test-supporters.ts's own posture toward
//      every database-touching action.
//
//   3. Tenant isolation for the new table is added to
//      scripts/test-tenant-isolation.ts in its existing NOT-EVALUATED-
//      tolerant pattern -- asserted here by confirming the section exists in
//      that file's source, not by running it (that script needs a live
//      database and real auth sessions; this one does not run it).
//
// Usage: npx tsx scripts/test-prospect-gifts.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProspectGiftCsvRow, isValidProspectGiftDate, type ProspectGiftCsvErrorReason } from "../lib/prospects";
import { parseCsv } from "../lib/candidates";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${good ? "PASS" : "FAIL"}: ${label}${good ? "" : `\n      got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  good ? pass++ : fail++;
}
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

// --- 1. Migration 0079 encodes ruling 0035 in the schema -----------------

section("migration 0079 encodes ruling 0035 in the schema");

const sql = readFileSync(join(root, "supabase/migrations/0079_prospect_gifts.sql"), "utf8");
const stmts = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

ok("migration creates exactly one new table: prospect_gifts", /create table prospect_gifts\s*\(/.test(stmts));
const createTargets = [...stmts.matchAll(/create table\s+([a-z_]+)/g)].map((m) => m[1]);
ok(
  "no other table is created in this file (ruling 0020: additive, scoped to the one named table)",
  createTargets.length === 1 && createTargets[0] === "prospect_gifts",
  `created: ${createTargets.join(", ")}`,
);
ok("no ALTER TABLE touches any pre-existing table (nothing already deployed is modified)", !/alter\s+table\s+(?!prospect_gifts)/.test(stmts));

ok("prospect_gifts has an INSERT policy", /create policy "team members can log a prospect gift"\s+on prospect_gifts for insert/.test(stmts));
ok("prospect_gifts has a SELECT policy", /create policy "team members can read prospect gift history"\s+on prospect_gifts for select/.test(stmts));
ok("prospect_gifts has NO update policy anywhere in the file", !/on prospect_gifts for update/.test(stmts));
ok("prospect_gifts has NO delete policy anywhere in the file", !/on prospect_gifts for delete/.test(stmts));
ok("prospect_gifts has no \"for all\" policy that would smuggle in update/delete", !/on prospect_gifts for all/.test(stmts));
ok(
  "exactly two policies exist for prospect_gifts (insert + select, no more)",
  (stmts.match(/on prospect_gifts for (insert|select|update|delete|all)/g) ?? []).length === 2,
);
ok("prospect_gifts' insert policy requires recorded_by = auth.uid() (no impersonation)", /with check \(recorded_by = auth\.uid\(\) and organization_id = my_organization_id\(\)\)/.test(stmts));
ok("prospect_gifts.amount has a positive check constraint", /check \(amount > 0\)/.test(stmts));
ok("prospect_gifts.prospect_id cascades from prospects", /prospect_id uuid not null references prospects \(id\) on delete cascade/.test(stmts));

const triggerFn = stmts.slice(stmts.indexOf("create function enforce_prospect_gift_org_match"));
ok("prospect_gifts' org-match function is security definer with search_path = public", /security definer set search_path = public/.test(triggerFn));
ok("prospect_gifts' org-match trigger fires BEFORE INSERT", /before insert on prospect_gifts/.test(stmts));

ok("RLS is enabled on prospect_gifts", /alter table prospect_gifts enable row level security/.test(stmts));

// --- 2. CSV import: parseCsv + parseProspectGiftCsvRow, offline, no database

section("gift-history CSV import: parseProspectGiftCsvRow, offline, no database");

const janeProspect = { id: "pro-jane", name: "Jane Foundation", contact_email: "jane@example.com" };
const johnProspect = { id: "pro-john", name: "John Memorial Fund", contact_email: "john@example.com" };
// Two DIFFERENT existing prospects who happen to share a name -- constructed
// explicitly, per the item's own instruction, to prove a shared-name row is
// reported ambiguous rather than guessed at either one.
const amyFundA = { id: "pro-amy-a", name: "Amy Smith Family Fund", contact_email: "amy.a@example.com" };
const amyFundB = { id: "pro-amy-b", name: "Amy Smith Family Fund", contact_email: "amy.b@example.com" };
const giftKnown = [janeProspect, johnProspect, amyFundA, amyFundB];

// A row matching exactly one prospect by (contact) email imports correctly.
check(
  "matches by exact case-insensitive contact_email",
  parseProspectGiftCsvRow({ prospect_email: "JANE@EXAMPLE.COM", amount: "50", gift_date: "2026-03-15", note: "Spring gift" }, giftKnown),
  { kind: "insert", prospectId: "pro-jane", amount: 50, giftDate: "2026-03-15", note: "Spring gift" },
);

// A row matching by name when email is absent.
check(
  "matches by exact case-insensitive name when no email is given",
  parseProspectGiftCsvRow({ prospect_name: "john memorial fund", amount: "100", gift_date: "2026-04-01" }, giftKnown),
  { kind: "insert", prospectId: "pro-john", amount: 100, giftDate: "2026-04-01", note: null },
);

// A row with an email that matches no one falls back to name.
check(
  "falls back to name when the given email matches no one",
  parseProspectGiftCsvRow({ prospect_email: "nobody@example.com", prospect_name: "Jane Foundation", amount: "10", gift_date: "2026-01-01" }, giftKnown),
  { kind: "insert", prospectId: "pro-jane", amount: 10, giftDate: "2026-01-01", note: null },
);

// A row matching TWO existing prospects sharing a name is "ambiguous", not a
// guess -- the explicit two-same-named-prospects fixture above.
check(
  "two existing prospects sharing a name: ambiguous match, never guessed",
  parseProspectGiftCsvRow({ prospect_name: "Amy Smith Family Fund", amount: "25", gift_date: "2026-02-01" }, giftKnown),
  { kind: "error", reason: "ambiguous match" },
);

// A row matching zero prospects (neither identifier resolves) is "no match".
check(
  "no identifier resolves to any existing prospect: no match",
  parseProspectGiftCsvRow({ prospect_name: "Nobody Here", amount: "25", gift_date: "2026-02-01" }, giftKnown),
  { kind: "error", reason: "no match" },
);
check(
  "blank prospect_email and prospect_name: no match (not a crash)",
  parseProspectGiftCsvRow({ amount: "25", gift_date: "2026-02-01" }, giftKnown),
  { kind: "error", reason: "no match" },
);

// An email that matches TWO prospects is reported ambiguous directly -- it
// does NOT also try the name (parseGiftCsvRow's own discipline, mirrored).
// A valid name match exists among the candidates (johnProspect), but must
// never be reached: the email step already found more than one match, so
// the row is ambiguous, full stop.
check(
  "two prospects sharing the SAME contact_email: ambiguous match by email, name never tried",
  parseProspectGiftCsvRow(
    { prospect_email: "SHARED@EXAMPLE.COM", prospect_name: "John Memorial Fund", amount: "25", gift_date: "2026-02-01" },
    [
      { id: "dup-a", name: "Dup Fund A", contact_email: "shared@example.com" },
      { id: "dup-b", name: "Dup Fund B", contact_email: "shared@example.com" },
      johnProspect, // a valid name match exists too, but must never be reached
    ],
  ),
  { kind: "error", reason: "ambiguous match" },
);

// Invalid amount: zero, negative, non-numeric, blank -- all "invalid amount".
check("zero amount: invalid amount", parseProspectGiftCsvRow({ prospect_email: "jane@example.com", amount: "0", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });
check("negative amount: invalid amount", parseProspectGiftCsvRow({ prospect_email: "jane@example.com", amount: "-5", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });
check("non-numeric amount: invalid amount", parseProspectGiftCsvRow({ prospect_email: "jane@example.com", amount: "fifty", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });
check("blank amount: invalid amount", parseProspectGiftCsvRow({ prospect_email: "jane@example.com", amount: "", gift_date: "2026-01-01" }, giftKnown), { kind: "error", reason: "invalid amount" });

// Invalid date: unparseable, blank -- "invalid date". A matched prospect and
// a valid amount are not enough on their own to import the row.
check("unparseable gift_date: invalid date", parseProspectGiftCsvRow({ prospect_email: "jane@example.com", amount: "25", gift_date: "not-a-date" }, giftKnown), { kind: "error", reason: "invalid date" });
check("blank gift_date: invalid date", parseProspectGiftCsvRow({ prospect_email: "jane@example.com", amount: "25", gift_date: "" }, giftKnown), { kind: "error", reason: "invalid date" });

// isValidProspectGiftDate: the same rule lib/supporters.ts's isValidGiftDate
// uses, factored out standalone (so this module has no dependency on
// lib/supporters.ts, per ruling 0035 clause 2's separation).
ok("isValidProspectGiftDate: a real calendar date is valid", isValidProspectGiftDate("2026-03-15"));
ok("isValidProspectGiftDate: an unparseable string is invalid", !isValidProspectGiftDate("not-a-date"));
ok("isValidProspectGiftDate: blank is invalid", !isValidProspectGiftDate(""));

// A whole small CSV run through parseCsv (unmodified, the same function
// importCandidatesCsv/importSupporterGiftsCsv use) and then
// parseProspectGiftCsvRow row by row, counts kept in separate per-reason
// buckets throughout, never blended (ruling 0021).
const giftCsvText = [
  "prospect_email,prospect_name,amount,gift_date,note",
  "jane@example.com,,50,2026-03-15,Spring gift", // insert (email match)
  ",John Memorial Fund,100,2026-04-01,", // insert (name match)
  ",Amy Smith Family Fund,25,2026-02-01,", // ambiguous (two Amy Smith Family Funds)
  ",Nobody Here,25,2026-02-01,", // no match
  "jane@example.com,,-5,2026-01-01,", // invalid amount
  "jane@example.com,,25,not-a-date,", // invalid date
].join("\n");

const giftCsvRows = parseCsv(giftCsvText);
check("parseCsv reads 6 data rows from the 7-line gift file", giftCsvRows.length, 6);

function runGiftImport(rows: Record<string, string>[], known: { id: string; name: string; contact_email: string | null }[]) {
  let imported = 0;
  const errorsByReason: Record<ProspectGiftCsvErrorReason, number> = { "no match": 0, "ambiguous match": 0, "invalid amount": 0, "invalid date": 0 };
  for (const row of rows) {
    const outcome = parseProspectGiftCsvRow(row, known);
    if (outcome.kind === "error") errorsByReason[outcome.reason]++;
    else imported++;
  }
  const errors = Object.values(errorsByReason).reduce((a, b) => a + b, 0);
  return { imported, errors, errorsByReason, total: rows.length };
}

// Before -> after: an empty-looking run (no known prospects) would reject
// every row as "no match"; the real run below, against the fixture roster,
// is what's asserted.
const emptyKnownResult = runGiftImport(giftCsvRows, []);
check("before: with NO known prospects, every row is a no-match error", emptyKnownResult, {
  imported: 0,
  errors: 6,
  errorsByReason: { "no match": 6, "ambiguous match": 0, "invalid amount": 0, "invalid date": 0 },
  total: 6,
});

const giftResult = runGiftImport(giftCsvRows, giftKnown);
check("after: counts: imported", giftResult.imported, 2);
check("after: counts: errors (total)", giftResult.errors, 4);
check("after: counts by reason, each distinguishable (never blended into one bucket)", giftResult.errorsByReason, {
  "no match": 1,
  "ambiguous match": 1,
  "invalid amount": 1,
  "invalid date": 1,
});
ok(
  "counts cover every row with no overlap and no gap (imported + errors = rows in)",
  giftResult.imported + giftResult.errors === giftResult.total,
  `${giftResult.imported}+${giftResult.errors} != ${giftResult.total}`,
);

// --- 3. Tenant isolation extended to prospect_gifts -----------------------

section("tenant isolation: section exists in scripts/test-tenant-isolation.ts (written, not executed here)");

const isolationSrc = readFileSync(join(root, "scripts/test-tenant-isolation.ts"), "utf8");
ok("references prospect_gifts in the NOT-EVALUATED-tolerant pattern (42P01 / PGRST205 tolerated)", /from\("prospect_gifts"\)[\s\S]{0,400}(42P01|PGRST205)/.test(isolationSrc) || /(42P01|PGRST205)[\s\S]{0,400}from\("prospect_gifts"\)/.test(isolationSrc));
ok("asserts Org B cannot SELECT Org A's prospect_gifts row", /Org B cannot SELECT Org A's prospect_gifts row/.test(isolationSrc));
ok("asserts the prospect_gifts org-match trigger refuses a cross-org gift", /prospect_gifts.*org-match trigger/.test(isolationSrc));
ok("asserts prospect_gifts has no update policy, even for the owning org", /prospect_gifts has no update policy/.test(isolationSrc));
ok("asserts prospect_gifts has no delete policy, even for the owning org", /prospect_gifts has no delete policy/.test(isolationSrc));
ok("asserts a $0 prospect gift is refused (amount > 0 check)", /A prospect gift of \$0 is refused/.test(isolationSrc));
ok("asserts recorded_by cannot be impersonated", /recorded_by must be the session user/.test(isolationSrc));
ok("asserts deleting a prospect cascades its gift history away", /Deleting a prospect deletes its gift history \(foreign key cascade\)/.test(isolationSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
