-- Ruling 0019: a declined prospect keeps its reason, and "never revisit" is a
-- choice a human makes rather than a blank field.
--
-- A dismissed CANDIDATE -- a funder never contacted -- has carried
-- dismissed_reason and revisit_date since 0031. A PROSPECT carried neither, so
-- the relationship the organisation invested most in was the one it remembered
-- least about. This closes that.
--
-- Two tables, not one column set, and the split is the whole point.
--
-- prospect_outcomes holds the no itself: what happened, when, and why.
--
-- prospect_outcome_dispositions holds the revisit decision, APPEND-ONLY. The
-- ruling's load-bearing constraint is that `never` may only ever come from an
-- explicit human action, and that an absent, blank or skipped field is
-- `undecided` and never `never`. A mutable disposition column would make that a
-- property of whatever code happened to write it; as an append-only log it is a
-- property of the schema:
--
--   * `undecided` is the ABSENCE of any row. Nothing stores it, so nothing can
--     get it wrong.
--   * `never` exists only as a row somebody inserted on purpose.
--   * `disposition` is not null WITH NO DEFAULT, so an insert that omits it
--     fails loudly instead of quietly taking a value nobody chose.
--
-- The same shape also satisfies the ruling's second test -- set `never`, then
-- reverse it, and both the original reason and the reversal are still readable
-- -- because a reversal is a new row rather than an overwrite. This is
-- retention, not deletion, consistent with a dismissed candidate being kept.
--
-- Hard rule 2 is untouched: nothing here references `stage`, and recording an
-- outcome does not move a prospect. Every stage transition remains a separate,
-- confirmed human action through the existing gate.
--
-- Additive under ruling 0020: two new tables, four new indexes, five new
-- policies, two new triggers, and constraints bounding only new columns. No
-- existing table, column or policy is touched at all -- there is no `add
-- column` in this file -- so nothing already deployed can break on it, and it
-- is safe to apply ahead of its code.

-- The no itself.
create table prospect_outcomes (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  -- Only 'declined' is authorized by ruling 0019. Deliberately text with a
  -- check rather than an enum, matching qualification_stages.state in 0064:
  -- this vocabulary is still settling, and a check constraint can be altered
  -- where an enum value cannot be removed.
  outcome text not null default 'declined',
  -- Nullable on purpose. A reason a person has not written yet is missing, and
  -- an empty string pretending to be a reason is worse than a null that says
  -- so. The interface asks for one; the schema does not invent one.
  reason text,
  occurred_on date not null default current_date,
  recorded_by uuid not null references auth.users (id),
  recorded_at timestamptz not null default now(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

alter table prospect_outcomes
  add constraint prospect_outcomes_outcome_check
  check (outcome in ('declined'));

create index prospect_outcomes_prospect_id_idx on prospect_outcomes (prospect_id, recorded_at desc);
create index prospect_outcomes_organization_id_idx on prospect_outcomes (organization_id);

comment on table prospect_outcomes is
  'A funder said no. Retained rather than deleted -- CLAUDE.md: a "no" is data, not a dead end. Carries no revisit disposition of its own; see prospect_outcome_dispositions, where the absence of a row IS "undecided".';

-- The revisit decision, append-only.
create table prospect_outcome_dispositions (
  id uuid primary key default gen_random_uuid(),
  prospect_outcome_id uuid not null references prospect_outcomes (id) on delete cascade,
  -- No default, deliberately. Ruling 0019: there must be no code path by which
  -- an absent field produces `never`. There is no default by which an absent
  -- field produces anything at all.
  disposition text not null,
  revisit_on date,
  -- `never` carries its own reason, separate from the decline's reason, and so
  -- does a reversal. Both are kept forever.
  reason text,
  decided_by uuid not null references auth.users (id),
  decided_at timestamptz not null default now(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

alter table prospect_outcome_dispositions
  add constraint prospect_outcome_dispositions_disposition_check
  check (disposition in ('revisit_on', 'never', 'undecided'));

-- A date belongs to exactly one disposition. Without this, a `never` row could
-- carry a revisit date and a `revisit_on` row could carry none -- two more ways
-- for one row to assert two different facts at once.
alter table prospect_outcome_dispositions
  add constraint prospect_outcome_dispositions_revisit_on_check
  check (
    (disposition = 'revisit_on' and revisit_on is not null)
    or (disposition <> 'revisit_on' and revisit_on is null)
  );

create index prospect_outcome_dispositions_outcome_id_idx
  on prospect_outcome_dispositions (prospect_outcome_id, decided_at desc);
create index prospect_outcome_dispositions_organization_id_idx
  on prospect_outcome_dispositions (organization_id);

comment on table prospect_outcome_dispositions is
  'Append-only history of the revisit decision on one outcome. The current disposition is the most recent row; NO ROWS MEANS "undecided" -- nobody has decided whether to return. Reversing "never" appends a row, it never edits or removes one, so the original choice and its reversal are both still readable.';

comment on column prospect_outcome_dispositions.disposition is
  'revisit_on | never | undecided. "never" is only ever written by an explicit human action (ruling 0019). Not null with no default: an insert that omits it errors rather than guessing.';

-- Tenant isolation. Hard rule 6, following 0033_multi_tenant_rls.sql. Nothing
-- in the codebase catches a table that skips this, so it is done here and
-- checked by scripts/test-tenant-isolation.ts.
alter table prospect_outcomes enable row level security;
alter table prospect_outcome_dispositions enable row level security;

-- Outcomes: readable and writable within the owning org. Update is allowed so a
-- reason can be corrected; delete is NOT granted, because the ruling is explicit
-- that this is retention and not deletion.
create policy "team members can record prospect outcomes"
  on prospect_outcomes for insert
  to authenticated
  with check (recorded_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read prospect outcomes"
  on prospect_outcomes for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can correct prospect outcomes"
  on prospect_outcomes for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- Dispositions: insert and select only, the same append-only treatment
-- stage_changes gets in 0033. No update policy and no delete policy means a
-- recorded decision cannot be edited away by anyone, in any org, through any
-- code path that uses the ordinary session client.
create policy "team members can decide a revisit disposition"
  on prospect_outcome_dispositions for insert
  to authenticated
  with check (decided_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read revisit dispositions"
  on prospect_outcome_dispositions for select
  to authenticated
  using (organization_id = my_organization_id());

-- Cross-table org integrity, the same treatment research_claims and
-- research_sources get in 0035 and 0037.
--
-- A foreign key check runs as the table owner and does NOT respect RLS, so the
-- insert policies above stop one org READING another's row and do not stop one
-- org POINTING AT it. docs/decisions/0001-multi-tenancy.md records that exact
-- hole, left open on eight existing columns, as a known accepted gap. These two
-- tables are new, so it costs nothing to close here instead of inheriting it.
create function enforce_prospect_outcome_prospect_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from prospects where id = new.prospect_id) then
    raise exception 'organization_id must match the referenced prospect''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger prospect_outcomes_org_match
  before insert on prospect_outcomes
  for each row execute function enforce_prospect_outcome_prospect_org_match();

create function enforce_disposition_outcome_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from prospect_outcomes where id = new.prospect_outcome_id) then
    raise exception 'organization_id must match the referenced outcome''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger prospect_outcome_dispositions_org_match
  before insert on prospect_outcome_dispositions
  for each row execute function enforce_disposition_outcome_org_match();
