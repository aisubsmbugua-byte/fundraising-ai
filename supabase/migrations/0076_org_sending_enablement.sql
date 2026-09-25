-- STATE item 74, authorized by ruling 0032: funder-facing sending is OFF for
-- an organization until the platform owner (a superadmin) turns it on. The
-- absence of an enablement row means disabled -- nothing stores "off".
--
-- (i) org_sending_enablement: one row per organization that has ever been
--     enabled or disabled. RLS enabled (hard rule 6):
--       * select: org-scoped via my_organization_id() -- a member can see
--         whether their own organization is enabled, never another's.
--       * insert and update: superadmin only, expressed with is_superadmin()
--         (0032_multi_tenant_foundation.sql -- the same profiles.is_superadmin
--         flag app/admin's layout and requireSuperadmin() read). NO policy
--         lets an ordinary member write, so an organization cannot enable
--         its own sending by editing a row it owns.
--       * NO delete policy: turning sending off is `enabled = false`, an
--         update, so the record of who decided what and when is retained.
--     `enabled` is NOT NULL WITH NO DEFAULT (0066's disposition reasoning): a
--     write that omits it fails loudly rather than quietly taking a value
--     nobody chose. organization_id is the primary key and deliberately has
--     NO `default my_organization_id()`: the writer is a superadmin acting
--     on ANOTHER organization, and a default would silently aim an omitted
--     value at the superadmin's own org. It is required, explicit, and
--     references organizations(id) ON DELETE CASCADE, so the admin area's
--     deletion of an empty test organization is not blocked by its own
--     enablement row (that path is service-role, not a member delete).
--
-- (ii) `create or replace` of draft_send_attempts_enforce_birth (0069, with
--     0075's `for update`) adding ONE refusal: no row with enabled = true for
--     new.organization_id -> the attempt is not born. The body is 0075's
--     verbatim except the added check block and its comment; every existing
--     check, the security definer clause and the lock are untouched.
--
--     ADDITIVE IN EFFECT despite the `create or replace`, following 0070's
--     and 0075's precedent: the function is already applied and must be
--     replaced in place. It only WIDENS a guard; it removes no check the
--     0075 version performed. Migrations 0001-0075 are untouched.
--
-- DEPLOY ORDER -- READ THIS.
--   * AFTER THIS MIGRATION IS APPLIED, NO ORGANIZATION CAN SEND until a
--     superadmin enables it -- INCLUDING THE OWNER'S OWN ORGANIZATION. The
--     admin toggle (Admin > Organizations) ships in the same push as this
--     migration's code: deploy that code, apply this migration, and flip
--     the owner's own organization ON immediately if it must keep sending.
--     Until then every send attempt is refused by the database.
--   * CODE AHEAD OF THE MIGRATION fails CLOSED, never open: the page and the
--     send handler treat any error reading org_sending_enablement (42P01
--     table missing, or anything else), no row, or enabled != true as "not
--     enabled" and refuse with the plain message before an attempt is born.
--     So deploying the code first switches sending OFF for everyone at deploy
--     time; the toggle would be inoperative until this migration creates
--     the table.
--   * MIGRATION AHEAD OF THE CODE: the old code does not know the table; its
--     sends are refused by the database birth trigger with the error above,
--     surfaced as "Could not record the send attempt". Nothing is sent.
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so this applies together or not at all. Re-running after
-- success fails on the existing table and policy names (no IF NOT EXISTS) --
-- a refusal that rolls the whole script back, not damage. Only the (ii)
-- replace is itself re-runnable. No organization name, id or email appears
-- anywhere in this file; enabling an organization is done through the admin
-- toggle, not by seed data.

-- (i)
create table org_sending_enablement (
  organization_id uuid primary key references organizations (id) on delete cascade,
  enabled boolean not null,
  set_by uuid references auth.users (id),
  set_at timestamptz default now()
);

comment on table org_sending_enablement is
  'Ruling 0032: an organization may send funder mail only while a row here says enabled = true. The absence of a row means disabled. Written only by a superadmin.';

alter table org_sending_enablement enable row level security;

create policy "team members can read their org's sending enablement"
  on org_sending_enablement for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "superadmins can enable sending"
  on org_sending_enablement for insert
  to authenticated
  with check (is_superadmin());

create policy "superadmins can change sending enablement"
  on org_sending_enablement for update
  to authenticated
  using (is_superadmin())
  with check (is_superadmin());

-- (ii) 0075's function verbatim, plus the enablement refusal.
create or replace function draft_send_attempts_enforce_birth() returns trigger as $$
declare
  d record;
begin
  -- FOR UPDATE: lock the draft row so this birth and a concurrent un-approve
  -- (0074's trigger reads draft_send_attempts) serialise -- under READ
  -- COMMITTED the later one waits, then re-reads the committed result, so
  -- one of the two always sees the other (STATE item 73).
  select organization_id, status, sent_at into d from drafts where id = new.draft_id for update;
  if d.organization_id is distinct from new.organization_id then
    raise exception 'draft_send_attempts: organization_id must match the referenced draft''s organization_id';
  end if;
  if d.status <> 'approved' then
    raise exception 'draft_send_attempts: only an approved draft can be sent (ruling 0029 clause 2)';
  end if;
  if d.sent_at is not null then
    raise exception 'draft_send_attempts: this draft has already been sent -- one draft, one send, ever (ruling 0029 clause 3)';
  end if;
  if exists (
    select 1 from draft_send_attempts
    where draft_id = new.draft_id and (outcome = 'sent' or outcome is null)
  ) then
    raise exception 'draft_send_attempts: a live, unconfirmed or confirmed attempt already exists for this draft -- it will not be sent twice';
  end if;
  if new.outcome is not null or new.completed_at is not null
     or new.error_note is not null or new.resend_message_id is not null then
    raise exception 'draft_send_attempts: an attempt is born unfinalized, before the provider is called -- terminal facts are written after (ruling 0029 clause 4)';
  end if;
  -- Ruling 0032 clause 3 (STATE item 74): sending is off unless the platform
  -- owner has switched it on for this organization. The ABSENCE of an enabled
  -- row is the off state.
  if not exists (
    select 1 from org_sending_enablement
    where organization_id = new.organization_id and enabled = true
  ) then
    raise exception 'draft_send_attempts: sending is not switched on for this organization -- the platform owner enables it per organization (ruling 0032)';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
