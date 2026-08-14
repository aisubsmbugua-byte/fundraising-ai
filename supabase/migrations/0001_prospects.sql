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

create policy "owners manage their prospects"
  on prospects for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create index prospects_channel_idx on prospects (channel);
create index prospects_owner_idx on prospects (owner_id);
