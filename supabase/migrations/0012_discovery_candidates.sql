-- Slice 4: Discovery intake
-- Apply after 0011_channel_match.sql.

create type candidate_status as enum ('pending', 'accepted', 'dismissed');

create table candidates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel channel not null,
  organization text,
  website text,
  contact_name text,
  contact_email text,
  source text,
  raw jsonb,
  suggested_tier int,
  status candidate_status not null default 'pending',
  reviewed_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table candidates enable row level security;

-- Team-scoped, not append-only: candidates are working data (status
-- moves pending -> accepted/dismissed), not an audit log.
create policy "team members manage candidates"
  on candidates for all
  to authenticated
  using (true)
  with check (true);

create index candidates_status_idx on candidates (status);
