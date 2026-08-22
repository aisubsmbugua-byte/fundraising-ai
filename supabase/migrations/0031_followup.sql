-- Follow-up: relationship memory + an AI-suggested next step humans
-- review before it's used. No email-send capability exists anywhere
-- in this app yet, so interactions are manually logged by a human
-- ("I called them") -- honest relationship memory, not simulated
-- activity. suggested_* on prospects is a proposal, never applied
-- automatically -- see suggestNextStep / useSuggestedNextStep in
-- app/(dashboard)/revisit/actions.ts.
create type interaction_kind as enum ('email', 'call', 'meeting', 'note');

create table interactions (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  kind interaction_kind not null,
  summary text not null,
  occurred_at date not null default current_date,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

alter table interactions enable row level security;

create policy "team members manage interactions"
  on interactions for all
  to authenticated
  using (true)
  with check (true);

alter table prospects
  add column suggested_next_action text,
  add column suggested_next_action_due date,
  add column suggested_reasoning text,
  add column suggested_at timestamptz;

-- "No" is data, not a dead end: a dismissed candidate can carry a
-- reason and an optional date to intentionally resurface it later.
-- Left off dismissCandidate() itself (no added friction to the
-- shipped one-click Donor Finder flow) -- set from the Follow-up page
-- instead, retroactively or proactively.
alter table candidates
  add column dismissed_reason text,
  add column revisit_date date;
