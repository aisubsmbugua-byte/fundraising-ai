-- Slice 3+ extension: organization knowledge base, stage 1 (text fields).
-- Apply after Slice 3 (screening) is live.

-- Singleton table: one row holding this nonprofit's own profile.
-- Enforced as a singleton in application code (always update the
-- existing row if one exists, insert only if none does) rather than
-- a DB constraint, to keep this simple.
create table org_profile (
  id uuid primary key default gen_random_uuid(),
  mission text,
  programs text,
  who_we_serve text,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

alter table org_profile enable row level security;

create policy "team members manage org profile"
  on org_profile for all
  to authenticated
  using (true)
  with check (true);
