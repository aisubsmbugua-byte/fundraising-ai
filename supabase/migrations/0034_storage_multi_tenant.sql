-- Multi-tenancy, stage 3: scope the org-documents storage bucket by
-- organization, same as every table in 0033. Apply after 0033, and
-- only after scripts/migrate-storage-paths.mjs has already relocated
-- any pre-existing objects under the bootstrap org's prefix -- these
-- policies assume every object is already prefixed, so applying this
-- first would make un-relocated objects briefly unreadable.

drop policy "team members can upload org documents" on storage.objects;
drop policy "team members can read org documents" on storage.objects;
drop policy "team members can delete org documents" on storage.objects;

create policy "team members can upload org documents"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'org-documents'
    and (storage.foldername(name))[1] = my_organization_id()::text
  );

create policy "team members can read org documents"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'org-documents'
    and (storage.foldername(name))[1] = my_organization_id()::text
  );

create policy "team members can delete org documents"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'org-documents'
    and (storage.foldername(name))[1] = my_organization_id()::text
  );
