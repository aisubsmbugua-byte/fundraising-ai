-- Slice 3+ extension: AI-assisted channel matching.
-- Apply after 0010_org_documents.sql.
--
-- Each "Run Analysis" click creates a new row (evaluations never get
-- overwritten). Review is a separate step on the same row: a human
-- confirms which channels to actually pursue (approved_channels),
-- which starts null until reviewed. AI proposes; a human decides --
-- this table is exactly that pattern.

create table channel_match_runs (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  evaluations jsonb not null,
  approved_channels text[],
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz
);

alter table channel_match_runs enable row level security;

create policy "team members can log channel match runs"
  on channel_match_runs for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "team members can read channel match runs"
  on channel_match_runs for select
  to authenticated
  using (true);

create policy "team members can review channel match runs"
  on channel_match_runs for update
  to authenticated
  using (true)
  with check (true);
