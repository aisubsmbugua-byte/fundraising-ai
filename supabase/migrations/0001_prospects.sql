-- Slice 1: CRM spine
-- Apply after Slice 0 (auth) is live.

create type channel as enum (
  'foundation',
  'regranting',
  'christian_business',
  'denomination',
  'daf',
  'major_donor'
);

create table prospects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel channel not null,
  organization text,
  contact_name text,
  contact_email text,
  website text,
  notes text,
  owner_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table prospects enable row level security;

-- Shared team workspace: any authenticated member can read/write any
-- prospect. owner_id is attribution (who created it), not an access gate.
create policy "team members manage all prospects"
  on prospects for all
  to authenticated
  using (true)
  with check (true);

create index prospects_channel_idx on prospects (channel);
create index prospects_owner_idx on prospects (owner_id);
