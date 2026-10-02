-- Ruling 0035: a funder's past gifts are a ledger, not a note. `ask_amount` on
-- a prospect is what is being asked for now, forward-looking, singular; what a
-- funder has actually GIVEN in the past is a different fact, and today it has
-- nowhere to live but a free-text notes box. STATE item 83.
--
-- This is the institutional-funder half of the same pattern ruling 0034
-- already settled for individual supporters (migration 0078:
-- supporter_gifts). prospect_gifts is a close mirror of that table, field for
-- field, keyed to `prospects` instead of `supporters`:
--
--   * One row per real gift, amount (checked positive) and date, APPEND-ONLY
--     -- RLS grants INSERT and SELECT ONLY, no update policy, no delete
--     policy, at all, matching ruling 0019's retention posture and ruling
--     0035 clause 1's own words ("never edited or deleted once logged").
--   * organization_id carries an org-match trigger (security definer, set
--     search_path = public, BEFORE INSERT), mirroring 0066/0078's exact
--     shape -- a foreign key check runs as the table owner and ignores RLS,
--     so it stops one org READING another's row but not one org POINTING a
--     gift at it (the known hole, docs/decisions/0001-multi-tenancy.md).
--     Closed here at birth, same as every table added since.
--   * Ruling 0035 clause 2: a SEPARATE table keyed to prospects, not a shared
--     column or a nullable second foreign key on supporter_gifts -- a
--     prospect and a supporter remain genuinely different entities (ruling
--     0034).
--   * Ruling 0035 clause 3: no channel restriction. Every prospect, any
--     channel, can carry giving history.
--
-- Additive under ruling 0020: one new table, its indexes, policies and
-- trigger. No existing table, column or policy is touched -- there is no
-- `alter table` against anything that predates this file -- so it is safe to
-- apply in either deploy order relative to its code: applied first, the new
-- Overview-tab giving-history card has data to read the moment the code
-- ships; code deployed first simply finds no rows yet (the card renders its
-- own empty state, and the "Log a gift" action fails closed with a normal
-- database error until this migration lands) -- every other page is
-- untouched either way.

create table prospect_gifts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  amount numeric not null,
  gift_date date not null,
  note text,
  recorded_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  organization_id uuid not null references organizations (id) default my_organization_id()
);

alter table prospect_gifts
  add constraint prospect_gifts_amount_positive_check
  check (amount > 0);

create index prospect_gifts_prospect_id_idx on prospect_gifts (prospect_id, gift_date desc);
create index prospect_gifts_organization_id_idx on prospect_gifts (organization_id);

comment on table prospect_gifts is
  'Ruling 0035: a prospect''s actual giving history, APPEND-ONLY. One row per real gift. No update policy, no delete policy, at all -- a correction is a new row, never a silent edit, matching ruling 0019''s retention posture and supporter_gifts'' own precedent (migration 0078).';

-- Tenant isolation. Hard rule 6, following 0033_multi_tenant_rls.sql. Nothing
-- in the codebase catches a table that skips this, so it is done here and
-- checked by scripts/test-tenant-isolation.ts.
alter table prospect_gifts enable row level security;

-- Gift history: insert and select ONLY, the same append-only treatment
-- supporter_gifts gets in 0078 (no update, no delete, for anyone, in any org,
-- through the ordinary session client).
create policy "team members can log a prospect gift"
  on prospect_gifts for insert
  to authenticated
  with check (recorded_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read prospect gift history"
  on prospect_gifts for select
  to authenticated
  using (organization_id = my_organization_id());

-- Cross-table org integrity. A foreign key check runs as the table owner and
-- does NOT respect RLS, so the policies above stop one org READING another's
-- row and do not stop one org POINTING AT it (docs/decisions/0001-multi-
-- tenancy.md's known hole, left open on eight existing columns as an accepted
-- gap). This table is new, so it costs nothing to close here instead of
-- inheriting it -- same pattern as 0066's enforce_prospect_outcome_prospect_org_match
-- and 0078's enforce_supporter_gift_org_match.
create function enforce_prospect_gift_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from prospects where id = new.prospect_id) then
    raise exception 'organization_id must match the referenced prospect''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger prospect_gifts_org_match
  before insert on prospect_gifts
  for each row execute function enforce_prospect_gift_org_match();
