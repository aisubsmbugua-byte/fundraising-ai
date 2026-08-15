-- Slice 3+ extension: organization knowledge base, stage 2 (expand fields).
-- Apply after 0004_org_profile.sql. Additive only -- preserves any
-- data already in org_profile (mission, programs, who_we_serve).

create type org_type as enum (
  'public_charity',
  'private_foundation',
  'fiscally_sponsored',
  'church_religious_org',
  'other'
);

alter table org_profile
  add column name text,
  add column org_type org_type,
  add column org_type_other text,
  add column year_founded int,
  add column annual_budget numeric,
  add column funding_need text,
  add column problem_statement text,
  add column vision text,
  add column cause_areas text[],
  add column cause_area_other text,
  add column geographic_area text,
  add column hq_location text,
  add column org_values text,
  add column outcomes text,
  add column notable_funders text;
