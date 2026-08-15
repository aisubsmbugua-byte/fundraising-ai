export const ORG_TYPES = [
  { value: "public_charity", label: "501(c)(3) Public Charity" },
  { value: "private_foundation", label: "501(c)(3) Private Foundation" },
  { value: "fiscally_sponsored", label: "Fiscally Sponsored" },
  { value: "church_religious_org", label: "Church / Religious Organization" },
  { value: "other", label: "Other" },
] as const;

export type OrgType = (typeof ORG_TYPES)[number]["value"];

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
  "Religion & Faith-Based",
  "Animal Welfare",
] as const;

export type OrgProfile = {
  id: string;
  name: string | null;
  org_type: OrgType | null;
  org_type_other: string | null;
  year_founded: number | null;
  annual_budget: number | null;
  funding_need: string | null;
  problem_statement: string | null;
  mission: string | null;
  vision: string | null;
  programs: string | null;
  cause_areas: string[] | null;
  cause_area_other: string | null;
  who_we_serve: string | null;
  geographic_area: string | null;
  hq_location: string | null;
  org_values: string | null;
  outcomes: string | null;
  notable_funders: string | null;
  updated_by: string | null;
  updated_at: string;
};
