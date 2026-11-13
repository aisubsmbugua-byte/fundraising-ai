// STATE item 117 as amended (ruling 0050 clause 7): the ways in that a funder's own filing gives.
//
// Two kinds of text come out of here and they are kept apart on purpose:
//   - FROM THE FILING: the contact a foundation names for requests, how to apply, deadlines, restrictions, the officers it
//     names, a charity's website and stated mission. Each is the filing's own text, shown as filed, with its tax year and a
//     link. Nothing is summarized or rewritten (the capture rule).
//   - GENERAL PRACTICE: one fixed paragraph per kind of funder, written by people, the same for every funder of that kind,
//     and labelled as not coming from the filing.
// There is no model call, no service key and no outside request here: only reads through the signed-in user's session.
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadFilingLinks, readableName, type Suggestion } from "./suggestions";

export interface ApplicationContact {
  person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  how_to_apply: string | null;
  deadlines: string | null;
  restrictions: string | null;
}

export interface NamedPerson {
  name: string;
  title: string | null;
  place: string | null;
  role: "officer" | "signer";
}

export interface WaysIn {
  ein: string;
  filing_object_id: string | null;
  tax_period_end: string | null;
  /** True where the filing says only pre-selected charities; false where that box is not checked; null where not held. */
  preselected: boolean | null;
  application: ApplicationContact[];
  people: NamedPerson[];
  people_total: number;
  website: string | null;
  phone: string | null;
  address: string | null;
  mission: string | null;
  link: { url: string; member: string | null } | null;
}

const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

