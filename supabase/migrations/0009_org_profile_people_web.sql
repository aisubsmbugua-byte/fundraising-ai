-- Slice 3+ extension: organization knowledge base, stage 6.
-- Apply after 0008_org_profile_lists.sql.
-- Adds website, key people (name/role pairs), and social media
-- links (platform/url pairs).

alter table org_profile
  add column website text,
  add column key_people jsonb,
  add column social_links jsonb;
