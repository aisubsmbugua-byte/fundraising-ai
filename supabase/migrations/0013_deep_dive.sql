-- Advancement workflow, stage 1: deep-dive research -> strategy.
-- Apply after 0012_discovery_candidates.sql.
--
-- One row per deep-dive run on a prospect. status/status_message are
-- updated progressively during the run so the UI can show real
-- progress (not a simulated animation) via polling. strategy is the
-- AI's proposal; approved_strategy stays null until a human approves
-- (optionally editing first) -- AI proposes, human decides.

create type deep_dive_status as enum (
  'researching',
  'analyzing',
  'ready_for_review',
  'error'
);

create table deep_dive_runs (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  status deep_dive_status not null default 'researching',
  status_message text,
  findings text,
  strategy jsonb,
  model text,
  error_message text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  approved_strategy jsonb
);

alter table deep_dive_runs enable row level security;

create policy "team members can log deep dive runs"
  on deep_dive_runs for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "team members can read deep dive runs"
  on deep_dive_runs for select
  to authenticated
  using (true);

-- Update is needed for progressive status writes during the run and
-- for the later approval step, so this isn't append-only like
-- stage_changes/screening_results.
create policy "team members can update deep dive runs"
  on deep_dive_runs for update
  to authenticated
  using (true)
  with check (true);

create index deep_dive_runs_prospect_idx on deep_dive_runs (prospect_id);
