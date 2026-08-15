-- Slice 3+ extension: organization knowledge base, stage 3.
-- Apply after 0005_org_profile_expand.sql.
-- Converts geographic_area (single text) into geographic_areas (an
-- array), preserving any existing value as a single-element array.

alter table org_profile
  alter column geographic_area type text[]
  using (case when geographic_area is null then null else array[geographic_area] end);

alter table org_profile rename column geographic_area to geographic_areas;
