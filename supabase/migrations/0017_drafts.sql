-- Advancement workflow, stage 2: outreach drafting (workflow steps
-- 3-4). Apply after 0016_deep_dive_started_at.sql.
--
-- Only unlocked once a prospect's Strategy is approved (enforced in
-- the generateDraft action, not just the UI). Each draft needs an
-- explicit human approval before it's considered ready -- no send
-- capability exists yet; that's a separate follow-on once Resend is
-- set up (a new secret, its own checkpoint).

create type draft_kind as enum ('intro_email', 'call_prep');
create type draft_status as enum ('draft', 'approved');

create table drafts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  deep_dive_run_id uuid references deep_dive_runs (id),
  kind draft_kind not null,
  subject text,
  content text not null,
  status draft_status not null default 'draft',
  model text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz
);

alter table drafts enable row level security;

create policy "team members manage drafts"
  on drafts for all
  to authenticated
  using (true)
  with check (true);

create index drafts_prospect_idx on drafts (prospect_id);
