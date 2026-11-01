// Importing people from a file the organization already holds (STATE item 103,
// ruling 0040 clauses 1-3). Pure: no database, no browser, no clock -- safe to
// import into the client page that parses the file AND into the server action
// that re-validates what that page sends.
//
// The general invariant: an import takes only the fields a connection may hold
// and names everything it leaves behind, BEFORE it writes. It never guesses at
// what a column means. The earlier defect this guards against (the supporters
// importer silently ignoring a real column because it only recognised literal
// header names) is answered by a MAPPING STEP the person completes: any
// pre-selection is a suggestion they can see and change, never a silent
// mapping; and the import is blocked, not defaulted, while anything required is
// unset.
//
// Contact details are never stored (ruling 0040 clause 1). The gate is the
// column HEADING: a column whose heading looks like contact details or a handle
// cannot be mapped to any field, not even Notes. Data cells are never
// inspected -- a person who files an email address under "Comments" has put it
// there themselves, and the disclosure tells them contact details are not
// imported; only headings gate.

import { isConnectionStrength } from "@/lib/network";

// ---------------------------------------------------------------------------
// Named limits
// ---------------------------------------------------------------------------

// The most people one import request carries. Past it the request is refused
// plainly (the person splits the file); it is never truncated.
export const NETWORK_IMPORT_MAX_ROWS = 5000;
// Rows per insert statement. A failure part-way reports exactly how many
// chunks' worth went in and that nothing after was attempted.
export const NETWORK_IMPORT_CHUNK_SIZE = 500;
// Next's default server-action body limit is 1 MB. The mapped rows are JSON, so
// the page refuses a batch above this BEFORE sending it rather than letting the
// framework reject it with a message nobody can read.
export const NETWORK_IMPORT_MAX_PAYLOAD_BYTES = 900_000;
// Per-field caps. A row over any of them is SKIPPED and counted as too long --
// never truncated, because a half-sentence of someone's notes is not their notes.
export const NETWORK_NAME_MAX = 200;
export const NETWORK_AFFILIATION_MAX = 300;
export const NETWORK_HOW_KNOWN_MAX = 500;
export const NETWORK_NOTES_MAX = 2000;
// The largest file the page will read into the browser.
export const NETWORK_IMPORT_MAX_FILE_BYTES = 10_000_000;
// How many of the file's first rows the person may name as the heading row.
export const NETWORK_HEADING_ROW_CHOICES = 10;
export const NETWORK_PREVIEW_ROWS = 5;

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

// RFC 4180-style records: quoted fields may hold commas, doubled quotes and
// line breaks; CRLF, LF and a lone CR end a record; a leading byte-order mark
// is dropped. Every record is returned, blank ones included, so blank rows can
// be COUNTED instead of vanishing. (lib/candidates.ts's parseCsv lowercases and
// keys headings, so a repeated or empty heading overwrites a column and a quoted
// line break splits a record -- a quiet loss this importer must not have. It is
// left untouched for its existing callers.)
export function readCsvRecords(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnything = false;
  const endRecord = () => {
    record.push(field);
    records.push(record);
    record = [];
    field = "";
    sawAnything = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAnything = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      sawAnything = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += ch;
      sawAnything = true;
    }
  }
  if (sawAnything || field.length > 0 || record.length > 0) endRecord();
  return records;
}

export const isBlankRecord = (r: readonly string[]) => r.every((c) => c.trim() === "");

export type CsvTable = {
  // The heading of every column, in file order, exactly as written (trimmed).
  // An empty string is a column with no heading.
  headers: string[];
  // The data records after the heading row, every one padded to headers.length.
  // Blank records are KEPT so they can be counted.
  rows: string[][];
  headerRowIndex: number;
};

// The first record that is not blank -- the default heading row. -1 for a file
// with nothing in it.
export function firstNonBlankRecord(records: readonly string[][]): number {
  return records.findIndex((r) => !isBlankRecord(r));
}

// Positions among the file's first records that could be the heading row (the
// non-blank ones). A LinkedIn "Connections.csv" begins with a few lines of
// notes before its headings, so the person may name the row; nothing is guessed.
export function headingRowCandidates(records: readonly string[][]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(records.length, NETWORK_HEADING_ROW_CHOICES); i++) if (!isBlankRecord(records[i])) out.push(i);
  return out;
}

