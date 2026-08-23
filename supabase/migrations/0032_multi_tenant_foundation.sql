-- Multi-tenancy, stage 1: organizations + profiles + the RLS helper
-- functions every later policy will use. Apply after 0031_followup.sql.
--
-- profiles is NOT org_profile (0004_org_profile.sql) -- org_profile
-- holds one tenant's own nonprofit content (mission/programs/etc,
-- scoped by organization_id starting in 0033); profiles is the new
-- per-*user* row that says which tenant (organization) a person
-- belongs to. Don't conflate the two.
--
-- This migration only adds new tables/functions and does not touch
-- any existing table's RLS -- the app keeps working exactly as it
-- does today ("using (true)" everywhere) until 0033 lands.

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table organizations enable row level security;
-- Deliberately zero policies: no "authenticated" role, including
-- superadmins, ever reads/writes this table directly. It's only ever
-- touched through the service-role admin client from the superadmin
-- tool's server actions (see lib/supabase/admin.ts). RLS with row
-- security enabled and no matching policy denies by default, so this
-- is a real lock, not an oversight.

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references organizations (id),
  is_superadmin boolean not null default false,
  email text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- SECURITY DEFINER so every downstream RLS policy (0033+) can call
-- these without a circular dependency on profiles' own policies.
-- STABLE because each only depends on auth.uid(), fixed for the
-- duration of one statement/request.
create function my_organization_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select organization_id from profiles where id = auth.uid();
$$;

create function is_superadmin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select is_superadmin from profiles where id = auth.uid()), false);
$$;

grant execute on function my_organization_id() to authenticated;
grant execute on function is_superadmin() to authenticated;

-- Any team member can see their teammates within their own org, but
-- never a row belonging to another org.
create policy "team members can read profiles in their org"
  on profiles for select
  to authenticated
  using (organization_id = my_organization_id());

-- Self-service profile creation on first login, restricted to the
-- organization_id baked into the invite's app_metadata (never a
-- client-supplied value -- user_metadata is client-writable via
-- updateUser, app_metadata is not, so the invite flow sets
-- app_metadata; see app/auth/callback/route.ts and the two invite
-- actions in app/admin and app/(dashboard)/settings/team). No
-- update/delete policy is granted: once created, a profile row is
-- immutable via the app, same append-only idiom as stage_changes.
create policy "invited users can create their own profile"
  on profiles for insert
  to authenticated
  with check (
    id = auth.uid()
    and organization_id = nullif(auth.jwt() -> 'app_metadata' ->> 'organization_id', '')::uuid
  );

-- Bootstrap: the one real org and real user live in production today.
insert into organizations (name) values ('Village Worship Initiative');

insert into profiles (id, organization_id, is_superadmin, email)
select u.id, o.id, true, u.email
from auth.users u
cross join (select id from organizations where name = 'Village Worship Initiative') o
where u.email = 'kanjii@kijijiagency.com';
