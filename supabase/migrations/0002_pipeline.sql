-- Slice 2: Pipeline board
-- Apply after Slice 1 (CRM spine) is live.

create type stage as enum (
  'discovery',
  'screening',
  'qualification',
  'cultivation',
  'ask',
  'decision',
  'stewardship'
);

alter table prospects
  add column stage stage not null default 'discovery';

create index prospects_stage_idx on prospects (stage);

-- Append-only audit log: every stage change is a confirmed, attributed
-- action. No update/delete policy is granted below, so rows can only
-- be inserted and read -- history can't be edited or erased later.
create table stage_changes (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  from_stage stage not null,
  to_stage stage not null,
  changed_by uuid not null references auth.users (id),
  changed_by_email text not null,
  note text,
  created_at timestamptz not null default now()
);

alter table stage_changes enable row level security;

create policy "team members can log stage changes"
  on stage_changes for insert
  to authenticated
  with check (changed_by = auth.uid());

create policy "team members can read stage changes"
  on stage_changes for select
  to authenticated
  using (true);

create index stage_changes_prospect_idx on stage_changes (prospect_id);
