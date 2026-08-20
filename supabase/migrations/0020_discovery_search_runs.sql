-- Discovery Search, reworked to run asynchronously like deep_dive_runs
-- (0013_deep_dive.sql) instead of inside one blocking HTTP request.
-- Apply after 0019_nonprofit_data_cache.sql.
--
-- The AI web search step can genuinely take a couple of minutes, and
-- was regularly exceeding Vercel's function timeout when run
-- synchronously inside the form submission. One row per search run;
-- status/status_message update progressively so the UI can poll real
-- progress instead of holding one request open. started_at is a lock,
-- same purpose as deep_dive_runs.started_at.

create type discovery_search_status as enum (
  'searching',
  'extracting',
  'screening',
  'done',
  'error'
);

create table discovery_search_runs (
  id uuid primary key default gen_random_uuid(),
  channel channel not null,
  status discovery_search_status not null default 'searching',
  status_message text,
  found_count int,
  error_message text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  started_at timestamptz
);

alter table discovery_search_runs enable row level security;

create policy "team members can log discovery search runs"
  on discovery_search_runs for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "team members can read discovery search runs"
  on discovery_search_runs for select
  to authenticated
  using (true);

-- Update is needed for progressive status writes during the run, so
-- this isn't append-only like stage_changes/screening_results.
create policy "team members can update discovery search runs"
  on discovery_search_runs for update
  to authenticated
  using (true)
  with check (true);
