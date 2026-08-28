-- Additive follow-up to 0035/0036, fixing the gap flagged in review: a
-- claim with no inspectable source isn't verifiable. Root cause was in the
-- app code, not the schema -- searchFunderWeb() was discarding the real
-- citation data the Anthropic API already returns whenever the web_search
-- tool runs, and the extraction step had to type a source_url from memory
-- of flattened prose alone (see lib/ai/funder-search.ts, lib/ai/
-- research-extract.ts for the full fix). This migration adds the tables
-- needed to store the real, retrieved sources those citations point to.
create type research_source_type as enum
  ('official_website', 'irs_filing', 'annual_report', 'secondary_source', 'other');

-- One row per distinct URL actually retrieved during a run -- written for
-- EVERY page searched, not just ones that end up cited to a claim, so
-- "what did we check" is answerable even for research_key_coverage rows
-- that ended up not_found/not_public.
create table research_sources (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  url text not null,
  title text,
  source_type research_source_type not null default 'other',
  page_age text,
  retrieved_at timestamptz not null default now(),
  organization_id uuid references organizations (id) default my_organization_id(),
  unique (research_run_id, url)
);

alter table research_sources enable row level security;

create policy "team members can log research sources"
  on research_sources for insert
  to authenticated
  with check (organization_id = my_organization_id());

create policy "team members can read research sources"
  on research_sources for select
  to authenticated
  using (organization_id = my_organization_id());

create trigger research_sources_org_match
  before insert on research_sources
  for each row execute function enforce_research_run_org_match();

create index research_sources_run_idx on research_sources (research_run_id);
create index research_sources_organization_id_idx on research_sources (organization_id);

-- Links one claim to one or more sources -- multiple rows per claim_id is
-- how multi-source corroboration or conflicting evidence is represented;
-- no separate flag needed for that at this layer.
create table research_claim_sources (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references research_claims (id) on delete cascade,
  source_id uuid not null references research_sources (id) on delete cascade,
  -- Denormalized, same rationale as research_claims.prospect_id in 0035:
  -- lets the existing enforce_research_run_org_match() trigger check this
  -- table's own organization_id unchanged. A SECOND trigger below
  -- (enforce_claim_source_run_match) additionally confirms claim_id and
  -- source_id both actually belong to this same research_run_id.
  research_run_id uuid not null references research_runs (id) on delete cascade,
  cited_text text,
  supports_directly boolean not null default true,
  -- sha256 of cited_text -- a lightweight integrity signal on the
  -- captured excerpt, NOT a durable full-page snapshot. A real snapshot
  -- would mean fetching and archiving the page ourselves, a separate,
  -- bigger feature (server-side fetch of third-party URLs, storage,
  -- robots.txt/legal considerations) -- not attempted here.
  content_hash text,
  organization_id uuid references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

alter table research_claim_sources enable row level security;

create policy "team members can log research claim sources"
  on research_claim_sources for insert
  to authenticated
  with check (organization_id = my_organization_id());

create policy "team members can read research claim sources"
  on research_claim_sources for select
  to authenticated
  using (organization_id = my_organization_id());

create trigger research_claim_sources_org_match
  before insert on research_claim_sources
  for each row execute function enforce_research_run_org_match();

-- enforce_research_run_org_match() alone only confirms new.organization_id
-- matches new.research_run_id's own org -- it says nothing about whether
-- claim_id/source_id actually belong to THAT run. Without this second
-- check, a session could insert a row whose research_run_id/organization_id
-- are its own (passing the trigger above) while claim_id/source_id point
-- at another organization's real claim/source rows -- RLS still blocks
-- ever reading those rows directly, but the link itself would silently
-- record a cross-tenant association that shouldn't be constructible at
-- all. Caught by writing this migration's own isolation test before
-- applying it (scripts/test-tenant-isolation.ts) -- see
-- docs/decisions/0002-research-agent.md.
create function enforce_claim_source_run_match() returns trigger as $$
begin
  if new.research_run_id is distinct from (select research_run_id from research_claims where id = new.claim_id) then
    raise exception 'claim_id must belong to the same research_run_id';
  end if;
  if new.research_run_id is distinct from (select research_run_id from research_sources where id = new.source_id) then
    raise exception 'source_id must belong to the same research_run_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger research_claim_sources_run_match
  before insert on research_claim_sources
  for each row execute function enforce_claim_source_run_match();

create index research_claim_sources_claim_idx on research_claim_sources (claim_id);
create index research_claim_sources_source_idx on research_claim_sources (source_id);
create index research_claim_sources_organization_id_idx on research_claim_sources (organization_id);

-- Claim-level additions: reporting_period can vary per claim even from the
-- same source page (a filing might reference multiple years), so it
-- belongs on the claim, not the source. confidence_reason makes
-- medium/low confidence explainable rather than an unexplained model
-- number.
alter table research_claims add column confidence_reason text;
alter table research_claims add column reporting_period text;

-- Whether a retry might reasonably find this field -- model's own signal,
-- defaulted server-side to true for not_found/not_public entries when the
-- model omits it, never silently false.
alter table research_key_coverage add column retry_recommended boolean not null default true;
