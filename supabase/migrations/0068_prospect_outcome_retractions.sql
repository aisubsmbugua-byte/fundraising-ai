-- Ruling 0027: a recorded outcome can be retracted, and a retraction is an
-- appended fact -- the record survives its own reversal.
--
-- Migration 0066 grants no delete on prospect_outcomes by design (ruling 0019:
-- retention, not deletion), so a decline recorded by misclick was permanent.
-- This closes that WITHOUT touching retention: a retraction is its own row
-- naming who, when, and optionally why. The outcome row it points at stays
-- exactly as written, and so does every disposition row. Relationship memory
-- keeps both halves -- that the team once recorded a no, and that the team
-- took it back.
--
-- The outcome in effect is DERIVED, in one place (ruling 0027 clause 3):
-- effective outcome = the recorded outcome unless a retraction row exists for
-- it. The derivation lives in lib/prospect-outcomes.ts (isOutcomeInEffect /
-- latestOutcomeInEffect); nothing in this schema stores "retracted" as a
-- status column, so no column can drift from the fact.
--
-- One retraction per outcome (unique on prospect_outcome_id). A second
-- retraction of an already-retracted outcome asserts nothing the first did
-- not; recording a decline AGAIN after a retraction is a new outcome row in
-- prospect_outcomes, never a resurrection of the old one (clause 4).
--
-- A retraction is itself retained (clause 4): org-scoped, append-only. RLS
-- grants insert and select only -- NO update policy and NO delete policy, the
-- same treatment prospect_outcome_dispositions gets in 0066, so a retraction
-- cannot be edited or removed by anyone, in any org, through any code path
-- that uses the ordinary session client.
--
-- Hard rule 2 is untouched: nothing here references `stage`, and retracting
-- an outcome does not move a prospect.
--
-- Additive under ruling 0020: one new table, one new index (plus the unique
-- constraint's), two new policies, one new function, one new trigger.
-- No existing table, column or policy is touched at all -- there is no
-- `add column` in this file -- so nothing already deployed can break on it,
-- and it is SAFE TO APPLY AHEAD OF ITS CODE.

create table prospect_outcome_retractions (
  id uuid primary key default gen_random_uuid(),
  -- Named prospect_outcome_id, matching prospect_outcome_dispositions in 0066,
  -- so the two tables that hang off an outcome address it the same way.
  prospect_outcome_id uuid not null references prospect_outcomes (id) on delete cascade,
  -- Nullable on purpose, same reasoning as prospect_outcomes.reason in 0066:
  -- a note nobody wrote is missing, and an empty string pretending to be one
  -- is worse than a null that says so.
  note text,
  retracted_by uuid not null references auth.users (id),
  retracted_at timestamptz not null default now(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

-- One retraction per outcome. The first retraction already voids the outcome;
-- a second would be a row asserting nothing. This also keeps the derivation a
-- membership test rather than a latest-row question.
alter table prospect_outcome_retractions
  add constraint prospect_outcome_retractions_outcome_unique
  unique (prospect_outcome_id);

create index prospect_outcome_retractions_organization_id_idx
  on prospect_outcome_retractions (organization_id);

comment on table prospect_outcome_retractions is
  'A recorded prospect outcome taken back by an explicit human action (ruling 0027). Append-only: the retraction and the outcome it voids are BOTH retained forever. An outcome with a row here is not in effect; the prospect stands as if no outcome were recorded. Recording a new decline afterwards is a new prospect_outcomes row.';

comment on column prospect_outcome_retractions.note is
  'Why it was taken back, if the person said. Optional -- a misclick needs no essay.';

-- Tenant isolation. Hard rule 6, following 0033_multi_tenant_rls.sql. Nothing
-- in the codebase catches a table that skips this, so it is done here and
-- checked by scripts/test-tenant-isolation.ts.
alter table prospect_outcome_retractions enable row level security;

-- Insert and select only. No update policy and no delete policy: a retraction
-- is an appended fact (ruling 0027 clauses 2 and 4).
create policy "team members can retract a prospect outcome"
  on prospect_outcome_retractions for insert
  to authenticated
  with check (retracted_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read outcome retractions"
  on prospect_outcome_retractions for select
  to authenticated
  using (organization_id = my_organization_id());

-- Cross-table org integrity, 0066's exact pattern. A foreign key check runs as
-- the table owner and does NOT respect RLS, so the insert policy above stops
-- one org READING another's outcome and does not stop one org POINTING AT it.
-- docs/decisions/0001-multi-tenancy.md records that hole as a known accepted
-- gap on eight existing columns; this table is new, so it is closed here.
create function enforce_retraction_outcome_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from prospect_outcomes where id = new.prospect_outcome_id) then
    raise exception 'organization_id must match the referenced outcome''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger prospect_outcome_retractions_org_match
  before insert on prospect_outcome_retractions
  for each row execute function enforce_retraction_outcome_org_match();
