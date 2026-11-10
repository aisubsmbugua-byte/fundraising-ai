// STATE item 103 -- importing people from any list, and large-list management on
// the Network page (ruling 0040 clauses 1-3). Offline: the pure mapping,
// classification and request-validation rules run for real; the REAL server
// actions run against an in-memory fake of the Supabase client (see
// scripts/network-test-support.ts) with the modules they import stubbed; and
// source scans pin the boundaries (session client only, no organization_id, no
// contact field, no migration).
//
// What this CANNOT prove: that the real database accepts these inserts and
// scopes them by row-level security, that PostgREST reads the search filter the
// way the fake does, or how the pages look and behave in a browser. The fake
// models PostgREST's 1000-row response limit and exact counts, nothing more.
//
// Usage: npx tsx scripts/test-network-import.ts

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  CONTACT_HEADING_STEMS,
  CONTACT_HEADING_WORDS,
  EMPTY_MAPPING,
  NETWORK_AFFILIATION_MAX,
  NETWORK_HOW_KNOWN_MAX,
  NETWORK_IMPORT_CHUNK_SIZE,
  NETWORK_IMPORT_MAX_ROWS,
  NETWORK_NAME_MAX,
  NETWORK_NOTES_MAX,
  classifyImportRows,
  connectionKey,
  countsAddUp,
  describeColumns,
  firstNonBlankRecord,
  headingRowCandidates,
  joinRoleAndAffiliation,
  looksLikeContactDetail,
  mappableColumns,
  normalizeHeading,
  parseImportRequest,
  readCsvRecords,
  reduceMapping,
  suggestMapping,
  tableFromRecords,
  type CsvTable,
  type FieldMapping,
  type MappedRow,
} from "../lib/network-import";
import {
  NETWORK_DELETE_CHUNK_SIZE,
  NETWORK_DELETE_MAX_IDS,
  NETWORK_PAGE_SIZE,
  matchesSearch,
  networkHref,
  normalizeSearch,
  pageWindow,
  parseDeleteIds,
  parsePage,
  searchOrFilter,
} from "../lib/network-list";
import { NETWORK_DISCLOSURE, NETWORK_IMPORT_DISCLOSURE } from "../lib/network";
import { FakeNetDb, USER_ID, makeStubber } from "./network-test-support";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}
const read = (p: string) => readFileSync(join(root, p), "utf8");
const stripComments = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");

