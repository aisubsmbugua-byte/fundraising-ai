export const ORG_TYPES = [
  { value: "public_charity", label: "501(c)(3) Public Charity" },
  { value: "private_foundation", label: "501(c)(3) Private Foundation" },
  { value: "fiscally_sponsored", label: "Fiscally Sponsored" },
  { value: "church_religious_org", label: "Church / Religious Organization" },
  { value: "other", label: "Other" },
] as const;

export type OrgType = (typeof ORG_TYPES)[number]["value"];

export function orgTypeLabel(value: string | null) {
  return ORG_TYPES.find((t) => t.value === value)?.label ?? value ?? "—";
}

// Native <input type="url"> rejects anything without a scheme (e.g.
// "www.example.com" fails, "https://www.example.com" passes), which
// is a bad UX for people who don't think to type "https://" first.
// So form fields use type="text" and we normalize here on save
// instead of fighting the browser's built-in validation.
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const CAUSE_AREAS = [
  "Education",
  "Health & Wellness",
  "Human Services",
  "Environment & Conservation",
  "Arts, Culture & Humanities",
  "Economic & Community Development",
  "Human & Civil Rights",
  "Youth Development",
  "Disaster Relief & Public Safety",
  "International & Foreign Affairs",
  "Christian Faith Based",
  "Animal Welfare",
] as const;

// Lightweight suggestions for the geographic-area tag input. Not real
// geocoding -- just common region terms plus US states. City-level
// predictive search would need a geocoding API (a new secret + cost),
// which is a separate call to make.
export const GEO_SUGGESTIONS = [
  "Nationwide",
  "International",
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
  "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
  "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
  "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
  "Wisconsin", "Wyoming",
] as const;

export type Funder = { name: string; location: string };
export type Person = { name: string; role: string };
export type SocialLink = { platform: string; url: string };

export type OrgProfile = {
  id: string;
  name: string | null;
  org_type: OrgType | null;
  org_type_other: string | null;
  year_founded: number | null;
  website: string | null;
  key_people: Person[] | null;
  social_links: SocialLink[] | null;
  annual_budget: number | null;
  funding_need: string | null;
  problem_statement: string | null;
  mission: string | null;
  vision: string | null;
  programs: string | null;
  cause_areas: string[] | null;
  cause_area_other: string | null;
  who_we_serve: string | null;
  geographic_areas: string[] | null;
  hq_location: string | null;
  org_values: string[] | null;
  outcomes: string[] | null;
  notable_funders: Funder[] | null;
  updated_by: string | null;
  updated_at: string;
};
