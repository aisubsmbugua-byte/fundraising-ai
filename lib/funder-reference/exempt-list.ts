// STATE item 119, stage two (ruling 0053): the IRS list of exempt organizations.
//
// Pure functions, no I/O, no model, no request. Two readers: scripts/load-exempt-list.ts (the owner's offline loader, which decides which
// of the 1.98 million listed rows to send) and the Donor Finder (which words what the IRS says about a lead).
//
// THE LOADER'S FILTER IS DELIBERATELY WIDER THAN THE RULE. The rule itself (which tier a row is in, which row matches a lead, which lead is
// a loaded funder under another name) is the database's: funder_reference_exempt_list_apply() in migration 0102 recomputes it from the
// stored fields and drops what does not qualify. Here a row is only kept or left out of the upload, so a row this file lets through that
// the database then drops costs nothing, and the name key below is only a way to find rows to send; the database's own key decides every match.

/** The IRS's own filing-requirement codes, in the IRS's words (EO BMF information sheet). */
export const FILING_REQUIREMENT: Record<string, { words: string; meaning: "not_required" | "files" | "other" }> = {
  "00": { words: "Not required to file (all other)", meaning: "not_required" },
  "01": { words: "Form 990 (all other) or 990-EZ return", meaning: "files" },
  "02": { words: "Required to file Form 990-N (e-Postcard), income less than $50,000 per year", meaning: "files" },
  "03": { words: "Group return", meaning: "files" },
  "04": { words: "Required to file Form 990-BL (Black Lung Trusts)", meaning: "files" },
  "06": { words: "Not required to file (church)", meaning: "not_required" },
  "07": { words: "Government 501(c)(1)", meaning: "other" },
  "13": { words: "Not required to file (religious organization)", meaning: "not_required" },
  "14": { words: "Not required to file (instrumentality of a state or political subdivision)", meaning: "not_required" },
};

export const TIER_LABELS: Record<number, string> = {
  1: "Church extension or gift fund, by its name",
  2: "Philanthropy or grantmaking, by its IRS category",
  3: "Foundation or fund, by its name",
};

export interface IrsFacts {
  ein: string;
  name: string;
  in_care_of: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  ruling_ym: string | null;
  ntee_cd: string | null;
  foundation_code: string | null;
  filing_req_cd: string;
  status_cd: string | null;
  tier: 1 | 2 | 3 | null;
  list_version: string;
  list_posted: string;
  /** More than one listed organization has this name in this state, so none was matched. */
  ambiguous: boolean;
  matches?: number;
  match: "ein" | "name_and_state" | "listed";
}

/** The IRS facts of a lead, as the database returned them; null when the lead is not tied to one listed organization. */
export function normalizeIrs(v: unknown): IrsFacts | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
  const match = r.match === "ein" || r.match === "listed" ? r.match : "name_and_state";
  if (r.ambiguous === true) {
    return { ein: "", name: "", in_care_of: null, street: null, city: null, state: null, zip: null, ruling_ym: null, ntee_cd: null, foundation_code: null, filing_req_cd: "", status_cd: null, tier: null, list_version: "", list_posted: "", ambiguous: true, matches: Number(r.matches ?? 0), match };
  }
  if (!s(r.ein) || !s(r.filing_req_cd)) return null;
  const tier = r.tier === 1 || r.tier === 2 || r.tier === 3 ? r.tier : null;
  return {
    ein: String(r.ein),
    name: String(r.name ?? ""),
    in_care_of: s(r.in_care_of),
    street: s(r.street),
    city: s(r.city),
    state: s(r.state),
    zip: s(r.zip),
    ruling_ym: s(r.ruling_ym),
    ntee_cd: s(r.ntee_cd),
    foundation_code: s(r.foundation_code),
    filing_req_cd: String(r.filing_req_cd),
    status_cd: s(r.status_cd),
    tier,
    list_version: String(r.list_version ?? ""),
    list_posted: String(r.list_posted ?? ""),
    ambiguous: false,
    match,
  };
}