/** A person's name made readable without changing a letter: every word capitalized (an initial like "A" is not an article), roman-numeral suffixes kept. */
export function readablePerson(name: string): string {
  const n = name.trim();
  if (n !== n.toUpperCase()) return n;
  return n
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => (/^\s+$/.test(w) ? w : /^(ii|iii|iv|vi)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

/** The filing's address fields joined in the order a person reads them. Each part as filed. */
export function joinAddress(parts: Array<unknown>): string | null {
  const t = parts.map(text).filter((p): p is string => p !== null);
  return t.length === 0 ? null : t.join(", ");
}

/** One application group from a Part XV record, as filed. Unknown keys are ignored, known ones are not reworded. */
export function parseApplicationGroups(raw: unknown): ApplicationContact[] {
  if (!Array.isArray(raw)) return [];
  const out: ApplicationContact[] = [];
  for (const g of raw) {
    const f = (g && typeof g === "object" ? (g as { fields?: Record<string, unknown> }).fields : null) ?? null;
    if (!f) continue;
    const person = text(f["RecipientPersonNm"]) ?? text(f["RecipientBusinessName/BusinessNameLine1Txt"]);
    const c: ApplicationContact = {
      person: person ? readablePerson(person) : null,
      phone: text(f["RecipientPhoneNum"]),
      email: text(f["RecipientEmailAddressTxt"]),
      address: joinAddress([f["RecipientUSAddress/AddressLine1Txt"], f["RecipientUSAddress/AddressLine2Txt"], f["RecipientUSAddress/CityNm"], f["RecipientUSAddress/StateAbbreviationCd"], f["RecipientUSAddress/ZIPCd"]]),
      how_to_apply: text(f["FormAndInfoAndMaterialsTxt"]),
      deadlines: text(f["SubmissionDeadlinesTxt"]),
      restrictions: text(f["RestrictionsOnAwardsTxt"]),
    };
    if (Object.values(c).some((v) => v !== null)) out.push(c);
  }
  return out;
}

interface PersonRow {
  listed_in: string;
  ordinal: number;
  name_as_named: string | null;
  title_as_stated: string | null;
  city: string | null;
  state: string | null;
}

export const MAX_PEOPLE_SHOWN = 10;

/** The columns this reader asks for, kept in one place so a test can run exactly these reads as a member. */
export const WAYS_IN_COLUMNS = {
  directory: "ein, source_object_id, source_tax_period_end, only_preselected_charities_box_checked",
  foundation: "ein, website_as_stated, phone_as_stated, address_line1, city, state, zip",
  charity: "ein, source_object_id, source_tax_period_end, website_as_stated, phone_as_stated, address_line1, city, state, zip, mission_as_stated",
  terms: "filing_object_id, application_groups",
  people: "filing_object_id, listed_in, ordinal, name_as_named, title_as_stated, city, state",
} as const;

/** Officers, directors and trustees (name, title, city and state: no street address and no pay), then the signer if not already named. */
export function parsePeople(rows: PersonRow[]): { people: NamedPerson[]; total: number } {
  const officers = rows
    .filter((r) => r.listed_in === "part_viii_officers_directors_trustees" && text(r.name_as_named))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map<NamedPerson>((r) => ({
      name: readablePerson(text(r.name_as_named)!),
      title: text(r.title_as_stated),
      place: joinAddress([r.city ? readableName(r.city) : null, r.state]),
      role: "officer",
    }));
  const seen = new Set(officers.map((o) => o.name.toLowerCase()));
  const signers = rows
    .filter((r) => r.listed_in === "signer_on_return_header" && text(r.name_as_named))
    .map<NamedPerson>((r) => ({ name: readablePerson(text(r.name_as_named)!), title: text(r.title_as_stated), place: null, role: "signer" }))
    .filter((p) => !seen.has(p.name.toLowerCase()));
  const all = [...officers, ...signers];
  return { people: all.slice(0, MAX_PEOPLE_SHOWN), total: all.length };
}

/** Fixed explanatory paragraphs. Written by people, the same for every funder of the kind, and shown as general practice. */
export const GENERAL_PRACTICE_LABEL = "General practice, not something this funder's filing says";

export const PRESELECTED_PRACTICE =
  "The filing says this funder gives only to pre-selected charities. That describes how it decides today, not a rule that cannot change. The usual ways in are: a personal introduction from someone who knows its trustees; a short letter or call to the contact its filing names, asking how a charity is considered; and asking organizations it already supports how they came to be chosen. None of these is certain, and none is an application.";

export const DAF_PRACTICE =
  "A donor-advised fund sponsor makes grants on the recommendation of the people who give through it. The way in is to meet the sponsor's requirements for a recommended charity and to be known to the people who give through it, for example by asking your own supporters whether they give this way.";

export const OPEN_FOUNDATION_PRACTICE =
  "The filing does not say this funder gives only to pre-selected charities. Many private foundations still prefer a short inquiry to a cold application: look for its guidelines first, then write to the contact its filing names with one clear sentence on how your work matches what it has funded.";

export const CHARITY_PRACTICE =
  "A public charity that gives to other charities usually runs programs that outside organizations can apply to or be nominated for. Read what it says about its programs on its website, and ask what its process is before preparing anything.";

/** The one fixed paragraph for a funder, chosen by facts the database holds about it. */
export function practiceFor(s: Pick<Suggestion, "source" | "is_daf_sponsor" | "takes_no_unsolicited">): string {
  if (s.source === "public_charity") return s.is_daf_sponsor ? DAF_PRACTICE : CHARITY_PRACTICE;
  return s.takes_no_unsolicited ? PRESELECTED_PRACTICE : OPEN_FOUNDATION_PRACTICE;
}

/** The ways in for the funders on one page, read through the member's own session: a handful of keyed reads, in parallel. */
export async function loadWaysIn(supabase: SupabaseClient, rows: Pick<Suggestion, "ein" | "source">[]): Promise<Record<string, WaysIn>> {
  const foundations = [...new Set(rows.filter((r) => r.source === "private_foundation").map((r) => r.ein))];
  const charities = [...new Set(rows.filter((r) => r.source === "public_charity").map((r) => r.ein))];
  const out: Record<string, WaysIn> = {};

  const blank = (ein: string): WaysIn => ({ ein, filing_object_id: null, tax_period_end: null, preselected: null, application: [], people: [], people_total: 0, website: null, phone: null, address: null, mission: null, link: null });

  const [dir, foundationIdentity, charityIdentity] = await Promise.all([
    foundations.length ? supabase.from("funder_reference_directory").select(WAYS_IN_COLUMNS.directory).in("ein", foundations) : Promise.resolve({ data: [] as unknown[] }),
    foundations.length ? supabase.from("funder_reference_foundations").select(WAYS_IN_COLUMNS.foundation).in("ein", foundations) : Promise.resolve({ data: [] as unknown[] }),
    charities.length ? supabase.from("charity_reference_organizations").select(WAYS_IN_COLUMNS.charity).in("ein", charities) : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const fileOf = new Map<string, { id: string; end: string | null; pre: boolean | null }>();
  for (const d of (dir.data ?? []) as Array<{ ein: string; source_object_id: string; source_tax_period_end: string | null; only_preselected_charities_box_checked: boolean | null }>) {
    fileOf.set(d.ein, { id: d.source_object_id, end: d.source_tax_period_end, pre: d.only_preselected_charities_box_checked });
  }
  const filingIds = [...fileOf.values()].map((v) => v.id);

  const [terms, people] = await Promise.all([
    filingIds.length ? supabase.from("funder_reference_application_terms").select(WAYS_IN_COLUMNS.terms).in("filing_object_id", filingIds) : Promise.resolve({ data: [] as unknown[] }),
    filingIds.length ? supabase.from("funder_reference_people").select(WAYS_IN_COLUMNS.people).in("filing_object_id", filingIds) : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const termsOf = new Map<string, unknown>();
  for (const t of (terms.data ?? []) as Array<{ filing_object_id: string; application_groups: unknown }>) termsOf.set(t.filing_object_id, t.application_groups);
  const peopleOf = new Map<string, PersonRow[]>();
  for (const p of (people.data ?? []) as Array<PersonRow & { filing_object_id: string }>) {
    const list = peopleOf.get(p.filing_object_id) ?? [];
    list.push(p);
    peopleOf.set(p.filing_object_id, list);
  }
  const identityOf = new Map<string, Record<string, string | null>>();
  for (const i of (foundationIdentity.data ?? []) as Array<Record<string, string | null>>) identityOf.set(String(i.ein), i);

  const charityFiling = new Map<string, string>();
  for (const c of (charityIdentity.data ?? []) as Array<Record<string, string | null>>) if (c.source_object_id) charityFiling.set(String(c.ein), String(c.source_object_id));
  const links = await loadFilingLinks(supabase, [...filingIds, ...charityFiling.values()]);

  for (const ein of foundations) {
    const w = blank(ein);
    const f = fileOf.get(ein);
    if (f) {
      w.filing_object_id = f.id;
      w.tax_period_end = f.end;
      w.preselected = f.pre === null ? null : Boolean(f.pre);
      w.application = parseApplicationGroups(termsOf.get(f.id));
      const parsed = parsePeople(peopleOf.get(f.id) ?? []);
      w.people = parsed.people;
      w.people_total = parsed.total;
      w.link = links[f.id] ?? null;
    }
    const id = identityOf.get(ein);
    if (id) {
      w.website = text(id.website_as_stated);
      w.phone = text(id.phone_as_stated);
      w.address = joinAddress([id.address_line1, id.city ? readableName(id.city) : null, id.state, id.zip]);
    }
    out[ein] = w;
  }
  for (const c of (charityIdentity.data ?? []) as Array<Record<string, string | null>>) {
    const ein = String(c.ein);
    const w = blank(ein);
    w.filing_object_id = c.source_object_id ?? null;
    w.tax_period_end = c.source_tax_period_end ?? null;
    w.website = text(c.website_as_stated);
    w.phone = text(c.phone_as_stated);
    w.address = joinAddress([c.address_line1, c.city ? readableName(c.city) : null, c.state, c.zip]);
    w.mission = text(c.mission_as_stated);
    w.link = c.source_object_id ? (links[String(c.source_object_id)] ?? null) : null;
    out[ein] = w;
  }
  return out;
}
