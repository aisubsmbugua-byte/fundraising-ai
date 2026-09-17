-- Build 1, Step 2: the qualification pipeline discriminator, and per-tier
-- atomic publication.
--
-- Two paths now exist against the same prospect: the original agentic run and
-- the new qualification run. They are NOT separated by an environment flag,
-- because a flag makes them mutually exclusive and the whole point is to run
-- both against the same funder and compare. research_runs is already versioned
-- per prospect (one funder has twenty-nine), so a discriminator on that table
-- is the natural seam.

alter table research_runs
  add column pipeline text not null default 'agentic';

alter table research_runs
  add constraint research_runs_pipeline_check
  check (pipeline in ('agentic', 'qualification'));

comment on column research_runs.pipeline is
  'agentic = the original single-model-call research run. qualification = the code-controlled pursue/dismiss pipeline. Both write here so the two can be compared per prospect; existing rows are agentic by definition.';

create index research_runs_pipeline_idx on research_runs (prospect_id, pipeline, version desc);

-- Per-tier results, published one row at a time.
--
-- The existing run writes nothing until the very end: the flip to 'ready' is
-- the last write, so no consumer ever sees a partial run. That is a
-- correctness property, not an oversight, and progressive presentation appears
-- to break it.
--
-- It does not, because each tier's output is COMPLETE AT ITS OWN TIER rather
-- than a partial version of the final answer. "This is the right legal entity
-- and it paid grants in its most recent filing" is a finished fact, publishable
-- on its own. So the property is preserved by making each tier's write atomic,
-- instead of by deferring every write to the end.
create table qualification_stages (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  tier text not null,
  state text not null,
  -- The tier's own finished result. Shape varies by tier and is owned by the
  -- code that writes it -- see lib/legitimacy.ts for tier1.
  result jsonb not null,
  -- Wall-clock for this tier alone, so the latency ladder is measured rather
  -- than asserted.
  duration_ms integer,
  published_at timestamptz not null default now(),
  organization_id uuid references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

alter table qualification_stages
  add constraint qualification_stages_tier_check
  check (tier in ('tier1_registry', 'tier2_official', 'fit', 'recommendation'));

-- Deliberately text with a check, matching entity_validation_status and
-- citation_consistency: this vocabulary is still settling, and a check
-- constraint can be altered where an enum value cannot be removed.
alter table qualification_stages
  add constraint qualification_stages_state_check
  check (state in ('established', 'conflicting', 'insufficient_evidence', 'not_applicable', 'retrieval_failed'));

-- One published result per tier per run. A tier that runs twice replaces
-- nothing silently -- the second write fails and the caller has to decide.
create unique index qualification_stages_run_tier_idx
  on qualification_stages (research_run_id, tier);

create index qualification_stages_run_idx on qualification_stages (research_run_id, published_at);

alter table qualification_stages enable row level security;

create policy "team members read qualification stages"
  on qualification_stages for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members write qualification stages"
  on qualification_stages for insert
  to authenticated
  with check (organization_id = my_organization_id());

-- Same guard as research_evidence and research_claim_sources: a stage row's
-- organization must match the run it belongs to, so a row cannot be attached
-- across a tenant boundary even by a caller holding both ids.
create or replace function enforce_qualification_stage_org_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  run_org uuid;
begin
  select organization_id into run_org from research_runs where id = new.research_run_id;
  if run_org is null then
    raise exception 'research run % not found', new.research_run_id;
  end if;
  if new.organization_id is distinct from run_org then
    raise exception 'qualification stage organization % does not match its run''s organization %', new.organization_id, run_org;
  end if;
  return new;
end;
$$;

create trigger qualification_stages_org_match
  before insert or update on qualification_stages
  for each row execute function enforce_qualification_stage_org_match();

comment on table qualification_stages is
  'One atomic, complete-at-its-tier result per stage of a qualification run. Publishing a tier does not publish a partial answer -- it publishes a finished one about a smaller question. See docs/reviews/0007-build-1-approved-scope.md.';
