-- Build 1 (Research Agent) -- see docs/decisions/0002-research-agent.md for
-- the full design rationale. Purely additive: no alter statement touches
-- deep_dive_runs, prospects, evidence_items, or any existing policy. The
-- live combined research+strategy action is completely untouched by this
-- migration; this is a new, parallel, dark (superadmin-only) capability.
--
-- Naming: research_runs/research_claims are NOT deep_dive_runs -- they
-- track the Research-only half of what deep_dive_runs still does in one
-- combined step. Don't conflate them.

create type research_run_status as enum ('researching', 'extracting', 'ready', 'error');
create type research_claim_type as enum ('fact', 'hypothesis');
create type research_confidence as enum ('high', 'medium', 'low');
create type research_verification_status as enum ('unverified', 'human_confirmed', 'human_disputed');

-- Parent run-tracking table, mirroring deep_dive_runs's own shape minus
-- everything that's Strategy's job (no strategy blob, no organization_intel
-- blob, no evidence_item_ids -- Research produces facts about the funder,
-- not a selection of the nonprofit's own evidence to cite).
create table research_runs (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  -- Per-prospect ordinal for humans ("this is v3 of the research"); id is
  -- the durable identity a later Strategy build's FK would point at.
  -- Computed app-side (select max+1) with a retry-on-unique-violation loop
  -- at the call site -- this constraint is the real backstop against a
  -- race between two concurrent runs, not just a formality.
  version integer not null,
  -- Explicit retry chain, not merely inferred from version ordering.
  retry_of uuid references research_runs (id),
  status research_run_status not null default 'researching',
  status_message text,
  findings text,
  model text,
  -- Reproducibility: what exactly produced this run's output, since claim
  -- rows are frozen snapshots that must remain meaningfully comparable
  -- long after the live web has moved on.
  prompt_version text,
  extraction_schema_version text,
  code_version text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric,
  latency_ms integer,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  organization_id uuid references organizations (id) default my_organization_id(),
  unique (prospect_id, version)
);

alter table research_runs enable row level security;

create policy "team members can log research runs"
  on research_runs for insert
  to authenticated
  with check (created_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read research runs"
  on research_runs for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can update research runs"
  on research_runs for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

create index research_runs_prospect_idx on research_runs (prospect_id);
create index research_runs_organization_id_idx on research_runs (organization_id);

-- One row per extracted fact/hypothesis. Normalized, not a jsonb array on
-- the run row, because claims are unbounded-per-run, independently
-- reviewable after the run completes (a human sets verification_status on
-- ONE claim, not the whole run), and need relational filtering for the
-- evaluation join below -- the same shape decision this codebase already
-- made, correctly, for evidence_items.
create table research_claims (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  -- Denormalized deliberately: claims are write-once per run, never moved
  -- between runs, so there's no drift risk, and it collapses the
  -- evaluation join from three tables to two.
  prospect_id uuid not null references prospects (id) on delete cascade,
  organization_id uuid references organizations (id) default my_organization_id(),
  -- No 'recommendation' value exists in this enum at all -- the strongest
  -- form of "never store these as equivalent" isn't a value someone has to
  -- remember not to use, it's a value that structurally can't be inserted.
  -- Recommendation-type content is categorically Strategy's job.
  claim_type research_claim_type not null,
  -- The real comparison key for the evaluation protocol (see
  -- research_expected_facts below) -- a stable, structured identifier like
  -- 'funding.typical_grant_size', enum-enforced at the extraction tool's
  -- own input schema (see lib/research.ts RESEARCH_CLAIM_KEYS), not left to
  -- convention alone.
  claim_key text not null,
  -- Free-text grouping/display only -- never used in a join.
  category text not null,
  claim text not null,
  source_url text,
  source_excerpt text,
  retrieved_at timestamptz not null default now(),
  confidence research_confidence not null default 'medium',
  verification_status research_verification_status not null default 'unverified',
  verified_by uuid references auth.users (id),
  verified_at timestamptz,
  recheck_at timestamptz,
  created_at timestamptz not null default now()
);

alter table research_claims enable row level security;

create policy "team members can log research claims"
  on research_claims for insert
  to authenticated
  with check (organization_id = my_organization_id());

create policy "team members can read research claims"
  on research_claims for select
  to authenticated
  using (organization_id = my_organization_id());

-- Update is needed for the human-verification step (setting
-- verification_status/verified_by/verified_at on one claim).
create policy "team members can review research claims"
  on research_claims for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

create index research_claims_run_idx on research_claims (research_run_id);
create index research_claims_prospect_idx on research_claims (prospect_id);
create index research_claims_organization_id_idx on research_claims (organization_id);

-- Cross-table organization integrity, database-enforced -- the first
-- trigger in this codebase, deliberately scoped and justified rather than
-- a new habit. Without this, organization_id default my_organization_id()
-- on each table independently doesn't stop a child row's organization_id
-- from silently diverging from its parent run's organization_id -- the
-- same class of cross-table gap already flagged (and accepted, for
-- already-live tables) in docs/decisions/0001-multi-tenancy.md. Closing it
-- here, before any data exists, costs nothing; leaving it open in brand
-- new tables wouldn't be justified the way accepting it on old tables was.
create function enforce_research_run_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from research_runs where id = new.research_run_id) then
    raise exception 'organization_id must match the referenced research_run''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger research_claims_org_match
  before insert on research_claims
  for each row execute function enforce_research_run_org_match();

-- Hand-authored ground truth for a small set of controlled fixture
-- prospects, for Track 1 (AI-output quality) of the evaluation protocol.
-- Not a child of research_runs -- stands alone per prospect, so it doesn't
-- need the trigger above, just ordinary RLS.
create table research_expected_facts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  claim_key text not null,
  category text not null,
  expected_claim text not null,
  source text,
  source_url text,
  authored_by uuid not null references auth.users (id),
  valid_as_of timestamptz not null default now(),
  organization_id uuid references organizations (id) default my_organization_id(),
  notes text
);

alter table research_expected_facts enable row level security;

create policy "team members manage research expected facts"
  on research_expected_facts for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

create index research_expected_facts_prospect_idx on research_expected_facts (prospect_id);
create index research_expected_facts_organization_id_idx on research_expected_facts (organization_id);

-- Persistent human verdicts on run quality over time, so "did research
-- quality improve between v1 and v3" is answerable later without
-- re-litigating a whole review by memory.
create table research_eval_reviews (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  -- null = reviewing an unexpected claim, not an expected-fact gap.
  expected_fact_id uuid references research_expected_facts (id) on delete cascade,
  -- null = a genuine miss, no matching claim was produced.
  claim_id uuid references research_claims (id) on delete cascade,
  -- 'match' | 'partial' | 'miss' | 'contradicted' (Mode A, has ground truth)
  -- 'plausible' | 'hallucinated' | 'unclear' (Mode B, no ground truth)
  verdict text not null,
  reviewed_by uuid not null references auth.users (id),
  reviewed_at timestamptz not null default now(),
  notes text,
  organization_id uuid references organizations (id) default my_organization_id()
);

alter table research_eval_reviews enable row level security;

create policy "team members can log research eval reviews"
  on research_eval_reviews for insert
  to authenticated
  with check (reviewed_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read research eval reviews"
  on research_eval_reviews for select
  to authenticated
  using (organization_id = my_organization_id());

create trigger research_eval_reviews_org_match
  before insert on research_eval_reviews
  for each row execute function enforce_research_run_org_match();

create index research_eval_reviews_run_idx on research_eval_reviews (research_run_id);
create index research_eval_reviews_organization_id_idx on research_eval_reviews (organization_id);
