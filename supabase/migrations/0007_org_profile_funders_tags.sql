-- Slice 3+ extension: organization knowledge base, stage 4.
-- Apply after 0006_org_profile_geo_tags.sql.
-- Converts notable_funders (single text) into an array, same pattern
-- as geographic_areas -- preserves any existing value.

alter table org_profile
  alter column notable_funders type text[]
  using (case when notable_funders is null then null else array[notable_funders] end);
