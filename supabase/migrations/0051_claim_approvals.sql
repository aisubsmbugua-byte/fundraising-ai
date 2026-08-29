-- Human decisions on individual research claims, and the record of what a
-- strategy was actually built from.
--
-- Approval is deliberately tied to a specific claim row, and a claim row
-- belongs to exactly one research run. A re-run therefore CANNOT inherit
-- approvals: new evidence and new wording produce new claims, which a person
-- has not seen. That is stricter than carrying decisions forward, and it is
-- the safe direction -- an approval means "I checked this wording against
-- this evidence", and neither survives a re-run unchanged.
create table research_claim_approvals (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  claim_id uuid not null references research_claims (id) on delete cascade,
  -- approved            verified, accepted in bulk
  -- approved_with_note  NOT verified, accepted anyway on the reviewer's own
  --                     knowledge -- the note is required, because this is a
  --                     person overriding the evidence and the reason must
  --                     survive them
  -- corrected           reviewer supplied better wording
  -- excluded            must not be used
  -- research_requested  the gap should be researched again, not guessed at
  decision text not null,
  note text,
  corrected_claim text,
  decided_by uuid references profiles (id),
  organization_id uuid references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

alter table research_claim_approvals enable row level security;

create policy "team members can record claim decisions" on research_claim_approvals
  for insert to authenticated with check (organization_id = my_organization_id());
create policy "team members can read claim decisions" on research_claim_approvals
  for select to authenticated using (organization_id = my_organization_id());

create trigger research_claim_approvals_org_match
  before insert on research_claim_approvals
  for each row execute function enforce_research_run_org_match();

create trigger research_claim_approvals_claim_run_match
  before insert on research_claim_approvals
  for each row execute function enforce_verification_claim_run_match();

create index research_claim_approvals_run_idx on research_claim_approvals (research_run_id);
create index research_claim_approvals_claim_idx on research_claim_approvals (claim_id);
create index research_claim_approvals_organization_id_idx on research_claim_approvals (organization_id);

-- Which research run's approved intelligence a strategy was built from.
-- Null means the strategy predates approved intelligence and was generated
-- from unstructured legacy research -- it has not been checked against
-- anything a person approved, and the UI says so rather than implying it has.
alter table deep_dive_runs add column approved_intelligence_run_id uuid references research_runs (id);
