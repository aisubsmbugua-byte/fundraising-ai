-- Additive follow-up to 0035_research_agent.sql, closing a gap raised in
-- review before the Research Agent's evaluation set runs: a run that
-- returns nine polished facts must not silently conceal what it didn't
-- find. This gives every RESEARCH_CLAIM_KEYS key an explicit per-run
-- completeness status, so absence is never ambiguous with "not asked."
--
-- 'found' / 'not_public' / 'not_found' / 'conflicting' are model-authored
-- (see lib/ai/research-extract.ts). 'not_attempted' and 'extraction_failed'
-- are always derived server-side in runResearch -- never trusted to model
-- self-reporting, since a model that silently skips a key or answers with
-- a malformed shape is exactly the failure mode this table exists to
-- catch. Only written for runs that reach 'ready'; an 'error' run's own
-- status already means "extraction failed" at the run level.
create type research_key_coverage_status as enum
  ('found', 'not_public', 'not_found', 'conflicting', 'not_attempted', 'extraction_failed');

create table research_key_coverage (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  claim_key text not null,
  status research_key_coverage_status not null,
  notes text,
  organization_id uuid references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now(),
  unique (research_run_id, claim_key)
);

alter table research_key_coverage enable row level security;

create policy "team members can log research key coverage"
  on research_key_coverage for insert
  to authenticated
  with check (organization_id = my_organization_id());

create policy "team members can read research key coverage"
  on research_key_coverage for select
  to authenticated
  using (organization_id = my_organization_id());

-- Reuses the existing trigger function from 0035 -- it only reads
-- new.research_run_id / new.organization_id, so it works unchanged
-- against any table with that same column pair.
create trigger research_key_coverage_org_match
  before insert on research_key_coverage
  for each row execute function enforce_research_run_org_match();

create index research_key_coverage_run_idx on research_key_coverage (research_run_id);
create index research_key_coverage_organization_id_idx on research_key_coverage (organization_id);
