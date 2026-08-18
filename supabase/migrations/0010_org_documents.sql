-- Slice 3+ extension: organization knowledge base, stage 2 (documents).
-- Apply after 0009_org_profile_people_web.sql.
--
-- Storage buckets are just rows in storage.buckets, so this creates
-- the bucket and its access policies via SQL like everything else --
-- no separate dashboard step needed. Bucket is private (public:
-- false); files are only reachable via signed URLs generated
-- server-side for authenticated team members.

insert into storage.buckets (id, name, public)
values ('org-documents', 'org-documents', false)
on conflict (id) do nothing;

create policy "team members can upload org documents"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'org-documents');

create policy "team members can read org documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'org-documents');

create policy "team members can delete org documents"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'org-documents');

-- Metadata table. Note: this stores files for human reference only --
-- it does not extract text content for AI to read yet. That's a
-- separate parsing task (PDF/DOCX text extraction), flagged
-- separately, not bundled in here.
create table org_documents (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  storage_path text not null,
  file_size bigint,
  content_type text,
  uploaded_by uuid not null references auth.users (id),
  uploaded_at timestamptz not null default now()
);

alter table org_documents enable row level security;

create policy "team members manage org documents"
  on org_documents for all
  to authenticated
  using (true)
  with check (true);
