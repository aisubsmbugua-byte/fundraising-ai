-- STATE item 71, part (a): brand capture for the proposal render view.
-- org_profile gains three nullable columns, and a new storage bucket holds
-- the uploaded logo file -- additive only, under ruling 0020.
--
-- Deploy order: apply this BEFORE deploying the code that reads/writes
-- logo_path/primary_color/accent_color or uploads to 'org-logos'. All three
-- columns are nullable with no default, so every existing row is valid the
-- instant they appear, and nothing reads them until the Org Settings UI and
-- the proposal view ship. In the other order (code before migration), the
-- Settings page's upload action would fail on the missing columns and the
-- proposal view would simply render its no-branding default -- fails
-- closed either way.
--
-- org_profile already carries organization_id and its RLS policy from
-- 0033 ("using (organization_id = my_organization_id())"), so these new
-- columns inherit tenant isolation with no policy change (hard rule 6).

alter table org_profile
  add column logo_path text,
  add column primary_color text,
  add column accent_color text;

-- text + check, matching 0063's faith-affiliation columns and
-- entity_validation_status: a 6-digit hex color or null, nothing else.
-- Checked, not trusted to the upload form -- a bad value never reaches a
-- CSS custom property downstream.
alter table org_profile
  add constraint org_profile_primary_color_check
  check (primary_color is null or primary_color ~ '^#[0-9a-fA-F]{6}$');

alter table org_profile
  add constraint org_profile_accent_color_check
  check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$');

comment on column org_profile.logo_path is
  'Storage path (not a URL) into the org-logos bucket, same shape as org_documents.storage_path. Null means no logo uploaded; the proposal view then renders with no logo rather than a broken image.';

comment on column org_profile.primary_color is
  '6-digit hex (#rrggbb) or null. Null means the proposal view falls back to the app''s own default navy, never an invented color.';

comment on column org_profile.accent_color is
  '6-digit hex (#rrggbb) or null. Null means the proposal view falls back to the app''s own default teal, never an invented color.';

-- Storage bucket for the logo (mirrors 0004_org_profile.sql's org-documents
-- bucket: buckets are just rows in storage.buckets, created here like
-- everything else -- no separate dashboard step).
--
-- PUBLIC, unlike org-documents (which is private + signed URLs). The
-- proposal render view (part c) needs the browser to load the logo
-- directly via <img src>, including at print time via the browser's own
-- print-to-PDF -- a signed URL would need re-generating per render and
-- would expire mid-review if a human leaves the tab open, for an asset
-- (an organization's own public-facing logo) that carries none of the
-- confidentiality org-documents' uploaded files might. Write access
-- (upload/delete) stays authenticated and org-scoped exactly like
-- org-documents' policies from 0034 -- only READ is public.
insert into storage.buckets (id, name, public)
values ('org-logos', 'org-logos', true)
on conflict (id) do nothing;

create policy "team members can upload org logo"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'org-logos' and (storage.foldername(name))[1] = my_organization_id()::text);

create policy "team members can replace org logo"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'org-logos' and (storage.foldername(name))[1] = my_organization_id()::text)
  with check (bucket_id = 'org-logos' and (storage.foldername(name))[1] = my_organization_id()::text);

create policy "team members can delete org logo"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'org-logos' and (storage.foldername(name))[1] = my_organization_id()::text);

-- Authenticated read policy too, even though the bucket's public flag
-- already serves objects via the public URL endpoint without an RLS check
-- (that's what "public" means in Supabase Storage) -- this is defense in
-- depth for any authenticated path (e.g. the dashboard listing a team's
-- own objects) and costs nothing since it only narrows, never widens, the
-- public endpoint's own access.
create policy "team members can read org logo"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'org-logos' and (storage.foldername(name))[1] = my_organization_id()::text);