function tableOf(csv: string, headerRow?: number): CsvTable {
  const records = readCsvRecords(csv);
  const t = tableFromRecords(records, headerRow ?? firstNonBlankRecord(records));
  if (!t) throw new Error("fixture has no table");
  return t;
}
const uuidOf = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function main() {
  // =========================================================================
  section("1. Reading the file: BOM, CRLF, quoted commas and line breaks, blank rows");

  {
    const bom = "﻿Name,Company\r\nJane Doe,\"Grace, Hope & Co\"\r\n\r\n\"Sam \"\"Sy\"\" Lee\",\"Line one\nline two\"\r\n,\r\n";
    const recs = readCsvRecords(bom);
    ok("a leading byte-order mark is dropped, so the first heading is exactly 'Name'", recs[0][0] === "Name");
    ok("CRLF ends a record; a quoted comma stays inside its cell", recs[1][0] === "Jane Doe" && recs[1][1] === "Grace, Hope & Co");
    ok("a quoted line break stays inside its cell (one record, not two)", recs[3][1] === "Line one\nline two" && recs[3][0] === 'Sam "Sy" Lee');
    ok("a doubled quote inside quotes is one quote", recs[3][0].includes('"Sy"'));
    ok("a wholly blank line is KEPT as a blank record (so blank rows can be counted), as is a row of empty cells", recs.length === 5 && recs[2].every((c) => c === "") && recs[4].every((c) => c === ""), JSON.stringify(recs));
    ok("a trailing newline does not add a phantom record", readCsvRecords("A,B\n1,2\n").length === 2 && readCsvRecords("A,B\n1,2").length === 2);
    ok("a lone CR also ends a record", readCsvRecords("A,B\r1,2").length === 2);
    ok("an empty file has no records", readCsvRecords("").length === 0 && firstNonBlankRecord(readCsvRecords("\n\n")) === -1);
    const t = tableOf(bom);
    ok("rows read counts every row under the headings, blank ones included; blank rows are counted separately", t.rows.length === 4 && reduceMapping(t, { ...EMPTY_MAPPING, name: 0 }).blankRows === 2 && reduceMapping(t, { ...EMPTY_MAPPING, name: 0 }).rowsRead === 4);
  }

  {
    const t = tableOf("Name,Name,\nA,B,C,D\nE\n");
    ok("two columns with the SAME heading stay two columns (positional, not keyed by heading)", t.headers[0] === "Name" && t.headers[1] === "Name" && t.rows[0][0] === "A" && t.rows[0][1] === "B");
    ok("a column with no heading exists, and a data row WIDER than the heading row adds a named-as-headingless column", t.headers.length === 4 && t.headers[2] === "" && t.headers[3] === "" && t.rows[0][3] === "D");
    ok("a short row is padded, not dropped", t.rows[1].length === 4 && t.rows[1][1] === "");
    const cols = describeColumns(t);
    ok("headingless columns are described as such and cannot be mapped", cols[2].headingless && !cols[2].mappable && cols[3].headingless && /no heading/.test(cols[2].label));
  }

  {
    // A LinkedIn Connections.csv begins with notes before the headings.
    const csv = 'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nJane,Doe,https://x,j@x.org,Grace,Pastor,01 Jan 2024\n';
    const recs = readCsvRecords(csv);
    ok("the default heading row is the first non-blank row (the notes) -- nothing is guessed", firstNonBlankRecord(recs) === 0);
    const cands = headingRowCandidates(recs);
    ok("the person may name another row among the first few non-blank ones; blank rows are not offered", cands.includes(0) && cands.includes(1) && cands.includes(3) && !cands.includes(2));
    const t = tableFromRecords(recs, 3)!;
    ok("naming row 4 makes it the heading row and ignores the rows above", t.headers[0] === "First Name" && t.rows.length === 1);
    ok("an out-of-range heading row gives no table", tableFromRecords(recs, 99) === null && tableFromRecords(recs, -1) === null);
  }

  // =========================================================================
  section("2. The heading matcher: contact-looking headings, tested on real-world headings");

  const LINKEDIN = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
  const DONOR = ["Name", "Email", "Phone", "Amount", "Address"];
  const BOARD = ["Member", "Organization", "Title"];
  {
    const flag = (hs: string[]) => hs.filter(looksLikeContactDetail);
    ok("LinkedIn export: URL and Email Address are contact-looking; First Name, Last Name, Company, Position, Connected On are not", JSON.stringify(flag(LINKEDIN)) === JSON.stringify(["URL", "Email Address"]), JSON.stringify(flag(LINKEDIN)));
    ok("donor list: Email, Phone and Address are contact-looking; Name and Amount are not", JSON.stringify(flag(DONOR)) === JSON.stringify(["Email", "Phone", "Address"]), JSON.stringify(flag(DONOR)));
    ok("board list: Member, Organization and Title are none of them contact-looking", flag(BOARD).length === 0);
    const mustFlag = [
      "email", "E-mail", "e_mail", "Email Address", "Work Email", "EMAIL", "Phone", "Phone Number", "Mobile", "Mobile Phone", "Cell", "Cell Phone", "Tel", "TEL.", "Telephone", "Home Phone",
      "Address", "Street", "Street Address", "Mailing Address", "Zip", "Zip Code", "Postal Code", "Postcode", "URL", "Website", "Web Site", "LinkedIn", "LinkedIn URL", "Profile URL",
      "Twitter", "Twitter Handle", "Facebook", "Instagram", "IG Handle", "Handle", "Social", "Social Media", "WhatsApp", "Fax", "Skype",
    ];
    const missed = mustFlag.filter((h) => !looksLikeContactDetail(h));
    ok(`every one of ${mustFlag.length} contact-looking headings is caught (email, e-mail, phone, mobile, cell, tel, address, street, zip, postal, url, website, linkedin, twitter, facebook, instagram, handle, social and more)`, missed.length === 0, missed.join(", "));
    const mustPass = ["Name", "Full Name", "First Name", "Last Name", "Company", "Organization", "Employer", "Position", "Title", "Job Title", "Role", "Notes", "Comments", "Relationship", "How we know them", "Amount", "Connected On", "Member", "Church", "Hotel", "Cellar", "Intelligence", "Last Gift", "Date"];
    const wronglyFlagged = mustPass.filter(looksLikeContactDetail);
    ok(`${mustPass.length} ordinary headings are NOT flagged (short stems match whole words only: 'Hotel' and 'Cellar' pass)`, wronglyFlagged.length === 0, wronglyFlagged.join(", "));
    ok("an empty heading is not 'contact-looking' (it is headingless, a different thing)", !looksLikeContactDetail("") && !looksLikeContactDetail("   "));
    ok("the heading lists are data and non-empty", CONTACT_HEADING_STEMS.length >= 10 && CONTACT_HEADING_WORDS.length >= 10);
    ok("normalizeHeading lowercases and collapses punctuation", normalizeHeading("  E-Mail  Address ") === "e mail address" && normalizeHeading("First_Name") === "first name");
  }

  // =========================================================================
  section("3. The mapping reducer: LinkedIn-, donor- and board-shaped files");

  const strengthSet = (m: FieldMapping, strength = "warm", sentence = "From my own contacts"): FieldMapping => ({ ...m, strength, howKnownSentence: sentence });

  {
    const csv =
      "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n" +
      "Jane,Doe,https://linkedin.com/in/jane,jane@example.org,Grace Church,Pastor,01 Jan 2024\n" +
      "Sam,Lee,https://linkedin.com/in/sam,sam@example.org,,Chair,02 Feb 2024\n" +
      "Ann,,https://linkedin.com/in/ann,ann@example.org,Hope Trust,,03 Mar 2024\n";
    const t = tableOf(csv);
    const sug = suggestMapping(t);
    ok("LinkedIn file: the suggestion pre-selects First+Last, Company and Position (now the TITLE) -- and nothing for How known or Notes", sug.nameMode === "split" && sug.first === 0 && sug.last === 1 && sug.affiliation === 4 && sug.title === 5 && sug.howKnown === null && sug.notes === null);
    ok("... and the suggestion leaves strength UNSET and the sentence empty (nothing inferred)", sug.strength === "" && sug.howKnownSentence === "");
    const r = reduceMapping(t, strengthSet(sug));
    ok("LinkedIn file: can be imported once strength and a how-known sentence are given", r.canImport && r.blockers.length === 0, r.blockers.join(" | "));
    ok(
      "LinkedIn file: the stored fields are EXACTLY name, affiliation, title (kept apart now, ruling 0044), the sentence and no notes",
      JSON.stringify(r.rows) ===
        JSON.stringify([
          { person_name: "Jane Doe", affiliation: "Grace Church", title: "Pastor", city: null, state: null, how_known: "From my own contacts", notes: null },
          { person_name: "Sam Lee", affiliation: null, title: "Chair", city: null, state: null, how_known: "From my own contacts", notes: null },
          { person_name: "Ann", affiliation: "Hope Trust", title: null, city: null, state: null, how_known: "From my own contacts", notes: null },
        ]),
      JSON.stringify(r.rows)
    );
    ok("LinkedIn file: no email address and no profile link appears in ANY stored field", !JSON.stringify(r.rows).includes("@") && !/linkedin|http/i.test(JSON.stringify(r.rows)));
    ok(
      "LinkedIn file: the columns not imported are named -- URL, Email Address (both flagged as contact details) and Connected On (not flagged)",
      JSON.stringify(r.notImported.map((c) => [c.heading, c.contact])) === JSON.stringify([["URL", true], ["Email Address", true], ["Connected On", false]]),
      JSON.stringify(r.notImported)
    );
    ok("LinkedIn file: the preview is the first people as they will be recorded", r.preview.length === 3 && r.preview[0].person_name === "Jane Doe");
    ok("LinkedIn file: the unimported columns plus the mapped ones account for every column", r.notImported.length + 4 /* first,last,company,position */ === t.headers.length);
  }

  {
    const csv = "Name,Email,Phone,Amount,Address\nJane Doe,jane@example.org,555-0100,\"$1,200\",1 Main St\nSam Lee,sam@example.org,555-0101,$50,2 Oak Ave\n";
    const t = tableOf(csv);
    const sug = suggestMapping(t);
    ok("donor list: only Name is pre-selected", sug.name === 0 && sug.nameMode === "single" && sug.affiliation === null && sug.title === null && sug.city === null && sug.state === null && sug.cityState === null && sug.notes === null && sug.howKnown === null);
    const r = reduceMapping(t, strengthSet(sug, "close", "Donor list, 2024"));
    ok("donor list: ONLY the name is stored (no affiliation, no notes); how-known is the typed sentence", JSON.stringify(r.rows) === JSON.stringify([
      { person_name: "Jane Doe", affiliation: null, title: null, city: null, state: null, how_known: "Donor list, 2024", notes: null },
      { person_name: "Sam Lee", affiliation: null, title: null, city: null, state: null, how_known: "Donor list, 2024", notes: null },
    ]));
    ok("donor list: Email, Phone, Amount and Address are named as not imported; Email, Phone and Address with the contact-details flag, Amount without", JSON.stringify(r.notImported.map((c) => [c.heading, c.contact])) === JSON.stringify([["Email", true], ["Phone", true], ["Amount", false], ["Address", true]]));
    ok("donor list: nothing from the email, phone, amount or address cells is stored", !/@|555|1,200|\$50|Main St|Oak Ave/.test(JSON.stringify(r.rows)));
  }

  {
    const csv = "Member,Organization,Title\nJane Doe,Grace Church,Treasurer\nSam Lee,,Chair\n";
    const t = tableOf(csv);
    const sug = suggestMapping(t);
    ok("board list: Member -> Name, Organization -> affiliation, Title -> title are pre-selected", sug.name === 0 && sug.affiliation === 1 && sug.title === 2);
    const r = reduceMapping(t, strengthSet(sug, "warm", "Board of Grace Church"));
    ok("board list: the title is stored as the TITLE, apart from the affiliation (it used to be joined as 'Role, Affiliation')", r.rows[0].affiliation === "Grace Church" && r.rows[0].title === "Treasurer" && r.rows[1].affiliation === null && r.rows[1].title === "Chair");
    ok("board list: every column is used, so the not-imported list is empty (and says so)", r.notImported.length === 0);
  }

  {
    ok("joinRoleAndAffiliation: both, either, neither", joinRoleAndAffiliation("Pastor", "Grace Church") === "Pastor, Grace Church" && joinRoleAndAffiliation("Pastor", "") === "Pastor" && joinRoleAndAffiliation("", "Grace Church") === "Grace Church" && joinRoleAndAffiliation(" ", " ") === null);
    ok("joinRoleAndAffiliation collapses stray whitespace", joinRoleAndAffiliation("  Vice   Chair ", " Grace   Church ") === "Vice Chair, Grace Church");
  }

  section("3b. What blocks the import");

  {
    const t = tableOf("Email,Amount\njane@example.org,100\nsam@example.org,50\n");
    const sug = suggestMapping(t);
    ok("a file with only Email and Amount columns: nothing is pre-selected", sug.name === null && sug.first === null && sug.affiliation === null);
    const r = reduceMapping(t, strengthSet(sug));
    ok("... and it cannot proceed: no name is mapped", !r.canImport && r.blockers.some((b) => /name/i.test(b)));
    ok("... because Email is not on any dropdown, the only column it could name is Amount (a person could still choose it, which is theirs to do)", mappableColumns(t).map((c) => c.heading).join() === "Amount");
    const forced = reduceMapping(t, { ...strengthSet(sug), name: 0 });
    ok("choosing the Email column as the Name anyway is refused, and no rows are produced from it", !forced.canImport && forced.rows.length === 0 && forced.blockers.some((b) => /contact details/.test(b)), JSON.stringify(forced.blockers));
  }

  {
    const t = tableOf("Name,Company,Email\nJane,Grace,jane@example.org\n");
    const base = suggestMapping(t);
    ok("strength unset BLOCKS the import (no default)", !reduceMapping(t, { ...base, howKnownSentence: "x" }).canImport && reduceMapping(t, { ...base, howKnownSentence: "x" }).blockers.some((b) => /how close/i.test(b)));
    ok("... a strength outside the closed list also blocks", !reduceMapping(t, { ...base, howKnownSentence: "x", strength: "best friends" }).canImport && !reduceMapping(t, { ...base, howKnownSentence: "x", strength: "WARM" }).canImport);
    ok("... each of close / warm / acquaintance unblocks it", ["close", "warm", "acquaintance"].every((s) => reduceMapping(t, { ...base, howKnownSentence: "x", strength: s }).canImport));
    ok("no how-known column and no sentence blocks the import", !reduceMapping(t, { ...base, strength: "warm" }).canImport && reduceMapping(t, { ...base, strength: "warm" }).blockers.some((b) => /how you know/i.test(b)));
    ok("a whitespace-only sentence is no sentence", !reduceMapping(t, { ...base, strength: "warm", howKnownSentence: "   " }).canImport);
    ok("a sentence over the how-known cap blocks", !reduceMapping(t, { ...base, strength: "warm", howKnownSentence: "x".repeat(NETWORK_HOW_KNOWN_MAX + 1) }).canImport);
    const forcedEmail = reduceMapping(t, { ...base, strength: "warm", howKnownSentence: "x", notes: 2 });
    ok("a contact-looking column cannot be mapped to NOTES either (no field at all)", !forcedEmail.canImport && forcedEmail.rows.length === 0);
    const forcedAff = reduceMapping(t, { ...base, strength: "warm", howKnownSentence: "x", affiliation: 2 });
    ok("... nor to affiliation", !forcedAff.canImport && forcedAff.rows.length === 0);
    const forcedHow = reduceMapping(t, { ...base, strength: "warm", howKnown: 2 });
    ok("... nor to how-known", !forcedHow.canImport && forcedHow.rows.length === 0);
    const twice = reduceMapping(t, { ...base, strength: "warm", howKnownSentence: "x", notes: 1 });
    ok("the same column used for two things is refused", !twice.canImport && twice.blockers.some((b) => /both/.test(b)));
    ok("a column index that is not in the file is refused", !reduceMapping(t, { ...base, strength: "warm", howKnownSentence: "x", notes: 99 }).canImport);
    ok("split name mode needs BOTH columns", !reduceMapping(t, { ...base, nameMode: "split", first: 0, last: null, strength: "warm", howKnownSentence: "x" }).canImport);
    ok("a file with headings and no people under them cannot proceed", !reduceMapping(tableOf("Name\n"), { ...EMPTY_MAPPING, name: 0, strength: "warm", howKnownSentence: "x" }).canImport);
    ok("a how-known COLUMN satisfies the requirement and a typed sentence fills only the rows where it is empty", (() => {
      const t2 = tableOf("Name,Known\nJane,Choir\nSam,\n");
      const r2 = reduceMapping(t2, { ...suggestMapping(t2), howKnown: 1, strength: "close", howKnownSentence: "Fallback" });
      return r2.canImport && r2.rows[0].how_known === "Choir" && r2.rows[1].how_known === "Fallback";
    })());
  }

  section("3c. No dropdown offers a contact-looking column");

  {
    const all = [LINKEDIN, DONOR, BOARD].map((h) => tableOf(`${h.join(",")}\n${h.map(() => "x").join(",")}\n`));
    const offered = all.flatMap((t) => mappableColumns(t).map((c) => c.heading));
    ok("across the LinkedIn, donor and board fixtures, no option list contains a contact-looking heading", offered.every((h) => !looksLikeContactDetail(h)), offered.join(", "));
    ok("... while every non-contact heading IS offered", ["First Name", "Last Name", "Company", "Position", "Connected On", "Name", "Amount", "Member", "Organization", "Title"].every((h) => offered.includes(h)));
    {
      const page = read("app/(dashboard)/network/import/import-workspace.tsx");
      const selects = (page.match(/<ColumnSelect\b/g) ?? []).length;
      ok("the page renders every dropdown from mappableColumns only: all ColumnSelect uses are given `options`, none is given the full column list", /options = useMemo\(\(\) => \(table \? mappableColumns\(table\)/.test(page) && selects === 10 && (page.match(/columns=\{options\}/g) ?? []).length === selects && !/columns=\{columns\}/.test(page), `${selects} selects`);
    }
  }

  // =========================================================================
  section("4. Classifying rows: duplicates, missing names, long fields -- counted separately, adding up");

  {
    const row = (name: string, aff: string | null = null, how: string | null = "h", notes: string | null = null): MappedRow => ({ person_name: name, affiliation: aff, title: null, city: null, state: null, how_known: how, notes });
    const existing = new Set([connectionKey("Jane Doe", "Grace Church"), connectionKey("Pat Roe", null)]);
    const rows = [
      row("Jane Doe", "Grace Church"), // existing
      row("  jane   DOE ", " grace church "), // existing, spacing and case differ
      row("Jane Doe", "Hope Trust"), // different affiliation: NOT a duplicate
      row("Jon Smith", "A"),
      row("Jon Smith", "A"), // repeats earlier row in file
      row("John Smith", "A"), // fuzzy neighbour: NOT a duplicate
      row("   "), // no name
      row("", "Somewhere"), // no name
      row("X".repeat(NETWORK_NAME_MAX + 1)), // too long
      row("Long Notes", null, "h", "n".repeat(NETWORK_NOTES_MAX + 1)),
      row("Long Aff", "a".repeat(NETWORK_AFFILIATION_MAX + 1)),
      row("Long How", null, "h".repeat(NETWORK_HOW_KNOWN_MAX + 1)),
      row("Pat Roe", null), // existing (no affiliation both sides)
      row("Pat Roe", ""), // existing ('' is no affiliation)
    ];
    const { toInsert, counts } = classifyImportRows(rows, existing);
    ok("received is the denominator: every row handed in", counts.received === rows.length);
    ok("duplicates against EXISTING people (exact normalized name+affiliation: trim, lowercase, collapse spaces) are counted on their own", counts.duplicateExisting === 4, JSON.stringify(counts));
    ok("duplicates WITHIN the file are counted on their own, separately from existing", counts.duplicateInFile === 1);
    ok("rows without a name are counted on their own (blank and whitespace-only)", counts.missingName === 2);
    ok("rows over a field cap (name, affiliation, how-known, notes) are counted as too long, not truncated", counts.tooLong === 4);
    ok("the same name at a different affiliation is a different person; 'Jon' and 'John' are different people (no fuzzy matching)", toInsert.map((r) => r.person_name + "|" + r.affiliation).join(";") === "Jane Doe|Hope Trust;Jon Smith|A;John Smith|A", toInsert.map((r) => r.person_name).join());
    ok("imported + duplicate-existing + duplicate-in-file + missing-name + too-long = rows received", countsAddUp(counts) && counts.toImport + counts.duplicateExisting + counts.duplicateInFile + counts.missingName + counts.tooLong === rows.length);
    ok("countsAddUp refuses numbers that do not add up", !countsAddUp({ ...counts, toImport: counts.toImport + 1 }));
    ok("each row lands in exactly one reason: a nameless row that is also over-long is 'missing name', not both", classifyImportRows([row("", null, "h", "n".repeat(NETWORK_NOTES_MAX + 1))], new Set()).counts.missingName === 1);
    ok("stored fields are trimmed and an empty optional field becomes null", (() => {
      const r = classifyImportRows([row("  Ada  ", "  ", "  ", "  ")], new Set()).toInsert[0];
      return r.person_name === "Ada" && r.affiliation === null && r.how_known === null && r.notes === null;
    })());
    ok("a name just at each cap is accepted", classifyImportRows([row("X".repeat(NETWORK_NAME_MAX), "a".repeat(NETWORK_AFFILIATION_MAX), "h".repeat(NETWORK_HOW_KNOWN_MAX), "n".repeat(NETWORK_NOTES_MAX))], new Set()).counts.toImport === 1);
  }

  // =========================================================================
  section("5. The server's view of the request: a hostile client");

  {
    const good = { person_name: "Jane", affiliation: null, title: null, city: null, state: null, how_known: "x", notes: null };
    ok("a well-formed request parses", "rows" in parseImportRequest([good], { strength: "warm" }, true));
    const bad = (rows: unknown, options: unknown) => "error" in parseImportRequest(rows, options, true);
    ok("bad strength is refused: missing, empty, wrong case, unknown, wrong type", bad([good], {}) && bad([good], { strength: "" }) && bad([good], { strength: "Warm" }) && bad([good], { strength: "friend" }) && bad([good], { strength: 3 }));
    ok("extra option keys are refused (no organization_id, no recorded_by, no strength-by-another-name)", bad([good], { strength: "warm", organization_id: "x" }) && bad([good], { strength: "warm", recorded_by: USER_ID }));
    ok("extra row keys are refused: organization_id, recorded_by, email, anything", bad([{ ...good, organization_id: "x" }], { strength: "warm" }) && bad([{ ...good, recorded_by: "x" }], { strength: "warm" }) && bad([{ ...good, email: "a@b.c" }], { strength: "warm" }));
    ok("a row missing a key is refused", bad([{ person_name: "Jane", affiliation: null, how_known: null }], { strength: "warm" }));
    ok("wrong types are refused: non-string name, number notes, an object, null row, string row", bad([{ ...good, person_name: 5 }], { strength: "warm" }) && bad([{ ...good, notes: 5 }], { strength: "warm" }) && bad([{ ...good, how_known: {} }], { strength: "warm" }) && bad([null], { strength: "warm" }) && bad(["Jane"], { strength: "warm" }));
    ok("not an array, an empty array, or null options are refused", bad({}, { strength: "warm" }) && bad([], { strength: "warm" }) && bad([good], null) && bad([good], "warm") && bad(null, { strength: "warm" }));
    const big = Array.from({ length: NETWORK_IMPORT_MAX_ROWS + 1 }, () => good);
    const refused = parseImportRequest(big, { strength: "warm" }, true);
    ok(`an oversize batch (${NETWORK_IMPORT_MAX_ROWS + 1} rows) is refused plainly, naming the limit`, "error" in refused && refused.error.includes(String(NETWORK_IMPORT_MAX_ROWS)) && /Nothing was imported/.test(refused.error));
    ok(`exactly ${NETWORK_IMPORT_MAX_ROWS} rows is accepted`, "rows" in parseImportRequest(big.slice(1), { strength: "warm" }, true));
    ok("the read-only preview needs no strength (it writes nothing) but still refuses extra keys", "rows" in parseImportRequest([good], {}, false) && "error" in parseImportRequest([good], { organization_id: "x" }, false));
    ok("the maximum rows per import is 5000 and the chunk size 500", NETWORK_IMPORT_MAX_ROWS === 5000 && NETWORK_IMPORT_CHUNK_SIZE === 500);
  }

  // =========================================================================
  section("6. The real server actions, run against a fake client");

  const S = makeStubber(root);
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  const revalidated: string[] = [];
  let db = new FakeNetDb();
  S.stub(S.resolve("lib/supabase/server.ts"), { createClient: () => db });
  S.stub(require.resolve("next/cache"), { revalidatePath: (p: string) => revalidated.push(p) });
  S.forget(S.resolve("lib/auth.ts"));
  const importActionsPath = S.resolve("app/(dashboard)/network/import-actions.ts");
  const actionsPath = S.resolve("app/(dashboard)/network/actions.ts");
  S.forget(importActionsPath);
  S.forget(actionsPath);
  S.forget(S.resolve("lib/network-store.ts"));

  try {
    const imp = require(importActionsPath) as {
      importConnections: (rows: unknown, options: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      previewConnectionImport: (rows: unknown, options: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const net = require(actionsPath) as {
      deleteConnections: (ids: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      getMatchingConnectionIds: (q: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const R = (name: string, aff: string | null = null, how: string | null = "From a list", notes: string | null = null) => ({ person_name: name, affiliation: aff, title: null, city: null, state: null, how_known: how, notes });
    const fresh = () => {
      db = new FakeNetDb();
      revalidated.length = 0;
      return db;
    };

    // ---- refusals touch nothing ----
    {
      const d = fresh();
      const results = await Promise.all([
        imp.importConnections([R("A")], { strength: "" }),
        imp.importConnections([R("A")], { strength: "friend" }),
        imp.importConnections([R("A")], {}),
        imp.importConnections([R("A")], { strength: "warm", organization_id: "other-org" }),
        imp.importConnections([{ ...R("A"), organization_id: "other-org" }], { strength: "warm" }),
        imp.importConnections([{ ...R("A"), email: "a@b.c" }], { strength: "warm" }),
        imp.importConnections(Array.from({ length: NETWORK_IMPORT_MAX_ROWS + 1 }, (_, i) => R(`P${i}`)), { strength: "warm" }),
        imp.importConnections([], { strength: "warm" }),
        imp.importConnections("not rows", { strength: "warm" }),
      ]);
      ok("the real action refuses a bad strength, extra keys, an oversize batch, an empty batch and junk -- every one returns {error}, none throws", results.every((r) => "error" in r), JSON.stringify(results.map((r) => r.error)));
      ok("... and a refused request makes NO database call at all (not even a read) and revalidates nothing", d.log.length === 0 && revalidated.length === 0, JSON.stringify(d.log));
      ok("... the oversize refusal names the limit", /5000/.test(results[6].error));
    }

    // ---- happy path with existing people past 1000 rows ----
    {
      const d = fresh();
      d.seed(
        "network_connections",
        Array.from({ length: 2300 }, (_, i) => ({ id: uuidOf(i + 1), person_name: `Existing ${i}`, affiliation: i % 2 ? `Org ${i}` : null, how_known: "x", strength: "warm", notes: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }))
      );
      d.seed("network_connections", [{ id: uuidOf(9000), person_name: "Jane Doe", affiliation: "Grace Church", how_known: "x", strength: "close", notes: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
      d.seed("network_connections", [{ id: uuidOf(9001), person_name: "Last One", affiliation: null, how_known: "x", strength: "close", notes: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
      const total = d.rows("network_connections").length; // 2302
      const rows = [
        R("New Person", "Hope Trust", "Donor list", "likes jazz"),
        R("Second New"),
        R("jane  doe", " GRACE CHURCH "), // duplicate of existing (the 2,301st row: beyond the first 1000)
        R("Last One"), // duplicate of the LAST existing row
        R("Second New"), // duplicate in file
        R("   "), // no name
        R("N".repeat(NETWORK_NAME_MAX + 1)), // too long
      ];
      const preview = await imp.previewConnectionImport(rows, {});
      ok("the preview classifies against EVERYONE already recorded (2302 people, past the 1000-row response limit) -- duplicates found in rows 2301 and 2302 prove the read was paged", "success" in preview && preview.counts.duplicateExisting === 2, JSON.stringify(preview));
      ok("the preview writes nothing", d.log.every((l) => l.op === "select") && d.rows("network_connections").length === total && d.logOf("network_connections", "insert").length === 0);
      const rangedReads = d.log.filter((l) => l.op === "select" && !l.head && l.range);
      ok("the existing people were read with ranges in pages (3 pages for 2302 rows) after an exact count", rangedReads.length === 3 && d.log.some((l) => l.head === true), `ranged reads: ${rangedReads.length}`);

      const before = d.log.length;
      const result = await imp.importConnections(rows, { strength: "warm" });
      ok("the real import succeeds", "success" in result, JSON.stringify(result));
      const c = result.counts;
      ok("counts BY REASON: 2 imported, 2 already recorded, 1 repeated in the file, 1 without a name, 1 too long", result.imported === 2 && c.toImport === 2 && c.duplicateExisting === 2 && c.duplicateInFile === 1 && c.missingName === 1 && c.tooLong === 1, JSON.stringify(c));
      ok("the counts add up to the 7 rows received (imported + each skip reason = rows in)", c.received === 7 && result.imported + c.duplicateExisting + c.duplicateInFile + c.missingName + c.tooLong === 7);
      const inserts = d.logOf("network_connections", "insert").slice(0);
      ok("exactly one insert call, carrying exactly the 2 new people", inserts.length === 1 && (inserts[0].payload as unknown[]).length === 2);
      const payload = inserts[0].payload as Record<string, unknown>[];
      ok("every inserted row has exactly recorded_by, person_name, affiliation, how_known, strength, notes -- and NEVER organization_id", payload.every((p) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["affiliation", "how_known", "notes", "person_name", "recorded_by", "strength"])), JSON.stringify(payload));
      ok("recorded_by is the verified session user, and strength is the one the importer chose, for every row", payload.every((p) => p.recorded_by === USER_ID && p.strength === "warm"));
      ok("the stored values are the trimmed mapped values (notes kept, empty optional fields null)", payload[0].person_name === "New Person" && payload[0].affiliation === "Hope Trust" && payload[0].how_known === "Donor list" && payload[0].notes === "likes jazz" && payload[1].affiliation === null);
      ok("the database default filled organization_id (the fake applied it; the action never sent one)", d.rows("network_connections").filter((r) => r.person_name === "New Person").every((r) => typeof r.organization_id === "string"));
      ok("revalidates the Network page and the prospects", revalidated.includes("/network") && revalidated.includes("/prospects"));
      ok("the log after the import shows reads, then ONE insert, and nothing on any other table", d.log.slice(before).every((l) => l.table === "network_connections"));

      // a second identical import is all duplicates -- idempotent
      const again = await imp.importConnections(rows, { strength: "warm" });
      ok("running the same import again imports nobody: the two new people are now 'already recorded' (and so is the repeat of one of them)", "success" in again && again.imported === 0 && again.counts.duplicateExisting === 5 && again.counts.duplicateInFile === 0 && countsAddUp(again.counts), JSON.stringify(again));
      ok("an import with nothing to write makes no insert call", d.logOf("network_connections", "insert").length === 1);
    }

    // ---- chunking ----
    {
      const d = fresh();
      const rows = Array.from({ length: 1200 }, (_, i) => R(`Chunk Person ${i}`));
      const r = await imp.importConnections(rows, { strength: "acquaintance" });
      const inserts = d.logOf("network_connections", "insert");
      ok("1200 people are inserted in chunks of 500, 500 and 200", "success" in r && r.imported === 1200 && JSON.stringify(inserts.map((i) => (i.payload as unknown[]).length)) === JSON.stringify([500, 500, 200]), JSON.stringify(inserts.map((i) => (i.payload as unknown[]).length)));
    }

    // ---- chunk failure is reported truthfully ----
    {
      const d = fresh();
      d.failInsert["network_connections"] = { onCall: 2, message: "boom: connection reset" };
      const rows = Array.from({ length: 1200 }, (_, i) => R(`Fail Person ${i}`));
      const r = await imp.importConnections(rows, { strength: "warm" });
      ok("a chunk failure returns {error}, not a thrown message and not a success", "error" in r && !("success" in r), JSON.stringify(r));
      ok("... it reports exactly how many went in before the failure (500) and that the 200 after it were never attempted", r.partial?.imported === 500 && r.partial?.notAttempted === 200, JSON.stringify(r.partial));
      ok("... the message says '500 of 1200', carries the database's reason, and says nothing after the failed step was attempted", /500 of 1200/.test(r.error) && /boom/.test(r.error) && /nothing after the failed step was attempted/.test(r.error), r.error);
      ok("... the message does NOT claim all-or-nothing: it says what already went in was not undone", /Nothing already imported was undone/.test(r.error));
      ok("... the third chunk was never sent, and exactly the first chunk's 500 are in the table", d.logOf("network_connections", "insert").length === 2 && d.rows("network_connections").length === 500);
    }

    // ---- a failed read of existing people imports nothing ----
    {
      const d = fresh();
      const orig = d.from.bind(d);
      d.from = ((table: string) => {
        const q = orig(table) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (table === "network_connections") {
          const select = q.select.bind(q);
          q.select = (...a: unknown[]) => {
            const s = select(...a);
            s.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "relation does not exist" }, count: null }).then(resolve);
            return s;
          };
        }
        return q;
      }) as typeof d.from;
      const r = await imp.importConnections([R("A")], { strength: "warm" });
      ok("if the existing people cannot be read the import writes nothing and says so (a duplicate check that could not run is not 'no duplicates')", "error" in r && /nothing was imported/i.test(r.error) && d.logOf("network_connections", "insert").length === 0, JSON.stringify(r));
    }

    // ---- bulk delete ----
    {
      const d = fresh();
      d.seed("network_connections", Array.from({ length: 250 }, (_, i) => ({ id: uuidOf(i + 1), person_name: `Del ${i}`, affiliation: null, strength: "warm", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" })));
      const ids = Array.from({ length: 250 }, (_, i) => uuidOf(i + 1));
      const r = await net.deleteConnections([...ids, ids[0]]);
      const dels = d.logOf("network_connections", "delete");
      ok("deleteConnections removes the selected people in chunks of 100 (100, 100, 50) and returns the count actually removed", "success" in r && r.deleted === 250 && dels.length === 3 && d.rows("network_connections").length === 0, JSON.stringify(r));
      ok("... a repeated id is removed once, not twice", r.deleted === 250);
      ok("... it deletes only network_connections (path suggestions go with them through the database's foreign key, not by this code)", d.log.every((l) => l.table === "network_connections"));
      ok("... it revalidates the Network page and prospects", revalidated.includes("/network") && revalidated.includes("/prospects"));
    }
    {
      const d = fresh();
      d.seed("network_connections", [{ id: uuidOf(1), person_name: "Keep", affiliation: null, strength: "warm" }]);
      const refusals = await Promise.all([net.deleteConnections([]), net.deleteConnections("all"), net.deleteConnections(["not-a-uuid"]), net.deleteConnections([uuidOf(1), 5]), net.deleteConnections(Array.from({ length: NETWORK_DELETE_MAX_IDS + 1 }, (_, i) => uuidOf(i + 1)))]);
      ok("deleteConnections refuses an empty selection, junk, non-uuid ids and an oversize selection, and touches nothing", refusals.every((r) => "error" in r) && d.log.length === 0 && d.rows("network_connections").length === 1, JSON.stringify(refusals));
    }
    {
      const d = fresh();
      d.seed("network_connections", Array.from({ length: 250 }, (_, i) => ({ id: uuidOf(i + 1), person_name: `Del ${i}`, affiliation: null, strength: "warm" })));
      const orig = d.from.bind(d);
      let n = 0;
      d.from = ((table: string) => {
        const q = orig(table) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (table === "network_connections") {
          const del = q.delete.bind(q);
          q.delete = () => {
            const dq = del();
            n++;
            if (n === 2) dq.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "timeout" }, count: null }).then(resolve);
            return dq;
          };
        }
        return q;
      }) as typeof d.from;
      const r = await net.deleteConnections(Array.from({ length: 250 }, (_, i) => uuidOf(i + 1)));
      ok("a failure part-way through a bulk removal reports exactly how many were removed and that nothing after was attempted", "error" in r && r.deleted === 100 && r.notAttempted === 50 && /100 of 250/.test(r.error) && /nothing after the failed step was attempted/.test(r.error) && d.rows("network_connections").length === 150, JSON.stringify(r));
    }

    // ---- select all matching, with a search that has special characters ----
    {
      const d = fresh();
      const people = ["50% Off Fund", "Smith, Jane", 'He said "hi"', "a_b Trust", "axb Trust", "Plain Person", "Back\\slash Co"].map((n, i) => ({ id: uuidOf(i + 1), person_name: n, affiliation: i === 5 ? "Smith & Sons" : null, strength: "warm" }));
      d.seed("network_connections", people);
      const idsFor = async (q: string) => {
        const r = await net.getMatchingConnectionIds(q);
        return "ids" in r ? r.ids.map((id: string) => people.find((p) => p.id === id)!.person_name).sort() : r.error;
      };
      ok("search is case-insensitive and covers name AND affiliation ('smith' finds a name and an affiliation)", JSON.stringify(await idsFor("SMITH")) === JSON.stringify(["Plain Person", "Smith, Jane"]));
      ok("a '%' in the search matches itself, not everything", JSON.stringify(await idsFor("50%")) === JSON.stringify(["50% Off Fund"]));
      ok("a '_' in the search matches itself, not any character ('a_b' does not find 'axb')", JSON.stringify(await idsFor("a_b")) === JSON.stringify(["a_b Trust"]));
      ok("a comma in the search does not split the filter ('Smith, J' finds the one with the comma)", JSON.stringify(await idsFor("Smith, J")) === JSON.stringify(["Smith, Jane"]));
      ok("a double quote in the search does not break the filter", JSON.stringify(await idsFor('"hi"')) === JSON.stringify(['He said "hi"']));
      ok("a backslash in the search matches itself", JSON.stringify(await idsFor("back\\slash")) === JSON.stringify(["Back\\slash Co"]));
      ok("an empty search selects everyone; 'no match' selects no one", (await net.getMatchingConnectionIds("")).total === 7 && (await net.getMatchingConnectionIds("zzz")).total === 0);
      const big = fresh();
      big.seed("network_connections", Array.from({ length: 1500 }, (_, i) => ({ id: uuidOf(i + 1), person_name: `Match ${i}`, affiliation: null, strength: "warm" })));
      const all = await net.getMatchingConnectionIds("match");
      ok("'select all N matching' returns ALL 1500 ids, past the 1000-row response limit, with the exact total", "ids" in all && all.ids.length === 1500 && all.total === 1500 && new Set(all.ids).size === 1500);
    }
  } finally {
    S.restore();
  }

  // =========================================================================
  section("7. Paging and search, pure");

  {
    ok("the page size is a named constant, 50", NETWORK_PAGE_SIZE === 50);
    ok("pageWindow: first page of 120 people is 1-50 of 3 pages", (() => { const w = pageWindow(1, 120); return w.from === 0 && w.to === 49 && w.first === 1 && w.last === 50 && w.totalPages === 3; })());
    ok("pageWindow: the last page is short (101-120)", (() => { const w = pageWindow(3, 120); return w.from === 100 && w.to === 119 && w.first === 101 && w.last === 120; })());
    ok("pageWindow: a page past the end clamps to the last page; page 0 and junk clamp to the first", pageWindow(99, 120).page === 3 && pageWindow(0, 120).page === 1 && pageWindow(NaN, 120).page === 1 && pageWindow(-4, 120).page === 1);
    ok("pageWindow: exactly one page's worth, one over, and empty", pageWindow(1, 50).totalPages === 1 && pageWindow(1, 51).totalPages === 2 && pageWindow(1, 0).totalPages === 1 && pageWindow(1, 0).first === 0 && pageWindow(1, 0).last === 0);
    ok("pageWindow: 1,500 people is 30 pages and the 30th is 1451-1500", (() => { const w = pageWindow(30, 1500); return w.totalPages === 30 && w.first === 1451 && w.last === 1500; })());
    ok("parsePage: a positive integer, else 1", parsePage("3") === 3 && parsePage("0") === 1 && parsePage("-2") === 1 && parsePage("abc") === 1 && parsePage(undefined) === 1 && parsePage("2.5") === 1 && parsePage(["4", "5"]) === 4);
    ok("normalizeSearch trims, collapses whitespace and caps length", normalizeSearch("  hello   world ") === "hello world" && normalizeSearch("x".repeat(500)).length === 100 && normalizeSearch(undefined) === "");
    ok("networkHref omits defaults and encodes the search", networkHref("", 1) === "/network" && networkHref("a b&c", 2) === "/network?q=a+b%26c&page=2" && networkHref("", 3) === "/network?page=3");
    ok("searchOrFilter: none for an empty search; otherwise a quoted, escaped ilike on name and affiliation", searchOrFilter("") === null && searchOrFilter("ab") === 'person_name.ilike."%ab%",affiliation.ilike."%ab%"');
    ok("searchOrFilter escapes LIKE wildcards and quoting characters in the right order", searchOrFilter('a%b_c"d\\e') === 'person_name.ilike."%a\\\\%b\\\\_c\\"d\\\\\\\\e%",affiliation.ilike."%a\\\\%b\\\\_c\\"d\\\\\\\\e%"', searchOrFilter('a%b_c"d\\e') ?? "");
    ok("matchesSearch is the same match in code: case-insensitive substring over name and affiliation", matchesSearch({ person_name: "Jane Doe", affiliation: "Grace Church" }, "grace") && matchesSearch({ person_name: "Jane Doe", affiliation: null }, "JANE") && !matchesSearch({ person_name: "Jane Doe", affiliation: null }, "grace") && matchesSearch({ person_name: "x", affiliation: null }, ""));
    ok("parseDeleteIds de-duplicates, requires uuids, and caps the count", (() => { const r = parseDeleteIds([uuidOf(1), uuidOf(1), uuidOf(2)]); return "ids" in r && r.ids.length === 2; })() && "error" in parseDeleteIds([]) && "error" in parseDeleteIds(["x"]) && NETWORK_DELETE_CHUNK_SIZE === 100 && NETWORK_DELETE_MAX_IDS === 10000);
  }

  // =========================================================================
  section("8. Disclosure");

  {
    ok("the import disclosure starts with the capture disclosure, unweakened and word for word", NETWORK_IMPORT_DISCLOSURE.startsWith(NETWORK_DISCLOSURE));
    ok("... and adds what an import adds (ruling 0040 clause 3): names, affiliations, how-known text and notes shared with the AI service; notes are free text; contact details not imported; nothing sent to the people listed", /name, where they work, how you know them, how close you are and your notes are shared with the AI service/.test(NETWORK_IMPORT_DISCLOSURE) && /shared with the AI service/.test(NETWORK_IMPORT_DISCLOSURE) && /free text/.test(NETWORK_IMPORT_DISCLOSURE) && /never imported or stored/.test(NETWORK_IMPORT_DISCLOSURE) && /Nothing is ever sent to the people you list/.test(NETWORK_IMPORT_DISCLOSURE));
    const ws = stripComments(read("app/(dashboard)/network/import/import-workspace.tsx"));
    ok("the import page renders the import disclosure", /NETWORK_IMPORT_DISCLOSURE/.test(ws) && /\{NETWORK_IMPORT_DISCLOSURE\}/.test(ws));
  }

  // =========================================================================
  section("9. Source scans: the import's boundaries");

  {
    const importActions = stripComments(read("app/(dashboard)/network/import-actions.ts"));
    const store = stripComments(read("lib/network-store.ts"));
    const listActions = stripComments(read("app/(dashboard)/network/actions.ts"));
    const pageDirs = ["app/(dashboard)/network/page.tsx", "app/(dashboard)/network/import/page.tsx", "app/(dashboard)/network/import/import-workspace.tsx", "app/(dashboard)/network/network-workspace.tsx"].map((p) => stripComments(read(p)));
    ok("the import action uses the SESSION client (createClient from lib/supabase/server) and no other client", /import \{ createClient \} from "@\/lib\/supabase\/server"/.test(importActions) && /createClient\(\)/.test(importActions));
    ok("no import, store or Network file uses createAdminClient, a service-role key, or the Anthropic client", ![importActions, store, listActions, ...pageDirs].some((t) => /createAdminClient|service_role|SERVICE_ROLE|serviceRole|anthropic/i.test(t)));
    ok("the import action never names organization_id (the column default fills it)", !/organization_id/.test(importActions) && !/organization_id/.test(store));
    ok("recorded_by is the verified session user's id in the store call, not a request value", /insertConnectionsInChunks\(supabase, user\.id,/.test(importActions) && /const user = await requireUser\(\)/.test(importActions));
    ok("the import and bulk-delete code reads no research table and no prospect table", ![importActions, store].some((t) => /from\("(research_|prospects|drafts|stage_changes|interactions|contacts)/.test(t)));
    ok("the import touches only network_connections", [importActions, store].every((t) => (t.match(/\.from\("([a-z_]+)"\)/g) ?? []).every((m) => m === '.from("network_connections")')));
    ok("the insert row built by the store has exactly the six allowed keys, plus title / city / state only when the chunk has one (ruling 0044)", (() => { const m = store.match(/\.insert\(\s*chunks\[i\]\.map\(\(r\) => \(\{([\s\S]*?)\}\)\)/); if (!m) return false; const keys = m[1].split("\n").map((l) => l.trim().split(/[:,]/)[0]).filter(Boolean); return JSON.stringify(keys) === JSON.stringify(["recorded_by", "person_name", "affiliation", "...(withFacts ? { title", "how_known", "strength", "notes"]) && /\.\.\.\(withFacts \? \{ title: r\.title, city: r\.city, state: r\.state \} : \{\}\)/.test(m[1]); })());
    const lib = stripComments(read("lib/network-import.ts")).replace(/export const CONTACT_HEADING_(STEMS|WORDS)[\s\S]*?\];/g, "");
    ok("lib/network-import.ts has no contact-field identifier outside its two heading lists (no email/phone/handle/social/url field exists in any type)", !/\b(email|phone|mobile|linkedin|twitter|facebook|instagram|whatsapp|handle|website)\b/i.test(lib), (lib.match(/\b(email|phone|mobile|linkedin|twitter|facebook|instagram|whatsapp|handle|website)\b/gi) ?? []).join());
    ok("the stored row type is exactly name, affiliation, title, city, state, how_known, notes", /export type MappedRow = \{\s*person_name: string;\s*affiliation: string \| null;\s*title: string \| null;\s*city: string \| null;\s*state: string \| null;\s*how_known: string \| null;\s*notes: string \| null;\s*\};/.test(lib));
    const clientFile = read("app/(dashboard)/network/import/import-workspace.tsx");
    ok("the client component imports no server-only module (no supabase, no auth, no anthropic) and is a client component", clientFile.startsWith('"use client"') && !/@\/lib\/supabase|@\/lib\/auth|@\/lib\/ai/.test(clientFile));
    ok("the client component has no email or tel input", !/type="(email|tel)"/.test(clientFile));
    ok("the file is parsed in the browser (readCsvRecords on file.text()) and never posted as a file", /file\.text\(\)/.test(clientFile) && /readCsvRecords\(text\)/.test(clientFile) && !/FormData|new FormData/.test(clientFile));
    ok("the Network page links to the import page", /href="\/network\/import"/.test(read("app/(dashboard)/network/network-workspace.tsx")));
    ok("bulk removal is expand-then-confirm: the remove button opens a confirm step and the delete call is only in the confirm handler", (() => { const w = read("app/(dashboard)/network/network-workspace.tsx"); const open = w.indexOf("setConfirmOpen(true)"); const call = w.indexOf("await deleteConnections(ids)"); return open > 0 && call > 0 && /const removeSelected = \(\) =>/.test(w) && w.indexOf("onClick={removeSelected}") > w.indexOf("{confirmOpen && (") && !/onClick=\{\(\) => deleteConnections/.test(w); })());
    ok("manual add, edit and single delete are unchanged in what they call", /addConnection/.test(read("app/(dashboard)/network/network-workspace.tsx")) && /updateConnection\(connection\.id, input\)/.test(read("app/(dashboard)/network/network-workspace.tsx")) && /deleteConnection\(connection\.id\)/.test(read("app/(dashboard)/network/network-workspace.tsx")));
    let migrationsTouched = "unknown";
    try {
      // Item 103 added no migration. Migrations 0083 (STATE item 107, ruling
      // 0044), 0084 (STATE item 110, ruling 0045) and 0085 (STATE item 112, the
      // same ruling's slice B) are the later, deliberate additions: they are
      // allowed to appear here; no OTHER migration may be added, and none may be
      // changed.
      const ALLOWED = /supabase\/migrations\/(0083_network_identity|0084_funder_reference|0085_network_person_findings|0086_funder_reference_directory|0087_funder_reference_search_pages_first)\.sql$/;
      const out = execSync("git status --porcelain -- supabase/migrations", { cwd: root, encoding: "utf8" })
        .split("\n")
        .filter((l) => l.trim() && !ALLOWED.test(l))
        .join("\n")
        .trim();
      const diff = execSync("git diff HEAD --name-only -- supabase/migrations", { cwd: root, encoding: "utf8" })
        .split("\n")
        .filter((l) => l.trim() && !ALLOWED.test(l))
        .join("\n")
        .trim();
      migrationsTouched = out + diff;
    } catch (e) {
      migrationsTouched = `git failed: ${(e as Error).message}`;
    }
    ok("no migration file was added or changed other than 0083_network_identity.sql, 0084_funder_reference.sql, 0085_network_person_findings.sql and 0086_funder_reference_directory.sql and 0087_funder_reference_search_pages_first.sql (git status and git diff HEAD over supabase/migrations are otherwise empty)", migrationsTouched === "", migrationsTouched);
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
