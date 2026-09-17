// What Discovery must hand to Research.
//
// The settled unit of pursuit is the OPPORTUNITY, and qualification cannot
// evaluate one that Discovery collapsed into a display name and then discarded
// the source for. Measured: giving Research a known opportunity name took one
// funder's shortlist recall from 0/4 to 4/4, finding /innovation/ and
// /innovation/2023-innovation-fund -- pages no keyword vocabulary could have
// predicted, because grant programmes are named arbitrarily.
//
// Nothing here redesigns Discovery. The `candidates` table already captures
// every field below; intake was dropping source_url and source_title on the
// way to `prospects`, so the most specific thing known about an opportunity
// was thrown away one row before the system that needed it.
//
// The URL is always one a search actually returned. Never generated, never
// reconstructed -- that is the capture contract, and a fabricated URL resolves
// to a real and unrelated page.

import { searchableOrganizationName } from "./legitimacy";

export const HANDOFF_VERSION = 1;

// What kind of thing are we being asked to qualify? A missing opportunity name
// is NOT automatically a defect: a general foundation legitimately has no named
// programme, and treating that as an error would manufacture work.
export const PROSPECT_KINDS = ["named_opportunity", "general_funder", "intermediary", "unknown"] as const;
export type ProspectKind = (typeof PROSPECT_KINDS)[number];

export type DiscoveryHandoff = {
  handoffVersion: number;
  funderName: string | null;
  // Present only when a named opportunity was actually discovered.
  opportunityName: string | null;
  // The exact page a search returned. This bypasses the manifest cap: a human
  // already saw it describing this opportunity.
  sourceUrl: string | null;
  sourceTitle: string | null;
  // Which search result it was, so a claim can be traced back to the sweep that
  // produced it rather than to a model's recollection.
  sourceResultIndex: number | null;
  // Whose page the source was -- the funder's own, or a directory writing about
  // them. Never conflated with provenance.
  sourceClassification: string | null;
  location: string | null;
  parentOrganization: string | null;
  kind: ProspectKind;
};

// Words that make a display name carry a programme rather than an organization.
const PROGRAMME_SHAPED = /\b(fund|grant|grants|program|programme|scholarship|fellowship|award|initiative|prize|bursary|regranting)\b/i;

// Funder types that describe a giving CHANNEL rather than a grantmaker.
const INTERMEDIARY_TYPE = /\b(donor[- ]advised|daf|community foundation|giving fund|wealth|advisory|fiscal sponsor)\b/i;

export function classifyProspectKind(input: {
  opportunityName?: string | null;
  funderType?: string | null;
  displayName?: string | null;
}): ProspectKind {
  if ((input.opportunityName ?? "").trim()) return "named_opportunity";
  if (INTERMEDIARY_TYPE.test(input.funderType ?? "")) return "intermediary";
  // A display name still carrying a programme phrase means a named opportunity
  // exists and was not captured -- unknown, not general_funder, because
  // asserting "this funder has no programme" on that evidence would be false.
  if (PROGRAMME_SHAPED.test(qualifierOf(input.displayName ?? ""))) return "unknown";
  if ((input.funderType ?? "").trim()) return "general_funder";
  return "unknown";
}

// The part of a display name that is not the organization: the parenthetical or
// dash-suffix Discovery appended.
function qualifierOf(displayName: string): string {
  const org = searchableOrganizationName(displayName);
  return displayName.length > org.length ? displayName.slice(org.length) : "";
}

export const HANDOFF_DEFECTS = ["missing_source_url", "unnamed_opportunity"] as const;
export type HandoffDefect = (typeof HANDOFF_DEFECTS)[number];

// A defect is Discovery failing to carry something it HAD -- not a funder
// failing to have it.
//
// `unnamed_opportunity` fires only when the display name or source title
// clearly contains a programme and the structured field is empty. A general
// foundation with no programme is not defective, and reporting it as such would
// send someone to fix data that is already correct.
export function handoffDefects(h: DiscoveryHandoff): HandoffDefect[] {
  const defects: HandoffDefect[] = [];
  if (!h.sourceUrl) defects.push("missing_source_url");

  const carriesProgramme =
    PROGRAMME_SHAPED.test(qualifierOf(h.funderName ?? "")) || PROGRAMME_SHAPED.test(h.sourceTitle ?? "");
  if (carriesProgramme && !(h.opportunityName ?? "").trim()) defects.push("unnamed_opportunity");

  return defects;
}

// Read a stored prospect row into the contract. Rows created before the
// contract existed are LEGACY: they are reported separately rather than
// repaired, because back-filling them by hand would improve a measurement
// without improving the system.
export function readHandoff(row: {
  legal_name?: string | null;
  name?: string | null;
  opportunity_name?: string | null;
  source_url?: string | null;
  source_title?: string | null;
  source_result_index?: number | null;
  source_classification?: string | null;
  website_status?: string | null;
  location?: string | null;
  parent_organization?: string | null;
  funder_type?: string | null;
  handoff_version?: number | null;
}): DiscoveryHandoff & { legacy: boolean } {
  return {
    handoffVersion: row.handoff_version ?? 0,
    legacy: (row.handoff_version ?? 0) < HANDOFF_VERSION,
    funderName: row.legal_name ?? row.name ?? null,
    opportunityName: row.opportunity_name ?? null,
    sourceUrl: row.source_url ?? null,
    sourceTitle: row.source_title ?? null,
    sourceResultIndex: row.source_result_index ?? null,
    sourceClassification: row.source_classification ?? row.website_status ?? null,
    location: row.location ?? null,
    parentOrganization: row.parent_organization ?? null,
    kind: classifyProspectKind({
      opportunityName: row.opportunity_name,
      funderType: row.funder_type,
      displayName: row.name,
    }),
  };
}
