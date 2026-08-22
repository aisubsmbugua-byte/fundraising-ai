-- Evidence library (Slice 6): verifiable outcomes, stories, testimonials,
-- and documents a human curates and can safely reuse. An item starts
-- unverified -- verified_at/verified_by/permission are set together in
-- one human action, since permission = 'approved' is what gates entry
-- into an AI prompt (see deep-dive-actions.ts). org_documents has no
-- text extraction, so source_document_id just links to an already-
-- uploaded file for human reference; the AI only ever reads the
-- human-written description below.
create type evidence_type as enum ('outcome', 'story', 'testimonial', 'document');
create type evidence_permission as enum ('approved', 'restricted');

create table evidence_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  type evidence_type not null,
  program text,
  geography text,
  permission evidence_permission not null default 'restricted',
  verified_at timestamptz,
  verified_by uuid references auth.users (id),
  source_document_id uuid references org_documents (id) on delete set null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table evidence_items enable row level security;

create policy "team members manage evidence items"
  on evidence_items for all
  to authenticated
  using (true)
  with check (true);

-- Which verified/approved evidence a deep-dive strategy actually cited,
-- so "used in N strategies" on an evidence item is a real count, not a
-- fabricated one.
alter table deep_dive_runs add column evidence_item_ids uuid[];