export function tableFromRecords(records: readonly string[][], headerRowIndex: number): CsvTable | null {
  if (headerRowIndex < 0 || headerRowIndex >= records.length) return null;
  const headerCells = records[headerRowIndex].map((h) => h.trim());
  const data = records.slice(headerRowIndex + 1);
  // A data row longer than the heading row has cells under no heading at all.
  // Those columns exist and must be named as not imported, so the width is the
  // widest row, not the heading row.
  const width = Math.max(headerCells.length, ...data.map((r) => r.length), 0);
  const headers = Array.from({ length: width }, (_, i) => headerCells[i] ?? "");
  const rows = data.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  return { headers, rows, headerRowIndex };
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

function words(heading: string): string[] {
  return heading
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export const normalizeHeading = (heading: string): string => words(heading).join(" ");

// A heading containing one of these (spaces and punctuation ignored, so
// "E-mail" and "Email Address" both hit "email") looks like contact details or
// a handle. Long, distinctive stems only -- a short stem would catch "hotel".
export const CONTACT_HEADING_STEMS: readonly string[] = [
  "email", "phone", "mobile", "telephone", "address", "street", "postal", "postcode",
  "website", "webpage", "homepage", "linkedin", "twitter", "facebook", "instagram",
  "whatsapp", "skype", "telegram", "tiktok", "snapchat", "youtube", "username",
];
// Short words match only as whole words ("cell" the column, not "cellar"). The
// brief's list (email, e-mail, phone, mobile, cell, tel, address, street, zip,
// postal, url, website, linkedin, twitter, facebook, instagram, handle, social)
// is covered by the stems above and these words; the extras (fax, sms, link,
// mail, web, www, http, username, whatsapp, ...) are the same kind of thing.
export const CONTACT_HEADING_WORDS: readonly string[] = [
  "tel", "url", "urls", "cell", "zip", "web", "www", "fax", "social", "handle", "handles",
  "sms", "link", "links", "http", "https", "mail",
];

export function looksLikeContactDetail(heading: string): boolean {
  const ws = words(heading);
  if (ws.length === 0) return false;
  const compact = ws.join("");
  if (CONTACT_HEADING_STEMS.some((s) => compact.includes(s))) return true;
  return ws.some((w) => CONTACT_HEADING_WORDS.includes(w));
}

export type ColumnInfo = {
  index: number;
  heading: string;
  // The label the person sees: always carries the position, because two
  // columns may share a heading.
  label: string;
  contact: boolean;
  headingless: boolean;
  // Only a column with a heading that does not look like contact details can
  // be mapped to any field.
  mappable: boolean;
};

export function describeColumns(table: CsvTable): ColumnInfo[] {
  return table.headers.map((heading, index) => {
    const headingless = heading === "";
    const contact = !headingless && looksLikeContactDetail(heading);
    return {
      index,
      heading,
      label: headingless ? `Column ${index + 1} (no heading)` : `Column ${index + 1}: ${heading}`,
      contact,
      headingless,
      mappable: !headingless && !contact,
    };
  });
}

// The columns a dropdown may offer. Contact-looking and headingless columns are
// absent from EVERY list, not merely disabled.
export function mappableColumns(table: CsvTable): ColumnInfo[] {
  return describeColumns(table).filter((c) => c.mappable);
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

export type FieldMapping = {
  nameMode: "single" | "split";
  name: number | null;
  first: number | null;
  last: number | null;
  affiliation: number | null;
  role: number | null;
  howKnown: number | null;
  // Used for a row whose how-known cell is empty, and for every row when no
  // column is mapped. Typed by the person; recorded as the batch's origin.
  howKnownSentence: string;
  notes: number | null;
  // "" = not chosen. No default, no inference (ruling 0040 clause 1).
  strength: string;
};

export const EMPTY_MAPPING: FieldMapping = {
  nameMode: "single",
  name: null,
  first: null,
  last: null,
  affiliation: null,
  role: null,
  howKnown: null,
  howKnownSentence: "",
  notes: null,
  strength: "",
};

// The stated alias lists. A heading that matches one EXACTLY (after lowercasing
// and collapsing punctuation) is PRE-SELECTED -- a suggestion the person sees
// in the dropdown and can change. No match means the dropdown starts on
// "not imported". Nothing here fuzzy-matches, and nothing maps without being shown.
export const HEADING_ALIASES = {
  name: ["name", "full name", "person", "person name", "contact name", "member", "member name", "donor", "donor name", "supporter", "supporter name"],
  first: ["first name", "first", "given name", "forename"],
  last: ["last name", "last", "surname", "family name"],
  affiliation: ["company", "organization", "organisation", "employer", "affiliation", "church", "institution", "workplace"],
  role: ["position", "title", "job title", "role", "occupation"],
  howKnown: ["how known", "how you know them", "how we know them", "relationship", "connection"],
  notes: ["notes", "note", "comments", "comment", "remarks"],
} as const;

export function suggestMapping(table: CsvTable): FieldMapping {
  const cols = mappableColumns(table);
  const find = (aliases: readonly string[]): number | null => {
    for (const c of cols) if (aliases.includes(normalizeHeading(c.heading))) return c.index;
    return null;
  };
  const name = find(HEADING_ALIASES.name);
  const first = find(HEADING_ALIASES.first);
  const last = find(HEADING_ALIASES.last);
  const m: FieldMapping = { ...EMPTY_MAPPING };
  if (name !== null) {
    m.name = name;
  } else if (first !== null && last !== null) {
    m.nameMode = "split";
    m.first = first;
    m.last = last;
  }
  m.affiliation = find(HEADING_ALIASES.affiliation);
  m.role = find(HEADING_ALIASES.role);
  m.howKnown = find(HEADING_ALIASES.howKnown);
  m.notes = find(HEADING_ALIASES.notes);
  return m;
}

export type MappedRow = {
  person_name: string;
  affiliation: string | null;
  how_known: string | null;
  notes: string | null;
};

export type NotImportedColumn = {
  index: number;
  heading: string;
  label: string;
  contact: boolean;
  headingless: boolean;
};

export type MappingResult = {
  // Plain reasons the import cannot proceed. Empty means it can.
  blockers: string[];
  // Every non-blank data row, mapped. Empty while a column is mapped unsoundly.
  rows: MappedRow[];
  rowsRead: number;
  blankRows: number;
  notImported: NotImportedColumn[];
  // How the first people will be recorded (rows that have a name).
  preview: MappedRow[];
  canImport: boolean;
};

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// The join the page states in words: "Role, Affiliation", or just whichever of
// the two is present.
export function joinRoleAndAffiliation(role: string, affiliation: string): string | null {
  const r = clean(role);
  const a = clean(affiliation);
  if (r && a) return `${r}, ${a}`;
  return r || a || null;
}

export function reduceMapping(table: CsvTable, mapping: FieldMapping): MappingResult {
  const blockers: string[] = [];
  const cols = describeColumns(table);
  const used: { field: string; index: number }[] = [];
  let sound = true;

  const useColumn = (field: string, index: number | null) => {
    if (index === null) return;
    const info = cols[index];
    if (!info) {
      blockers.push(`The column chosen for ${field} is not in this file.`);
      sound = false;
      return;
    }
    if (info.contact) {
      blockers.push(`"${info.heading}" looks like contact details, which are never stored, so it cannot be used for ${field}.`);
      sound = false;
      return;
    }
    if (info.headingless) {
      blockers.push(`${info.label} has no heading, so it cannot be used for ${field}.`);
      sound = false;
      return;
    }
    const clash = used.find((u) => u.index === index);
    if (clash) {
      blockers.push(`${info.label} is chosen for both ${clash.field} and ${field}. Each column can be used for one thing.`);
      sound = false;
      return;
    }
    used.push({ field, index });
  };

  if (mapping.nameMode === "single") {
    if (mapping.name === null) blockers.push("Choose the column that holds each person's name.");
    useColumn("Name", mapping.name);
  } else {
    if (mapping.first === null || mapping.last === null) blockers.push("Choose both the First name column and the Last name column, or switch to a single Name column.");
    useColumn("First name", mapping.first);
    useColumn("Last name", mapping.last);
  }
  useColumn("Affiliation", mapping.affiliation);
  useColumn("Role or title", mapping.role);
  useColumn("How you know them", mapping.howKnown);
  useColumn("Notes", mapping.notes);

  if (!isConnectionStrength(mapping.strength)) blockers.push("Choose how close you are to these people (close, warm or acquaintance). It applies to the whole batch and has no default.");
  const sentence = clean(mapping.howKnownSentence);
  if (mapping.howKnown === null && !sentence) {
    blockers.push("Say how you know these people: choose a column, or type one sentence (for example \"From our 2024 donor list\"). It is how this batch's origin is recorded.");
  }
  if (sentence.length > NETWORK_HOW_KNOWN_MAX) blockers.push(`The sentence about how you know them is longer than ${NETWORK_HOW_KNOWN_MAX} characters.`);

  const mappedIdx = new Set(used.map((u) => u.index));
  const notImported: NotImportedColumn[] = cols
    .filter((c) => !mappedIdx.has(c.index))
    .map((c) => ({ index: c.index, heading: c.heading, label: c.label, contact: c.contact, headingless: c.headingless }));

  const dataRecords = table.rows;
  const blankRows = dataRecords.filter(isBlankRecord).length;
  const rowsRead = dataRecords.length;
  if (rowsRead === 0) blockers.push("The file has a heading row but no people under it.");

  const rows: MappedRow[] = [];
  if (sound) {
    const cell = (r: readonly string[], i: number | null) => (i === null ? "" : (r[i] ?? ""));
    for (const r of dataRecords) {
      if (isBlankRecord(r)) continue;
      const person_name =
        mapping.nameMode === "single"
          ? clean(cell(r, mapping.name))
          : clean([cell(r, mapping.first), cell(r, mapping.last)].filter((p) => p.trim()).join(" "));
      rows.push({
        person_name,
        affiliation: joinRoleAndAffiliation(cell(r, mapping.role), cell(r, mapping.affiliation)),
        how_known: clean(cell(r, mapping.howKnown)) || sentence || null,
        notes: cell(r, mapping.notes).trim() || null,
      });
    }
  }
  if (rows.length > NETWORK_IMPORT_MAX_ROWS) {
    blockers.push(`This file has ${rows.length} people and one import takes at most ${NETWORK_IMPORT_MAX_ROWS}. Split the file and import it in parts.`);
  }
  if (rows.length > 0 && new TextEncoder().encode(JSON.stringify(rows)).length > NETWORK_IMPORT_MAX_PAYLOAD_BYTES) {
    blockers.push("This batch is too large to send in one import. Split the file and import it in parts.");
  }

  return {
    blockers,
    rows: sound ? rows : [],
    rowsRead,
    blankRows,
    notImported,
    preview: rows.filter((r) => r.person_name).slice(0, NETWORK_PREVIEW_ROWS),
    canImport: blockers.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Classifying rows (shared by the page's preview and the server action)
// ---------------------------------------------------------------------------

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Exact normalized name + affiliation: trim, lowercase, collapse whitespace.
// Nothing fuzzy -- "Jon Smith" and "John Smith" are different people here.
export function connectionKey(name: string, affiliation: string | null): string {
  return JSON.stringify([norm(name), norm(affiliation)]);
}

export type ImportCounts = {
  // The denominator: rows the classification was given.
  received: number;
  // Rows that will be (or were) written.
  toImport: number;
  // Already recorded, by exact name + affiliation.
  duplicateExisting: number;
  // Repeats an earlier row of the same file.
  duplicateInFile: number;
  missingName: number;
  tooLong: number;
};

// Each row lands in exactly ONE of the reasons, so they cannot blend: no name
// first, then too long, then duplicate.
export function countsAddUp(c: ImportCounts): boolean {
  return c.toImport + c.duplicateExisting + c.duplicateInFile + c.missingName + c.tooLong === c.received;
}

export function isTooLong(r: MappedRow): boolean {
  return (
    r.person_name.length > NETWORK_NAME_MAX ||
    (r.affiliation ?? "").length > NETWORK_AFFILIATION_MAX ||
    (r.how_known ?? "").length > NETWORK_HOW_KNOWN_MAX ||
    (r.notes ?? "").length > NETWORK_NOTES_MAX
  );
}

export function classifyImportRows(
  rows: readonly MappedRow[],
  existing: ReadonlySet<string>
): { toInsert: MappedRow[]; counts: ImportCounts } {
  const counts: ImportCounts = { received: rows.length, toImport: 0, duplicateExisting: 0, duplicateInFile: 0, missingName: 0, tooLong: 0 };
  const seen = new Set<string>();
  const toInsert: MappedRow[] = [];
  for (const raw of rows) {
    const row: MappedRow = {
      person_name: raw.person_name.trim(),
      affiliation: raw.affiliation?.trim() || null,
      how_known: raw.how_known?.trim() || null,
      notes: raw.notes?.trim() || null,
    };
    if (!row.person_name) {
      counts.missingName++;
      continue;
    }
    if (isTooLong(row)) {
      counts.tooLong++;
      continue;
    }
    const key = connectionKey(row.person_name, row.affiliation);
    if (existing.has(key)) {
      counts.duplicateExisting++;
      continue;
    }
    if (seen.has(key)) {
      counts.duplicateInFile++;
      continue;
    }
    seen.add(key);
    toInsert.push(row);
    counts.toImport++;
  }
  return { toInsert, counts };
}

// ---------------------------------------------------------------------------
// The server's view of the request: treat the client as hostile
// ---------------------------------------------------------------------------

const ROW_KEYS = ["affiliation", "how_known", "notes", "person_name"] as const;

export type ParsedImportRequest = { error: string } | { rows: MappedRow[]; strength: string | null };

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// `requireStrength` is false only for the read-only preview (which writes
// nothing). A real import with an unset or unknown strength is refused here,
// before anything is read or written.
export function parseImportRequest(rowsRaw: unknown, optionsRaw: unknown, requireStrength: boolean): ParsedImportRequest {
  if (!isPlainObject(optionsRaw)) return { error: "The import request was not understood." };
  const optionKeys = Object.keys(optionsRaw);
  if (optionKeys.some((k) => k !== "strength")) return { error: "The import request carried something this import does not accept." };
  let strength: string | null = null;
  if (requireStrength) {
    if (!isConnectionStrength(optionsRaw.strength)) return { error: "Choose how close you are: close, warm or acquaintance. Nothing was imported." };
    strength = optionsRaw.strength;
  }
  if (!Array.isArray(rowsRaw)) return { error: "The import request was not understood." };
  if (rowsRaw.length === 0) return { error: "There are no people to import." };
  if (rowsRaw.length > NETWORK_IMPORT_MAX_ROWS) {
    return { error: `This import has ${rowsRaw.length} people and one import takes at most ${NETWORK_IMPORT_MAX_ROWS}. Split the file and import it in parts. Nothing was imported.` };
  }
  const rows: MappedRow[] = [];
  for (let i = 0; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    // A malformed row is a refusal of the whole request, not a skip (ruling
    // 0023): it is not a person with a missing name, it is a request that is
    // not ours.
    if (!isPlainObject(r)) return { error: `Row ${i + 1} was not understood. Nothing was imported.` };
    const keys = Object.keys(r).sort();
    if (keys.length !== ROW_KEYS.length || keys.some((k, j) => k !== ROW_KEYS[j])) {
      return { error: `Row ${i + 1} carried fields this import does not accept. Nothing was imported.` };
    }
    if (typeof r.person_name !== "string") return { error: `Row ${i + 1} was not understood. Nothing was imported.` };
    for (const k of ["affiliation", "how_known", "notes"] as const) {
      if (r[k] !== null && typeof r[k] !== "string") return { error: `Row ${i + 1} was not understood. Nothing was imported.` };
    }
    rows.push({
      person_name: r.person_name,
      affiliation: r.affiliation as string | null,
      how_known: r.how_known as string | null,
      notes: r.notes as string | null,
    });
  }
  return { rows, strength };
}

// ---------------------------------------------------------------------------
// What the person is told
// ---------------------------------------------------------------------------

// The plain sentence for a column that is not imported. Contact-looking columns
// get the stronger one.
export function notImportedSentence(c: NotImportedColumn): string {
  if (c.contact) return `${c.label} — looks like contact details. Contact details are never stored.`;
  if (c.headingless) return `${c.label} — has no heading, so it cannot be imported.`;
  return `${c.label} — not imported.`;
}
