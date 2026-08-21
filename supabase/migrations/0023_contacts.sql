-- People: a deduplicated directory of individual contacts, auto-
-- populated whenever a contact name/email is captured on a candidate
-- or prospect (see lib/contacts.ts upsertContact), rather than a
-- manually-maintained list. Distinct from the Pipeline's "Contact"
-- stage, which is a prospect's stage, not a person record.
create table contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  organization text,
  source_candidate_id uuid references candidates (id) on delete set null,
  source_prospect_id uuid references prospects (id) on delete set null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table contacts enable row level security;

create policy "team members manage contacts"
  on contacts for all
  to authenticated
  using (true)
  with check (true);
