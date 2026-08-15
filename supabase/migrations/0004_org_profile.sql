-- Slice 3+ extension: organization knowledge base, stage 1 (text fields).
-- Apply after Slice 3 (screening) is live.

create type org_type as enum (
  'public_charity',
  'private_foundation',
  'fiscally_sponsored',
  'church_religious_org',
  'other'
);

-- Singleton table: one row holding this nonprofit's own profile.
-- Enforced as a singleton in application code (always update the
-- existing row if one exists, insert only if none does) rather than
-- a DB constraint, to keep this simple.
create table org_profile (
  id uuid primary key default gen_random_uuid(),

  name text,
  org_type org_type,
  org_type_other text,
  year_founded int,

  annual_budget numeric,
  funding_need text,

  problem_statement text,
  mission text,
  vision text,
  programs text,
  cause_areas text[],
  cause_area_other text,

  who_we_serve text,
  geographic_area text,
  hq_location text,

  org_values text,

  outcomes text,
  notable_funders text,

  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

alter table org_profile enable row level security;

create policy "team members manage org profile"
  on org_profile for all
  to authenticated
  using (true)
  with check (true);
