import { CHANNELS, type Channel } from "./prospects";
import type { OrgProfile } from "./organization";

export type ChannelEvaluation = {
  channel: Channel;
  recommended: boolean;
  confidence: "low" | "medium" | "high";
  rationale: string;
};

export type ChannelMatchRun = {
  id: string;
  model: string;
  evaluations: ChannelEvaluation[];
  approved_channels: string[] | null;
  created_by: string;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
};

export const CHANNEL_DESCRIPTIONS: Record<Channel, string> = {
  foundation: "Foundations & family trusts -- data-rich, apply via formal grant processes",
  regranting: "Regranting ministries -- data-rich, redistribute funds to aligned organizations",
  christian_business:
    "Christian businesses & marketplace giving -- mixed automation, values-aligned business giving",
  denomination: "Denominations & network funds -- mixed automation, church/denominational giving structures",
  daf: "Donor-advised funds (DAFs) -- relationship-led, individual donors directing funds through a sponsor",
  major_donor: "Major donors & individuals -- relationship-led, high-capacity individual giving",
};

// Formats the org profile into a compact text block for the AI
// prompt. Only includes fields that are actually filled in.
export function buildProfileSummary(profile: OrgProfile): string {
  const lines: string[] = [];
  if (profile.name) lines.push(`Organization: ${profile.name}`);
  if (profile.org_type) {
    const otherNote = profile.org_type === "other" && profile.org_type_other ? ` (${profile.org_type_other})` : "";
    lines.push(`Legal status: ${profile.org_type}${otherNote}`);
  }
  if (profile.year_founded) lines.push(`Founded: ${profile.year_founded}`);
  if (profile.annual_budget) lines.push(`Annual budget: $${profile.annual_budget.toLocaleString("en-US")}`);
  if (profile.funding_need) lines.push(`Current funding need: ${profile.funding_need}`);
  if (profile.problem_statement) lines.push(`Problem statement: ${profile.problem_statement}`);
  if (profile.mission) lines.push(`Mission: ${profile.mission}`);
  if (profile.vision) lines.push(`Vision: ${profile.vision}`);
  if (profile.programs) lines.push(`Programs: ${profile.programs}`);
  const causeAreas = [...(profile.cause_areas ?? []), profile.cause_area_other].filter(Boolean);
  if (causeAreas.length) lines.push(`Cause area(s): ${causeAreas.join(", ")}`);
  if (profile.who_we_serve) lines.push(`Population(s) served: ${profile.who_we_serve}`);
  if (profile.geographic_areas?.length) lines.push(`Geographic area served: ${profile.geographic_areas.join(", ")}`);
  if (profile.hq_location) lines.push(`HQ location: ${profile.hq_location}`);
  if (profile.org_values?.length) lines.push(`Core values: ${profile.org_values.join("; ")}`);
  if (profile.outcomes?.length) lines.push(`Key outcomes: ${profile.outcomes.join("; ")}`);
  if (profile.notable_funders?.length) {
    const funders = profile.notable_funders
      .map((f) => (f.location ? `${f.name} (${f.location})` : f.name))
      .join(", ");
    lines.push(`Notable funders: ${funders}`);
  }
  if (profile.key_people?.length) {
    const people = profile.key_people
      .map((p) => `${p.name} (${p.role})${p.phone ? ` [phone: ${p.phone}]` : ""}`)
      .join(", ");
    lines.push(`Key people: ${people}`);
  }
  return lines.join("\n");
}

export function buildChannelList(): string {
  return CHANNELS.map((c) => `- ${c.value}: ${c.label} -- ${CHANNEL_DESCRIPTIONS[c.value]}`).join("\n");
}
