-- Ruling 0034: a supporter is not a prospect being courted. An individual,
-- recurring giver is a new, separate concept -- its own minimal shape, its
-- own append-only gift ledger, its own interaction history -- built ALONGSIDE
-- the prospect/funder model, never inside it. STATE item 80.
--
-- Three tables.
--
-- (i) supporters: the record of who they are and what they said they'd give.
--     name, email, phone, how they arrived (source_type, a closed list of
--     event/website/other, plus a free-text source_detail), and the pledge as
--     TOLD -- pledged_amount/pledged_frequency, what the person said, not what
--     was received (ruling 0034 clause 2's split starts here: a pledge with
--     zero gifts logged is a legible, honest state, not an error, so neither
--     column is required).
--       * Deliberately NO channel, NO stage, NO EIN, NO typical_grant_size --
--         ruling 0034 clause 1 is explicit that none of the courtship-stage
--         model's fields apply to a retail-scale individual giver who has
--         already said yes.
--       * Team-scoped like prospects and candidates (0033): one policy for
--         all four operations, gated on organization_id alone -- there is no
--         owner/creator restriction on this table, same as those two.
--
-- (ii) supporter_gifts: what was actually received, APPEND-ONLY. Ruling 0034
--     clause 2's other half: a commitment and an actual gift are two
--     different facts and must not collapse into one row. One row per real
--     gift, amount (checked positive) and date, RLS grants INSERT and SELECT
--     ONLY -- no update policy, no delete policy, at all, matching ruling
--     0019's retention posture (0066: prospect_outcome_dispositions) and
--     ruling 0034 clause 2's own words: "If a logged gift was wrong, the fix
--     is a correction row, not a silent edit."
--       * organization_id carries an org-match trigger in 0066's exact shape
--         (security definer, set search_path = public, BEFORE INSERT) rather
--         than trusting the FK -- a foreign key check runs as the table owner
--         and ignores RLS, so it stops one org READING another's row but not
--         one org POINTING a gift at it (the known hole,
--         docs/decisions/0001-multi-tenancy.md). Closed here at birth, same
--         as every table added since.
--
-- (iii) supporter_interactions: the parallel to the existing `interactions`
--     table (0031) prospects use -- kind, summary, occurred_at, created_by --
--     but its OWN table with its OWN foreign key, per the ruling's explicit
--     instruction not to add a second, nullable FK to that heavily-used
--     table. Reuses interaction_kind (0031's enum: email/call/meeting/note)
--     rather than inventing a parallel vocabulary: logging a call, an email,
--     a meeting or a note is exactly as meaningful for a supporter as for a
--     prospect, and a second enum with the same four values would be a
--     distinction with no difference.
--       * Editable/deletable by any team member ("for all", org-scoped),
--         matching the existing `interactions` table's own policy shape
--         (0033:237-244) -- this is relationship memory, not a retained
--         historical ledger like (ii). Because update is possible here,
--         the org-match trigger fires on UPDATE OF supporter_id too, not
--         insert alone (the same hardening 0077 added for
--         network_path_suggestions, beyond 0066's insert-only original) --
--         closing the repoint hole at birth rather than leaving it for a
--         later item to find.
--
-- Additive under ruling 0020: three new tables, their indexes, policies and
-- triggers. No existing table, column or policy is touched -- there is no
-- `alter table` against anything that predates this file -- so it is safe to
-- apply in either deploy order relative to its code: applied first, the new
-- pages have data to read the moment the code ships; code deployed first
-- simply finds no Supporters nav item's queries resolving anything yet (the
-- page itself isn't linked from anywhere until this migration lands), and
-- every other page is untouched either way.

create table supporters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  name text not null,
  email text,
  phone text,
  source_type text not null,
  source_detail text,
  pledged_amount numeric,
  pledged_frequency text,
  notes text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table supporters
  add constraint supporters_source_type_check
  check (source_type in ('event', 'website', 'other'));

alter table supporters
  add constraint supporters_pledged_frequency_check
  check (pledged_frequency is null or pledged_frequency in ('one_time', 'monthly', 'annual'));

create index supporters_organization_id_idx on supporters (organization_id);

comment on table supporters is
  'Ruling 0034: an individual, recurring giver -- its own shape, not a prospect. No channel, no stage, no EIN, no typical_grant_size. pledged_amount/pledged_frequency is the pledge as TOLD; see supporter_gifts for what was actually received.';

create table supporter_gifts (
  id uuid primary key default gen_random_uuid(),
  supporter_id uuid not null references supporters (id) on delete cascade,
  amount numeric not null,
  gift_date date not null,
  note text,
  recorded_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  organization_id uuid not null references organizations (id) default my_organization_id()
);

alter table supporter_gifts
  add constraint supporter_gifts_amount_positive_check
  check (amount > 0);

create index supporter_gifts_supporter_id_idx on supporter_gifts (supporter_id, gift_date desc);
create index supporter_gifts_organization_id_idx on supporter_gifts (organization_id);

comment on table supporter_gifts is
  'Ruling 0034 clause 2: what was actually received, APPEND-ONLY. One row per real gift. No update policy, no delete policy, at all -- a correction is a new row, never a silent edit, matching ruling 0019''s retention posture.';

create table supporter_interactions (
  id uuid primary key default gen_random_uuid(),
  supporter_id uuid not null references supporters (id) on delete cascade,
  kind interaction_kind not null,
  summary text not null,
  occurred_at date not null default current_date,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  organization_id uuid not null references organizations (id) default my_organization_id()
);

create index supporter_interactions_supporter_id_idx on supporter_interactions (supporter_id, occurred_at desc);
create index supporter_interactions_organization_id_idx on supporter_interactions (organization_id);

comment on table supporter_interactions is
  'The supporter-side parallel to `interactions` (0031) -- same shape (kind/summary/occurred_at/created_by), its own table and its own foreign key, per ruling 0034''s explicit instruction not to add a second nullable FK to the heavily-used prospect table.';

-- Tenant isolation. Hard rule 6, following 0033_multi_tenant_rls.sql. Nothing
-- in the codebase catches a table that skips this, so it is done here and
-- checked by scripts/test-tenant-isolation.ts.
alter table supporters enable row level security;
alter table supporter_gifts enable row level security;
alter table supporter_interactions enable row level security;

-- Supporters: team-scoped like prospects/candidates (0033:17-24, 108-115) --
-- one "for all" policy, gated on organization_id alone, no creator
-- restriction, matching the existing shared-team-table shape exactly.
create policy "team members manage supporters"
  on supporters for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- Gift history: insert and select ONLY, the same append-only treatment
-- prospect_outcome_dispositions gets in 0066 (no update, no delete, for
-- anyone, in any org, through the ordinary session client).
create policy "team members can log a gift"
  on supporter_gifts for insert
  to authenticated
  with check (recorded_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read gift history"
  on supporter_gifts for select
  to authenticated
  using (organization_id = my_organization_id());

-- Supporter interactions: team-scoped "for all", matching the existing
-- `interactions` table's own policy shape (0033:242-244) -- relationship
-- memory is editable/deletable by the team, unlike the gift ledger above.
create policy "team members manage supporter interactions"
  on supporter_interactions for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- Cross-table org integrity. A foreign key check runs as the table owner and
-- does NOT respect RLS, so the policies above stop one org READING another's
-- row and do not stop one org POINTING AT it (docs/decisions/0001-multi-
-- tenancy.md's known hole, left open on eight existing columns as an accepted
-- gap). These tables are new, so it costs nothing to close here instead of
-- inheriting it -- same pattern as 0066's enforce_prospect_outcome_prospect_org_match.
create function enforce_supporter_gift_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from supporters where id = new.supporter_id) then
    raise exception 'organization_id must match the referenced supporter''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger supporter_gifts_org_match
  before insert on supporter_gifts
  for each row execute function enforce_supporter_gift_org_match();

-- BEFORE INSERT OR UPDATE OF supporter_id: supporter_interactions, unlike
-- supporter_gifts, has an UPDATE policy (it's editable relationship memory,
-- not a retained ledger), so a repoint-to-another-org's-supporter via UPDATE
-- is a real path an insert-only trigger would miss -- the same hardening
-- 0077 added for network_path_suggestions beyond 0066's original insert-only
-- shape.
create function enforce_supporter_interaction_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from supporters where id = new.supporter_id) then
    raise exception 'organization_id must match the referenced supporter''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger supporter_interactions_org_match
  before insert or update of supporter_id on supporter_interactions
  for each row execute function enforce_supporter_interaction_org_match();