export const formatEin = (ein: string): string => (/^\d{9}$/.test(ein) ? `${ein.slice(0, 2)}-${ein.slice(2)}` : ein);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** '201103' as the list gives it becomes 'March 2011'; anything else is shown as given. */
export function formatRulingMonth(ym: string | null): string | null {
  if (!ym) return null;
  const m = /^(\d{4})(\d{2})$/.exec(ym);
  if (!m) return ym;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${m[1]}` : m[1];
}

export function filingRequirementWords(code: string): string {
  return FILING_REQUIREMENT[code]?.words ?? `code ${code}`;
}

/** What the IRS list says about whether a return is required, in one phrase, or null when it is not tied to a listed organization. */
export function irsMark(irs: IrsFacts | null): string | null {
  if (!irs) return null;
  if (irs.ambiguous) return "More than one organization on the IRS list has this name in this state, so none was matched";
  const meaning = FILING_REQUIREMENT[irs.filing_req_cd]?.meaning ?? "other";
  if (meaning === "not_required") return "The IRS list says it is not required to file; no giving figures";
  if (meaning === "files") return "The IRS list says it files a return; none is in the database, so no giving figures";
  return "On the IRS list; no return in the database, so no giving figures";
}

/** Plain lines of what the list says, as listed. Nothing here is typed by a model. */
export function describeIrs(irs: IrsFacts | null): string[] {
  if (!irs) return [];
  if (irs.ambiguous) return [`${irs.matches ?? "More than one"} organizations on the IRS list share this name and state; open the grants below to check which it is.`];
  const lines: string[] = [];
  const place = [irs.street, [irs.city, [irs.state, irs.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  lines.push(`On the IRS list as ${irs.name}${place ? `, ${place}` : ""}.`);
  const how = irs.match === "ein" ? "matched by EIN" : irs.match === "listed" ? "as listed" : "matched by name and state";
  lines.push(`EIN ${formatEin(irs.ein)}, from the IRS list, ${how}.`);
  const parts: string[] = [];
  const ruled = formatRulingMonth(irs.ruling_ym);
  if (ruled) parts.push(`ruled exempt ${ruled}`);
  if (irs.ntee_cd) parts.push(`IRS category ${irs.ntee_cd}`);
  parts.push(`filing requirement: ${filingRequirementWords(irs.filing_req_cd).replace(/^Not/, "not")}`);
  lines.push(parts.join(" · ") + ".");
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// the loader's side
// ---------------------------------------------------------------------------------------------------------------------------------------

/** The database's name key, for finding rows to send. Same steps as funder_reference_name_key() (migration 0099). */
export function nameKey(p: string | null | undefined): string | null {
  const k = (p ?? "")
    .toUpperCase()
    .replace(/^\s*\([0-9]+\)\s*/, "")
    .replace(/^THE\s+/, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return k === "" ? null : k;
}

export const leadKeyOf = (name: string | null | undefined, state: string | null | undefined): string | null => {
  const k = nameKey(name);
  return k === null ? null : `${k}|${(state ?? "").trim().toUpperCase()}`;
};

export interface BmfRow {
  EIN: string;
  NAME: string;
  ICO: string;
  STREET: string;
  CITY: string;
  STATE: string;
  ZIP: string;
  SUBSECTION: string;
  RULING: string;
  FOUNDATION: string;
  STATUS: string;
  FILING_REQ_CD: string;
  NTEE_CD: string;
}

export const BMF_COLUMNS = ["EIN", "NAME", "ICO", "STREET", "CITY", "STATE", "ZIP", "SUBSECTION", "RULING", "FOUNDATION", "STATUS", "FILING_REQ_CD", "NTEE_CD"] as const;

/** Where each column the loader needs sits in a file's header line. Throws when the IRS layout no longer has one of them. */
export function bmfIndex(header: string[]): Record<string, number> {
  const idx = Object.fromEntries(header.map((c, i) => [c.trim(), i]));
  for (const w of BMF_COLUMNS) if (!(w in idx)) throw new Error(`the header has no ${w} column; the IRS layout may have changed`);
  return idx;
}

export function bmfRow(cells: string[], idx: Record<string, number>): BmfRow {
  return Object.fromEntries(BMF_COLUMNS.map((w) => [w, (cells[idx[w]] ?? "").trim()])) as unknown as BmfRow;
}

/** A word the three tiers can turn on; a row whose name has none of these and whose category is not T cannot be in any tier. */
const TIER_WORDS = /extension|loan|gift|advised|foundation|fund|trust|endowment/i;

/**
 * Whether the loader sends a row. Wider than the rule on purpose (see the top of this file): any row whose key is a lead's key (whatever
 * it must file), and any religious organization the IRS says is not required to file, with unconditional exemption, whose name has a word
 * a tier turns on or whose category begins with T.
 */
export function sendRow(r: Pick<BmfRow, "NAME" | "STATE" | "FILING_REQ_CD" | "STATUS" | "NTEE_CD">, leadKeys: ReadonlySet<string>): boolean {
  const key = leadKeyOf(r.NAME, r.STATE);
  if (key !== null && leadKeys.has(key)) return true;
  if (r.FILING_REQ_CD !== "06" && r.FILING_REQ_CD !== "13") return false;
  if (r.STATUS !== "01") return false;
  return TIER_WORDS.test(r.NAME) || r.NTEE_CD.startsWith("T");
}

export function toStoredRow(r: BmfRow, listVersion: string, listPosted: string): Record<string, string | null> {
  const n = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    ein: r.EIN,
    name: r.NAME.trim(),
    in_care_of: n(r.ICO),
    street: n(r.STREET),
    city: n(r.CITY),
    state: n(r.STATE),
    zip: n(r.ZIP),
    ruling_ym: n(r.RULING),
    subsection: n(r.SUBSECTION),
    foundation_code: n(r.FOUNDATION),
    ntee_cd: n(r.NTEE_CD),
    filing_req_cd: r.FILING_REQ_CD,
    status_cd: n(r.STATUS),
    list_version: listVersion,
    list_posted: listPosted,
  };
}
