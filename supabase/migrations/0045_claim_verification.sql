-- Stage 5: independent semantic verification of a claim against its own
-- evidence.
--
-- This is the boundary the evidence-first redesign deliberately left open.
-- That work guarantees a claim cites REAL, exactly-captured text from a
-- source that describes the right entity. It does not check that the claim's
-- WORDING follows from that text -- a claim can cite a perfectly real
-- fragment and still overstate it, generalise a single grant into a policy,
-- or drop the qualifier that changes its meaning.
--
-- Kept as its own table rather than columns on research_claims for two
-- reasons: a claim may be verified more than once (a new model, a revised
-- prompt) and overwriting would destroy the comparison, and research_claims
-- already has verification_status for HUMAN review, which is a different
-- judgement that must not be conflated with a model's.
create table research_claim_verifications (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  claim_id uuid not null references research_claims (id) on delete cascade,
  -- supported | partially_supported | unsupported | contradicted
  -- text, not an enum: this vocabulary is new and expected to move.
  verdict text not null,
  -- Why, in the verifier's own words -- the part a human reviewer reads.
  reason text,
  model text not null,
  -- How many evidence fragments the verifier was shown. A verdict reached on
  -- zero evidence means something different from one reached on five.
  evidence_count integer not null default 0,
  organization_id uuid references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

alter table research_claim_verifications enable row level security;

create policy "team members can log claim verifications" on research_claim_verifications
  for insert to authenticated with check (organization_id = my_organization_id());
create policy "team members can read claim verifications" on research_claim_verifications
  for select to authenticated using (organization_id = my_organization_id());

-- Same two guards every research child table carries: the row's org must
-- match its run's, and its claim must belong to that same run -- FK
-- constraints are not subject to RLS, so without this a session could point
-- a real verification row at another organization's claim.
create trigger research_claim_verifications_org_match
  before insert on research_claim_verifications
  for each row execute function enforce_research_run_org_match();

create function enforce_verification_claim_run_match() returns trigger as $$
begin
  if new.research_run_id is distinct from (select research_run_id from research_claims where id = new.claim_id) then
    raise exception 'claim_id must belong to the same research_run_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger research_claim_verifications_claim_run_match
  before insert on research_claim_verifications
  for each row execute function enforce_verification_claim_run_match();

create index research_claim_verifications_run_idx on research_claim_verifications (research_run_id);
create index research_claim_verifications_claim_idx on research_claim_verifications (claim_id);
create index research_claim_verifications_organization_id_idx on research_claim_verifications (organization_id);
