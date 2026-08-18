-- Advancement workflow, stage 1c: capture funder intel at candidate
-- creation too, not only via AI deep-dive after acceptance.
-- Apply after 0014_prospect_funder_intel.sql.

alter table candidates
  add column location text,
  add column funder_type text,
  add column geographic_focus text,
  add column typical_grant_size text,
  add column focus_areas text[];
