-- Scheduled overnight Discovery Search + a manual pause switch, so
-- the candidate queue can't grow faster than a human can review it.
-- Two-layer safety: this settings row's `enabled` flag is the manual
-- override; the queue_threshold is checked by the cron route itself
-- before running (skips the night's run entirely if the pending
-- queue is already at or above threshold).
-- Singleton table, same "enforced in application code" pattern as
-- org_profile (0004_org_profile.sql).
-- Apply after 0020_discovery_search_runs.sql.

create table auto_search_settings (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null default false,
  queue_threshold int not null default 15,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

alter table auto_search_settings enable row level security;

create policy "team members manage auto search settings"
  on auto_search_settings for all
  to authenticated
  using (true)
  with check (true);
