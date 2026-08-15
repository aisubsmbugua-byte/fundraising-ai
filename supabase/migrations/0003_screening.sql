-- Slice 3: Screening & classification
-- Apply after Slice 2 (pipeline) is live.

create table screening_rules (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  description text,
  channel channel, -- nullable: applies to all channels if null
  weight int not null default 1,
  criterion jsonb not null,
  active boolean not null default true,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table screening_rules enable row level security;

create policy "team members manage screening rules"
  on screening_rules for all
  to authenticated
  using (true)
  with check (true);

create index screening_rules_channel_idx on screening_rules (channel);

-- Each "Screen" run inserts a new result rather than overwriting the
-- last one, so a prospect's classification history over time is
-- preserved. Only insert/select are granted, same append-only
-- pattern as stage_changes.
create table screening_results (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  tier int not null check (tier in (1, 2, 3)),
  score numeric not null,
  breakdown jsonb not null,
  screened_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

alter table screening_results enable row level security;

create policy "team members can log screening results"
  on screening_results for insert
  to authenticated
  with check (screened_by = auth.uid());

create policy "team members can read screening results"
  on screening_results for select
  to authenticated
  using (true);

create index screening_results_prospect_idx on screening_results (prospect_id);
